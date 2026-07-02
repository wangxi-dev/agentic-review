#!/usr/bin/env python3
"""agentic-review:cleanup

Shut down the local bridge server. Comments are NOT deleted: they live in a
persistent, per-repo folder under ~/.agentic-review/comments/<repo-key>/ and
survive restarts, so a relaunch for the same repo reuses them.

  (no args)    shut down the active session; keep all stored comments
  --force      also skip the guarded confirmation (used internally by launch.py)
  --quiet      minimal output (used internally by launch.py)

  --sessions          list every stored per-repo comment folder
  --sessions --force  PRUNE stale folders (every stored session except the one
                      currently active), deleting their comments for good
"""
import json
import os
import shutil
import sys
import time

import common as C


def do_cleanup(force=False, quiet=False):
    """Shut down the active bridge. Never deletes the comment folder."""
    state = C.load_state()
    if not state:
        if not quiet:
            print("agentic-review: no active session to clean up.")
        return 0

    # Ask the server to shut down gracefully, then hard-stop if needed.
    try:
        C.api_post(state, "/api/cleanup")
    except Exception:  # noqa: BLE001 - server may already be closing the socket
        pass
    time.sleep(0.3)
    pid = state.get("serverPid")
    if C.process_alive(pid):
        C.terminate(pid)

    C.clear_state()
    if not quiet:
        print("agentic-review: session cleaned up (server stopped).")
        store = state.get("commentsDir")
        if store:
            print("  kept comments: %s" % store)
            print("  (persistent — remove with 'cleanup --sessions --force')")
    return 0


def _session_info(path):
    """(repoRoot, branch, updatedAt, comment_count) for a stored folder."""
    repo = branch = updated = ""
    try:
        with open(os.path.join(path, "meta.json"), "r", encoding="utf-8") as fh:
            m = json.load(fh)
        repo = m.get("repoRoot", "")
        branch = m.get("branch", "")
        updated = m.get("updatedAt", "")
    except (OSError, ValueError):
        pass
    try:
        n = len([f for f in os.listdir(path)
                 if f.endswith(".json") and f != "meta.json"])
    except OSError:
        n = 0
    return repo, branch, updated, n


def prune_sessions(force=False):
    """List (or, with force, delete) stale per-repo comment folders.

    The currently active session's folder is always preserved.
    """
    state = C.load_state()
    active = None
    if state and state.get("commentsDir"):
        active = os.path.realpath(state["commentsDir"])

    dirs = C.list_session_dirs()
    if not dirs:
        print("agentic-review: no stored review sessions.")
        return 0

    stale = [d for d in dirs if os.path.realpath(d) != active]
    print("Stored review comment folders under %s:" % C.COMMENTS_ROOT)
    for d in dirs:
        is_active = os.path.realpath(d) == active
        repo, branch, updated, n = _session_info(d)
        tag = "  [ACTIVE]" if is_active else ""
        loc = repo or os.path.basename(d)
        extra = " @%s" % branch if branch else ""
        when = " last %s" % updated if updated else ""
        print("  %s%s  (%d comments%s)%s" % (loc, extra, n, when, tag))

    if not stale:
        print("Nothing stale to prune (only the active session is stored).")
        return 0

    if not force:
        print()
        print("%d stale session(s) can be pruned (the active one is kept)."
              % len(stale))
        print("Re-run with '--sessions --force' to delete them for good.")
        return 3

    removed = 0
    for d in stale:
        shutil.rmtree(d, ignore_errors=True)
        removed += 1
    print("agentic-review: pruned %d stale session(s)." % removed)
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if "--sessions" in argv:
        rc = prune_sessions(force="--force" in argv)
    else:
        rc = do_cleanup(force="--force" in argv, quiet="--quiet" in argv)
    sys.exit(rc)


if __name__ == "__main__":
    main()
