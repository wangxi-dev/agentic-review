#!/usr/bin/env python3
"""agentic-review:cleanup

Shut down the local bridge server and remove the temp comments folder.

IMPORTANT: cleanup deletes the comments. Run 'agentic-review:take-feedback'
first and let the user take a last look, so no feedback is lost.

  --force   skip the "did you take a last look?" guard
  --quiet   minimal output (used internally by launch.py)
"""
import os
import shutil
import sys
import time

import common as C


def do_cleanup(force=False, quiet=False):
    state = C.load_state()
    if not state:
        if not quiet:
            print("agentic-review: no active session to clean up.")
        return 0

    if not force:
        try:
            data = C.api_get(state, "/api/comments")
            n = len(data.get("comments", []))
        except Exception:  # noqa: BLE001 - best-effort count
            n = "?"
        print("About to shut down the review server and DELETE its comments store.")
        print("  comments on record : %s" % n)
        print("  store              : %s" % state.get("commentsDir", "?"))
        print("Run 'agentic-review:take-feedback' first if you haven't captured these.")
        print("Re-run with --force to proceed.")
        return 3

    # Ask the server to shut down gracefully.
    try:
        C.api_post(state, "/api/cleanup")
    except Exception:  # noqa: BLE001 - server may already be closing the socket
        pass
    time.sleep(0.3)

    pid = state.get("serverPid")
    if C.process_alive(pid):
        C.terminate(pid)

    removed = None
    # Remove only the ephemeral review artifacts (comments + pre-commit
    # messages); preserve user checkers in <work>/checkers and the .gitignore.
    work_dir = state.get("workDir")
    if state.get("workDirIsDefault") and work_dir and os.path.isdir(work_dir):
        for sub in ("comments", "precommit"):
            shutil.rmtree(os.path.join(work_dir, sub), ignore_errors=True)
        removed = work_dir + " (comments + precommit)"
        # If nothing of value remains (no user checkers), drop the whole folder.
        leftover = [n for n in os.listdir(work_dir) if n != ".gitignore"]
        if not leftover:
            shutil.rmtree(work_dir, ignore_errors=True)
            removed = work_dir
    elif state.get("commentsIsTemp") and state.get("commentsDir") \
            and os.path.isdir(state["commentsDir"]):
        shutil.rmtree(state["commentsDir"], ignore_errors=True)
        removed = state["commentsDir"]

    C.clear_state()
    if not quiet:
        print("agentic-review: session cleaned up.")
        if removed:
            print("  removed: %s" % removed)
        elif state.get("commentsDir"):
            print("  kept comments store: %s" % state["commentsDir"])
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    rc = do_cleanup(force="--force" in argv, quiet="--quiet" in argv)
    sys.exit(rc)


if __name__ == "__main__":
    main()
