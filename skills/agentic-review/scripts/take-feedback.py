#!/usr/bin/env python3
"""agentic-review:take-feedback

Read every stored reviewer comment from the active session and print them
grouped by file and ordered by line, so the agent can address them in another
iteration.

  --json   emit the raw comments JSON instead of the readable summary
"""
import json
import sys

import common as C


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


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")

    data = C.api_get(state, "/api/comments")
    comments = data.get("comments", [])

    if "--json" in argv:
        print(json.dumps(comments, indent=2))
        return

    if not comments:
        print("No reviewer comments yet.")
        return

    by_file = {}
    for c in comments:
        by_file.setdefault(c.get("path", "(unknown)"), []).append(c)

    n = len(comments)
    print("# Reviewer feedback (%d comment%s)\n" % (n, "" if n == 1 else "s"))
    for path in sorted(by_file):
        print("## %s" % path)
        for c in sorted(by_file[path], key=sort_key):
            side = (" %s" % c["side"]) if c.get("side") else ""
            who = (" — %s" % c["author"]) if c.get("author") else ""
            text = (c.get("text") or "").strip()
            print("- [%s%s]%s %s" % (anchor(c), side, who, text))
        print()
    print("Address these comments, then re-run the review (take-feedback again) "
          "before cleanup to confirm nothing is missed.")


if __name__ == "__main__":
    main()
