"""agentic-review bridge: file content and diffs (including the expanded,
pretty-printed JSON diff).
"""
import difflib
import json
import os
import posixpath

from ar_core import (
    Config, HttpError, git, looks_binary, renderer_for, MAX_CONTENT_BYTES,
)


def read_content(cfg: Config, rel):
    real = cfg.resolve_in_root(rel)
    if os.path.isdir(real):
        raise HttpError(400, "path is a directory")
    if os.path.exists(real):
        size = os.path.getsize(real)
        if size > MAX_CONTENT_BYTES:
            raise HttpError(413, "file too large to inline (%d bytes)" % size)
        with open(real, "rb") as fh:
            data = fh.read()
        if looks_binary(data):
            raise HttpError(415, "binary file")
        return {"path": rel, "kind": "text", "content": data.decode("utf-8")}
    # Not in the working tree (e.g. deleted) -> try the diff base.
    norm = posixpath.normpath(rel.replace("\\", "/"))
    proc = git(cfg, "show", "%s:%s" % (cfg.diff_base, norm), check=False)
    if proc.returncode != 0:
        raise HttpError(404, "file not found: %s" % rel)
    text = proc.stdout
    if "\x00" in text:
        raise HttpError(415, "binary file")
    return {"path": rel, "kind": "text", "content": text, "fromBase": True}


def read_diff(cfg: Config, rel, pretty=False):
    real = cfg.resolve_in_root(rel)
    norm = posixpath.normpath(rel.replace("\\", "/"))
    # Pretty (expanded) JSON diff: minified single-line JSON is unreadable in a
    # raw line diff. Pretty-print both sides and diff those instead. Falls back
    # (returns None) to the raw diff below if either side isn't valid JSON, is
    # binary, or is too large.
    if pretty and renderer_for(norm) == "json":
        pj = _json_pretty_diff(cfg, rel, norm, real)
        if pj is not None:
            return pj
    # Untracked files have no tracked counterpart; synthesize an add-diff.
    tracked = git(cfg, "ls-files", "--error-unmatch", "--", norm, check=False)
    if tracked.returncode != 0 and os.path.exists(real):
        # Run relative to root so the diff header shows b/<rel>, not an abs path.
        # Use the literal "/dev/null" (not os.devnull): git diff --no-index only
        # special-cases that string, and Windows' os.devnull ("nul") makes git fail.
        proc = git(cfg, "diff", "--no-index", "--", "/dev/null", norm, check=False)
        unified = proc.stdout
    else:
        proc = git(cfg, "diff", cfg.diff_base, "--", norm, check=False)
        unified = proc.stdout
    # Flag binary diffs so the shell can show the right message rather than a
    # misleading "no diff".
    binary = ("Binary files " in unified) or ("GIT binary patch" in unified)
    return {"path": rel, "base": cfg.diff_base, "unified": unified, "binary": binary}


def _pretty_json_text(text):
    """Pretty-print a JSON document (stable key order preserved).

    Returns the formatted string (with a trailing newline) or None if the text
    is not valid JSON. An empty/whitespace-only side (added or deleted file) is
    treated as an empty document so the diff reads as all-added / all-removed.
    """
    if text is None:
        return None
    if text.strip() == "":
        return ""
    try:
        obj = json.loads(text)
    except (ValueError, UnicodeDecodeError):
        return None
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def _json_pretty_diff(cfg: Config, rel, norm, real):
    """Build a line-oriented unified diff of pretty-printed JSON.

    Returns a diff payload dict (with ``pretty: True``) on success, or None to
    signal the caller should fall back to the raw git diff.
    """
    # Old side: the version in the diff base (empty if the file is new there).
    old_text = ""
    tracked = git(cfg, "ls-files", "--error-unmatch", "--", norm, check=False)
    if tracked.returncode == 0:
        show = git(cfg, "show", "%s:%s" % (cfg.diff_base, norm), check=False)
        if show.returncode == 0:
            old_text = show.stdout
    # New side: the working-tree version (empty if the file was deleted).
    if os.path.exists(real):
        try:
            if os.path.getsize(real) > MAX_CONTENT_BYTES:
                return None
            with open(real, "rb") as fh:
                data = fh.read()
        except OSError:
            return None
        if looks_binary(data):
            return None
        new_text = data.decode("utf-8")
    else:
        new_text = ""
    old_pp = _pretty_json_text(old_text)
    new_pp = _pretty_json_text(new_text)
    if old_pp is None or new_pp is None:
        return None  # a side isn't valid JSON -> fall back to the raw diff
    unified = ""
    if old_pp != new_pp:
        diff = difflib.unified_diff(
            old_pp.splitlines(keepends=True), new_pp.splitlines(keepends=True),
            fromfile="a/" + norm, tofile="b/" + norm)
        body = "".join(diff)
        if body:
            unified = "diff --git a/%s b/%s\n%s" % (norm, norm, body)
    # "Formatting only": the file changed textually (e.g. minified/reformatted)
    # but is semantically identical, so the expanded diff is empty. Flag it so
    # the shell can explain that instead of misreporting the file as unchanged.
    formatting_only = unified == "" and old_text != new_text
    return {"path": rel, "base": cfg.diff_base, "unified": unified,
            "binary": False, "pretty": True, "formattingOnly": formatting_only}
