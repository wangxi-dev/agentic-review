# agentic-review — next steps

The core tool is built and tested (bridge server, review shell, skill commands,
file + GitHub comment stores, tests). This file tracks the remaining ideas, most
of them from reviewer feedback. Pick up any item independently.

## How to resume

- Repo root: `~/agentic-review`. Run the bridge with
  `python3 local-server/server.py --root <repo> --port 8900`. The review shell is
  at `http://127.0.0.1:8900/review.html` (the bridge injects the session token, so
  the port is all you need); the overview + setup guide are at
  `http://127.0.0.1:8900/`.
- Tests: `python3 local-server/test_server.py` (stdlib unittest).
- Browser smoke tests live outside the repo (Playwright in Docker); re-create as
  needed. Don't commit/push unless explicitly asked.

## Backlog (from reviewer feedback)

### 1. JSON: expanded / pretty diff — ✅ done
Implemented: `GET /api/diff?path=…&pretty=1`. For JSON-renderer files the server
loads the old side (from the diff base via `git show <base>:<path>`, empty for
added files) and the new side (working tree, empty for deleted), pretty-prints
both with `json.dumps(indent=2)` (stable key order), and emits a line-oriented
`difflib` unified diff with a `diff --git` header so diff2html renders it. Guards
fall back to the raw git diff (response omits `pretty:true`) when either side is
invalid JSON, binary, or larger than `MAX_CONTENT_BYTES`. A purely reformatting
change (same data, different whitespace, e.g. minified) yields an empty expanded
diff and is flagged `formattingOnly` so the shell explains it instead of
misreporting "unchanged". The shell defaults the JSON diff to the expanded view
and shows an "Expanded JSON diff · show raw" toggle (`site/js/viewer.js`
`renderDiff`/`jsonDiffToggle`); a note appears when the server fell back or when
only formatting differs. See `_json_pretty_diff` / `_pretty_json_text` in
`local-server/ar_content.py` and the tests in `local-server/test_server.py`.

### 2. Markdown: render Mermaid diagrams — ✅ done
Implemented: ` ```mermaid ` fences render as diagrams in the markdown preview
pane (pinned `mermaid@10.9.1`, `securityLevel: "strict"`, `htmlLabels: false`);
the produced SVG is re-sanitized with DOMPurify's SVG profile before insertion.
Invalid diagrams keep their source block with an inert error note; if mermaid
isn't loaded the fence is left as-is. Preview pane only. See `site/js/mermaid.js`.

### 3. HTML preview: optional script execution
Reviewers noted a fully script-blocked iframe makes interactive pages look broken.
Add an explicit, per-file opt-in to run scripts.
- Sketch: keep the default `sandbox=""` (no scripts). Add a "⚠ Run scripts"
  toggle in the html preview header that switches the iframe to
  `sandbox="allow-scripts"` (NOT `allow-same-origin`, so the reviewed page still
  cannot reach the shell's origin, cookies, or the bridge token). Re-create the
  iframe on toggle. Make the risk explicit in the UI copy.
- Note: never combine `allow-scripts` with `allow-same-origin` for reviewed code.

### 4. Checks as repo-level gates (CI-style) — partially done
Reviewer wants checkers to behave like CI gates, not just per-file lint.
**Done so far:** `GET /api/check-all` runs the selected per-file checkers across
every changed file; the shell's checks ▾ menu has "Run on all changed files" with
a consolidated, click-through report. Built-ins `loc` and `complexity` stay
per-file.
**Still to do:**

**Decided in the latest review (still to build):** findings → comments via an
explicit **button** (not auto-posted); the approve/whitelist gate uses **both** a
UI action and a persisted whitelist file; repo-scoped **build/test command checks
are deferred** — do LoC/complexity across changed files first.

- **Repo-scoped checkers** (e.g. `build pass`, `test pass`) — *deferred for now.*
  Extend the checker contract with a `scope` in `--describe`: `"file"` (current;
  content on stdin) vs `"repo"` (run once for the whole repo, no stdin; receives
  the repo root and the list of changed paths as args/JSON). The server runs
  repo-scoped checkers once in check-all and shows a single pass/fail row. Ship
  example `build`/`test` checkers under `examples/checkers/` that shell out to the
  project's build/test.
- **Findings → comments** *(button, decided).* Add a "file as comment" action on a
  finding (and a bulk "file all") that POSTs `/api/comments` anchored to the
  path/line, so a violation becomes a tracked review comment the agent reads back
  via `take-feedback`. The human clicks to file — findings are not auto-posted.
  Guard against duplicates (dedupe by rule+path+line).
- **Whitelist / manual approval** *(both UI + file, decided).* Offer "approve /
  whitelist" on a finding in the shell, persisting to a whitelist file keyed by a
  stable fingerprint (checker id + rule + path + a content hash of the offending
  line, so it survives line moves). The server filters whitelisted findings out of
  check-all (or marks them "approved"); add a view of the whitelist. Decide
  granularity (per-line vs per-rule-per-file) and whether the whitelist is committed
  (shared) or git-ignored (local) — likely committed so the gate is shared, which
  means it should live OUTSIDE the git-ignored work folder (e.g.
  `.agentic-review-allow.json` at repo root).

### 5. Optional token-free local mode (tighten CORS instead)
Today the security model is: `launch.py` always sets a per-session **token** but
sets **no** `--allow-origin`, so the bridge runs in **dev-echo CORS** (`server.py`
`_cors_origin` echoes any Origin when `strict_origin` is false). That means any
website open in the browser could hit `http://localhost:<port>/api/...`; the token
(checked in `_check_token`, sent by the shell as the `X-AR-Token` header, or
injected as `<meta name="ar-token">` for the same-origin shell) is what makes that
safe. So `port`/`api` only *locate* the bridge; the **token authorizes** it.
- Idea: offer a mode where the token is optional and security comes from a **strict
  CORS allowlist** instead — restrict to `http://localhost:<port>` +
  `http://127.0.0.1:<port>` (and the same-origin no-Origin case) and **drop
  dev-echo by default**. Cross-origin reads are then blocked by the browser, and
  state-changing calls (JSON body) are blocked by preflight, so a loopback-only
  same-origin session needs no token at all — truly "just the port".
- Trade-off: the always-allowed GitHub Pages origin (and any `AR_PAGES_ORIGIN`)
  still needs the token, because that path is intentionally cross-origin. So keep
  the token for the hosted shell; make it optional only for the same-origin path.
- Sketch: add `--no-token` (or default the same-origin flow to token-less) and
  flip the default origin policy to strict (allowlist localhost + same-origin),
  with dev-echo behind an explicit `--allow-origin '*'` / `AR_DEV_ECHO=1` opt-in.
  Update `launch.py` to stop minting a token unless a pages origin is configured.
- `local-server/server.py` and `site/app.js` had both grown past the project's
  own 800-LoC checker. **Both are now split (✅).** `app.js` is the slim entry
  over ES modules under `site/js/` (`core`, `manifest`, `viewer`, `comments`,
  `checks`, `mermaid`). `server.py` is now the slim entry/orchestrator over
  sibling modules `ar_core` (constants/Config/git), `ar_manifest`
  (manifest/tree/precommit), `ar_content` (content + diffs incl. expanded JSON),
  `ar_checkers`, `ar_comments` (stores + validation), and `ar_http` (the
  handler); `server.py` re-exports their public names so `import server` is
  unchanged. Each file is under the 800-LoC limit (largest is `ar_comments` at
  270).

### 6. Threaded comment conversations (human ↔ agent) — ✅ done
Implemented. A comment is now a small **thread** with a lifecycle, so the human
and the agent take turns on it instead of the comment being a one-way note.
- **Schema.** Every comment carries `status` (default `open`) and `replies: []`.
  Each reply is `{id, author ("human"|"agent"), text, createdAt}`. Old comments
  with neither field behave as an `open` thread with no replies (backward-compat;
  readers use `c.get("status") or "open"` / `c.get("replies") or []`).
- **API.** `POST /api/comments/reply?id=…` appends a reply (validated `author`,
  non-empty `text`); `PATCH /api/comments?id=…` sets the status to one of
  `open` / `resolved` / `rejected` / `wont-fix` / `needs-discussion`. Both the
  files store and the GitHub-issue store implement `add_reply` / `set_status`
  (the GitHub backend re-renders the hidden JSON payload, so replies+status
  round-trip through the issue comment). See `ar_comments.py` (`make_reply`,
  `validate_status`, store `_mutate`) and `ar_http.py` (do_PATCH + routes).
- **take-feedback semantics.** Returns the full thread + status and by default
  surfaces only `open` / `needs-discussion` comments (the live set); `--all`
  includes settled ones. It prints a "whose turn" hint from the last author
  (human spoke last on a live thread ⇒ agent's turn; agent spoke last ⇒ waiting
  on the human). New `agentic-review:reply` command lets the agent reply and/or
  set status from the CLI (`--id`, `--text`/stdin, `--status`).
- **UI.** The inline thread renders replies (human vs agent styled distinctly), a
  per-comment status chip that doubles as the human's status selector, and a
  reply box. See `site/js/comments.js` + `site/styles.css`.

### 7. Session-level automated check suite (specify at launch, show status per review)
Reviewer wants to declare **which automated checks to run** when starting a
session (e.g. `build`, `ut`/unit tests, `code analysis`, lint), have the bridge
run them, and surface each check's **execution result on every review** — plus a
clear top-level indicator of **whether and when all the automated checks have
run** (and passed/failed).

- **Specify at launch.** Let `launch` (or a config file / env, e.g.
  `AR_CHECKS=build,ut,analyze` or a `checks:` list in the user-level config) name
  the check suite for the session. Each named check maps to a repo-scoped command
  (reuse the deferred `scope:"repo"` checker contract from item 4 — run once for
  the whole repo, no stdin, receives the repo root + changed paths).
- **Run + record results.** The bridge runs the suite (on demand and/or after a
  change), persisting each check's status (`pending`/`running`/`pass`/`fail`),
  exit summary, duration, and the commit/diff it ran against.
- **Show on every review.** The shell renders a **check-status banner** (e.g.
  "3/3 checks passed · build ✓ ut ✓ analyze ✓ · ran 2m ago against <sha>") visible
  on each file/review, so the human sees at a glance if all automated checks have
  executed and whether they're green — and is warned when results are stale
  (the working tree changed since the checks last ran).
- Builds on item 4 (repo-scoped checkers, findings→comments); the new part is the
  **session-declared suite** + the **always-visible run/status summary**.

### 8. Surface cross-review task claim/progress in the shell
Today when the human clicks **Address all**, the portal only shows the "task
queued" POST response. The author agent's poll (`next-task.py`) already flips the
task file to `status:"in-progress"` + `claimedAt` (and the file is removed on
`--done`), so the state exists on disk — the shell just doesn't read it. Reviewer
couldn't tell whether the agent had picked up the task.

- **Expose task state.** Add `GET /api/task` (latest task: `pending` /
  `in-progress` / done-absent, plus `createdAt`/`claimedAt`). State stays in the
  task file; the endpoint only lets the browser read it.
- **Show a banner.** In the shell, render an "Address all" status chip:
  `queued -> agent working (claimed 12s ago) -> done`, and clear it when the task
  file is gone. Poll it alongside the existing comment refresh.
- **Also persist comments by default across restarts.** Loading a server-side
  code fix needs a bridge restart, which currently **deletes temp comments** on
  relaunch (`commentsIsTemp`). Either warn loudly, or make `launch` default to a
  persistent (git-ignored) comments folder so a restart never drops the human's
  in-flight review. (Lost a live review this way during testing.)

## Smaller follow-ups

- Comment edit currently only edits text; consider re-anchoring (move a comment to
  a different line) if needed.
- `examples/` is a handy manual test corpus; consider a one-command launcher that
  serves it with the empty-tree diff base (see README "Trying the renderers").
- Cross-browser: verify the GitHub Pages → `http://localhost` path in Chrome
  (Private Network Access), Firefox, and Safari once Pages is enabled (Phase 6).

## Done so far (for context)

- Bridge endpoints: manifest / content / diff / comments (GET/POST/PUT/DELETE) /
  cleanup; loopback-only; path-confined; token + Origin allowlist; PNA preflight.
- Shell: file list, code (full/diff), markdown preview with block anchoring,
  sandboxed HTML, JSON tree viewer; inline comment threads in every mode with
  edit/delete; responsive layout.
- Skill: `launch` / `take-feedback` / `cleanup` (cross-platform Python).
- Comment stores: files (default) + GitHub issue (reference), both with
  list/save/update/delete.
- Markdown preview renders Mermaid diagrams (strict mode, SVG re-sanitized;
  `site/js/mermaid.js`).
- JSON diffs default to an expanded (pretty-printed) line-oriented diff
  (`/api/diff?…&pretty=1`) with a raw-diff toggle and graceful fallback; a
  purely reformatting change (same data, different whitespace) is reported as
  "formatting only" instead of a misleading "unchanged".
- Shell split into ES modules under `site/js/` (core / manifest / viewer /
  comments / checks / mermaid); `site/app.js` is the slim entry. Each file is
  under the project's 800-LoC checker.
- Bridge split into modules under `local-server/` (`ar_core` / `ar_manifest` /
  `ar_content` / `ar_checkers` / `ar_comments` / `ar_http`); `server.py` is the
  slim entry/orchestrator that re-exports their public API. Each file is under
  the 800-LoC checker.
- Threaded comments (human ↔ agent): each comment has a `status`
  (open/resolved/rejected/wont-fix/needs-discussion) and a `replies[]` thread.
  `POST /api/comments/reply?id=…` + `PATCH /api/comments?id=…`; both stores
  support it; new `agentic-review:reply` CLI; `take-feedback` shows threads,
  status, and whose turn (default = open/needs-discussion, `--all` for settled).
- Orphaned comments stay reachable: the shell lists comments whose anchor file
  is no longer in the change set (e.g. deleted) under a "files no longer in the
  review" section, and shows the preserved thread when opened
  (`site/js/manifest.js` `orphanCommentPaths`/`renderOrphanRows`, `viewer.js`
  orphan branch).
- Tests: 77 unittest cases green.
