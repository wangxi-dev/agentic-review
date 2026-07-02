---
name: agentic-review
description: Launch a local, human-in-the-loop review of AI-generated changes. Use when the user wants to review the agent's current diff (or all files) in a browser, run code checks, leave inline comments, propose a commit message for review, and feed that feedback back to the agent before continuing. Driven by a loopback bridge server and a static review shell.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[launch|precommit|take-feedback|reply|cleanup] [review-comments-folder]"
---

# agentic-review

A local review loop for AI-generated code. The agent starts a small loopback
HTTP **bridge server** that exposes the current repo's changes to a static
**review shell** (a web page). The human reads the diff (or browses all files),
runs code checks, leaves comments, and the agent reads those comments back to
iterate.

The commands are **plain Python** (stdlib only) so they run the same on Windows,
macOS, and Linux — no shell scripts. Invoke them with the platform's Python 3:
`python3` on macOS/Linux, or `python` / `py -3` on Windows. Below, `python3`
stands for whichever you have.

Commands map to scripts in `scripts/`:

| Command                        | Script             | Purpose                                    |
| ------------------------------ | ------------------ | ------------------------------------------ |
| `agentic-review:launch`        | `launch.py`        | start the server, print the shell URL      |
| `agentic-review:precommit`     | `precommit.py`     | stage a proposed commit message for review |
| `agentic-review:take-feedback` | `take-feedback.py` | read reviewer comment threads back         |
| `agentic-review:comment`       | `comment.py`       | file a review comment (with author identity) |
| `agentic-review:reply`         | `reply.py`         | reply to a comment / set its status        |
| `agentic-review:next-task`     | `next-task.py`     | claim a dropped cross-review task (author poll) |
| `agentic-review:cleanup`       | `cleanup.py`       | shut down the server (keeps comments); `--sessions` prunes stored folders |

All resolve the bridge and the active session automatically (from
`~/.agentic-review/session.json`); you do not pass ports or tokens by hand.

## `agentic-review:launch [review-comments-folder]`

Starts the bridge for the repository the user is **currently working in** (its
git root), with a per-session token, and prints the URL to open.

```bash
python3 skills/agentic-review/scripts/launch.py [review-comments-folder]
```

- Comments are stored in a **persistent, per-repo folder** under
  `~/.agentic-review/comments/<repo-key>/` (outside the repo, keyed by the repo
  path). They **survive a reviewer/bridge restart** — relaunching for the same
  repo reuses the same folder, so comments are never lost on restart. They are
  removed only by an explicit prune (`cleanup --sessions --force`). Pass an
  optional folder argument to override the location.
- Default diff base is **working tree vs `HEAD`** (all uncommitted changes,
  including untracked files). Override with `AR_DIFF_BASE` (e.g. `main`).
- Default starting port is `8900`; the script advances to the next free port if
  it is busy.
- The same-origin shell needs **only the port** — open
  `http://127.0.0.1:<port>/review.html`. The bridge injects the session token
  into that page, so there is no `?api=` or `?token=` to copy by hand.
- To use the hosted GitHub Pages shell instead, set `AR_PAGES_ORIGIN` (e.g.
  `https://you.github.io/agentic-review`); the script then also prints a
  cross-origin `?api=…&token=…` URL and adds that origin to the server's CORS
  allowlist.

After launching, **give the user the printed
`http://127.0.0.1:<port>/review.html` URL** and ask them to review and comment.
Then wait for them to say they are done before taking feedback.

## `agentic-review:precommit`

Stage a **proposed commit message** into the active review as a pseudo "file
change" so the reviewer can read and comment on it *before* you commit. It shows
up at the top of the review's file list.

```bash
python3 skills/agentic-review/scripts/precommit.py --message "feat: ..."   # inline
python3 skills/agentic-review/scripts/precommit.py --file MSG.txt           # from a file
printf "%s" "$MESSAGE" | python3 skills/agentic-review/scripts/precommit.py  # from stdin
python3 skills/agentic-review/scripts/precommit.py --show                   # print current
```

Use this when you are about to commit: draft the message, stage it, ask the user
to review it (and the diff), then run `take-feedback`, revise, and only then
commit. The message is stored at `<repo>/.agentic-review/precommit/`.

## `agentic-review:take-feedback`

Reads the stored comment **threads** and prints them grouped by file and ordered
by line. Each comment shows its lifecycle status (`open`, `resolved`, `rejected`,
`wont-fix`, `needs-discussion`), its replies, and a hint about whose turn it is.

```bash
python3 skills/agentic-review/scripts/take-feedback.py          # only live threads
python3 skills/agentic-review/scripts/take-feedback.py --all    # include settled threads
python3 skills/agentic-review/scripts/take-feedback.py --json   # raw comment objects
```

By default only `open` / `needs-discussion` comments are shown (the set still
awaiting the agent); pass `--all` to also see `resolved` / `rejected` /
`wont-fix`. Use the output to drive the next iteration: address each open comment
in the code, **reply** to explain what you did (see below), and re-run the review.
`--json` emits the raw comment objects (`{id, path, line, side, range, text,
author, createdAt, status, replies}`) if you need to process them programmatically.

## `agentic-review:reply`

Reply to a comment **as the agent** and/or move it through its lifecycle, so the
review is a two-way conversation instead of a one-way comment dump. The human can
always override the status in the shell.

```bash
# reply with an explanation
python3 skills/agentic-review/scripts/reply.py --id <comment-id> --text "done in <commit>"
# reply and flag for discussion
python3 skills/agentic-review/scripts/reply.py --id <comment-id> --text "why here?" --status needs-discussion
# resolve / reject without a reply
python3 skills/agentic-review/scripts/reply.py --id <comment-id> --status resolved
# long reply from stdin
printf "%s" "$MSG" | python3 skills/agentic-review/scripts/reply.py --id <comment-id>
```

Get comment ids from `take-feedback --json` (the `id` field). `--status` accepts
`open`, `resolved`, `rejected`, `wont-fix`, or `needs-discussion`. Give at least
one of `--text` or `--status`.

## `agentic-review:cleanup`

Shuts the bridge server down gracefully. **Comments are kept** — they live in the
persistent per-repo folder and are not deleted, so the next launch reuses them.

```bash
python3 skills/agentic-review/scripts/cleanup.py            # stop the server, keep comments
python3 skills/agentic-review/scripts/cleanup.py --force    # same (skips the confirm)

# Manage stored per-repo comment folders:
python3 skills/agentic-review/scripts/cleanup.py --sessions          # list them
python3 skills/agentic-review/scripts/cleanup.py --sessions --force  # prune stale ones
```

Plain `cleanup` never deletes comments or pre-commit messages. To reclaim space,
`cleanup --sessions` lists every stored per-repo comment folder under
`~/.agentic-review/comments/`; adding `--force` prunes the **stale** ones (every
stored session except the one currently active). User checkers in
`.agentic-review/checkers/` and the repo's `setting.json` are always preserved.

## Typical round trip

1. `launch` → open the URL, user reviews the diff (or all files) and comments.
2. `take-feedback` → read the comment threads, make the requested changes.
3. `reply` → reply to each comment explaining what you did and resolve / reject /
   flag it for discussion; re-run `take-feedback` to confirm the live set is empty.
4. (optional) `precommit` → stage the commit message and have the user review it.
5. `cleanup --force` once the user is satisfied; then commit.

## Cross-review (portal buttons)

The review shell has three topbar buttons that let the human drive agents
directly. Each comment / reply now also records **who** wrote it — a role
(`human` / `author-agent` / `review-agent`) plus the agent + model — shown as a
label like `ReviewAgent-Copilot-Opus`.

- **⇄ Cross-review** — spawns a **brand-new** reviewer agent session (its own
  process) that reads the diff + the proposed commit message and files review
  comments via `comment.py`. The reviewer does NOT edit code. **Pick which agent
  runs it** from the dropdown next to the button (see below).
- **✎ Address all** — drops a task file the **already-running, idle author**
  agent picks up to address all open comments (no new process spawned).
- **✓ LGTM → commit** — a deterministic, bridge-direct `git commit` (optional
  push), refused while open comments remain unless overridden.

### Choosing the review agent

The dropdown next to **⇄ Cross-review** lets the human select which agent runs
the cross-review, **changeable at any moment**. Built-in presets (commands are
hardcoded in the bridge, never taken from repo content):

| Choice        | Runs                                                    |
| ------------- | ------------------------------------------------------- |
| Copilot CLI   | `copilot -p {prompt} --allow-all-tools`                 |
| Claude Code   | `claude -p {prompt} --dangerously-skip-permissions`     |
| opencode      | `opencode run {prompt}`                                 |
| Codex CLI     | `codex exec {prompt}`                                   |
| Bring your own | spawns **nothing** — the bridge builds the review prompt and shows it on the portal to copy into your own agent |

The selection is stored per-repo in `<repo>/.agentic-review/setting.json`
(git-ignored, survives cleanup) as
`{"reviewAgent": "<id>", "reviewModels": {"<id>": "<model>"}}`, and can be
changed anytime from the dropdown. **Cross-review is always available** — no
config file is required.

A second **model** dropdown appears next to the agent picker for agents that
expose a fixed model list (Copilot: `gpt-5.5`/`gpt-5.4`/`claude-opus-4.8`/
`claude-sonnet-4.5`/`claude-sonnet-4.6`; Claude Code: `opus`/`sonnet`/`haiku`).
Pick one and the reviewer runs with `--model <model>` appended; leave it on
"default model" to use the agent's own default. The chosen model is validated
against the hardcoded per-agent list (so repo content can never inject an
arbitrary flag value) and remembered **per agent**. Agents without a model list
(opencode, Codex, "bring your own") hide the dropdown.

While a reviewer runs, a status pill in the topbar shows its state
(running → done ✓). The progress window can be **hidden** (not closed) — the
review keeps running in the background and the page no longer re-renders the open
file on every poll; click the pill to reopen the window at any time.

### Overriding the review command (optional)

To use a custom command (extra flags, a pinned model, a different binary), add a
`review` entry to the **user-level** config at `~/.agentic-review/config.json`
(never from repo content), run as an argument list with a single `{prompt}`
substitution. It then appears in the dropdown as an extra choice:

```jsonc
{
  "agents": {
    "review": { "label": "ReviewAgent-Copilot-GPT5.5",
                "command": ["copilot", "-p", "{prompt}", "--model", "gpt-5.5", "--allow-all-tools"],
                "agent": "copilot", "model": "gpt-5.5" }
  }
}
```

**✎ Address all** and **✓ LGTM → commit** need no agent config and are always
available.

### Author agent: picking up "Address all" tasks

After `launch`, if you are the **author** agent, self-arm a periodic wake (e.g.
the CLI's `/every`) that runs `next-task.py`. When the human clicks **Address
all**, your next poll claims the task; then run `take-feedback`, make the changes,
and `reply --status resolved` each comment. Finish with `next-task.py --done <id>`.

**Stop polling once the human re-engages.** The poll only exists to deliver work
while the human is away from the session (the bridge cannot push into your stdin,
so you pull). As soon as the human sends you a direct message, **tear down the
poll schedule** — they are back and can hand you work directly; a live poll would
just burn turns. Re-arm it only if they step away again.

**After you make the code changes, always reply.** Addressing a comment is not
done until you `reply --status resolved` (or `needs-discussion`) on it — the human
watches the thread, not just the diff. Never resolve silently; explain what you
did in the reply.

## `agentic-review:comment`

File a review comment from the CLI (used by a spawned reviewer agent). Identity is
read from `AR_ROLE` / `AR_AGENT` / `AR_MODEL` / `AR_LABEL` env vars (the bridge
sets these when it spawns the reviewer).

```bash
python3 skills/agentic-review/scripts/comment.py --path src/app.py --line 42 --text "off-by-one here"
python3 skills/agentic-review/scripts/comment.py --path README.md --text "file-level note"
```

## `agentic-review:next-task`

Claim the next pending cross-review task dropped from the portal (the author
agent's poll). Tasks are files under `<work-dir>/tasks/`.

```bash
python3 skills/agentic-review/scripts/next-task.py            # claim the oldest pending task
python3 skills/agentic-review/scripts/next-task.py --peek     # list without claiming
python3 skills/agentic-review/scripts/next-task.py --done <id># mark a claimed task complete
```

Exit code 3 means nothing is pending (so a poll loop can quietly go back to sleep).

## Notes

- The server binds to `127.0.0.1` only and confines file access to the repo
  root (path traversal, absolute paths, and symlink escape are rejected).
- A per-session token is required on every `/api/*` call; the shell sends it via
  the `X-AR-Token` header (carried in the `?token=` URL the user opens).
- Only one session runs at a time (a new `launch` cleans up the previous one).
- Requires Python 3.8+ and `git` on `PATH`. No third-party packages.
- **Comment store:** comments live in a persistent, per-repo folder under
  `~/.agentic-review/comments/<repo-key>/` (outside the repo, keyed by repo
  path). They survive reviewer/bridge restarts and are only removed by
  `cleanup --sessions --force`. Pre-commit messages and repo-scoped bits (user
  `checkers/`, `setting.json`) stay in the in-repo git-ignored
  `<repo>/.agentic-review/` folder (which cleanup no longer wipes, so they
  persist too).
- **Checks:** the shell can run code checkers on a file. Built-ins cover lines of
  code and complexity; users add their own CLIs under
  `<repo>/.agentic-review/checkers/` (each prints JSON — see the README).
- **All files:** the shell's "All files" tab browses the whole repo as a tree
  (gitignored files excluded), not just the changed set.
