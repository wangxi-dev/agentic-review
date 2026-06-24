# agentic-review — Execution Plan

This is the build plan for the project. A fresh session should read this file plus
`design.md` (full design) and start at the first unchecked task. Keep the
checkboxes updated as work lands.

## How to resume (read this first)

1. Repo root: `~/agentic-review` (remote `https://github.com/wangxi-dev/agentic-review.git`, branch `main`).
2. Pushing: `source .secrets/setenv.sh` (sets session identity WindTalkerGold
   <wang.xiw@outlook.com> + PAT-based push), then `git push` or
   `.secrets/push.sh -m "msg"`. The `.secrets/` folder is git-ignored and holds
   the PAT (`pat`), `push.sh`, and `setenv.sh`. **Never read `.secrets/pat`.**
3. Do **not** commit/push unless the user explicitly asks.
4. Local manual test loop:
   ```bash
   python3 local-server/server.py 8900           # bridge
   python3 -m http.server 8000 --directory site  # shell
   # open http://localhost:8000/?port=8900
   ```

## Current state (done)

- [x] Repo initialized; `README.md` (overview) + `design.md` (full design).
- [x] Push tooling: `.secrets/push.sh`, `.secrets/setenv.sh` (session-level
      identity + PAT push), `.gitignore` ignores `.secrets/`.
- [x] Minimal scaffold verified end-to-end:
  - `site/` — `index.html` + `app.js`, reads `?port=` / `?api=` and tests
    GET `/ping` + POST `/comments`.
  - `local-server/server.py` — Python stdlib stub; dummy GET/POST, CORS +
    `Access-Control-Allow-Private-Network: true`, binds `127.0.0.1` only.
  - `skills/agentic-review/SKILL.md` — stub.

## Target API contract (local server)

All JSON. The shell only ever talks to this server. `<root>` = the directory
under review; every path is validated to stay inside `<root>`.

- `GET /ping` → `{status, service, version}`  *(done)*
- `GET /api/manifest` → list of files under review:
  `{ base, root, files: [ {path, status: modified|added|deleted|renamed, oldPath?, kind: text|binary, renderer: code|markdown|html} ] }`
- `GET /api/content?path=<rel>` → `{path, kind, content}` (text only; `415` for
  binary, `403` for traversal/out-of-root).
- `GET /api/diff?path=<rel>` → `{path, base, unified}` (unified diff text).
- `GET /api/comments` → `{comments: [ {id, path, line, side?, range?, text, author?, createdAt} ]}`
- `POST /api/comments` body `{path, line, side?, range?, text, author?}` →
  `{status:"ok", id}` (persists one JSON file per comment in the comments dir).
- `POST /api/cleanup` → `{status:"ok"}` then graceful shutdown.

Server config (CLI flags): `--root <dir>`, `--port <n>` (default 8900),
`--comments-dir <dir>`, `--diff-base <git-ref>`, `--allow-origin <origin>`
(repeatable), `--token <t>` (optional). Env fallbacks where sensible.

## Phase 1 — Local server: real endpoints

- [ ] Refactor `server.py` into a small app (still stdlib-only unless a dep is
      clearly justified). Add argparse for the flags above.
- [ ] `GET /api/manifest` from `git -C <root> diff --name-status <base>` (default
      base = working tree vs `HEAD`). Classify renderer by extension.
- [ ] `GET /api/content` — text-only, with path-traversal protection (realpath
      must be within `<root>`; reject symlink escape, `..`, absolute paths).
- [ ] `GET /api/diff` — unified diff per file (`git diff`), for diff mode.
- [ ] `POST /api/comments` / `GET /api/comments` — store/list comments as JSON
      files in `--comments-dir`.
- [ ] `POST /api/cleanup` — graceful shutdown.
- [ ] Security: enforce `--allow-origin` allowlist (keep dev echo behind a flag);
      optional `--token` checked on `/api/*` via `X-AR-Token`; loopback bind.
- [ ] Handle port-in-use with a clear error.
- **Acceptance:** curl can list the changed files of a real repo, fetch one
  file's content and diff, post + read back a comment, and traversal is rejected.

## Phase 2 — Site shell: real review UI

- [ ] Read base URL + optional token from `?api=`/`?port=`/`?token=` and send the
      token header on every request.
- [ ] File list panel from `/api/manifest`.
- [ ] Source viewer with syntax highlighting; **diff mode** (highlight changes)
      and **full mode** (new file only). Decide highlighter/diff lib (Prism/
      highlight.js + diff2html, vendored vs CDN — CDN OK once on Pages).
- [ ] Markdown preview (render charts/tables; GitHub + ADO variants). Sanitize
      output.
- [ ] Comment UI: select line/range, write a comment, POST it; render existing
      comments inline.
- [ ] Keep it pure static (HTML/JS/CSS), no build step required.
- **Acceptance:** load the shell against a real repo, browse files, view code +
  diff + markdown, leave a comment, see it persist.

## Phase 3 — Skill: wire the commands

- [ ] `agentic-review:launch [review-comments-folder]` — start `server.py` with
      `--root` (current repo), `--comments-dir`, `--diff-base`, `--port`,
      optional `--token`; print/open the shell URL with `?api=&token=`.
- [ ] `agentic-review:take-feedback` — read all stored comments and present them
      to the agent for another iteration.
- [ ] `agentic-review:cleanup` — call `/api/cleanup`, remove temp comments,
      remind the user to take a last look first (run take-feedback before cleanup).
- **Acceptance:** the three commands drive a full review round trip.

## Phase 4 — Pluggable comment store

- [ ] Define a generic store interface (save/load) behind the comment endpoints.
- [ ] Default = files; add one alternative (e.g. GitHub issues) as a reference
      implementation, ensuring the user's agent can still read comments back.

## Phase 5 — HTML/JS/CSS rendering (next step in design)

- [ ] Render reviewed HTML/JS/CSS inside a sandboxed `<iframe sandbox>` so it
      never executes in the shell's origin.

## Phase 6 — Deploy + cross-browser

- [ ] Publish `site/` to GitHub Pages (user will configure Pages).
- [ ] Verify HTTPS-Pages → `http://localhost` works in Chrome (incl. Private
      Network Access preflight), Firefox, and Safari; document supported browsers
      and the same-origin fallback (server also serving the shell) if needed.

## Phase 7 — Hardening + tests

- [ ] Path-safety, origin-allowlist, and token tests.
- [ ] Friendly errors (server down, wrong token, binary/oversized files).
- [ ] Optional: per-session token auto-generated at launch and embedded in the
      shell URL.

## Key decisions to confirm when resuming

- Diff base: working tree vs `HEAD` vs an explicit commit range.
- Highlighter / markdown / diff libraries, and vendored vs CDN.
- Comment anchor schema (line vs range, diff side) — keep it in the API contract.
- Whether the local server should also serve `site/` (same-origin fallback).
