"""agentic-review bridge: the change manifest, pre-commit pseudo files, and the
all-files tree.
"""
import os

from ar_core import (
    Config, HttpError, git, is_git_repo, kind_hint, renderer_for,
    PRECOMMIT_STATUS,
)


_STATUS_MAP = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed",
               "C": "copied", "T": "modified", "U": "modified"}


def build_manifest(cfg: Config):
    if not is_git_repo(cfg):
        raise HttpError(400, "root is not a git repository: %s" % cfg.root)
    files = []
    seen = set()
    # Tracked changes vs the diff base (working tree vs HEAD by default).
    proc = git(cfg, "diff", "--name-status", "-z", cfg.diff_base)
    tokens = proc.stdout.split("\x00")
    i = 0
    while i < len(tokens):
        code = tokens[i]
        if not code:
            i += 1
            continue
        letter = code[0]
        status = _STATUS_MAP.get(letter, "modified")
        if letter in ("R", "C"):
            old_path = tokens[i + 1]
            new_path = tokens[i + 2]
            i += 3
            entry = {"path": new_path, "status": status, "oldPath": old_path}
        else:
            path = tokens[i + 1]
            i += 2
            entry = {"path": path, "status": status}
        path = entry["path"]
        if path in seen:
            continue
        seen.add(path)
        entry["kind"] = kind_hint(path)
        entry["renderer"] = renderer_for(path)
        files.append(entry)
    # Untracked (newly created, not yet staged) files -> treat as added.
    if cfg.include_untracked:
        u = git(cfg, "ls-files", "--others", "--exclude-standard", "-z")
        for path in u.stdout.split("\x00"):
            if not path or path in seen:
                continue
            seen.add(path)
            files.append({
                "path": path,
                "status": "added",
                "kind": kind_hint(path),
                "renderer": renderer_for(path),
            })
    files.sort(key=lambda f: f["path"])
    # Surface any pending pre-commit message(s) as pseudo entries at the top so
    # the reviewer can read and comment on the proposed commit before it lands.
    return {"base": cfg.diff_base, "root": cfg.root,
            "files": precommit_entries(cfg) + files}


def precommit_entries(cfg: Config):
    """Pseudo manifest entries for files in the work folder's precommit/ dir."""
    out = []
    pdir = cfg.precommit_dir
    if not os.path.isdir(pdir):
        return out
    try:
        names = sorted(os.listdir(pdir))
    except OSError:
        return out
    for name in names:
        full = os.path.join(pdir, name)
        if not os.path.isfile(full) or name.startswith("."):
            continue
        # Path is relative to root so the content endpoint can serve it.
        rel = os.path.relpath(full, cfg.root).replace(os.sep, "/")
        out.append({
            "path": rel,
            "status": PRECOMMIT_STATUS,
            "kind": "text",
            "renderer": renderer_for(name) if renderer_for(name) != "code" else "markdown",
            "pseudo": True,
            "label": "Proposed commit message" if len(names) == 1 else name,
        })
    return out


def write_precommit(cfg: Config, message, name="commit-message.md"):
    """Persist a proposed commit message into the work folder's precommit/ dir."""
    if not isinstance(message, str) or not message.strip():
        raise HttpError(400, "precommit requires non-empty 'message'")
    # Keep the filename simple and confined to the precommit dir.
    name = os.path.basename(name) or "commit-message.md"
    os.makedirs(cfg.precommit_dir, exist_ok=True)
    path = os.path.join(cfg.precommit_dir, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(message)
    os.replace(tmp, path)
    return os.path.relpath(path, cfg.root).replace(os.sep, "/")


def changed_status_map(cfg: Config):
    """Map path -> change status (modified/added/deleted/renamed) vs the base."""
    if not is_git_repo(cfg):
        return {}
    out = {}
    proc = git(cfg, "diff", "--name-status", "-z", cfg.diff_base)
    tokens = proc.stdout.split("\x00")
    i = 0
    while i < len(tokens):
        code = tokens[i]
        if not code:
            i += 1
            continue
        letter = code[0]
        status = _STATUS_MAP.get(letter, "modified")
        if letter in ("R", "C"):
            out[tokens[i + 2]] = status
            i += 3
        else:
            out[tokens[i + 1]] = status
            i += 2
    if cfg.include_untracked:
        u = git(cfg, "ls-files", "--others", "--exclude-standard", "-z")
        for path in u.stdout.split("\x00"):
            if path and path not in out:
                out[path] = "added"
    return out


def build_file_tree(cfg: Config):
    """List ALL reviewable files as a nested tree.

    Files come from git (tracked + untracked-but-not-ignored), so .gitignore is
    respected — ignored paths like build output and the git-ignored .secrets/
    folder are not exposed. Directory nodes are derived from the file paths.
    """
    if not is_git_repo(cfg):
        raise HttpError(400, "root is not a git repository: %s" % cfg.root)
    status_map = changed_status_map(cfg)
    paths = set()
    for p in git(cfg, "ls-files", "-z").stdout.split("\x00"):
        if p:
            paths.add(p)
    if cfg.include_untracked:
        for p in git(cfg, "ls-files", "--others", "--exclude-standard", "-z").stdout.split("\x00"):
            if p:
                paths.add(p)
    # Deleted files are gone from the working tree but worth showing in review.
    for p, status in status_map.items():
        if status == "deleted":
            paths.add(p)

    root = {"dirs": {}, "files": []}
    for p in paths:
        parts = p.split("/")
        node = root
        cur = ""
        for part in parts[:-1]:
            cur = (cur + "/" + part) if cur else part
            node = node["dirs"].setdefault(part, {"path": cur, "dirs": {}, "files": []})
        node["files"].append({
            "name": parts[-1], "path": p, "type": "file",
            "kind": kind_hint(p), "renderer": renderer_for(p),
            "status": status_map.get(p),
        })
    return {"root": cfg.root, "base": cfg.diff_base, "entries": _serialize_tree(root)}


def _serialize_tree(node):
    dirs = []
    for name in sorted(node["dirs"].keys(), key=str.lower):
        child = node["dirs"][name]
        dirs.append({"name": name, "path": child["path"], "type": "dir",
                     "children": _serialize_tree(child)})
    files = sorted(node["files"], key=lambda f: f["name"].lower())
    return dirs + files
