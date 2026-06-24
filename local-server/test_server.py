#!/usr/bin/env python3
"""Tests for the agentic-review local bridge server (stdlib unittest).

Run:  python3 local-server/test_server.py
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402


def make_cfg(root, **over):
    """Build a server.Config without argparse."""
    class A:
        pass
    a = A()
    a.root = root
    a.port = over.get("port", 8999)
    a.diff_base = over.get("diff_base", "HEAD")
    a.token = over.get("token")
    a.site_dir = over.get("site_dir")
    a.no_untracked = over.get("no_untracked", False)
    a.allow_origin = over.get("allow_origin")
    a.comments_dir = over.get("comments_dir")
    a.work_dir = over.get("work_dir")
    a.comment_store = over.get("comment_store", "files")
    a.github_repo = over.get("github_repo")
    a.github_issue = over.get("github_issue")
    return server.Config(a)


def git(root, *args):
    subprocess.run(["git", "-C", root, *args], check=True,
                   capture_output=True, text=True)


def make_repo():
    root = tempfile.mkdtemp(prefix="ar-test-repo-")
    git(root, "init", "-q")
    git(root, "config", "user.email", "t@t.com")
    git(root, "config", "user.name", "t")
    with open(os.path.join(root, "a.txt"), "w") as fh:
        fh.write("line1\nline2\nline3\n")
    with open(os.path.join(root, "doc.md"), "w") as fh:
        fh.write("# Title\n")
    with open(os.path.join(root, "img.bin"), "wb") as fh:
        fh.write(b"\x89PNG\x00\x01\x02\x03original\xff")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "init")
    # working-tree changes vs HEAD
    with open(os.path.join(root, "a.txt"), "w") as fh:
        fh.write("line1\nline2 CHANGED\nline3\nline4\n")
    os.remove(os.path.join(root, "doc.md"))
    with open(os.path.join(root, "new.js"), "w") as fh:
        fh.write("console.log('hi');\n")
    with open(os.path.join(root, "img.bin"), "wb") as fh:
        fh.write(b"\x89PNG\x00\x09\x08\x07changed\xfe")
    return root


# ---------------------------------------------------------------------------
class PathSafetyTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ar-safe-")
        os.makedirs(os.path.join(self.root, "sub"))
        with open(os.path.join(self.root, "sub", "f.txt"), "w") as fh:
            fh.write("ok")
        self.cfg = make_cfg(self.root)

    def test_valid_nested(self):
        self.assertTrue(self.cfg.resolve_in_root("sub/f.txt").endswith("f.txt"))

    def test_rejects_dotdot(self):
        with self.assertRaises(server.HttpError) as e:
            self.cfg.resolve_in_root("../etc/passwd")
        self.assertEqual(e.exception.code, 403)

    def test_rejects_deep_dotdot(self):
        with self.assertRaises(server.HttpError):
            self.cfg.resolve_in_root("sub/../../escape")

    def test_rejects_absolute(self):
        with self.assertRaises(server.HttpError) as e:
            self.cfg.resolve_in_root("/etc/passwd")
        self.assertEqual(e.exception.code, 403)

    def test_rejects_windows_absolute(self):
        with self.assertRaises(server.HttpError):
            self.cfg.resolve_in_root("C:/Windows/win.ini")

    def test_rejects_empty(self):
        with self.assertRaises(server.HttpError):
            self.cfg.resolve_in_root("")

    @unittest.skipIf(os.name == "nt", "symlink escape semantics are POSIX here")
    def test_rejects_symlink_escape(self):
        outside = tempfile.mkdtemp(prefix="ar-outside-")
        with open(os.path.join(outside, "secret"), "w") as fh:
            fh.write("top secret")
        link = os.path.join(self.root, "escape")
        os.symlink(outside, link)
        with self.assertRaises(server.HttpError) as e:
            self.cfg.resolve_in_root("escape/secret")
        self.assertEqual(e.exception.code, 403)


# ---------------------------------------------------------------------------
class ClassificationTests(unittest.TestCase):
    def test_renderer(self):
        self.assertEqual(server.renderer_for("a.md"), "markdown")
        self.assertEqual(server.renderer_for("a.html"), "html")
        self.assertEqual(server.renderer_for("a.json"), "json")
        self.assertEqual(server.renderer_for("a.py"), "code")

    def test_kind(self):
        self.assertEqual(server.kind_hint("a.png"), "binary")
        self.assertEqual(server.kind_hint("a.txt"), "text")

    def test_binary_detection(self):
        self.assertTrue(server.looks_binary(b"abc\x00def"))
        self.assertTrue(server.looks_binary(b"\xff\xfe\x00bad"))
        self.assertFalse(server.looks_binary("héllo".encode("utf-8")))


# ---------------------------------------------------------------------------
class CommentValidationTests(unittest.TestCase):
    def setUp(self):
        self.cfg = make_cfg(tempfile.mkdtemp(prefix="ar-cv-"))

    def test_requires_path(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"text": "hi"})

    def test_requires_text(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "a.txt", "text": "   "})

    def test_bad_side(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "a.txt", "text": "x", "side": "left"})

    def test_bad_range(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "a.txt", "text": "x",
                                           "range": {"start": "a", "end": 2}})

    def test_valid(self):
        c = server.make_comment(self.cfg, {"path": "a.txt", "line": 2, "side": "new",
                                           "text": "hi", "author": "me"})
        self.assertEqual(c["path"], "a.txt")
        self.assertEqual(c["line"], 2)
        self.assertIn("id", c)
        self.assertIn("createdAt", c)

    def test_path_must_be_in_root(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "../x", "text": "hi"})


# ---------------------------------------------------------------------------
class OriginPolicyTests(unittest.TestCase):
    def _allowed(self, cfg, origin):
        h = server.Handler.__new__(server.Handler)
        h.cfg = cfg
        return h._origin_allowed(origin)

    def test_dev_echo_when_no_allowlist(self):
        cfg = make_cfg(tempfile.mkdtemp(), port=8900)
        self.assertEqual(self._allowed(cfg, "https://anything.example"),
                         "https://anything.example")

    def test_strict_allows_listed(self):
        cfg = make_cfg(tempfile.mkdtemp(), port=8900,
                       allow_origin=["https://foo.bar"])
        self.assertEqual(self._allowed(cfg, "https://foo.bar"), "https://foo.bar")

    def test_strict_blocks_unlisted(self):
        cfg = make_cfg(tempfile.mkdtemp(), port=8900,
                       allow_origin=["https://foo.bar"])
        self.assertIsNone(self._allowed(cfg, "https://evil.example"))

    def test_same_origin_always_allowed(self):
        cfg = make_cfg(tempfile.mkdtemp(), port=8900,
                       allow_origin=["https://foo.bar"])
        self.assertEqual(self._allowed(cfg, "http://127.0.0.1:8900"),
                         "http://127.0.0.1:8900")

    def test_github_pages_always_allowed_in_strict_mode(self):
        # The published Pages shell is allowed even under a strict allowlist
        # that does not list it explicitly.
        cfg = make_cfg(tempfile.mkdtemp(), port=8900,
                       allow_origin=["https://foo.bar"])
        pages = server.DEFAULT_ALLOWED_ORIGINS[0]
        self.assertEqual(self._allowed(cfg, pages), pages)

    def test_default_allowed_origins_includes_pages(self):
        self.assertIn("https://wangxi-dev.github.io", server.DEFAULT_ALLOWED_ORIGINS)


# ---------------------------------------------------------------------------
class GitHubStoreTests(unittest.TestCase):
    def test_render_parse_roundtrip(self):
        c = {"id": "x1", "path": "a.txt", "line": 5, "side": "new",
             "range": None, "text": "fix this", "author": "wx",
             "createdAt": "2026-01-01T00:00:00Z"}
        body = server._gh_render(c)
        self.assertIn("fix this", body)            # human-readable
        self.assertEqual(server._gh_parse(body), c)  # machine-recoverable

    def test_parse_ignores_plain_comment(self):
        self.assertIsNone(server._gh_parse("just a normal issue comment"))

    def test_store_save_and_list_with_fake_runner(self):
        posted = []

        def fake_runner(args, input_text=None):
            if "POST" in args:
                # extract the -f body=... payload
                body = next(a.split("=", 1)[1] for a in args if a.startswith("body="))
                posted.append({"body": body})
                return ""
            # list call
            return json.dumps(posted)

        store = server.GitHubIssueCommentStore("o/r", 7, runner=fake_runner)
        c = {"id": "c1", "path": "a.txt", "line": 1, "side": "new", "range": None,
             "text": "hello", "author": None, "createdAt": "2026-01-01T00:00:00Z"}
        store.save(c)
        got = store.list()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["text"], "hello")

    def test_store_requires_repo_and_issue(self):
        with self.assertRaises(server.HttpError):
            server.GitHubIssueCommentStore(None, None)

    def test_store_edit_and_delete_with_fake_runner(self):
        # Simulate the GitHub issue-comments API: each item has an integer id
        # and a body that carries our embedded payload.
        items = []
        next_id = [100]
        calls = []

        def fake_runner(args, input_text=None):
            calls.append(args)
            if "POST" in args:
                body = next(a.split("=", 1)[1] for a in args if a.startswith("body="))
                items.append({"id": next_id[0], "body": body})
                next_id[0] += 1
                return ""
            if "PATCH" in args:
                gh = int(args[3].rsplit("/", 1)[-1])
                body = next(a.split("=", 1)[1] for a in args if a.startswith("body="))
                for it in items:
                    if it["id"] == gh:
                        it["body"] = body
                return ""
            if "DELETE" in args:
                gh = int(args[3].rsplit("/", 1)[-1])
                items[:] = [it for it in items if it["id"] != gh]
                return ""
            return json.dumps(items)  # list

        store = server.GitHubIssueCommentStore("o/r", 7, runner=fake_runner)
        c = {"id": "abc", "path": "a.txt", "line": 1, "side": "new", "range": None,
             "text": "first", "author": None, "createdAt": "2026-01-01T00:00:00Z"}
        store.save(c)
        updated = store.update("abc", {"text": "changed"})
        self.assertEqual(updated["text"], "changed")
        self.assertEqual(store.list()[0]["text"], "changed")
        self.assertTrue(store.delete("abc"))
        self.assertEqual(store.list(), [])
        self.assertFalse(store.delete("abc"))


# ---------------------------------------------------------------------------
class EndToEndHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = make_repo()
        cls.comments = tempfile.mkdtemp(prefix="ar-e2e-comments-")
        cls.cfg = make_cfg(cls.root, token="secret", comments_dir=cls.comments)
        server.Handler.cfg = cls.cfg
        server.Handler.store = server.make_store(cls.cfg)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def get(self, path, token="secret"):
        headers = {"X-AR-Token": token} if token else {}
        req = urllib.request.Request(self.url(path), headers=headers)
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())

    def post(self, path, body, token="secret"):
        return self._send("POST", path, body, token)

    def _send(self, method, path, body, token="secret"):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["X-AR-Token"] = token
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.url(path), data=data,
                                     headers=headers, method=method)
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode())

    def test_ping(self):
        st, data = self.get("/ping", token=None)
        self.assertEqual(st, 200)
        self.assertEqual(data["service"], server.SERVICE)

    def test_token_required(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/manifest", token=None)
        self.assertEqual(e.exception.code, 401)

    def test_manifest(self):
        st, data = self.get("/api/manifest")
        paths = {f["path"]: f for f in data["files"]}
        self.assertIn("a.txt", paths)
        self.assertEqual(paths["a.txt"]["status"], "modified")
        self.assertEqual(paths["doc.md"]["status"], "deleted")
        self.assertEqual(paths["new.js"]["status"], "added")
        self.assertEqual(paths["doc.md"]["renderer"], "markdown")

    def test_content(self):
        st, data = self.get("/api/content?path=a.txt")
        self.assertIn("line2 CHANGED", data["content"])

    def test_content_deleted_from_base(self):
        st, data = self.get("/api/content?path=doc.md")
        self.assertIn("# Title", data["content"])
        self.assertTrue(data.get("fromBase"))

    def test_diff(self):
        st, data = self.get("/api/diff?path=a.txt")
        self.assertIn("+line2 CHANGED", data["unified"])

    def test_diff_untracked(self):
        st, data = self.get("/api/diff?path=new.js")
        self.assertIn("new file", data["unified"])
        self.assertIn("b/new.js", data["unified"])

    def test_diff_text_not_binary(self):
        st, data = self.get("/api/diff?path=a.txt")
        self.assertFalse(data.get("binary"))

    def test_diff_binary_flagged(self):
        st, data = self.get("/api/diff?path=img.bin")
        self.assertTrue(data.get("binary"))

    def test_traversal_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/api/content?path=../../../../etc/passwd")
        self.assertEqual(e.exception.code, 403)

    def test_comment_roundtrip(self):
        st, data = self.post("/api/comments",
                             {"path": "a.txt", "line": 2, "side": "new", "text": "why?"})
        self.assertEqual(data["status"], "ok")
        st, listed = self.get("/api/comments")
        texts = [c["text"] for c in listed["comments"]]
        self.assertIn("why?", texts)

    def test_comment_edit(self):
        _, data = self.post("/api/comments",
                            {"path": "a.txt", "line": 5, "text": "before edit"})
        cid = data["id"]
        st, upd = self._send("PUT", "/api/comments?id=" + cid, {"text": "after edit"})
        self.assertEqual(st, 200)
        self.assertEqual(upd["comment"]["text"], "after edit")
        self.assertIn("updatedAt", upd["comment"])
        _, listed = self.get("/api/comments")
        match = [c for c in listed["comments"] if c["id"] == cid]
        self.assertEqual(match[0]["text"], "after edit")

    def test_comment_edit_empty_rejected(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 6, "text": "x"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._send("PUT", "/api/comments?id=" + data["id"], {"text": "   "})
        self.assertEqual(e.exception.code, 400)

    def test_comment_delete(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 7, "text": "to delete"})
        cid = data["id"]
        st, res = self._send("DELETE", "/api/comments?id=" + cid, None)
        self.assertEqual(res["status"], "ok")
        _, listed = self.get("/api/comments")
        self.assertNotIn(cid, [c["id"] for c in listed["comments"]])

    def test_comment_delete_missing(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._send("DELETE", "/api/comments?id=nonexistent", None)
        self.assertEqual(e.exception.code, 404)

    def test_tree_lists_all_files(self):
        st, data = self.get("/api/tree")
        names = [e["name"] for e in data["entries"]]
        self.assertIn("a.txt", names)          # unchanged + changed both appear
        # img.bin is a tracked file -> should be in the tree even if unchanged-by-name
        self.assertIn("img.bin", names)
        # change status is annotated
        a = [e for e in data["entries"] if e.get("name") == "a.txt"][0]
        self.assertEqual(a["status"], "modified")

    def test_tree_excludes_work_dir(self):
        st, data = self.get("/api/tree")
        names = [e["name"] for e in data["entries"]]
        self.assertNotIn(".agentic-review", names)
        self.assertNotIn(".git", names)

    def test_precommit_roundtrip_and_pseudo_entry(self):
        st, res = self.post("/api/precommit", {"message": "# Title\n\nbody"})
        self.assertEqual(res["status"], "ok")
        self.assertTrue(res["path"].startswith(".agentic-review/precommit/"))
        # appears as a pseudo entry at the top of the manifest
        _, man = self.get("/api/manifest")
        first = man["files"][0]
        self.assertTrue(first.get("pseudo"))
        self.assertEqual(first["status"], "precommit")
        # its content is served
        _, content = self.get("/api/content?path=" + first["path"])
        self.assertIn("# Title", content["content"])

    def test_precommit_empty_rejected(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/precommit", {"message": "  "})
        self.assertEqual(e.exception.code, 400)

    def test_static_shell_served(self):
        # site_dir defaults to None in make_cfg; verify 404 path handling instead
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.get("/does-not-exist", token=None)
        self.assertEqual(e.exception.code, 404)

CHECKERS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "checkers")


def run_checker_cli(name, content, args=()):
    proc = subprocess.run([sys.executable, os.path.join(CHECKERS_DIR, name), *args],
                          input=content, capture_output=True, text=True)
    return proc


class BuiltinCheckerTests(unittest.TestCase):
    def test_loc_describe(self):
        out = run_checker_cli("loc.py", "", ["--describe"]).stdout
        meta = json.loads(out)
        self.assertEqual(meta["id"], "loc")

    def test_loc_flags_long_line(self):
        content = "ok\n" + ("x" * 300) + "\n"
        res = json.loads(run_checker_cli("loc.py", content, ["f.txt"]).stdout)
        rules = [f["rule"] for f in res["findings"]]
        self.assertIn("max-line-length", rules)
        ll = [f for f in res["findings"] if f["rule"] == "max-line-length"][0]
        self.assertEqual(ll["line"], 2)

    def test_loc_flags_big_file(self):
        content = "\n".join("line%d" % i for i in range(900)) + "\n"
        res = json.loads(run_checker_cli("loc.py", content, ["big.txt"]).stdout)
        self.assertTrue(any(f["rule"] == "max-file-loc" for f in res["findings"]))

    def test_complexity_params_and_nesting(self):
        content = (
            "def big(a, b, c, d, e, f):\n"
            "    if a:\n"
            "        if b:\n"
            "            if c:\n"
            "                if d:\n"
            "                    deep = 1\n"
        )
        res = json.loads(run_checker_cli("complexity.py", content, ["x.py"]).stdout)
        rules = {f["rule"] for f in res["findings"]}
        self.assertIn("max-params", rules)
        self.assertIn("max-nesting", rules)

    def test_complexity_ignores_control_keywords(self):
        # `if (a, b, c, d, e)` shouldn't be counted as a 5-param function.
        content = "if (a):\n    pass\n"
        res = json.loads(run_checker_cli("complexity.py", content, ["x.py"]).stdout)
        self.assertFalse(any(f["rule"] == "max-params" for f in res["findings"]))


class CheckerDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="ar-chk-")
        git(self.root, "init", "-q")
        git(self.root, "config", "user.email", "t@t.com")
        git(self.root, "config", "user.name", "t")
        with open(os.path.join(self.root, "f.py"), "w") as fh:
            fh.write("x = 1\n")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "init")
        self.cfg = make_cfg(self.root)

    def test_discovers_builtins(self):
        ids = {c["id"] for c in server.discover_checkers(self.cfg)}
        self.assertIn("loc", ids)
        self.assertIn("complexity", ids)

    def test_run_checkers_structure(self):
        out = server.run_checkers(self.cfg, "f.py")
        self.assertEqual(out["path"], "f.py")
        ids = {r["id"] for r in out["results"]}
        self.assertIn("loc", ids)
        for r in out["results"]:
            self.assertIn("findings", r)

    def test_run_checkers_rejects_missing_file(self):
        with self.assertRaises(server.HttpError):
            server.run_checkers(self.cfg, "nope.py")

    def test_user_checker_discovered(self):
        cdir = self.cfg.user_checkers_dir
        os.makedirs(cdir, exist_ok=True)
        with open(os.path.join(cdir, "mine.py"), "w") as fh:
            fh.write(
                "import json,sys\n"
                "if '--describe' in sys.argv:\n"
                "    print(json.dumps({'id':'mine','name':'Mine','description':'d'}))\n"
                "else:\n"
                "    print(json.dumps({'findings':[{'line':1,'severity':'info','rule':'r','message':'hi'}]}))\n"
            )
        ids = {c["id"] for c in server.discover_checkers(self.cfg)}
        self.assertIn("mine", ids)
        out = server.run_checkers(self.cfg, "f.py", ["mine"])
        self.assertEqual(out["results"][0]["findings"][0]["message"], "hi")

    def test_check_all_changed_files(self):
        # Two changed files with violations; check-all should aggregate them.
        long_line = "x = '" + ("y" * 300) + "'\n"
        with open(os.path.join(self.root, "a.py"), "w") as fh:
            fh.write(long_line)
        with open(os.path.join(self.root, "b.py"), "w") as fh:
            fh.write("def f(a, b, c, d, e, f):\n    return 1\n")
        out = server.run_checkers_all(self.cfg, ["loc", "complexity"])
        paths = {f["path"] for f in out["files"]}
        self.assertIn("a.py", paths)
        self.assertIn("b.py", paths)
        self.assertGreaterEqual(out["summary"]["warnings"], 2)
        self.assertEqual(out["summary"]["filesWithFindings"], len(out["files"]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
