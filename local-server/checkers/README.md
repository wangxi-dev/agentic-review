# agentic-review checkers

A **checker** is a small command-line program that inspects one file and reports
problems (lines too long, too much nesting, etc.). The review server discovers
checkers, runs them on demand, and the shell shows their findings inline and in a
summary.

Checkers live in two places:

- **Built-in** — this folder (`local-server/checkers/`): `loc.py`, `complexity.py`.
- **User** — `<repo>/.agentic-review/checkers/` in the repo under review. Drop
  your own there; they are discovered automatically and never committed (the
  work folder is git-ignored).

> **Security:** checkers are executables run on your machine on demand. The server
> only runs checkers from these two trusted locations — never from the reviewed
> repo's tracked content — so cloning a repo can't inject a checker. Only add
> checkers you trust.

## The contract

A checker is any executable the server can launch. By extension it runs as:
`.py → python`, `.js`/`.mjs → node`, `.sh → bash`, otherwise executed directly.
It must implement two modes:

### 1. `checker --describe`

Print a single JSON object to stdout describing the checker:

```json
{ "id": "loc", "name": "Lines of code", "description": "Flags long files and lines." }
```

- `id` — short unique id (used in the API and the UI checkbox). Defaults to the
  filename stem if omitted.
- `name` — human-readable name shown in the picker.
- `description` — one line shown under the name.

### 2. `checker <relative-path>`

The file's **content is provided on stdin**; the first argument is the file's
repo-relative path (useful for language detection by extension). Print a single
JSON object with a `findings` array to stdout:

```json
{ "findings": [
  { "line": 42, "severity": "warning", "rule": "max-line-length", "message": "Line is 312 chars (limit 250)." },
  { "severity": "error", "rule": "max-file-loc", "message": "File has 950 lines (limit 800)." }
] }
```

Each finding:

| field      | required | meaning                                              |
| ---------- | -------- | ---------------------------------------------------- |
| `line`     | no       | 1-based line number; omit for a file-level finding.  |
| `severity` | no       | `error`, `warning` (default), or `info`.             |
| `rule`     | no       | short rule id, e.g. `max-line-length`.               |
| `message`  | yes      | what's wrong (shown to the reviewer).                |

Rules of the road:

- **Read content from stdin**, not from the path on disk (the server feeds you
  the exact bytes under review).
- **Print only JSON** on stdout. Use a non-zero exit code + stderr to signal a
  real failure (the shell shows it as a checker error).
- Keep it fast; the server enforces a per-run timeout (15s).
- No findings? Print `{"findings": []}`.

## Minimal example (Python)

```python
#!/usr/bin/env python3
import json, sys

DESCRIBE = {"id": "no-tabs", "name": "No tabs", "description": "Flags hard tabs."}

def main(argv):
    if "--describe" in argv:
        print(json.dumps(DESCRIBE)); return
    findings = []
    for i, line in enumerate(sys.stdin.read().split("\n"), 1):
        if "\t" in line:
            findings.append({"line": i, "severity": "warning",
                             "rule": "no-tabs", "message": "Line contains a tab."})
    print(json.dumps({"findings": findings}))

if __name__ == "__main__":
    main(sys.argv[1:])
```

Save it as `<repo>/.agentic-review/checkers/no_tabs.py`, reload the shell, and it
appears in the checks picker.

## Built-in checkers

| id           | flags                                                              | thresholds (env override)                          |
| ------------ | ------------------------------------------------------------------ | -------------------------------------------------- |
| `loc`        | files over the line limit; lines over the character limit          | `AR_LOC_MAX_FILE` (800), `AR_LOC_MAX_LINE` (250)   |
| `complexity` | nesting deeper than the limit; functions with too many parameters  | `AR_CX_MAX_NESTING` (4), `AR_CX_MAX_PARAMS` (4)     |
