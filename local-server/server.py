#!/usr/bin/env python3
"""agentic-review local bridge server — entry point / orchestrator.

The only component with access to local files. The static review shell talks
*exclusively* to this server. Binds to loopback (127.0.0.1) only.

The implementation is split into sibling modules (mirroring the shell's site/js
split), each well under the project's own 800-LoC checker:
    ar_core.py      constants, classification, HttpError, Config, git helpers
    ar_manifest.py  change manifest, pre-commit pseudo files, all-files tree
    ar_content.py   file content + diffs (incl. expanded pretty JSON diff)
    ar_checkers.py  pluggable checker plugins
    ar_comments.py  pluggable comment store (files + GitHub issue) + validation
    ar_http.py      the HTTP handler (CORS/PNA, token, routing, static shell)
This file only parses arguments, builds Config, and starts the server.

Endpoints (all JSON unless noted):
    GET  /ping                      -> {status, service, version}
    GET  /api/manifest              -> {base, root, files:[...]}
    GET  /api/content?path=<rel>    -> {path, kind, content}   (415 binary, 403 traversal)
    GET  /api/diff?path=<rel>       -> {path, base, unified}   (&pretty=1: expanded JSON diff)
    GET  /api/comments              -> {comments:[...]}   (each has status + replies[])
    POST /api/comments              -> {status:"ok", id}
    PUT  /api/comments?id=<id>      -> edit comment text
    PATCH /api/comments?id=<id>     -> set lifecycle status (open/resolved/rejected/...)
    POST /api/comments/reply?id=<id>-> append a reply (author human|agent) to the thread
    DELETE /api/comments?id=<id>    -> delete a comment
    POST /api/cleanup               -> {status:"ok"} then graceful shutdown
    GET  /<static>                  -> serves the shell from --site-dir (same-origin fallback)

Run:
    python3 server.py --root /path/to/repo [--port 8900] [--comments-dir DIR]
                      [--diff-base HEAD] [--allow-origin https://foo.bar]...
                      [--token SECRET] [--site-dir ../site]

Security model: loopback bind, root-confined file access (no traversal / symlink
escape), optional Origin allowlist, optional per-session token on /api/*, and
Private Network Access preflight support for HTTPS shells (e.g. GitHub Pages).
"""
import argparse
import os
import sys
from http.server import ThreadingHTTPServer

# Re-export the public API from the split modules so `import server` keeps
# exposing the same names (used by tests and external callers).
from ar_core import (  # noqa: F401
    Config, HttpError, VERSION, SERVICE, DEFAULT_ALLOWED_ORIGINS,
    renderer_for, kind_hint, looks_binary, git, is_git_repo,
    now_iso, ensure_work_dir,
)
from ar_manifest import (  # noqa: F401
    build_manifest, build_file_tree, write_precommit, precommit_entries,
    changed_status_map,
)
from ar_content import (  # noqa: F401
    read_content, read_diff, _pretty_json_text, _json_pretty_diff,
)
from ar_checkers import (  # noqa: F401
    discover_checkers, run_checkers, run_checkers_all,
)
from ar_comments import (  # noqa: F401
    CommentStore, FileCommentStore, GitHubIssueCommentStore,
    make_store, make_comment, make_reply, validate_status,
    VALID_STATUSES, REPLY_AUTHORS, DEFAULT_STATUS, _gh_render, _gh_parse,
)
from ar_http import Handler, _inject_token  # noqa: F401


def parse_args(argv):
    p = argparse.ArgumentParser(description="agentic-review local bridge server")
    p.add_argument("--root", default=os.environ.get("AR_ROOT", os.getcwd()),
                   help="directory under review (default: $AR_ROOT or cwd)")
    p.add_argument("--port", type=int,
                   default=int(os.environ.get("AR_PORT", "8900")),
                   help="loopback port (default: 8900)")
    p.add_argument("--comments-dir", default=os.environ.get("AR_COMMENTS_DIR"),
                   help="directory to store comment JSON files (default: <work-dir>/comments)")
    p.add_argument("--work-dir", default=os.environ.get("AR_WORK_DIR"),
                   help="in-repo git-ignored work folder (default: <root>/.agentic-review)")
    p.add_argument("--diff-base", default=os.environ.get("AR_DIFF_BASE", "HEAD"),
                   help="git ref to diff against (default: HEAD = working tree vs HEAD)")
    p.add_argument("--allow-origin", action="append",
                   default=([os.environ["AR_ALLOW_ORIGIN"]]
                            if os.environ.get("AR_ALLOW_ORIGIN") else None),
                   help="allowed shell Origin (repeatable). If omitted, dev-echoes any origin.")
    p.add_argument("--token", default=os.environ.get("AR_TOKEN"),
                   help="optional per-session token required on /api/* via X-AR-Token")
    p.add_argument("--site-dir",
                   default=os.environ.get("AR_SITE_DIR",
                                          os.path.join(os.path.dirname(__file__), "..", "site")),
                   help="serve the shell from this dir for same-origin use (default: ../site)")
    p.add_argument("--no-untracked", action="store_true",
                   help="exclude untracked files from the manifest")
    p.add_argument("--comment-store", choices=("files", "github"),
                   default=os.environ.get("AR_COMMENT_STORE", "files"),
                   help="comment backend (default: files)")
    p.add_argument("--github-repo", default=os.environ.get("AR_GITHUB_REPO"),
                   help="owner/repo for --comment-store github")
    p.add_argument("--github-issue", type=int,
                   default=(int(os.environ["AR_GITHUB_ISSUE"])
                            if os.environ.get("AR_GITHUB_ISSUE") else None),
                   help="issue number to attach comments to for --comment-store github")
    # Positional port for backward-compat with the old stub (python server.py 8900).
    p.add_argument("legacy_port", nargs="?", type=int, help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    if args.legacy_port is not None:
        args.port = args.legacy_port
    return args


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    cfg = Config(args)
    if not os.path.isdir(cfg.root):
        print("error: --root is not a directory: %s" % cfg.root, file=sys.stderr)
        return 2
    Handler.cfg = cfg
    Handler.store = make_store(cfg)

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", cfg.port), Handler)
    except OSError as e:
        print("error: cannot bind 127.0.0.1:%d (%s). Is the port already in use?"
              % (cfg.port, e), file=sys.stderr)
        return 1

    print("agentic-review local server v%s" % VERSION)
    print("  listening : http://127.0.0.1:%d" % cfg.port)
    print("  root      : %s" % cfg.root)
    print("  diff base : %s" % cfg.diff_base)
    print("  work dir  : %s" % cfg.work_dir)
    if cfg.comment_store == "github":
        print("  comments  : github issue %s#%s" % (cfg.github_repo, cfg.github_issue))
    else:
        print("  comments  : %s%s" % (cfg.comments_dir,
                                      " (temp)" if cfg.comments_dir_is_temp else ""))
    if cfg.site_dir and os.path.isdir(cfg.site_dir):
        print("  shell     : http://127.0.0.1:%d/review.html  (same-origin)" % cfg.port)
        print("  docs      : http://127.0.0.1:%d/  (overview + setup guide)" % cfg.port)
    if cfg.token:
        print("  token     : required on /api/* (X-AR-Token)")
    if not cfg.strict_origin:
        print("  origin    : DEV ECHO (no --allow-origin set; any origin accepted)")
    else:
        print("  origin    : allowlist %s" % sorted(cfg.allow_origins))
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
