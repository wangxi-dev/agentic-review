#!/usr/bin/env python3
"""agentic-review:launch [review-comments-folder]

Start the local bridge server for the repo the user is currently in, with a
per-session token, and print the shell URL(s) to open in a browser.

Env overrides:
  AR_PORT          starting port (default 8900; auto-advances if busy)
  AR_DIFF_BASE     git ref to diff against (default HEAD = working tree vs HEAD)
  AR_PAGES_ORIGIN  GitHub Pages shell origin, e.g. https://you.github.io/agentic-review
  AR_REVIEW_ROOT   override the directory under review (default: current git root)
"""
import argparse
import json
import os
import secrets
import shutil
import sys
import time

import common as C

# The project's published GitHub Pages shell (the bridge always allows this
# origin). Override with AR_PAGES_URL for a self-hosted shell.
DEFAULT_PAGES_SHELL = "https://wangxi-dev.github.io/agentic-review/"


def _migrate_legacy(old_dir, new_dir, only_ext):
    """Move leftover files from a legacy in-repo folder into the new one.

    Only runs when the destination has nothing of interest yet, so it never
    clobbers newer data. `only_ext` (e.g. ".json") limits which files move;
    None moves everything. Best-effort — failures are ignored.
    """
    if not os.path.isdir(old_dir) or os.path.realpath(old_dir) == os.path.realpath(new_dir):
        return
    try:
        existing = [f for f in os.listdir(new_dir)
                    if f != "meta.json" and (only_ext is None or f.endswith(only_ext))]
    except OSError:
        existing = []
    if existing:
        return
    try:
        names = os.listdir(old_dir)
    except OSError:
        return
    for name in names:
        if only_ext is not None and not name.endswith(only_ext):
            continue
        src = os.path.join(old_dir, name)
        if not os.path.isfile(src):
            continue
        try:
            shutil.move(src, os.path.join(new_dir, name))
        except OSError:
            pass


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agentic-review:launch")
    parser.add_argument("comments_folder", nargs="?",
                        help="folder to persist comments in (default: a temp dir)")
    parser.add_argument("--agent-pid", type=int,
                        help="PID of the author agent that launched this (default: parent)")
    parser.add_argument("--agent-id",
                        help="tool-native agent/session id of the author agent")
    args = parser.parse_args(argv)

    if not os.path.isfile(C.SERVER):
        C.die("server not found at %s" % C.SERVER)

    # If a session is already running, tear it down first (single session).
    if C.load_state():
        sys.stderr.write("agentic-review: existing session found; cleaning it up.\n")
        import cleanup as _cleanup
        _cleanup.do_cleanup(force=True, quiet=True)

    review_root = os.environ.get("AR_REVIEW_ROOT") or C.git_toplevel()
    if not os.path.isdir(review_root):
        C.die("review root is not a directory: %s" % review_root)

    # In-repo git-ignored work folder for comments + pre-commit messages.
    work_dir = os.path.join(review_root, ".agentic-review")

    diff_base = os.environ.get("AR_DIFF_BASE", "HEAD")
    pages_origin = os.environ.get("AR_PAGES_ORIGIN", "").strip()
    token = secrets.token_urlsafe(24)
    start_port = int(os.environ.get("AR_PORT", "8900"))
    port = C.find_free_port(start_port)

    os.makedirs(C.STATE_DIR, exist_ok=True)
    log_path = os.path.join(C.STATE_DIR, "server-%d.log" % port)

    server_args = [
        C.python_exe(), C.SERVER,
        "--root", review_root,
        "--port", str(port),
        "--diff-base", diff_base,
        "--token", token,
    ]
    if args.comments_folder:
        comments_dir = os.path.abspath(args.comments_folder)
        comments_is_temp = False
    else:
        # Persistent, user-level, per-repo comment folder (survives restarts).
        # NOT in the repo, NOT a temp dir — only an explicit prune removes it.
        comments_dir = C.session_dir(review_root)
        comments_is_temp = False
    # Precommit messages stay in the in-repo work folder: they are served to the
    # shell through the repo-root-confined content endpoint, so they MUST live
    # under the repo root. cleanup no longer wipes them, so they persist too.
    precommit_dir = os.path.join(work_dir, "precommit")
    os.makedirs(comments_dir, exist_ok=True)
    os.makedirs(precommit_dir, exist_ok=True)
    # One-time migration: earlier versions kept comments inside the repo
    # (<work_dir>/comments). If this repo still has some and the new persistent
    # folder is empty, move them over so nothing is lost on the upgrade.
    if not args.comments_folder:
        _migrate_legacy(os.path.join(work_dir, "comments"), comments_dir, ".json")
    server_args += ["--comments-dir", comments_dir,
                    "--precommit-dir", precommit_dir]
    if pages_origin:
        server_args += ["--allow-origin", pages_origin]

    proc = C.spawn_detached(server_args, log_path)

    # Wait for /ping.
    ready = False
    for _ in range(50):
        if C.ping(port):
            ready = True
            break
        if proc.poll() is not None:
            sys.stderr.write("--- server log ---\n")
            try:
                with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                    sys.stderr.write(fh.read())
            except OSError:
                pass
            C.die("server exited during startup.")
        time.sleep(0.1)
    if not ready:
        C.die("server did not become ready; see %s" % log_path)

    # Record the AUTHOR agent (the process that ran launch) so the bridge knows
    # which already-running, idle agent to hand "address comments" tasks to.
    author_pid = args.agent_pid or os.getppid()
    author_id = args.agent_id or os.environ.get("AR_AGENT_ID")

    # Small metadata file so 'cleanup --sessions' can show useful info about
    # each stored review folder (which repo, when last used).
    branch = C.run_git(["rev-parse", "--abbrev-ref", "HEAD"], review_root)
    meta = {
        "repoRoot": review_root,
        "branch": branch,
        "sessionKey": os.path.basename(comments_dir.rstrip(os.sep)),
        "port": port,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    try:
        with open(os.path.join(comments_dir, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, indent=2)
    except OSError:
        pass

    C.save_state({
        "port": port,
        "token": token,
        "commentsDir": comments_dir,
        "commentsIsTemp": comments_is_temp,
        "precommitDir": precommit_dir,
        "workDir": work_dir,
        # Comments + precommit now live in a persistent, user-level, per-repo
        # folder — cleanup must NEVER wipe them. Only an explicit prune
        # ('cleanup --sessions --force') removes stored sessions.
        "workDirIsDefault": False,
        "serverPid": proc.pid,
        "reviewRoot": review_root,
        "diffBase": diff_base,
        "log": log_path,
        "authorPid": author_pid,
        "authorAgentId": author_id,
        "authorAgent": os.environ.get("AR_AGENT"),
        "authorModel": os.environ.get("AR_MODEL"),
    })

    print("agentic-review session started.")
    print("  reviewing : %s  (diff base: %s)" % (review_root, diff_base))
    print("  comments  : %s" % comments_dir)
    print("  server    : http://127.0.0.1:%d  (pid %d)" % (port, proc.pid))
    print()
    print("Open the review shell (same-origin, works out of the box):")
    print("  http://127.0.0.1:%d/review.html" % port)
    print("  (the bridge injects the session token; no ?api= or ?token= needed)")
    # Only advertise the hosted GitHub Pages shell when the user opted in by
    # setting AR_PAGES_ORIGIN / AR_PAGES_URL. That path is cross-origin, so it
    # needs the explicit ?api=&token= query the bridge cannot inject for it.
    if pages_origin or os.environ.get("AR_PAGES_URL"):
        pages_shell = os.environ.get("AR_PAGES_URL", DEFAULT_PAGES_SHELL).rstrip("/")
        print()
        print("Or the hosted shell (GitHub Pages):")
        print("  %s/review.html?api=http://localhost:%d&token=%s" % (pages_shell, port, token))


if __name__ == "__main__":
    main()
