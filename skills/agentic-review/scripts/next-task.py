#!/usr/bin/env python3
"""agentic-review:next-task

Claim the next pending cross-review task that the human dropped from the portal
("Address all open comments"). This is how the already-running, idle **author**
agent picks up work without the human opening a chat: after `launch`, the author
self-arms a periodic wake that runs this; when a task appears, it acts.

Tasks are plain files under <work-dir>/tasks/ (no endpoint needed to read them).

  next-task.py                 # claim the oldest pending task; print what to do
  next-task.py --peek          # show pending tasks without claiming
  next-task.py --done <id>     # mark a claimed task complete (removes it)

Exit code 0 = a task is ready / handled; 3 = nothing pending (so a poll loop can
quietly go back to sleep).
"""
import argparse
import datetime
import json
import os
import sys

import common as C

NOTHING = 3


def _tasks_dir(state):
    work = state.get("workDir")
    if not work:
        C.die("session has no workDir; relaunch with the current skill version.")
    return os.path.join(work, "tasks")


def _jobs_dir(state):
    work = state.get("workDir")
    if not work:
        C.die("session has no workDir; relaunch with the current skill version.")
    d = os.path.join(work, "jobs")
    os.makedirs(d, exist_ok=True)
    return d


def _active_marker(state):
    return os.path.join(_jobs_dir(state), "active.json")


def _set_active(state, kind, job_id):
    """Register author work as the single in-flight job so the bridge's commit /
    new-review guard can see it. pid is the long-lived author agent (this CLI),
    so the marker stays live until we clear it on --done."""
    pid = state.get("authorPid") or os.getppid()
    marker = _active_marker(state)
    tmp = marker + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump({"kind": kind, "pid": pid, "jobId": job_id,
                   "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat()},
                  fh, indent=2)
    os.replace(tmp, marker)


def _clear_active(state, job_id=None):
    """Remove the active marker (only if it belongs to job_id, when given)."""
    marker = _active_marker(state)
    if job_id is not None:
        cur = _load(marker)
        if cur and cur.get("jobId") not in (job_id, None):
            return
    try:
        os.remove(marker)
    except OSError:
        pass


def _load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _save(path, task):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(task, fh, indent=2)
    os.replace(tmp, path)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    p = argparse.ArgumentParser(prog="agentic-review:next-task",
                                description="Claim the next dropped cross-review task.")
    p.add_argument("--peek", action="store_true", help="list pending tasks without claiming")
    p.add_argument("--done", metavar="ID", help="mark a claimed task complete (removes it)")
    args = p.parse_args(argv)

    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")
    tasks_dir = _tasks_dir(state)

    if args.done:
        path = os.path.join(tasks_dir, args.done + ".json")
        if os.path.isfile(path):
            os.remove(path)
            print("Task %s marked done." % args.done)
        else:
            print("No such task: %s" % args.done)
        # Release the active-job guard so LGTM/commit and new cross-reviews are
        # allowed again once the author has finished addressing.
        _clear_active(state, args.done)
        return

    if not os.path.isdir(tasks_dir):
        print("No pending tasks.")
        sys.exit(NOTHING)

    files = sorted(f for f in os.listdir(tasks_dir) if f.endswith(".json"))
    pending = [(f, _load(os.path.join(tasks_dir, f))) for f in files]
    pending = [(f, t) for f, t in pending if t and t.get("status") == "pending"]

    if args.peek:
        if not pending:
            print("No pending tasks.")
            sys.exit(NOTHING)
        for _f, t in pending:
            print("- %s  %s  (%s)" % (t.get("id"), t.get("action"), t.get("createdAt")))
        return

    if not pending:
        print("No pending tasks.")
        sys.exit(NOTHING)

    fname, task = pending[0]
    path = os.path.join(tasks_dir, fname)
    task["status"] = "in-progress"
    task["claimedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _save(path, task)
    # Mark this author work as the single in-flight job so the bridge blocks a
    # racing commit or a new cross-review until we run --done.
    _set_active(state, "address-all", task.get("id"))

    print("Claimed task %s (action: %s)." % (task.get("id"), task.get("action")))
    print()
    if task.get("action") == "address-all":
        print("Now address ALL open comments:")
        print("  1. python3 skills/agentic-review/scripts/take-feedback.py --json")
        print("  2. For each open / needs-discussion comment: make the code change.")
        print("  3. Reply + resolve each:")
        print("     python3 skills/agentic-review/scripts/reply.py --id <id> "
              "--text \"<what you did>\" --status resolved")
        print("     (set --status needs-discussion if you disagree or need info)")
    print()
    print("When finished, run: python3 skills/agentic-review/scripts/next-task.py "
          "--done %s" % task.get("id"))


if __name__ == "__main__":
    main()
