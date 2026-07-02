# agentic-review — Cross-Review (proposal)

> **Status:** ✅ implemented on branch `u/wang/cross-review` (Parts 0, 1, 2, 3A;
> Part 3B/push works via the LGTM commit's push checkbox). 94 server tests green.
> The plan below is what was built; remaining open questions are marked **❓**.

## What we have today (recap)

- A loopback **bridge** (`local-server/`) exposes the repo's diff + a comment
  store to a static **review shell** (`site/`).
- Comments are **threads**: each has a `status`
  (`open`/`resolved`/`rejected`/`wont-fix`/`needs-discussion`) and `replies[]`.
- A reply's `author` is a free-ish enum: **`human`** or **`agent`**
  (`ar_comments.py` `REPLY_AUTHORS`). The top-level comment's `author` is a free
  string.
- A human drives the loop: read diff → comment → run `take-feedback` → the agent
  (in a chat session) edits and replies → repeat.
- `precommit.py` already lets the author agent stage a **proposed commit
  message** that shows up as a pseudo-file in the review.

The loop today **always needs a human at a chat session** to push the agent. The
cross-review feature adds **buttons in the portal** that let the human trigger
agent work directly, and gives every comment a **first-class author identity** so
a 3-party conversation (human + author-agent + review-agent) is legible.

---

## Goal: three buttons in the portal

| # | Button | What it does | Required? |
|---|--------|--------------|-----------|
| 1 | **Trigger cross-review** | Spawn a *reviewer* agent (chosen from a dropdown of presets — Copilot / Claude Code / opencode / Codex — or "bring your own") that reads the diff **+ the proposed commit message**, then posts review comments back into the shell. | core |
| 2 | **Ask author to address comments** | Hand a task to the **already-running author** agent (the one that wrote the code) to read open comments, edit code, and reply — **no new process is spawned**; it reuses the existing session via a file task-inbox it polls. | core |
| 3 | **LGTM → commit (→ push)** | Tell the author agent (or the bridge directly) "approved": commit using the proposed message, optionally push. | optional |

---

## Part 0 — Comment authorship gets an identity (prerequisite)

Today "who said this" is just `human` / `agent`. With a reviewer agent in the
mix we have **three** distinct voices, and we want to know **which agent + which
model** spoke. Proposed identity model on every comment and every reply:

```jsonc
{
  "authorRole": "human" | "author-agent" | "review-agent",
  "agent":      "copilot" | "claude" | null,   // null for humans
  "model":      "gpt-5" | "opus-4.8" | null,   // null for humans
  "authorLabel": "Human" | "AuthorAgent-Copilot-GPT5" | "ReviewAgent-Copilot-Opus"
}
```

- **`authorLabel`** is a derived, display-friendly string the shell renders on the
  comment/reply chip. Format: `Human`, or `{Role}-{Agent}-{Model}` for agents.
- **Backward compat.** Old comments/replies (`author: "human"|"agent"`) map as:
  `human → {role:human}`; `agent → {role:author-agent, agent/model unknown}`.
  Readers fall back exactly like the current `c.get("status") or "open"` pattern.
- **Validation** (`ar_comments.py`): extend `REPLY_AUTHORS` → a role enum; accept
  optional `agent`/`model` strings (length-capped, charset-limited). Build
  `authorLabel` server-side so the shell can't be tricked into a misleading label.
- **Where identity comes from.** When the bridge spawns an agent (Parts 1–3) it
  passes the role/agent/model as **env vars** (e.g. `AR_ROLE=review-agent
  AR_AGENT=copilot AR_MODEL=gpt-5`). The skill scripts (`reply.py` and a new
  `comment.py`) read those and stamp every comment/reply they create. The human's
  comments from the shell are stamped `human` server-side.

> **❓ Model string source.** Does the spawned CLI expose which model it used? If
> not, the user configures it per command template (see Part 1) and we trust that
> label. Simplest: the label is whatever the launching command declares.

---

## Part 1 — Trigger cross-review (core)

### Flow

1. Human clicks **Trigger cross-review** in the portal.
2. Bridge (optionally) ensures a **proposed commit message** exists — either it
   was already staged via `precommit.py`, or we first spawn the *author* agent
   with a tiny "write a one-paragraph commit message describing your changes"
   prompt. The message is the reviewer's "here's what I intended to do" context.
3. Bridge spawns the **reviewer command** (detached, in the repo root) — a
   **user-configured template**, default `copilot -p "<review prompt>"`.
4. The review prompt tells the agent to:
   - read the diff under review (`git diff` against the session's diff base, or
     the agentic-review skill's `take-feedback`/manifest),
   - read `.agentic-review/precommit/commit-message.md`,
   - file findings as **review comments** via the bridge API, stamped
     `review-agent` (using the new `comment.py` skill script with
     `AR_ROLE=review-agent`).
5. The shell auto-refreshes (it already polls), so the human watches review
   comments appear, then replies / resolves like any other comment.

### How the reviewer posts comments

The reviewer runs as a **brand-new agent session** — its own fresh LLM context /
process, **not** the human's current working agent. It shares only the review's
**comment store + token** so its comments land in the same shell the human is
watching (and it reads the diff from the same bridge). Spawned headless via the
configured command, it stamps every comment `review-agent`. Add a skill script:

```text
agentic-review:comment --path FILE [--line N] [--side new|old] --text "…"
# stamps authorRole/agent/model from AR_ROLE / AR_AGENT / AR_MODEL env
```

It POSTs `/api/comments` exactly like the shell does. No new trust surface for
*posting* — it's the same authenticated endpoint.

### Choosing the command (security-critical)

The command that gets executed must come from **trusted sources**, never
free-form from the reviewed repo (same principle as checkers, see README
"Security").

- **Built-in presets** ship with the bridge (hardcoded in `ar_agents.py`):
  Copilot CLI, Claude Code, opencode, Codex CLI, and "bring your own" (spawns
  nothing — shows the prompt to copy). Their commands live in *our* source, so
  selecting one from the portal dropdown can't inject anything.
- The **selection** is stored per-repo in `<repo>/.agentic-review/setting.json`
  as `{"reviewAgent": "<id>"}`. That file only holds a preset **id**, validated
  against the known set, so even a malicious repo can't turn it into a command.
  It is changeable from the dropdown at any moment and survives cleanup.
- To **override the command** (extra flags, pinned model, different binary), add
  a `review` entry to `~/.agentic-review/config.json` (user-level, **outside**
  any repo). It appears in the dropdown as the `config` choice.
- Template shape:

  ```jsonc
  {
    "agents": {
      "review":  { "label": "ReviewAgent-Copilot-Opus",
                   "command": ["copilot", "-p", "{prompt}"],
                   "agent": "copilot", "model": "opus-4.8" }
    }
  }
  ```

- `{prompt}` is the only substitution; the bridge builds the prompt, never the
  repo. Command is run detached with `cwd = repo root`, args as a **list** (no
  shell string interpolation).
- Endpoints: `GET /api/agents` (choices + current selection),
  `POST /api/setting` (persist the choice), `POST /api/agent/review` → returns a
  `jobId` (or `status:"manual"` + the prompt for "bring your own"),
  `GET /api/job?id=<id>` → status + log tail for the portal's progress modal.

> **Always available.** Cross-review works on first run via presets; only the
> "bring your own" choice runs nothing (it just shows the prompt).

---

## Part 2 — Ask author to address comments (optional)

This is the *automated* version of today's manual loop (human opens a chat,
agent runs `take-feedback`, edits, replies).

**Key difference from Part 1.** The reviewer is a *brand-new* session, but the
author is the **already-running** agent that wrote the code. We assume it is
**idle** (finished its turn) when the human clicks the button — we want to hand
work back to *that* process, not spawn a fresh one that lacks the author's
context.

### Detecting the right process (clarifying the ❓)

Yes — capture the author's process identity at launch. `launch.py` is invoked
*by* the author agent, so it can record who to talk to:

- **PID + agent id.** `launch.py` records the **author agent's PID** (and, where
  available, a tool-native agent/session id, e.g. Copilot CLI's agent id) into
  `~/.agentic-review/session.json` — either auto-detected as the parent process
  or passed explicitly (`launch.py --agent-pid <pid> --agent-id <id>`). Since only
  one session runs at a time, this uniquely identifies "the author." The PID also
  lets the bridge check the process is **still alive** before handing it work.
- **Delivery = a file task-inbox (no injecting into a TUI).** You can't reliably
  push a prompt into an arbitrary interactive CLI's stdin. So the human's button
  just **drops a task file** (e.g. `.agentic-review/tasks/<id>.json` =
  `{action:"address-all", createdAt}`). The idle author agent picks it up because,
  right after `launch`, the skill tells it to **self-arm a periodic wake** (the
  CLI's own `/every` / schedule) that polls the task-inbox; on the next tick it
  sees the task, runs `take-feedback`, edits, replies, and clears the task.
- **Tool-native alternative.** Where the runtime supports messaging an idle agent
  by id (e.g. Copilot CLI `write_agent`), the bridge/skill can deliver directly
  instead of polling. The task-inbox is the tool-agnostic fallback.

> **❓ Confirm the delivery model:** record PID/agent-id at launch + file
> task-inbox + self-armed poll (tool-agnostic), with tool-native messaging as an
> optimization where available?

### Flow

1. Human clicks **Address all open comments** (the default, see below). The shell
   writes a task file via the bridge; no fresh agent is spawned.
2. The idle author agent wakes on its next poll, runs `take-feedback`, and for
   each `open` / `needs-discussion` comment makes the code change, then
   `reply.py --id … --text … --status resolved`. If it disagrees or needs info it
   sets `needs-discussion` and explains. (`AR_ROLE=author-agent`.)
3. Author agent edits files, replies, sets statuses, clears the task. The diff
   changes; the shell auto-refreshes; the human sees resolutions + new code.

### Why this is feasible

Every primitive already exists: `take-feedback` (read threads + "whose turn"
hint), `reply.py` (reply + set status), the comment store round-trips, and the
CLI can self-schedule a wake. Part 2 is "hand the existing author a task and let
it run the loop it already knows."

> **Decided: address ALL open comments** is the typical/default action (one
> button, batch the whole live set) rather than per-thread. A per-thread "address
> just this one" can be a secondary action later, but the default is address-all.

> **❓ Concurrency.** Block triggering the author while a review job is running
> (and vice-versa) to avoid two agents editing at once. Bridge enforces a single
> active "mutating" job; reject with 409 otherwise.

---

## Part 3 — LGTM → commit (→ push) (optional)

Two ways to implement; we can offer both.

**A. Bridge-direct (no agent).** Simplest and most predictable. The bridge runs
`git commit -F .agentic-review/precommit/commit-message.md` (only staged changes,
or `git commit -a` per a toggle), and — if the human ticked "push" — `git push`.
No model involved, deterministic.

**B. Agent-driven.** Spawn the author agent with "the review is approved (LGTM).
Commit your work using the proposed commit message; then push." Useful if commits
need judgment (splitting, hygiene, regenerating the message).

### Flow

1. Human clicks **LGTM → commit**, with checkboxes: `[ ] push`, and **❓** a
   "require all threads resolved" guard (refuse if any `open` thread remains?).
2. Bridge validates the guard, then runs path **A** (default) or **B** (if
   configured), returns the new commit SHA / push result.
3. Because the default diff base is "working tree vs HEAD", committing makes the
   change **drop out of the review** — the shell already handles and announces
   this. Clean end-of-loop.

> **❓ Push safety.** Push is the one irreversible-ish step. Gate it behind an
> explicit checkbox (default **off**) + a confirm, and surface the remote/branch
> it will push to. Never push automatically.

> **❓ Commit message trailer.** Include the `Co-authored-by: Copilot …` trailer
> automatically? And a `Reviewed-by: ReviewAgent-…` trailer summarizing the cross
> review?

---

## New surface area (summary)

### Bridge endpoints (kept minimal — state lives in **files**, not endpoints)

Progress/status needs **no new endpoints**: review comments stream in through the
existing `/api/comments` (the shell already polls it), and jobs/tasks/logs are
just files under `.agentic-review/` (`tasks/<id>.json`, `jobs/<id>.log`) that you
can read on disk. We only add the few endpoints the **browser** genuinely needs,
because the browser can only touch the local disk *through* the bridge:

| Method + path | Purpose |
|---|---|
| `GET  /api/agents` | which agent templates are configured (for enabling buttons) |
| `POST /api/agent/review` | spawn the brand-new reviewer session |
| `POST /api/task` | drop a task file for the idle author (`{action:"address-all"}`) |
| `POST /api/commit` | bridge-direct commit (`{message?, push?, addAll?}`) |

No `/api/agent/jobs` status endpoints — the file logs + the live comment stream
are enough. All token-guarded like the rest of `/api/*`.

### Skill scripts

- **new** `comment.py` — create a comment from the CLI with role/agent/model
  stamping (used by spawned agents).
- `reply.py` — extend to stamp role/agent/model (today it hardcodes
  `author: "agent"`).
- **new** `cross-review.py` (or extend `launch`) — write/read
  `~/.agentic-review/config.json` templates.

### Shell

- Topbar buttons (gated on `/api/agents`): **Trigger cross-review**, **Address
  all open comments**, **LGTM → commit**. Progress is read from the **live comment
  stream** (already polled) — no separate jobs indicator/endpoint.
- Comment/reply chips render `authorLabel` with distinct styling for
  human / author-agent / review-agent.

### Schema

- Comments + replies gain `authorRole`, `agent`, `model`, `authorLabel`
  (server-derived). Backward compatible.

---

## Security model (delta from today)

The new, sharp edge is **the bridge executes commands**. Mitigations:

1. **Command choice is a preset id or user-level config**, never a free-form
   string from repo content or the shell request body. Built-in preset commands
   live in the bridge's own source; overrides live in
   `~/.agentic-review/config.json`. The repo-level `setting.json` only stores a
   validated preset **id**, so a cloned repo can't inject a command.
2. **No shell interpolation** — commands are arg **lists**, the only substitution
   is the bridge-built `{prompt}`.
3. **Loopback + token** unchanged: only the authenticated same-origin shell can
   hit `/api/agent/*` and `/api/setting`.
4. **Single active mutating job** (concurrency guard) to avoid clobbering.
5. **Push is opt-in + confirmed**, never automatic.
6. The **"bring your own"** choice runs nothing — it only shows the prompt.

---

## Suggested build order

1. **Part 0** — identity on comments/replies (schema + validation + shell chips).
   Self-contained, valuable on its own, unblocks the rest.
2. **Part 1** — config templates + `spawn_detached` for a **brand-new reviewer
   session** + `/api/agent/review` + `comment.py` + topbar button. Progress via
   the live comment stream + file logs (no jobs endpoint).
3. **Part 3A** — bridge-direct commit (deterministic, low risk).
4. **Part 2** — author "address **all**" automation: record author PID/agent-id at
   launch + `POST /api/task` file-inbox + self-armed poll.
5. **Part 3B / push** — agent-driven commit + push, behind confirms.

---

## Open questions (consolidated)

1. **Model label** — derive from the CLI, or trust the config template's `model`?
2. **Review agent choice** — presets (Copilot / Claude Code / opencode / Codex) +
   "bring your own", picked from a dropdown, stored per-repo in `setting.json`.
3. **Part 2 delivery** — record author PID/agent-id at launch + file task-inbox +
   self-armed poll (tool-agnostic), with tool-native messaging where available?
   *(Default action = address ALL open comments — decided.)*
4. **Concurrency** — single active mutating job (409 on conflict)?
5. **Commit guard** — refuse commit while any `open` thread remains?
6. **Push** — checkbox + confirm, show remote/branch; never auto. Agree?
7. **Trailers** — auto-add `Co-authored-by` / `Reviewed-by`?
8. **Who writes the commit message** — always the author agent's `precommit`, or
   allow the human to edit it in the shell before LGTM?
