#!/usr/bin/env python3
"""agentic-review:precommit

Stage a proposed commit message into the active review as a "pseudo file change"
so the reviewer can read and comment on it before the agent actually commits.

The message is written to <work-dir>/precommit/commit-message.md and shows up at
the top of the review's file list.

Usage:
  python3 precommit.py --message "feat: ..."     # inline
  python3 precommit.py --file MSG.txt            # from a file
  echo "..." | python3 precommit.py              # from stdin
  python3 precommit.py --show                    # print the current message
"""
import argparse
import sys

import common as C


def main(argv=None):
    parser = argparse.ArgumentParser(prog="agentic-review:precommit")
    parser.add_argument("--message", "-m", help="the commit message text")
    parser.add_argument("--file", "-f", help="read the message from this file")
    parser.add_argument("--name", default="commit-message.md",
                        help="file name under precommit/ (default: commit-message.md)")
    parser.add_argument("--show", action="store_true",
                        help="print the current pre-commit message and exit")
    args = parser.parse_args(argv)

    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")

    if args.show:
        man = C.api_get(state, "/api/manifest")
        pre = [f for f in man.get("files", []) if f.get("status") == "precommit"]
        if not pre:
            print("(no pre-commit message set)")
            return
        for f in pre:
            content = C.api_get(state, "/api/content?path=" + _q(f["path"]))
            print("# %s\n" % f["path"])
            print(content.get("content", ""))
        return

    if args.message is not None:
        message = args.message
    elif args.file:
        with open(args.file, "r", encoding="utf-8") as fh:
            message = fh.read()
    elif not sys.stdin.isatty():
        message = sys.stdin.read()
    else:
        C.die("provide the message via --message, --file, or stdin.")

    if not message.strip():
        C.die("refusing to write an empty commit message.")

    res = C.api_post(state, "/api/precommit", {"message": message, "name": args.name})
    print("agentic-review: proposed commit message staged for review.")
    print("  path: %s" % res.get("path"))
    print("Ask the reviewer to open it (top of the file list) and comment, then "
          "run 'agentic-review:take-feedback' before committing.")


def _q(s):
    from urllib.parse import quote
    return quote(s, safe="")


if __name__ == "__main__":
    main()
