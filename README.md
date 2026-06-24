# agentic-review

A local, human-in-the-loop review layer for AI-generated code.

AI agents produce more code than a human can comfortably review. `agentic-review`
gives you a fast **local** loop to read, comment on, and feed changes back to the
agent before it continues.

> **Status:** working. Bridge server, review shell, and the three skill commands
> are implemented and tested. See **[design.md](./design.md)** for the full
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

The skill commands are plain Python (stdlib only) so they run the same on
Windows, macOS, and Linux. Use your platform's Python 3 (`python3`, `python`, or
`py -3`).

- `agentic-review:launch [review-comments-folder]` — start the local server.
- `agentic-review:take-feedback` — feed the stored comments back to the agent.
- `agentic-review:cleanup` — shut down the server and remove the temp comments.

## Quick start

```bash
# from the repo you want to review:
python3 path/to/agentic-review/skills/agentic-review/scripts/launch.py
# open the printed URL, e.g. http://127.0.0.1:8900/?token=...
# review and comment, then:
python3 .../scripts/take-feedback.py        # read comments back
python3 .../scripts/cleanup.py --force      # tear down
```

Or run the bridge directly:

```bash
python3 local-server/server.py --root /path/to/repo --port 8900
# same-origin shell: http://127.0.0.1:8900/
```

Requirements: Python 3.8+ and `git` on `PATH`. No third-party packages for the
server or skill; the shell loads highlight.js / marked / DOMPurify / diff2html
from a CDN.

### What counts as "under review" (the diff base)

By default the review shows **uncommitted changes** (working tree vs `HEAD`), so
once a change is committed it drops out of the review — the shell auto-refreshes
and tells you when that happens. To review **committed** history instead, set the
diff base to an earlier ref:

```bash
AR_DIFF_BASE=HEAD~1 python3 .../scripts/launch.py     # review the last commit
python3 local-server/server.py --root . --diff-base main --port 8900  # vs main
```

## Tests

```bash
python3 local-server/test_server.py     # stdlib unittest: unit + end-to-end
```

### Trying the renderers (example files)

`examples/` contains one file per supported renderer (`.py .js .cs .cpp .java
.html .md .json`). The manifest only lists files that **changed** vs the diff
base, so point the diff base at the empty tree to make every tracked file show up
as "added":

```bash
# from the repo root
python3 local-server/server.py --root "$PWD" \
  --diff-base "$(git hash-object -t tree /dev/null)" --port 8900
# open http://127.0.0.1:8900/  and browse examples/:
#   code files  -> full / diff (syntax highlighting, click a line to comment)
#   sample.md   -> preview (click a block to comment), full, diff
#   sample.html -> preview (sandboxed iframe; scripts blocked), full, diff
#   sample.json -> tree (collapsible JSON navigator), full, diff
```

Comments anchored to a line/block render **inline** in full, diff, and preview
modes.

## Layout

```text
local-server/server.py        # loopback bridge (manifest/content/diff/comments)
local-server/test_server.py   # unit + end-to-end tests
site/                         # static review shell (index.html, app.js, styles.css)
skills/agentic-review/        # SKILL.md + scripts/ (launch, take-feedback, cleanup)
examples/                     # sample files, one per renderer
```

## Deploying the shell

The shell is fully static. Two ways to serve it:

1. **Same-origin (default, zero-config).** The bridge serves `site/` itself at
   `http://127.0.0.1:<port>/`, so there is no cross-origin call at all.
2. **GitHub Pages.** The shell is published at
   **https://wangxi-dev.github.io/agentic-review/** (via
   `.github/workflows/static.yml`, source = "GitHub Actions"). The bridge
   **always allows** this origin, so just open
   `https://wangxi-dev.github.io/agentic-review/?api=http://localhost:<port>&token=…`
   — `agentic-review:launch` prints this link for you. The bridge sends
   `Access-Control-Allow-Private-Network: true` on preflights for Chrome's
   Private Network Access.

For any *other* static host, launch the bridge with
`AR_PAGES_ORIGIN=https://your.host` to add that origin to the CORS allowlist (and
`AR_PAGES_URL=https://your.host/path/` to make `launch` print its link).

## Browser support

An HTTPS Pages shell calling `http://localhost` works in current Chrome, Firefox,
and Safari via the loopback exception. Chrome may require the Private Network
Access preflight headers (sent by the bridge). If a browser blocks the localhost
call, use the same-origin option above.

## Documentation

- **[design.md](./design.md)** — architecture, security model, supported content,
  comment schema, and the browser-compatibility analysis.
- **[next-step.md](./next-step.md)** — remaining ideas and backlog.

