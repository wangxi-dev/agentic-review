# agentic-review — Feature Proposals

## 1. Diff between reviews (delta view)

Each `launch`/`cleanup` cycle is a clean slate. After the agent makes changes based on round-1 feedback and re-launches, the human sees the full diff fresh — with no indication of what was already reviewed vs what's newly changed.

**Proposal:** After each round, persist a marker ref (`AR_LAST_REVIEWED`). On next launch, offer a "since last review" diff that shows only the delta the agent produced in response to the previous round of comments. The full-diff view remains available as a fallback.

## 2. Suggested code changes (patches)

GitHub PR reviews let reviewers propose an exact diff the author can apply with one click. Here, the human writes "change `x` to `y` on line 42" and the agent must parse natural language — fragile and lossy.

**Proposal:** Add a "Suggest change" mode in the shell. The reviewer selects a line range, types the replacement code, and the shell generates a unified patch snippet. The agent can then apply this patch directly via `take-feedback --apply`, avoiding misinterpretation of free-text instructions. Partially tracked in the existing backlog (findings → comments).

## 3. Approval / decline signal

When the human says "I'm done reviewing," it's ambiguous — does it mean "approved, proceed to commit" or "I'm done commenting, please address these issues and come back"?

**Proposal:** Add an explicit review-state signal. Options:
- **Per-file flag:** Each file can be marked "Approved," "Changes requested," or "Reviewed." These aggregate to a whole-review summary.
- **Whole-review action:** A "Submit review" button with three outcomes: "Approve" (agent may commit), "Request changes" (agent must address and re-launch), "Comment" (feedback posted, no decision either way).

## 4. Multi-commit diff base

Currently only one diff base is supported (e.g., vs `HEAD` or vs `main`). Reviewing incremental changes across multiple rounds or comparing against a different base requires restarting the server.

**Proposal:** Persist a moving `AR_LAST_REVIEWED` marker ref (see item 1). Allow changing the diff base while the server is running via a "Change base" input in the shell header. Support reviewing a range of commits (e.g., "commits since last tag").

## 5. Keyboard shortcuts

Review is a reading-heavy, keyboard-driven activity. The shell is entirely mouse-dependent.

**Proposal:** Standard shortcuts for both the "Changed" and "All files" tabs:
- `j` / `k` — next / previous file in the current list or tree
- `n` / `p` — next / previous comment
- `esc` — close open panels, clear selection
- `r` — open reply box on the active comment
- `t` — toggle between "Changed" and "All files" tabs
- `/` — focus file filter in either tab

## 6. Dark mode

The CSS uses custom properties (`--bg`, `--fg`, `--border`, etc.) ready for theming, but there's no theme toggle. Reviewing code for extended sessions in light mode is fatiguing.

**Proposal:** Add a theme toggle (light / dark / system) in the top bar. Store preference in `localStorage`. Trivial given the existing CSS variable architecture — just swap the values.

## 7. File search / filter

Browsing a large repo requires clicking through deeply nested directory trees. The "Changed" tab also becomes unwieldy with 40+ files.

**Proposal:** Add a filter input above both the "Changed" file list and the "All files" tree that fuzzy-filters entries. Optionally add a `/` keyboard shortcut to focus the filter.

## 8. Cross-file / cross-repo checkers

The checker contract supports only file-scoped checks (content on stdin). Many valuable reviews are cross-file: "is this new function actually called?", "does this import duplicate an existing one?", "are there breaking API changes?"

**Proposal:** Extend the checker contract with a `scope` field (`"file"` vs `"repo"`). Repo-scoped checkers receive the repo root and a list of changed paths (as JSON on stdin or args), run once, and emit a single pass/fail result. Ship examples: a type-check runner, an import-dependency checker.

## 9. Comment templates

Reviewers write the same patterns repeatedly: "Add error handling," "Needs a test," "Use consistent naming," etc.

**Proposal:** Allow users to define quick-comment templates (in `.agentic-review/templates.json`). Show a picker in the comment form — select one and optionally edit before posting. Ship a small default set.

## 10. Persistent review sessions (session-scoped comments)

Comments live in `.agentic-review/comments/` and are deleted on `cleanup`. Each agent session should get its own folder so multiple review rounds don't clobber each other's comments.

**Proposal:** Scoped comment folders per session under `.agentic-review/comments/<session-id>/`. Previous session comments stay as read-only reference. On re-launch in the same branch, surface prior comments for context.

## 11. Image diff preview

Binary files get zero treatment — images show "binary" and are unopenable.

**Proposal:** Detect image files (PNG, SVG, JPEG, WebP). In the diff viewer, render old and new side-by-side. For SVG, optionally apply the git diff directly as a visual overlay.

## 12. Local code checks

The checker system runs per-file on demand. There's no equivalent of running the project's test suite or linter from within the review shell before deciding whether to commit — without pushing to a remote CI.

**Proposal:** Extend checkers to support repo-scoped commands (e.g., `pytest`, `npm test`, `cargo check`). The checker runs locally, pipes output, and shows pass/fail + any findings inline in the review shell. No remote CI dependency — everything stays local. Use the existing checker contract with the `"repo"` scope.

## 13. Unread reply indicators

The comment thread supports human↔agent conversation, but the human doesn't know the agent replied unless they re-open the shell manually. This is tracked in the existing backlog as "threaded comment conversations."

**Proposal:** Already in progress via threaded comments. Extend with a WebSocket connection (from the bridge) or periodic polling. Show an unread-count badge on the shell tab title and in the comment panel. Highlight threads with unread agent replies.

---

## Priority Triage

| Tier | Items |
|------|-------|
| **P1 — high priority** | 2 (suggested patches), 3 (approval signal), 5 (keyboard shortcuts), 7 (file search) |
| **P2 — next** | 1 (delta view), 4 (multi-commit base), 6 (dark mode), 11 (image diff), 13 (unread indicators) |
| **P3 — nice to have** | 8 (cross-file checkers), 9 (comment templates), 10 (persistent sessions), 12 (local code checks) |
