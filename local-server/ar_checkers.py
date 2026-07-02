"""agentic-review bridge: pluggable checker plugins (built-in + user CLIs)."""
import json
import os
import subprocess

from ar_core import (
    Config, HttpError, looks_binary,
    PYTHON_EXE, CHECKER_EXTS, CHECKER_TIMEOUT, CHECKER_MAX_OUTPUT,
    CHECKER_MAX_FINDINGS, NO_WINDOW,
)
from ar_manifest import build_manifest


def _checker_command(path):
    """How to invoke a checker file, by extension (cross-platform)."""
    ext = os.path.splitext(path)[1].lower()
    if ext == ".py":
        return [PYTHON_EXE, path]
    if ext in (".js", ".mjs"):
        return ["node", path]
    if ext == ".sh":
        return ["bash", path]
    return [path]  # assume directly executable


def _describe_checker(path):
    try:
        proc = subprocess.run(_checker_command(path) + ["--describe"],
                              capture_output=True, text=True, timeout=CHECKER_TIMEOUT,
                              encoding="utf-8", errors="replace",
                              creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError):
        return {}
    if proc.returncode == 0 and proc.stdout.strip():
        try:
            meta = json.loads(proc.stdout)
            return meta if isinstance(meta, dict) else {}
        except ValueError:
            return {}
    return {}


def discover_checkers(cfg: Config):
    """Find checker CLIs: built-in first, then user checkers in the work dir.

    Only these two trusted, user-controlled locations are scanned; checkers are
    never executed from the repo's tracked content.
    """
    out = []
    seen = set()
    for directory, builtin in ((cfg.builtin_checkers_dir, True),
                               (cfg.user_checkers_dir, False)):
        if not os.path.isdir(directory):
            continue
        for name in sorted(os.listdir(directory)):
            if name.startswith(".") or name.startswith("_"):
                continue
            full = os.path.join(directory, name)
            if not os.path.isfile(full):
                continue
            ext = os.path.splitext(name)[1].lower()
            if ext not in CHECKER_EXTS and not os.access(full, os.X_OK):
                continue
            meta = _describe_checker(full)
            cid = meta.get("id") or os.path.splitext(name)[0]
            if cid in seen:
                continue
            seen.add(cid)
            out.append({
                "id": cid,
                "name": meta.get("name", cid),
                "description": meta.get("description", ""),
                "builtin": builtin,
                "_path": full,
            })
    return out


def _run_one_checker(checker, rel, content):
    entry = {"id": checker["id"], "name": checker["name"], "findings": []}
    try:
        proc = subprocess.run(
            _checker_command(checker["_path"]) + [rel],
            input=content, capture_output=True, text=True, timeout=CHECKER_TIMEOUT,
            encoding="utf-8", errors="replace",
            creationflags=NO_WINDOW)
    except subprocess.TimeoutExpired:
        entry["error"] = "checker timed out after %ds" % CHECKER_TIMEOUT
        return entry
    except (OSError, subprocess.SubprocessError) as e:
        entry["error"] = "checker failed to run: %s" % e
        return entry
    if proc.returncode != 0:
        entry["error"] = (proc.stderr or "checker exited with %d" % proc.returncode).strip()[:500]
        return entry
    out = (proc.stdout or "")[:CHECKER_MAX_OUTPUT]
    if not out.strip():
        return entry
    try:
        parsed = json.loads(out)
    except ValueError:
        entry["error"] = "checker did not return valid JSON"
        return entry
    findings = parsed.get("findings", []) if isinstance(parsed, dict) else []
    norm = []
    for f in findings[:CHECKER_MAX_FINDINGS]:
        if not isinstance(f, dict):
            continue
        line = f.get("line")
        sev = f.get("severity")
        norm.append({
            "line": line if isinstance(line, int) and line > 0 else None,
            "severity": sev if sev in ("error", "warning", "info") else "warning",
            "rule": str(f.get("rule", ""))[:100],
            "message": str(f.get("message", ""))[:500],
        })
    entry["findings"] = norm
    return entry


def run_checkers(cfg: Config, rel, ids=None):
    real = cfg.resolve_in_root(rel)
    if not os.path.isfile(real):
        raise HttpError(400, "not a file: %s" % rel)
    with open(real, "rb") as fh:
        data = fh.read()
    if looks_binary(data):
        raise HttpError(415, "binary file")
    content = data.decode("utf-8", "replace")
    checkers = discover_checkers(cfg)
    if ids:
        wanted = set(ids)
        checkers = [c for c in checkers if c["id"] in wanted]
    results = [_run_one_checker(c, rel, content) for c in checkers]
    return {"path": rel, "results": results}


def run_checkers_all(cfg: Config, ids=None):
    """Run the selected checkers across every changed text file (repo-level)."""
    manifest = build_manifest(cfg)
    files = []
    errors = 0
    warnings = 0
    for entry in manifest["files"]:
        # Skip pseudo (pre-commit), deleted, and binary-by-extension files.
        if entry.get("pseudo") or entry.get("status") == "deleted" or entry.get("kind") == "binary":
            continue
        real = os.path.join(cfg.root, entry["path"].replace("/", os.sep))
        if not os.path.isfile(real):
            continue
        try:
            res = run_checkers(cfg, entry["path"], ids)
        except HttpError:
            continue  # e.g. binary detected at read time
        nf = 0
        for r in res["results"]:
            for f in r["findings"]:
                nf += 1
                if f["severity"] == "error":
                    errors += 1
                elif f["severity"] == "warning":
                    warnings += 1
        if nf:
            files.append(res)
    return {"base": manifest["base"], "files": files,
            "summary": {"errors": errors, "warnings": warnings,
                        "filesWithFindings": len(files)}}
