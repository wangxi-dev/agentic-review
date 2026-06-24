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
import os
import secrets
import sys
import tempfile
import time

import common as C

# The project's published GitHub Pages shell (the bridge always allows this
# origin). Override with AR_PAGES_URL for a self-hosted shell.
DEFAULT_PAGES_SHELL = "https://wangxi-dev.github.io/agentic-review/"


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agentic-review:launch")
    parser.add_argument("comments_folder", nargs="?",
                        help="folder to persist comments in (default: a temp dir)")
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

    if args.comments_folder:
        comments_dir = os.path.abspath(args.comments_folder)
        os.makedirs(comments_dir, exist_ok=True)
        comments_is_temp = False
    else:
        comments_dir = tempfile.mkdtemp(prefix="agentic-review-comments-")
        comments_is_temp = True

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
        "--comments-dir", comments_dir,
        "--diff-base", diff_base,
        "--token", token,
    ]
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

    C.save_state({
        "port": port,
        "token": token,
        "commentsDir": comments_dir,
        "commentsIsTemp": comments_is_temp,
        "serverPid": proc.pid,
        "reviewRoot": review_root,
        "diffBase": diff_base,
        "log": log_path,
    })

    print("agentic-review session started.")
    print("  reviewing : %s  (diff base: %s)" % (review_root, diff_base))
    print("  comments  : %s" % comments_dir)
    print("  server    : http://127.0.0.1:%d  (pid %d)" % (port, proc.pid))
    print()
    print("Open the review shell (same-origin, works out of the box):")
    print("  http://127.0.0.1:%d/?token=%s" % (port, token))
    # The hosted GitHub Pages shell is always allowed by the bridge, so print a
    # ready-to-click link to it too (override with AR_PAGES_URL).
    pages_shell = os.environ.get("AR_PAGES_URL", DEFAULT_PAGES_SHELL).rstrip("/")
    print()
    print("Or the hosted shell (GitHub Pages):")
    print("  %s/?api=http://localhost:%d&token=%s" % (pages_shell, port, token))


if __name__ == "__main__":
    main()
