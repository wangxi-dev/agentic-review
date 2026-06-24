#!/usr/bin/env python3
"""agentic-review local bridge server.

The only component with access to local files. The static review shell talks
*exclusively* to this server. Binds to loopback (127.0.0.1) only.

Endpoints (all JSON unless noted):
    GET  /ping                      -> {status, service, version}
    GET  /api/manifest              -> {base, root, files:[...]}
    GET  /api/content?path=<rel>    -> {path, kind, content}   (415 binary, 403 traversal)
    GET  /api/diff?path=<rel>       -> {path, base, unified}
    GET  /api/comments              -> {comments:[...]}
    POST /api/comments              -> {status:"ok", id}
    POST /api/cleanup               -> {status:"ok"} then graceful shutdown
    GET  /<static>                  -> serves the shell from --site-dir (same-origin fallback)

Run:
    python3 server.py --root /path/to/repo [--port 8900] [--comments-dir DIR]
                      [--diff-base HEAD] [--allow-origin https://foo.bar]...
                      [--token SECRET] [--site-dir ../site]

Security model: loopback bind, root-confined file access (no traversal / symlink
escape), optional Origin allowlist, optional per-session token on /api/*, and
Private Network Access preflight support for HTTPS shells (e.g. GitHub Pages).
"""
import argparse
import json
import mimetypes
import os
import posixpath
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

VERSION = "0.2.0"
SERVICE = "agentic-review-local-server"

# Origins always permitted to reach the bridge, in addition to any --allow-origin
# values and the loopback shell we serve ourselves. This is the project's
# published GitHub Pages shell (origin = scheme + host only, no path). Override
# or extend via --allow-origin / the AR_ALLOW_ORIGIN env var.
DEFAULT_ALLOWED_ORIGINS = ("https://wangxi-dev.github.io",)

# Extension -> renderer hint for the shell.
MARKDOWN_EXT = {".md", ".markdown", ".mdown", ".mkd"}
HTML_EXT = {".html", ".htm"}
JSON_EXT = {".json", ".jsonc", ".geojson", ".ipynb"}
# Extensions we treat as binary up front in the manifest (content endpoint still
# does a real null-byte check on everything else).
BINARY_EXT = {
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tif", ".tiff",
    ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".jar",
    ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".flac", ".ogg", ".webm",
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    ".so", ".dll", ".dylib", ".exe", ".bin", ".o", ".a", ".class",
    ".pyc", ".pyd", ".wasm", ".db", ".sqlite", ".lock",
}

MAX_CONTENT_BYTES = 5 * 1024 * 1024  # refuse to inline anything bigger than 5 MiB


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def renderer_for(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in MARKDOWN_EXT:
        return "markdown"
    if ext in HTML_EXT:
        return "html"
    if ext in JSON_EXT:
        return "json"
    return "code"


def kind_hint(path):
    ext = os.path.splitext(path)[1].lower()
    return "binary" if ext in BINARY_EXT else "text"


def looks_binary(data: bytes) -> bool:
    if b"\x00" in data:
        return True
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return True
    return False


class HttpError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


class Config:
    def __init__(self, args):
        self.root = os.path.realpath(args.root)
        self.port = args.port
        self.diff_base = args.diff_base
        self.token = args.token
        self.site_dir = os.path.realpath(args.site_dir) if args.site_dir else None
        self.include_untracked = not args.no_untracked
        # Allowlist: explicit origins make the policy strict; absent => dev echo.
        self.allow_origins = set(args.allow_origin or [])
        self.strict_origin = bool(self.allow_origins)
        # Same-origin requests from the shell we serve ourselves are always fine.
        self.allow_origins.add("http://localhost:%d" % self.port)
        self.allow_origins.add("http://127.0.0.1:%d" % self.port)
        # The published GitHub Pages shell is always allowed too.
        self.allow_origins.update(DEFAULT_ALLOWED_ORIGINS)
        # Comment store selection (pluggable; see make_store).
        self.comment_store = args.comment_store
        self.github_repo = args.github_repo
        self.github_issue = args.github_issue
        if args.comments_dir:
            self.comments_dir = os.path.realpath(args.comments_dir)
            os.makedirs(self.comments_dir, exist_ok=True)
            self.comments_dir_is_temp = False
        else:
            self.comments_dir = tempfile.mkdtemp(prefix="agentic-review-comments-")
            self.comments_dir_is_temp = True

    def resolve_in_root(self, rel):
        """Resolve a client-supplied relative path, confined to root.

        Rejects absolute paths, traversal, and symlinks that escape root.
        Returns the real absolute path. Raises HttpError(403) on violation.
        """
        if rel is None or rel == "":
            raise HttpError(400, "missing path")
        # Normalise as a POSIX-style relative path first.
        rel = rel.replace("\\", "/")
        if rel.startswith("/") or (len(rel) > 1 and rel[1] == ":"):
            raise HttpError(403, "absolute paths are not allowed")
        norm = posixpath.normpath(rel)
        if norm == ".." or norm.startswith("../"):
            raise HttpError(403, "path escapes root")
        candidate = os.path.join(self.root, norm)
        real = os.path.realpath(candidate)
        root_with_sep = self.root if self.root.endswith(os.sep) else self.root + os.sep
        if real != self.root and not real.startswith(root_with_sep):
            raise HttpError(403, "path escapes root")
        return real


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------

def git(cfg: Config, *args, check=True):
    proc = subprocess.run(
        ["git", "-C", cfg.root, *args],
        capture_output=True, text=True,
    )
    if check and proc.returncode != 0:
        raise HttpError(500, "git %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc


def is_git_repo(cfg: Config) -> bool:
    proc = git(cfg, "rev-parse", "--is-inside-work-tree", check=False)
    return proc.returncode == 0 and proc.stdout.strip() == "true"


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
    return {"base": cfg.diff_base, "root": cfg.root, "files": files}


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


def read_diff(cfg: Config, rel):
    real = cfg.resolve_in_root(rel)
    norm = posixpath.normpath(rel.replace("\\", "/"))
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


# ---------------------------------------------------------------------------
# comment store (pluggable behind a generic interface)
# ---------------------------------------------------------------------------

class CommentStore:
    """Generic interface: persist and retrieve comments.

    Implementations must round-trip the comment dict (id, path, line, side,
    range, text, author, createdAt) so the user's agent can read them back via
    GET /api/comments regardless of where they are stored.
    """
    def list(self):
        raise NotImplementedError

    def save(self, comment):
        raise NotImplementedError

    def update(self, cid, fields):
        """Apply `fields` (e.g. {"text": ...}) to comment `cid`; return it or None."""
        raise HttpError(501, "this comment store does not support editing")

    def delete(self, cid):
        """Delete comment `cid`; return True if it existed."""
        raise HttpError(501, "this comment store does not support deleting")


# Fields a client is allowed to edit on an existing comment.
EDITABLE_FIELDS = ("text",)


class FileCommentStore(CommentStore):
    """Default backend: one JSON file per comment in a directory."""
    def __init__(self, directory):
        self.directory = directory
        self._lock = threading.Lock()
        os.makedirs(directory, exist_ok=True)

    def _path(self, cid):
        # cid is server-generated (timestamp + hex); guard against any abuse.
        if not cid or "/" in cid or "\\" in cid or os.path.sep in cid or ".." in cid:
            raise HttpError(400, "invalid comment id")
        return os.path.join(self.directory, "%s.json" % cid)

    def list(self):
        out = []
        for name in os.listdir(self.directory):
            if not name.endswith(".json"):
                continue
            try:
                with open(os.path.join(self.directory, name), "r", encoding="utf-8") as fh:
                    out.append(json.load(fh))
            except (ValueError, OSError):
                continue
        out.sort(key=lambda c: c.get("createdAt", ""))
        return out

    def save(self, comment):
        with self._lock:
            path = self._path(comment["id"])
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(comment, fh, indent=2)
            os.replace(tmp, path)
        return comment

    def update(self, cid, fields):
        with self._lock:
            path = self._path(cid)
            if not os.path.isfile(path):
                raise HttpError(404, "comment not found: %s" % cid)
            with open(path, "r", encoding="utf-8") as fh:
                comment = json.load(fh)
            for k in EDITABLE_FIELDS:
                if k in fields:
                    comment[k] = fields[k]
            comment["updatedAt"] = now_iso()
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(comment, fh, indent=2)
            os.replace(tmp, path)
        return comment

    def delete(self, cid):
        with self._lock:
            path = self._path(cid)
            if not os.path.isfile(path):
                return False
            os.remove(path)
            return True


# Marker embedded in each GitHub issue comment so we can recover the structured
# comment on list() while still showing a human-readable body in the issue.
_GH_MARKER = "<!-- agentic-review:"
_GH_MARKER_END = "-->"


def _gh_render(comment):
    """Format a comment as a GitHub issue-comment body (human text + payload)."""
    if comment.get("range"):
        anchor = "L%s-%s" % (comment["range"]["start"], comment["range"]["end"])
    elif comment.get("line") is not None:
        anchor = "L%s" % comment["line"]
    else:
        anchor = "file"
    side = (" (%s)" % comment["side"]) if comment.get("side") else ""
    who = comment.get("author") or "reviewer"
    human = "**%s** commented on `%s` %s%s:\n\n%s" % (
        who, comment.get("path", "?"), anchor, side, comment.get("text", ""))
    payload = json.dumps(comment, separators=(",", ":"))
    return "%s\n\n%s %s %s" % (human, _GH_MARKER, payload, _GH_MARKER_END)


def _gh_parse(body):
    """Recover the structured comment from an issue-comment body, or None."""
    start = body.find(_GH_MARKER)
    if start < 0:
        return None
    start += len(_GH_MARKER)
    end = body.find(_GH_MARKER_END, start)
    if end < 0:
        return None
    try:
        return json.loads(body[start:end].strip())
    except ValueError:
        return None


def _run_gh(args, input_text=None):
    """Invoke the GitHub CLI. Raises HttpError on failure / if gh is missing."""
    try:
        proc = subprocess.run(["gh", *args], capture_output=True, text=True,
                              input=input_text)
    except FileNotFoundError:
        raise HttpError(500, "the 'gh' CLI is required for the github comment store")
    if proc.returncode != 0:
        raise HttpError(502, "gh %s failed: %s" % (" ".join(args), proc.stderr.strip()))
    return proc.stdout


class GitHubIssueCommentStore(CommentStore):
    """Reference alternative backend: comments live on a GitHub issue.

    Each review comment becomes an issue comment whose body carries a hidden
    JSON payload; list() reads them back. Lets a team review in the agent's UI
    while the durable record lives in GitHub. `runner` is injectable for tests.
    """
    def __init__(self, repo, issue, runner=_run_gh):
        if not repo or not issue:
            raise HttpError(500, "github comment store needs --github-repo and --github-issue")
        self.repo = repo
        self.issue = int(issue)
        self._runner = runner
        self._lock = threading.Lock()

    def save(self, comment):
        body = _gh_render(comment)
        with self._lock:
            self._runner([
                "api", "--method", "POST",
                "repos/%s/issues/%d/comments" % (self.repo, self.issue),
                "-f", "body=%s" % body,
            ])
        return comment

    def list(self):
        return [c for _id, c in self._list_with_gh_ids()]

    def _list_with_gh_ids(self):
        out = self._runner([
            "api", "--paginate",
            "repos/%s/issues/%d/comments" % (self.repo, self.issue),
        ])
        try:
            raw = json.loads(out) if out.strip() else []
        except ValueError:
            raw = []
        pairs = []
        for item in raw:
            parsed = _gh_parse(item.get("body", ""))
            if parsed:
                pairs.append((item.get("id"), parsed))
        pairs.sort(key=lambda p: p[1].get("createdAt", ""))
        return pairs

    def _find_gh_id(self, cid):
        for gh_id, comment in self._list_with_gh_ids():
            if comment.get("id") == cid:
                return gh_id, comment
        return None, None

    def update(self, cid, fields):
        with self._lock:
            gh_id, comment = self._find_gh_id(cid)
            if gh_id is None:
                raise HttpError(404, "comment not found: %s" % cid)
            for k in EDITABLE_FIELDS:
                if k in fields:
                    comment[k] = fields[k]
            comment["updatedAt"] = now_iso()
            self._runner([
                "api", "--method", "PATCH",
                "repos/%s/issues/comments/%s" % (self.repo, gh_id),
                "-f", "body=%s" % _gh_render(comment),
            ])
        return comment

    def delete(self, cid):
        with self._lock:
            gh_id, _comment = self._find_gh_id(cid)
            if gh_id is None:
                return False
            self._runner([
                "api", "--method", "DELETE",
                "repos/%s/issues/comments/%s" % (self.repo, gh_id),
            ])
            return True


def make_store(cfg: Config):
    """Factory: build the configured comment store."""
    if cfg.comment_store == "github":
        return GitHubIssueCommentStore(cfg.github_repo, cfg.github_issue)
    return FileCommentStore(cfg.comments_dir)


def make_comment(cfg: Config, body):
    if not isinstance(body, dict):
        raise HttpError(400, "body must be a JSON object")
    path = body.get("path")
    if not path or not isinstance(path, str):
        raise HttpError(400, "comment requires a 'path'")
    # Validate the path is inside root (don't require the file to exist).
    cfg.resolve_in_root(path)
    text = body.get("text")
    if not text or not isinstance(text, str) or not text.strip():
        raise HttpError(400, "comment requires non-empty 'text'")
    line = body.get("line")
    if line is not None and not isinstance(line, int):
        raise HttpError(400, "'line' must be an integer")
    side = body.get("side")
    if side is not None and side not in ("old", "new"):
        raise HttpError(400, "'side' must be 'old' or 'new'")
    rng = body.get("range")
    if rng is not None:
        if (not isinstance(rng, dict) or not isinstance(rng.get("start"), int)
                or not isinstance(rng.get("end"), int)):
            raise HttpError(400, "'range' must be {start:int, end:int}")
    author = body.get("author")
    if author is not None and not isinstance(author, str):
        raise HttpError(400, "'author' must be a string")
    return {
        "id": time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8],
        "path": path,
        "line": line,
        "side": side,
        "range": rng,
        "text": text,
        "author": author,
        "createdAt": now_iso(),
    }


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "agentic-review-local/%s" % VERSION
    protocol_version = "HTTP/1.1"

    # set by the server factory
    cfg: Config = None
    store: CommentStore = None

    # -- CORS / security helpers --------------------------------------------
    def _origin_allowed(self, origin):
        if origin is None:
            return None  # non-CORS (same-origin / curl): nothing to echo
        if not self.cfg.strict_origin:
            return origin  # dev echo (no allowlist configured)
        return origin if origin in self.cfg.allow_origins else None

    def _send_cors(self):
        origin = self.headers.get("Origin")
        allowed = self._origin_allowed(origin)
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-AR-Token")
            if self.headers.get("Access-Control-Request-Private-Network") == "true":
                self.send_header("Access-Control-Allow-Private-Network", "true")

    def _check_token(self, query):
        if not self.cfg.token:
            return
        sent = self.headers.get("X-AR-Token")
        if sent is None and query is not None:
            vals = query.get("token")
            sent = vals[0] if vals else None
        if not sent or not secrets.compare_digest(sent, self.cfg.token):
            raise HttpError(401, "invalid or missing token")

    # -- response helpers ---------------------------------------------------
    def _send_json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._send_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_bytes(self, code, body, content_type):
        self.send_response(code)
        self._send_cors()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, err: HttpError):
        self._send_json(err.code, {"status": "error", "message": err.message})

    # -- routing ------------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        self._dispatch("GET")

    def do_HEAD(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            if path in ("/ping", "/health"):
                self._send_json(200, {"status": "ok", "service": SERVICE, "version": VERSION})
                return
            if path.startswith("/api/"):
                self._check_token(query)
                self._handle_api(method, path, query)
                return
            if method == "GET":
                self._serve_static(path)
                return
            raise HttpError(404, "not found: %s" % path)
        except HttpError as e:
            self._error(e)
        except BrokenPipeError:
            pass
        except Exception as e:  # noqa: BLE001 - last-resort guard
            self._error(HttpError(500, "internal error: %s" % e))

    def _handle_api(self, method, path, query):
        cfg = self.cfg
        if path == "/api/manifest" and method == "GET":
            self._send_json(200, build_manifest(cfg))
        elif path == "/api/content" and method == "GET":
            rel = (query.get("path") or [None])[0]
            self._send_json(200, read_content(cfg, rel))
        elif path == "/api/diff" and method == "GET":
            rel = (query.get("path") or [None])[0]
            self._send_json(200, read_diff(cfg, rel))
        elif path == "/api/comments" and method == "GET":
            self._send_json(200, {"comments": self.store.list()})
        elif path == "/api/comments" and method == "POST":
            body = self._read_json_body()
            comment = make_comment(cfg, body)
            self.store.save(comment)
            self._send_json(200, {"status": "ok", "id": comment["id"]})
        elif path == "/api/comments" and method == "PUT":
            cid = (query.get("id") or [None])[0]
            if not cid:
                raise HttpError(400, "missing comment id")
            body = self._read_json_body() or {}
            text = body.get("text")
            if not isinstance(text, str) or not text.strip():
                raise HttpError(400, "edit requires non-empty 'text'")
            updated = self.store.update(cid, {"text": text})
            self._send_json(200, {"status": "ok", "comment": updated})
        elif path == "/api/comments" and method == "DELETE":
            cid = (query.get("id") or [None])[0]
            if not cid:
                raise HttpError(400, "missing comment id")
            existed = self.store.delete(cid)
            if not existed:
                raise HttpError(404, "comment not found: %s" % cid)
            self._send_json(200, {"status": "ok", "id": cid})
        elif path == "/api/cleanup" and method == "POST":
            self._send_json(200, {"status": "ok"})
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            raise HttpError(404, "no such endpoint: %s %s" % (method, path))

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise HttpError(400, "invalid JSON body")

    def _serve_static(self, path):
        if not self.cfg.site_dir:
            raise HttpError(404, "not found")
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        norm = posixpath.normpath(rel)
        if norm.startswith("..") or os.path.isabs(norm):
            raise HttpError(403, "forbidden")
        full = os.path.join(self.cfg.site_dir, norm)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            raise HttpError(404, "not found: %s" % path)
        ctype, _ = mimetypes.guess_type(full)
        with open(full, "rb") as fh:
            body = fh.read()
        self._send_bytes(200, body, ctype or "application/octet-stream")

    def log_message(self, fmt, *args):
        sys.stderr.write("[agentic-review] %s %s\n" % (self.address_string(), fmt % args))


# ---------------------------------------------------------------------------
# bootstrap
# ---------------------------------------------------------------------------

def parse_args(argv):
    p = argparse.ArgumentParser(description="agentic-review local bridge server")
    p.add_argument("--root", default=os.environ.get("AR_ROOT", os.getcwd()),
                   help="directory under review (default: $AR_ROOT or cwd)")
    p.add_argument("--port", type=int,
                   default=int(os.environ.get("AR_PORT", "8900")),
                   help="loopback port (default: 8900)")
    p.add_argument("--comments-dir", default=os.environ.get("AR_COMMENTS_DIR"),
                   help="directory to store comment JSON files (default: a temp dir)")
    p.add_argument("--diff-base", default=os.environ.get("AR_DIFF_BASE", "HEAD"),
                   help="git ref to diff against (default: HEAD = working tree vs HEAD)")
    p.add_argument("--allow-origin", action="append",
                   default=([os.environ["AR_ALLOW_ORIGIN"]]
                            if os.environ.get("AR_ALLOW_ORIGIN") else None),
                   help="allowed shell Origin (repeatable). If omitted, dev-echoes any origin.")
    p.add_argument("--token", default=os.environ.get("AR_TOKEN"),
                   help="optional per-session token required on /api/* via X-AR-Token")
    p.add_argument("--site-dir",
                   default=os.environ.get("AR_SITE_DIR",
                                          os.path.join(os.path.dirname(__file__), "..", "site")),
                   help="serve the shell from this dir for same-origin use (default: ../site)")
    p.add_argument("--no-untracked", action="store_true",
                   help="exclude untracked files from the manifest")
    p.add_argument("--comment-store", choices=("files", "github"),
                   default=os.environ.get("AR_COMMENT_STORE", "files"),
                   help="comment backend (default: files)")
    p.add_argument("--github-repo", default=os.environ.get("AR_GITHUB_REPO"),
                   help="owner/repo for --comment-store github")
    p.add_argument("--github-issue", type=int,
                   default=(int(os.environ["AR_GITHUB_ISSUE"])
                            if os.environ.get("AR_GITHUB_ISSUE") else None),
                   help="issue number to attach comments to for --comment-store github")
    # Positional port for backward-compat with the old stub (python server.py 8900).
    p.add_argument("legacy_port", nargs="?", type=int, help=argparse.SUPPRESS)
    args = p.parse_args(argv)
    if args.legacy_port is not None:
        args.port = args.legacy_port
    return args


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    cfg = Config(args)
    if not os.path.isdir(cfg.root):
        print("error: --root is not a directory: %s" % cfg.root, file=sys.stderr)
        return 2
    Handler.cfg = cfg
    Handler.store = make_store(cfg)

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", cfg.port), Handler)
    except OSError as e:
        print("error: cannot bind 127.0.0.1:%d (%s). Is the port already in use?"
              % (cfg.port, e), file=sys.stderr)
        return 1

    print("agentic-review local server v%s" % VERSION)
    print("  listening : http://127.0.0.1:%d" % cfg.port)
    print("  root      : %s" % cfg.root)
    print("  diff base : %s" % cfg.diff_base)
    if cfg.comment_store == "github":
        print("  comments  : github issue %s#%s" % (cfg.github_repo, cfg.github_issue))
    else:
        print("  comments  : %s%s" % (cfg.comments_dir,
                                      " (temp)" if cfg.comments_dir_is_temp else ""))
    if cfg.site_dir and os.path.isdir(cfg.site_dir):
        print("  shell     : http://127.0.0.1:%d/  (same-origin)" % cfg.port)
    if cfg.token:
        print("  token     : required on /api/* (X-AR-Token)")
    if not cfg.strict_origin:
        print("  origin    : DEV ECHO (no --allow-origin set; any origin accepted)")
    else:
        print("  origin    : allowlist %s" % sorted(cfg.allow_origins))
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
