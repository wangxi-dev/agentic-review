# agentic-review — next steps

The core tool is built and tested (bridge server, review shell, skill commands,
file + GitHub comment stores, tests). This file tracks the remaining ideas, most
of them from reviewer feedback. Pick up any item independently.

## How to resume

- Repo root: `~/agentic-review`. Run the bridge with
  `python3 local-server/server.py --root <repo> --port 8900` and open
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

### 2. Markdown: render Mermaid diagrams
Render ```` ```mermaid ```` code blocks as diagrams in preview mode.
- Sketch: load `mermaid` from the CDN (pin a version, like the other libs). After
  the markdown is sanitized and inserted, find `pre > code.language-mermaid`,
  hand the text to `mermaid.render`, and replace the block with the SVG.
- Security: Mermaid manipulates DOM; keep it to the preview pane only, and run
  `mermaid.initialize({ securityLevel: "strict" })`. Sanitize the produced SVG
  with DOMPurify (SVG profile) before insertion. If mermaid isn't loaded, leave
  the fenced code block as-is.

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
- **Repo-scoped checkers** (e.g. `build pass`, `test pass`). Extend the checker
  contract with a `scope` in `--describe`: `"file"` (current; content on stdin) vs
  `"repo"` (run once for the whole repo, no stdin; receives the repo root and the
  list of changed paths as args/JSON). The server runs repo-scoped checkers once
  in check-all and shows a single pass/fail row. Ship example `build`/`test`
  checkers under `examples/checkers/` that shell out to the project's build/test.
- **Findings → comments.** Add a "file as comment" action on a finding (and a bulk
  "file all") that POSTs `/api/comments` anchored to the path/line, so a violation
  becomes a tracked review comment the agent reads back via `take-feedback`. Guard
  against duplicates (dedupe by rule+path+line).
- **Whitelist / manual approval.** Persist approved or whitelisted violations in
  `<repo>/.agentic-review/checks-whitelist.json` (keyed by a stable fingerprint:
  checker id + rule + path + a content hash of the offending line, so it survives
  line moves). The server filters whitelisted findings out of check-all (or marks
  them "approved"); the shell offers "approve / whitelist" on a finding and a view
  of the whitelist. Decide whitelist granularity (per-line vs per-rule-per-file)
  and whether the whitelist is committed (shared) or git-ignored (local) — likely
  committed so the gate is shared, which means it should live OUTSIDE the
  git-ignored work folder (e.g. `.agentic-review-allow.json` at repo root).

## Tech debt
- `local-server/server.py` (~1.2k lines) and `site/app.js` (~1.2k lines) now
  exceed the project's own 800-LoC checker. Split them: server into modules
  (manifest/tree, content/diff, comments+stores, checkers, http), app.js into
  ES modules (api, filelist/tree, viewer/renderers, comments, checks).

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
- Tests: 39 unittest cases green.
