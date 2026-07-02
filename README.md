# agentic-review

A local, human-in-the-loop review layer for AI-generated code.

AI agents produce more code than a human can comfortably review. `agentic-review`
gives you a fast **local** loop to read, comment on, and feed changes back to the
agent before it continues.

> **Status:** working. Bridge server, review shell, and the three skill commands
> are implemented and tested. See **[design.md](./docs/design.md)** for the full
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
- `agentic-review:take-feedback` — feed the stored comment threads back to the agent.
- `agentic-review:reply` — reply to a comment / set its status (resolve, reject, discuss).
- `agentic-review:cleanup` — shut down the server and remove the temp comments.

## Quick start

```bash
# from the repo you want to review:
python3 path/to/agentic-review/skills/agentic-review/scripts/launch.py
# open the printed URL, e.g. http://127.0.0.1:8900/review.html  (token auto-injected)
# review and comment, then:
python3 .../scripts/take-feedback.py        # read comment threads back
python3 .../scripts/reply.py --id <id> --text "done" --status resolved  # reply + resolve
python3 .../scripts/cleanup.py --force      # tear down
```

Or run the bridge directly:

```bash
python3 local-server/server.py --root /path/to/repo --port 8900
# same-origin review shell: http://127.0.0.1:8900/review.html
# overview + setup guide:   http://127.0.0.1:8900/
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
# open http://127.0.0.1:8900/review.html  and browse examples/:
#   code files  -> full / diff (syntax highlighting, click a line to comment)
#   sample.md   -> preview (click a block to comment; renders Mermaid), full, diff
#   sample.html -> preview (sandboxed iframe; scripts blocked by default, with an
#                  opt-in "⚠ Run scripts" toggle), full, diff
#   sample.json  -> tree (collapsible JSON navigator), full, diff
#   oneline.json -> a minified one-liner: the raw diff is one unreadable line,
#                   while the default *expanded* diff pretty-prints both sides
#                   into a clean, line-oriented diff. (A purely reformatting
#                   change — same data, different whitespace — is detected and
#                   reported as "formatting only" rather than a misleading
#                   "unchanged".)
```

Comments anchored to a line/block render **inline** in full, diff, and preview
modes.

## Browsing all files

The shell's file panel has two tabs: **Changed** (the diff set) and **All
files**. "All files" shows the whole repo as a collapsible tree (built from
`git ls-files` + untracked-but-not-ignored, so `.gitignore`'d paths — build
output, the `.agentic-review/` work folder, secrets — are excluded). The top two
levels expand by default; deeper folders expand on click. Any file can be opened,
read, checked, and commented on, even if it isn't part of the diff.

## Proposing a commit message (pre-commit)

Before committing, the agent can stage a **proposed commit message** so the human
reviews it like a change:

```bash
python3 skills/agentic-review/scripts/precommit.py --message "feat: ..."
```

It is written to `<repo>/.agentic-review/precommit/commit-message.md` and appears
as a pseudo entry at the top of the file list (rendered as Markdown, commentable).
Run `take-feedback`, revise, then commit.

## Checks (pluggable code checkers)

The shell can run code **checkers** on the open file ("Run checks" in the viewer
header; pick which checkers from the ▾ menu). Findings show inline on the
offending lines and in a summary, by severity.

Built-in checkers:

- **Lines of code** — flags files over **800 lines** and lines over **250
  characters**.
- **Code complexity** — flags **nesting deeper than 4** and functions with **more
  than 4 parameters** (heuristic).

### Writing your own checker

> Full contract, a copy-paste minimal example, and the built-in thresholds live in
> **[local-server/checkers/README.md](./local-server/checkers/README.md)**. The
> short version:

Drop an executable CLI into `<repo>/.agentic-review/checkers/` (a `.py`, `.js`,
`.sh`, or executable file). The bridge runs only checkers from this folder and the
built-in one — never from the repo's tracked content. A checker must support:

```text
checker --describe        # prints {"id","name","description"} as JSON
checker <relative-path>   # reads the file CONTENT on stdin, prints findings JSON
```

Findings format (stdout):

```json
{ "findings": [
  { "line": 12, "severity": "warning", "rule": "max-line-length", "message": "Line is 312 chars (> 250)" },
  { "severity": "error", "rule": "max-file-loc", "message": "File has 950 lines (> 800)" }
] }
```

`line` is optional (omit for a file-level finding); `severity` is `error`,
`warning`, or `info`. Thresholds for the built-ins are overridable via env vars
(`AR_LOC_MAX_FILE`, `AR_LOC_MAX_LINE`, `AR_CX_MAX_NESTING`, `AR_CX_MAX_PARAMS`).

> **Security:** checkers are executables run on your machine on demand. Only place
> checkers you trust in `.agentic-review/checkers/`. That folder is git-ignored
> and not populated by cloning a repo, so a reviewed repo cannot inject checkers.


## Layout

```text
local-server/server.py        # loopback bridge: slim entry/orchestrator (parse args, start server)
local-server/ar_core.py       #   constants, classification, Config, git helpers
local-server/ar_manifest.py   #   change manifest, pre-commit pseudo files, all-files tree
local-server/ar_content.py    #   file content + diffs (incl. expanded pretty JSON diff)
local-server/ar_checkers.py   #   pluggable checker plugins
local-server/ar_comments.py   #   comment stores (files + GitHub issue) + validation
local-server/ar_http.py       #   HTTP handler (CORS/PNA, token, routing, static shell)
local-server/checkers/        # built-in checker CLIs (loc.py, complexity.py)
local-server/test_server.py   # unit + end-to-end tests
site/                         # static site: index.html (overview), guideline.html (setup),
                              #   review.html (review shell), app.js + js/ modules, styles.css
skills/agentic-review/        # SKILL.md + scripts/ (launch, precommit, take-feedback, reply, cleanup)
examples/                     # sample files, one per renderer
```

## Deploying the shell

The shell is fully static. Two ways to serve it:

1. **Same-origin (default, zero-config).** The bridge serves `site/` itself, so the
   review shell is at `http://127.0.0.1:<port>/review.html` (and the overview +
   setup guide at `http://127.0.0.1:<port>/`). There is no cross-origin call at all,
   and the bridge **injects the session token** into the shell page, so just the
   port is needed — no `?token=` to copy.
2. **GitHub Pages.** The site is published at
   **https://wangxi-dev.github.io/agentic-review/** (via
   `.github/workflows/static.yml`, source = "GitHub Actions") with the review shell
   at **/review.html**. The bridge **always allows** this origin, so just open
   `https://wangxi-dev.github.io/agentic-review/review.html?api=http://localhost:<port>&token=…`
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

- **[design.md](./docs/design.md)** — architecture, security model, supported content,
  comment schema, and the browser-compatibility analysis.
- **[next-step.md](./docs/next-step.md)** — remaining ideas and backlog.

