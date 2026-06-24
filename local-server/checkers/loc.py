#!/usr/bin/env python3
"""agentic-review checker: lines of code.

A checker is a small CLI that the review server runs on one file:

  checker --describe          -> prints {"id","name","description"} as JSON
  checker <relative-path>      -> reads the file CONTENT on stdin and prints
                                  {"findings":[{line?,severity,rule,message}, ...]}

This one flags files that are too long and individual lines that are too wide.
Thresholds: AR_LOC_MAX_FILE (default 800), AR_LOC_MAX_LINE (default 250).
"""
import json
import os
import sys

MAX_FILE_LOC = int(os.environ.get("AR_LOC_MAX_FILE", "800"))
MAX_LINE_LEN = int(os.environ.get("AR_LOC_MAX_LINE", "250"))

DESCRIBE = {
    "id": "loc",
    "name": "Lines of code",
    "description": "Flags files over %d lines and lines over %d characters."
                   % (MAX_FILE_LOC, MAX_LINE_LEN),
}


def main(argv):
    if "--describe" in argv:
        print(json.dumps(DESCRIBE))
        return
    content = sys.stdin.read()
    lines = content.split("\n")
    loc = len(lines) - 1 if content.endswith("\n") else len(lines)

    findings = []
    if loc > MAX_FILE_LOC:
        findings.append({
            "severity": "error", "rule": "max-file-loc",
            "message": "File has %d lines (limit %d)." % (loc, MAX_FILE_LOC),
        })
    for i, line in enumerate(lines, 1):
        length = len(line)
        if length > MAX_LINE_LEN:
            findings.append({
                "line": i, "severity": "warning", "rule": "max-line-length",
                "message": "Line is %d characters (limit %d)." % (length, MAX_LINE_LEN),
            })
    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    main(sys.argv[1:])
