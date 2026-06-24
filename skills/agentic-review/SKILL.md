---
name: agentic-review
description: Launch a local, human-in-the-loop review of AI-generated changes. Use when the user wants to review the agent's current diff (or all files) in a browser, run code checks, leave inline comments, propose a commit message for review, and feed that feedback back to the agent before continuing. Driven by a loopback bridge server and a static review shell.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[launch|precommit|take-feedback|cleanup] [review-comments-folder]"
---

# agentic-review

A local review loop for AI-generated code. The agent starts a small loopback
HTTP **bridge server** that exposes the current repo's changes to a static
**review shell** (a web page). The human reads the diff (or browses all files),
runs code checks, leaves comments, and the agent reads those comments back to
iterate. See `design.md` at the repo root for the full architecture and security
model.

The commands are **plain Python** (stdlib only) so they run the same on Windows,
macOS, and Linux — no shell scripts. Invoke them with the platform's Python 3:
`python3` on macOS/Linux, or `python` / `py -3` on Windows. Below, `python3`
stands for whichever you have.

Commands map to scripts in `scripts/`:

| Command                        | Script             | Purpose                                    |
| ------------------------------ | ------------------ | ------------------------------------------ |
| `agentic-review:launch`        | `launch.py`        | start the server, print the shell URL      |
| `agentic-review:precommit`     | `precommit.py`     | stage a proposed commit message for review |
| `agentic-review:take-feedback` | `take-feedback.py` | read reviewer comments back to the agent   |
| `agentic-review:cleanup`       | `cleanup.py`       | shut down the server, delete temp comments |

All resolve the bridge and the active session automatically (from
`~/.agentic-review/session.json`); you do not pass ports or tokens by hand.

## `agentic-review:launch [review-comments-folder]`

Starts the bridge for the repository the user is **currently working in** (its
git root), with a per-session token, and prints the URL to open.

```bash
python3 skills/agentic-review/scripts/launch.py [review-comments-folder]
```

- The optional argument is a folder to persist comments in. Omit it to use a
  fresh temp folder (auto-deleted on cleanup).
- Default diff base is **working tree vs `HEAD`** (all uncommitted changes,
  including untracked files). Override with `AR_DIFF_BASE` (e.g. `main`).
- Default starting port is `8900`; the script advances to the next free port if
  it is busy.
- To use the hosted GitHub Pages shell instead of the same-origin one, set
  `AR_PAGES_ORIGIN` (e.g. `https://you.github.io/agentic-review`); the script
  then also prints a `?api=…&token=…` URL and adds that origin to the server's
  CORS allowlist.

After launching, **give the user the printed `http://127.0.0.1:<port>/?token=…`
URL** and ask them to review and comment. Then wait for them to say they are
done before taking feedback.

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

Reads every stored comment and prints them grouped by file and ordered by line.

```bash
python3 skills/agentic-review/scripts/take-feedback.py
```

Use the output to drive the next iteration: address each comment in the code,
explain anything you intentionally skip, then re-run the review. Add `--json` to
get the raw comment objects (`{id, path, line, side, range, text, author,
createdAt}`) if you need to process them programmatically.

## `agentic-review:cleanup`

Shuts the server down gracefully and removes the temp review artifacts.

```bash
python3 skills/agentic-review/scripts/cleanup.py          # guarded: shows count, asks to confirm
python3 skills/agentic-review/scripts/cleanup.py --force  # actually tear down
```

**Cleanup deletes the comments and pre-commit messages** (but preserves any user
checkers in `.agentic-review/checkers/`). Always run `take-feedback` first and
let the user take a last look. The unforced cleanup deliberately refuses and
prints the outstanding comment count so feedback is never lost by accident.

## Typical round trip

1. `launch` → open the URL, user reviews the diff (or all files) and comments.
2. `take-feedback` → read comments, make the requested changes.
3. (optional) `precommit` → stage the commit message and have the user review it.
4. `cleanup --force` once the user is satisfied; then commit.

## Notes

- The server binds to `127.0.0.1` only and confines file access to the repo
  root (path traversal, absolute paths, and symlink escape are rejected).
- A per-session token is required on every `/api/*` call; the shell sends it via
  the `X-AR-Token` header (carried in the `?token=` URL the user opens).
- Only one session runs at a time (a new `launch` cleans up the previous one).
- Requires Python 3.8+ and `git` on `PATH`. No third-party packages.
- **Work folder:** comments and pre-commit messages live in a git-ignored
  `<repo>/.agentic-review/` folder (self-ignoring via its own `.gitignore`).
- **Checks:** the shell can run code checkers on a file. Built-ins cover lines of
  code and complexity; users add their own CLIs under
  `<repo>/.agentic-review/checkers/` (each prints JSON — see the README).
- **All files:** the shell's "All files" tab browses the whole repo as a tree
  (gitignored files excluded), not just the changed set.
