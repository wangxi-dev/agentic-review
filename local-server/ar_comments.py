"""agentic-review bridge: the pluggable comment store (files default + GitHub
issue reference backend) and comment validation/creation.
"""
import json
import os
import subprocess
import threading
import time
import uuid

from ar_core import Config, HttpError, now_iso


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
