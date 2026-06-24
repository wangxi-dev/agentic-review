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
