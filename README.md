# agentic-review

A local, human-in-the-loop review layer for AI-generated code.

AI agents produce more code than a human can comfortably review. `agentic-review`
gives you a fast **local** loop to read, comment on, and feed changes back to the
agent before it continues.

> **Status:** early design. See **[design.md](./design.md)** for the full
> architecture, security model, and open questions.

## How it works

Three pillars:

- **Skill** — teaches AI agents to launch a review, collect feedback, and clean up.
- **Shell** — a static review UI, hosted on GitHub Pages or self-hosted.
- **Local bridge** — a loopback HTTP server that exposes your local files to the
  shell and stores your comments.

The shell talks **only** to the local server on `http://localhost:8900`, which is
the only component with access to your files.

## Skill commands

- `agentic-review:launch [review-comments-folder]` — start the local server.
- `agentic-review:take-feedback` — feed the stored comments back to the agent.
- `agentic-review:cleanup` — shut down the server and remove the temp comments.

## Documentation

- **[design.md](./design.md)** — architecture, security model, supported content,
  comment schema, and the browser-compatibility analysis.
