#!/usr/bin/env python3
"""agentic-review checker: code complexity (heuristic).

  checker --describe       -> {"id","name","description"}
  checker <relative-path>  -> reads CONTENT on stdin, prints {"findings":[...]}

Heuristics (language-agnostic, best-effort):
  * deep nesting    — indentation level deeper than AR_CX_MAX_NESTING (default 4)
  * long signatures — functions/methods with more than AR_CX_MAX_PARAMS params
                      (default 4)

These are intentionally simple; they exist to demonstrate the checker plugin
contract. Drop your own CLIs in <repo>/.agentic-review/checkers/ to add checks.
"""
import json
import os
import re
import sys

MAX_NESTING = int(os.environ.get("AR_CX_MAX_NESTING", "4"))
MAX_PARAMS = int(os.environ.get("AR_CX_MAX_PARAMS", "4"))

DESCRIBE = {
    "id": "complexity",
    "name": "Code complexity",
    "description": "Flags nesting deeper than %d and functions with more than %d "
                   "parameters." % (MAX_NESTING, MAX_PARAMS),
}

# Control-flow words that look like calls but are not function definitions.
KEYWORDS = {"if", "for", "while", "switch", "catch", "return", "with", "do",
            "else", "elif", "sizeof", "function", "await", "yield"}

# def name(...) / function name(...)
DEF_RE = re.compile(r"\b(?:def|function)\s+([A-Za-z_]\w*)\s*\(([^()]*)\)")
# name(...) {   — C / Java / JS style method bodies
METHOD_RE = re.compile(r"\b([A-Za-z_]\w*)\s*\(([^()]*)\)\s*\{")


def count_params(param_str):
    s = param_str.strip()
    if not s:
        return 0
    depth = 0
    count = 1
    for ch in s:
        if ch in "([{<":
            depth += 1
        elif ch in ")]}>":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            count += 1
    return count


def indent_width(line):
    width = 0
    for ch in line:
        if ch == " ":
            width += 1
        elif ch == "\t":
            width += 4
        else:
            break
    return width


def main(argv):
    if "--describe" in argv:
        print(json.dumps(DESCRIBE))
        return
    content = sys.stdin.read()
    lines = content.split("\n")
    findings = []

    # Parameter counts.
    for i, line in enumerate(lines, 1):
        matched = None
        m = DEF_RE.search(line)
        if m:
            matched = m.group(2)
        else:
            m = METHOD_RE.search(line)
            if m and m.group(1) not in KEYWORDS:
                matched = m.group(2)
        if matched is not None:
            n = count_params(matched)
            if n > MAX_PARAMS:
                findings.append({
                    "line": i, "severity": "warning", "rule": "max-params",
                    "message": "Function has %d parameters (limit %d)." % (n, MAX_PARAMS),
                })

    # Nesting depth, estimated from indentation.
    widths = sorted({indent_width(ln) for ln in lines if ln.strip()})
    unit = next((w for w in widths if w > 0), 0)
    if unit:
        for i, line in enumerate(lines, 1):
            if not line.strip():
                continue
            level = indent_width(line) // unit
            if level > MAX_NESTING:
                findings.append({
                    "line": i, "severity": "warning", "rule": "max-nesting",
                    "message": "Nesting depth ~%d (limit %d)." % (level, MAX_NESTING),
                })

    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    main(sys.argv[1:])
