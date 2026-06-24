#!/usr/bin/env python3
"""agentic-review local bridge server (minimal connectivity stub).

Run:
    python3 server.py [port]      # default port 8900
    PORT=8900 python3 server.py

Binds to 127.0.0.1 only (never 0.0.0.0). Provides dummy GET/POST so the static
shell in ../site can verify end-to-end connectivity. Sends permissive CORS +
Private Network Access headers so an HTTPS shell (e.g. GitHub Pages) can reach it
during testing; tighten these to an Origin allowlist for real use.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
DEFAULT_PORT = 8900


class Handler(BaseHTTPRequestHandler):
    server_version = "agentic-review-local/0.1"

    def _cors(self):
        origin = self.headers.get("Origin")
        # Echo the caller's Origin (or "*" when absent) so localhost-served,
        # file://, and GitHub Pages shells can all connect during testing.
        self.send_header("Access-Control-Allow-Origin", origin if origin else "*")
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Forward-compat with Chrome Private Network Access preflights.
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?", 1)[0] in ("/", "/ping", "/health"):
            self._json(200, {
                "status": "ok",
                "service": "agentic-review-local-server",
                "message": "connected",
            })
        else:
            self._json(404, {"status": "error", "message": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw.decode("utf-8")) if raw else None
        except (ValueError, UnicodeDecodeError):
            data = None
        # Dummy: just acknowledge receipt.
        self._json(200, {
            "status": "ok",
            "received_bytes": len(raw),
            "echo": data,
        })

    def log_message(self, fmt, *args):
        sys.stderr.write("[agentic-review] %s - %s\n" % (self.address_string(), fmt % args))


def main():
    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    elif os.environ.get("PORT"):
        port = int(os.environ["PORT"])

    httpd = ThreadingHTTPServer((HOST, port), Handler)
    print("agentic-review local server listening on http://%s:%d" % (HOST, port))
    print("  GET  /ping      -> dummy ok")
    print("  POST /comments  -> dummy ok (any path accepts POST)")
    print("Press Ctrl+C to stop.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
