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

### 1. JSON: expanded / pretty diff
Huge single-line JSON files are unreadable in a raw `git diff`. Pretty-print both
sides (stable key order) before diffing so the unified diff is line-oriented.
- Sketch: add `GET /api/diff?path=…&pretty=1`. For JSON files, load old (from the
  diff base via `git show <base>:<path>`) and new content, `json.loads` +
  `json.dumps(…, indent=2, sort_keys=False)` each side, then
  `git diff --no-index` the two normalized temp files (or difflib.unified_diff).
- Shell: when renderer is `json`, default the diff mode to the pretty variant and
  offer a "raw diff" toggle. Guard: fall back to the raw diff if either side is
  invalid JSON or too large.

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
- `local-server/server.py` (~1.2k lines) and `site/app.js` (~1.2k lines) now
  exceed the project's own 800-LoC checker. **`app.js` is split (✅)** into ES
  modules under `site/js/` (`core`, `manifest`, `viewer`, `comments`, `checks`,
  `mermaid`) with `site/app.js` as the slim entry/orchestrator; each file is
  under the 800-LoC limit. **Still to do:** split `server.py` into modules
  (manifest/tree, content/diff, comments+stores, checkers, http).

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
- Shell split into ES modules under `site/js/` (core / manifest / viewer /
  comments / checks / mermaid); `site/app.js` is the slim entry. Each file is
  under the project's 800-LoC checker.
- Tests: 59 unittest cases green.
