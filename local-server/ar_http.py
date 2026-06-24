"""agentic-review bridge: the HTTP handler — CORS/PNA, token auth, routing, the
static shell, and the JSON API that ties the other modules together.
"""
import html as html_lib
import json
import mimetypes
import os
import posixpath
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

from ar_core import Config, HttpError, SERVICE, VERSION
from ar_manifest import build_manifest, build_file_tree, write_precommit
from ar_content import read_content, read_diff
from ar_checkers import discover_checkers, run_checkers, run_checkers_all
from ar_comments import CommentStore, make_comment


def _inject_token(body, token):
    """Inject a <meta name="ar-token"> into an HTML page so the same-origin shell
    can authenticate without a ?token= query parameter."""
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError:
        return body
    tag = '<meta name="ar-token" content="%s">' % html_lib.escape(token, quote=True)
    if "</head>" in text:
        text = text.replace("</head>", "  " + tag + "\n</head>", 1)
    else:
        text = tag + "\n" + text
    return text.encode("utf-8")


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
        elif path == "/api/tree" and method == "GET":
            self._send_json(200, build_file_tree(cfg))
        elif path == "/api/content" and method == "GET":
            rel = (query.get("path") or [None])[0]
            self._send_json(200, read_content(cfg, rel))
        elif path == "/api/diff" and method == "GET":
            rel = (query.get("path") or [None])[0]
            pretty = (query.get("pretty") or [None])[0] in ("1", "true", "yes")
            self._send_json(200, read_diff(cfg, rel, pretty=pretty))
        elif path == "/api/checkers" and method == "GET":
            checkers = [{"id": c["id"], "name": c["name"],
                         "description": c["description"], "builtin": c["builtin"]}
                        for c in discover_checkers(cfg)]
            self._send_json(200, {"checkers": checkers})
        elif path == "/api/check" and method == "GET":
            rel = (query.get("path") or [None])[0]
            sel = (query.get("checkers") or [None])[0]
            ids = [s for s in sel.split(",") if s] if sel else None
            self._send_json(200, run_checkers(cfg, rel, ids))
        elif path == "/api/check-all" and method == "GET":
            sel = (query.get("checkers") or [None])[0]
            ids = [s for s in sel.split(",") if s] if sel else None
            self._send_json(200, run_checkers_all(cfg, ids))
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
        elif path == "/api/precommit" and method == "POST":
            body = self._read_json_body() or {}
            rel = write_precommit(cfg, body.get("message"),
                                  body.get("name") or "commit-message.md")
            self._send_json(200, {"status": "ok", "path": rel})
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
        # Same-origin shell: inject the session token into the review page so it
        # authenticates without a ?token= in the URL — opening
        # http://127.0.0.1:<port>/review.html is enough. (The hosted cross-origin
        # shell still uses ?token=; the bridge can't inject into a CDN page.)
        if self.cfg.token and os.path.basename(norm) == "review.html":
            body = _inject_token(body, self.cfg.token)
        self._send_bytes(200, body, ctype or "application/octet-stream")

    def log_message(self, fmt, *args):
        sys.stderr.write("[agentic-review] %s %s\n" % (self.address_string(), fmt % args))
