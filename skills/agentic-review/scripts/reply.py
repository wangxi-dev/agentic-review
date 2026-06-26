#!/usr/bin/env python3
"""agentic-review:reply

Reply to a reviewer comment as the **agent**, and/or set its lifecycle status,
so the review becomes a two-way conversation instead of a one-way note dump.

  reply.py --id <comment-id> --text "done in <commit>"
  reply.py --id <comment-id> --text "can you clarify the edge case?" --status needs-discussion
  reply.py --id <comment-id> --status resolved          # status only, no reply
  printf "%s" "$LONG_REPLY" | reply.py --id <comment-id> # text from stdin

Flags:
  --id      the comment id to reply to (from take-feedback --json)   [required]
  --text    the reply body (or pipe it on stdin)
  --status  set the thread status: open | resolved | rejected | wont-fix |
            needs-discussion. Lets the agent resolve, reject, or flag a comment
            for discussion. The human can always override it in the shell.

Give at least one of --text or --status.
"""
import argparse
import sys

import common as C

STATUSES = ("open", "resolved", "rejected", "wont-fix", "needs-discussion")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    p = argparse.ArgumentParser(prog="agentic-review:reply", add_help=True,
                                description="Reply to a review comment as the agent and/or set its status.")
    p.add_argument("--id", required=True, help="comment id to reply to")
    p.add_argument("--text", help="reply text (or pipe on stdin)")
    p.add_argument("--status", choices=STATUSES, help="set the thread status")
    args = p.parse_args(argv)

    text = args.text
    if text is None and not sys.stdin.isatty():
        piped = sys.stdin.read().strip()
        if piped:
            text = piped
    if not text and not args.status:
        C.die("give at least one of --text or --status.")

    state = C.load_state()
    if not state:
        C.die("no active session (run 'agentic-review:launch' first).")

    cid = args.id
    if text and text.strip():
        C.api_post(state, "/api/comments/reply?id=" + _q(cid),
                   {"author": "agent", "text": text.strip()})
        print("Replied to %s." % cid)
    if args.status:
        C.api_send(state, "PATCH", "/api/comments?id=" + _q(cid),
                   {"status": args.status})
        print("Status of %s set to '%s'." % (cid, args.status))


def _q(value):
    from urllib.parse import quote
    return quote(value, safe="")


if __name__ == "__main__":
    main()
