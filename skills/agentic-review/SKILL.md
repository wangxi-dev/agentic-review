---
name: agentic-review
description: Launch a local, human-in-the-loop review of AI-generated changes. Serves the static review shell and a loopback bridge server, collects reviewer comments, and feeds them back to the agent.
---

# agentic-review (skill — stub)

Minimal placeholder for end-to-end wiring. Commands are not implemented yet.

- `agentic-review:launch [review-comments-folder]` — start the local bridge
  server (`local-server/server.py`) and open the static shell (`site/index.html`)
  pointed at it via `?port=`.
- `agentic-review:take-feedback` — read stored reviewer comments and iterate.
- `agentic-review:cleanup` — stop the server and remove the temp comments.

See `design.md` at the repo root for the full design.
