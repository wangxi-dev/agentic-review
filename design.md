# agentic-review — Design

## Motivation

Agentic coding has a review problem: AI agents generate large volumes of code,
faster than a human can meaningfully review. `agentic-review` adds a lightweight,
**local** review loop so a human can read, comment on, and feed back on changes
before the agent continues.

## Architecture

Three pillars:

- **Skill** — tells AI agents that this tool exists and how to drive it
  (launch, take feedback, clean up).
- **Static page (the "shell")** — the review UI. Hosted on GitHub Pages by
  default (e.g. `https://foo.bar`); users may self-host if they wish. It ships
  no project data — it only renders what the local server provides.
- **Local server (the "bridge")** — a small HTTP server the skill starts on the
  user's machine (e.g. `http://localhost:8900`). It is the only thing the shell
  talks to, and the only component with access to local files.

The user works in the shell. The shell reads file content and writes comments
**exclusively** through `localhost:8900` — that single origin is its entire
backend.

## Security model

- The local server **binds to loopback only** (`127.0.0.1`), never `0.0.0.0`.
- It serves **only files under an explicit root** and rejects path traversal
  (`..`, absolute paths, symlinks that escape the root).
- It restricts CORS to the **known shell origin** (e.g. `https://foo.bar`) via an
  `Origin` allowlist and answers preflight `OPTIONS`. Because the shell is HTTPS
  and the server is `http://localhost`, also send
  `Access-Control-Allow-Private-Network: true` on the preflight to stay
  compatible with Chrome's Private Network Access (see *Does this plan work?*).
- Optionally, a per-session token (printed at launch, sent by the shell) so that
  other local processes or web pages cannot talk to the server.

## Supported content

- **Source code** — syntax-highlighted by file type. Two modes: *diff* (highlights
  the changes, e.g. from `git diff`) and *full* (shows the new file only).
- **Markdown** — automatically formatted, rendering tables/blockquotes/code, and
  sanitized before display. ` ```mermaid ` fenced blocks render as diagrams (strict
  mode, SVG re-sanitized); if a diagram is invalid the source block is kept as-is.
- **JSON** — a collapsible tree viewer (*tree* mode) for navigation, plus the
  usual *full* and *diff* modes. The *diff* mode defaults to an **expanded**
  (pretty-printed) line-oriented diff so minified single-line JSON is reviewable,
  with a toggle back to the raw git diff (falls back automatically when a side
  isn't valid JSON). A purely reformatting change (same data, different
  whitespace) yields an empty expanded diff and is reported as "formatting only".
- **HTML / JS / CSS** — rendered inside a sandboxed `iframe` so the reviewed code
  never runs in the shell's own origin.

Comments can be anchored to a line (or range) in *full* and *diff* modes, or to a
rendered block in markdown *preview* mode, and are shown **inline** next to the
anchored line/block in every mode.

## Local server responsibilities

The server bridges the UI and local resources:

- **List** the files under review (a manifest the shell can render), e.g. the set
  of changed files in the working tree, plus an **all-files tree** of the whole
  repo (git-ignored paths excluded) for browsing beyond the diff.
- **Load** file content (text files only) and, for diff mode, the corresponding
  diff.
- **Save** comments POSTed by the shell into the configured comments store.
- **Stage** a proposed commit message (pre-commit) as a pseudo file change so the
  human can review it before the agent commits.
- **Run checkers** — pluggable code-check CLIs (built-in + user-provided) whose
  JSON findings the shell renders inline and in a summary.
- **Shut down** and clean up on request.

### Work folder

Comments, pre-commit messages, and user checkers live in a git-ignored
`<repo>/.agentic-review/` folder (made self-ignoring via its own `.gitignore`), so
the review's own artifacts never appear as changes to the repo under review.
Cleanup removes the ephemeral `comments/` and `precommit/`, preserving
`checkers/`.

### Checker plugins

A checker is a small CLI run on one file: `checker --describe` returns
`{id,name,description}`; `checker <relpath>` reads the file content on stdin and
prints `{"findings":[{line?,severity,rule,message}]}`. Built-ins cover lines of
code and complexity; users drop their own under `.agentic-review/checkers/`. The
server only executes checkers from the built-in directory and that work folder —
never from the reviewed repo's tracked content — and runs them on demand with a
timeout.

## Skill commands

- `agentic-review:launch [review-comments-folder]` — start the server and tell it
  where to store comments. Prints the URL (and token, if used).
- `agentic-review:take-feedback` — read all stored comments so the agent can loop
  again.
- `agentic-review:cleanup` — shut down the server and delete the temp comments.
  **Remind the user to take a last look first**, and run `take-feedback` before
  cleanup so no feedback is lost.

## UI shell

Calls `localhost` to get the file manifest and content, renders it to the user,
and lets the user leave comments. Comments are stored as files by default.

## Comments

Comments are stored as files by default. Each comment carries enough anchoring to
be actionable: file path, line/range (and which side, in diff mode), the comment
text, and a timestamp/id. Comments can be **edited and deleted** from the shell
(`PUT`/`DELETE /api/comments?id=…`), and the inline thread, side panel, and the
agent's `take-feedback` view all reflect the current state.

The store must be **pluggable behind a generic interface** (list / save / update /
delete) so users can swap files for another channel (e.g. GitHub issues, or any
other storage) — as long as the user's agent can still read the comments back.

## Does this plan work?

Mostly yes — it is buildable. The main things to design around:

- **Browser compatibility (the key risk).** An HTTPS shell calling
  `http://localhost` works today in Chrome, Firefox, and Safari thanks to the
  loopback exception. However, Chrome's Private Network Access may require the
  preflight headers listed under *Security model*, and Google notes the localhost
  exception is "subject to review." Mitigations: ship the CORS + PNA headers;
  document supported browsers; or, as a fallback, let the **local server also
  serve the shell** (same-origin `http://localhost:8900`), which avoids
  mixed-content / PNA entirely — at the cost of the UI no longer auto-updating
  from GitHub Pages.
- **Discovering the change set.** `launch` currently only takes a comments folder,
  but the server also needs to know *what* is under review (repo root / diff
  base). Consider adding that argument.
- **Cleanup ordering.** `cleanup` deletes comments, so it must run *after*
  `take-feedback`; the reminder in the command enforces this.
