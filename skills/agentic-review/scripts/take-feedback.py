#!/usr/bin/env python3
"""agentic-review:take-feedback

Read the stored reviewer comments from the active session as **threads** - each
with its replies and lifecycle status - so the agent can work the live set and
reply back.

By default only comments awaiting the agent are shown: status `open` or
`needs-discussion`. Resolved / rejected / wont-fix threads are hidden unless you
pass --all.

  --all    include resolved / rejected / wont-fix threads too
  --json   emit the raw comment objects instead of the readable summary

After addressing a comment, reply and (optionally) set its status with
`agentic-review:reply --id <id> --text "..." [--status resolved]`.
"""
import json
import sys

import common as C

# Statuses the agent still needs to act on (shown by default).
LIVE_STATUSES = ("open", "needs-discussion")


def anchor(c):
    if c.get("range"):
        return "L%s-%s" % (c["range"]["start"], c["range"]["end"])
    if c.get("line") is not None:
        return "L%s" % c["line"]
    return "file"


def sort_key(c):
    if c.get("range"):
        return c["range"]["start"]
    return c["line"] if c.get("line") is not None else -1


def status_of(c):
    return c.get("status") or "open"


def last_author(c):
    replies = c.get("replies") or []
    if replies:
        return replies[-1].get("author")
    return c.get("author") or "human"


def whose_turn(c):
    """Heuristic: if the human spoke last on an unsettled thread it's the
    agent's turn; if the agent spoke last and it's still open we're waiting on
    the human."""
    if status_of(c) not in LIVE_STATUSES:
        return None
    return "human" if last_author(c) == "agent" else "agent"


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    show_all = "--all" in argv
    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")

    data = C.api_get(state, "/api/comments")
    comments = data.get("comments", [])

    if "--json" in argv:
        if not show_all:
            comments = [c for c in comments if status_of(c) in LIVE_STATUSES]
        print(json.dumps(comments, indent=2))
        return

    shown = comments if show_all else [c for c in comments if status_of(c) in LIVE_STATUSES]

    if not comments:
        print("No reviewer comments yet.")
        return
    if not shown:
        print("No open comments. (%d settled comment%s hidden; use --all to see them.)"
              % (len(comments), "" if len(comments) == 1 else "s"))
        return

    by_file = {}
    for c in shown:
        by_file.setdefault(c.get("path", "(unknown)"), []).append(c)

    n = len(shown)
    hidden = len(comments) - n
    header = "# Reviewer feedback (%d %scomment%s)" % (
        n, "" if show_all else "open ", "" if n == 1 else "s")
    print(header + "\n")
    for path in sorted(by_file):
        print("## %s" % path)
        for c in sorted(by_file[path], key=sort_key):
            _print_comment(c)
        print()
    if hidden and not show_all:
        print("(%d settled comment%s hidden; use --all to include them.)\n"
              % (hidden, "" if hidden == 1 else "s"))
    print("Address each open comment in the code. Then reply with "
          "'agentic-review:reply --id <id> --text \"...\" [--status resolved|rejected|"
          "needs-discussion]'. Re-run take-feedback before cleanup to confirm "
          "nothing is missed.")


def _print_comment(c):
    side = (" %s" % c["side"]) if c.get("side") else ""
    who = (" - %s" % c["author"]) if c.get("author") else ""
    text = (c.get("text") or "").strip()
    print("- [%s%s] (%s)%s id=%s" % (anchor(c), side, status_of(c), who, c.get("id")))
    print("  %s" % text)
    for r in (c.get("replies") or []):
        rtext = (r.get("text") or "").strip()
        print("    >> %s: %s" % (r.get("author") or "?", rtext))
    turn = whose_turn(c)
    if turn == "agent":
        print("  * your turn (reply / resolve this).")
    elif turn == "human":
        print("  * waiting on the human.")


if __name__ == "__main__":
    main()
