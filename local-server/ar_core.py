"""agentic-review bridge: shared foundation.

Constants, classification helpers, the HttpError exception, the Config object,
and the low-level git helpers. This module has no dependencies on the other
ar_* modules, so everything else can import from it.
"""
import os
import posixpath
import subprocess
import sys
from datetime import datetime, timezone


VERSION = "0.2.0"
SERVICE = "agentic-review-local-server"

# Origins always permitted to reach the bridge, in addition to any --allow-origin
# values and the loopback shell we serve ourselves. This is the project's
# published GitHub Pages shell (origin = scheme + host only, no path). Override
# or extend via --allow-origin / the AR_ALLOW_ORIGIN env var.
DEFAULT_ALLOWED_ORIGINS = ("https://wangxi-dev.github.io",)

# In-repo work folder (git-ignored) holding comments + pre-commit messages.
WORK_DIR_NAME = ".agentic-review"
PRECOMMIT_STATUS = "precommit"

# Checker plugins: small CLIs that emit JSON findings for one file.
PYTHON_EXE = sys.executable or "python3"
CHECKER_EXTS = {".py", ".js", ".mjs", ".sh"}
CHECKER_TIMEOUT = 15        # seconds per checker invocation
CHECKER_MAX_OUTPUT = 1000000
CHECKER_MAX_FINDINGS = 2000

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


def ensure_work_dir(work_dir):
    """Create the in-repo work folder and make it self-git-ignoring.

    A `.gitignore` containing `*` makes git ignore everything in the folder
    (including the comments and pre-commit messages we keep there), so the work
    folder never shows up as a change to the repo under review.
    """
    os.makedirs(work_dir, exist_ok=True)
    gi = os.path.join(work_dir, ".gitignore")
    if not os.path.exists(gi):
        try:
            with open(gi, "w", encoding="utf-8") as fh:
                fh.write("# Created by agentic-review. Ignore everything here.\n*\n")
        except OSError:
            pass


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
        # Work folder inside the repo (git-ignored) for comments + pre-commit
        # messages. Defaults to <root>/.agentic-review.
        if args.work_dir:
            self.work_dir = os.path.realpath(args.work_dir)
        else:
            self.work_dir = os.path.join(self.root, WORK_DIR_NAME)
        self.work_dir_is_default = not args.work_dir and not args.comments_dir
        ensure_work_dir(self.work_dir)
        self.precommit_dir = os.path.join(self.work_dir, "precommit")
        # Checker plugins: built-in (shipped) + user-provided (in the work dir).
        self.builtin_checkers_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)), "checkers")
        self.user_checkers_dir = os.path.join(self.work_dir, "checkers")
        if args.comments_dir:
            self.comments_dir = os.path.realpath(args.comments_dir)
            os.makedirs(self.comments_dir, exist_ok=True)
            self.comments_dir_is_temp = False
        else:
            # Default: store comments in the in-repo work folder.
            self.comments_dir = os.path.join(self.work_dir, "comments")
            os.makedirs(self.comments_dir, exist_ok=True)
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
