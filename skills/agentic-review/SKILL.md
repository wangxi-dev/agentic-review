---
name: agentic-review
description: Launch a local, human-in-the-loop review of AI-generated changes. Use when the user wants to review the agent's current diff in a browser, leave inline comments, and feed that feedback back to the agent before continuing. Provides three commands — launch, take-feedback, cleanup — driven by a loopback bridge server and a static review shell.
user-invocable: true
allowed-tools: Bash, Read, Grep, Glob
argument-hint: "[launch|take-feedback|cleanup] [review-comments-folder]"
---

# agentic-review

A local review loop for AI-generated code. The agent starts a small loopback
HTTP **bridge server** that exposes the current repo's changes to a static
**review shell** (a web page). The human reads the diff, leaves comments, and the
agent reads those comments back to iterate. See `design.md` at the repo root for
the full architecture and security model.

The commands are **plain Python** (stdlib only) so they run the same on Windows,
macOS, and Linux — no shell scripts. Invoke them with the platform's Python 3:
`python3` on macOS/Linux, or `python` / `py -3` on Windows. Below, `python3`
stands for whichever you have.

Three commands map to three scripts in `scripts/`:

| Command                        | Script             | Purpose                                    |
| ------------------------------ | ------------------ | ------------------------------------------ |
| `agentic-review:launch`        | `launch.py`        | start the server, print the shell URL      |
| `agentic-review:take-feedback` | `take-feedback.py` | read reviewer comments back to the agent   |
| `agentic-review:cleanup`       | `cleanup.py`       | shut down the server, delete temp comments |

All three resolve the bridge and the active session automatically (from
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

Shuts the server down gracefully and removes the temp comments.

```bash
python3 skills/agentic-review/scripts/cleanup.py          # guarded: shows count, asks to confirm
python3 skills/agentic-review/scripts/cleanup.py --force  # actually tear down
```

**Cleanup deletes the comments.** Always run `take-feedback` first and let the
user take a last look. The unforced cleanup deliberately refuses and prints the
outstanding comment count so feedback is never lost by accident; only pass
`--force` once the user has confirmed.

## Typical round trip

1. `launch` → open the URL, user comments on the diff.
2. `take-feedback` → read comments, make the requested changes.
3. (optional) launch/feedback again to confirm the fixes.
4. `cleanup --force` once the user is satisfied.

## Notes

- The server binds to `127.0.0.1` only and confines file access to the repo
  root (path traversal, absolute paths, and symlink escape are rejected).
- A per-session token is required on every `/api/*` call; the shell sends it via
  the `X-AR-Token` header (carried in the `?token=` URL the user opens).
- Only one session runs at a time (a new `launch` cleans up the previous one).
- Requires Python 3.8+ and `git` on `PATH`. No third-party packages.
