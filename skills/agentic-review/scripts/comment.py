#!/usr/bin/env python3
"""agentic-review:comment

File a review comment from the CLI, anchored to a file (and optionally a line or
side). Used by a spawned **reviewer** agent during a cross-review, but usable by
any agent. The comment's author identity (role / agent / model / label) is read
from the environment so the shell can show WHO left it:

  AR_ROLE   human | author-agent | review-agent   (default: review-agent)
  AR_AGENT  the tool, e.g. copilot / claude
  AR_MODEL  the model, e.g. gpt-5 / opus-4.8
  AR_LABEL  explicit display label (overrides the derived one)

  comment.py --path src/app.py --line 42 --text "off-by-one here"
  comment.py --path README.md --text "file-level note"            # no --line
  printf "%s" "$LONG" | comment.py --path src/app.py --line 9     # text on stdin
"""
import argparse
import os
import sys

import common as C


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    p = argparse.ArgumentParser(
        prog="agentic-review:comment",
        description="File a review comment (with author identity) from the CLI.")
    p.add_argument("--path", required=True, help="repo-relative file path to anchor to")
    p.add_argument("--line", type=int, help="1-based line number (omit for a file-level comment)")
    p.add_argument("--side", choices=("old", "new"), help="diff side (default: new)")
    p.add_argument("--text", help="comment text (or pipe it on stdin)")
    args = p.parse_args(argv)

    text = args.text
    if text is None and not sys.stdin.isatty():
        piped = sys.stdin.read().strip()
        if piped:
            text = piped
    if not text or not text.strip():
        C.die("comment requires --text (or text on stdin).")

    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")

    body = {"path": args.path, "line": args.line, "side": args.side,
            "text": text.strip()}
    _stamp_identity(body, default_role="review-agent")

    res = C.api_post(state, "/api/comments", body)
    where = args.path + (":%d" % args.line if args.line else "")
    print("Filed comment on %s (id=%s)." % (where, res.get("id")))


def _stamp_identity(body, default_role):
    role = os.environ.get("AR_ROLE") or default_role
    body["authorRole"] = role
    for env_key, field in (("AR_AGENT", "agent"), ("AR_MODEL", "model"),
                           ("AR_LABEL", "label")):
        val = os.environ.get(env_key)
        if val:
            body[field] = val


if __name__ == "__main__":
    main()
