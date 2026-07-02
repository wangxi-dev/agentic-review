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
    # Minified single-line JSON, modified in the working tree (the case the
    # expanded JSON diff exists for) plus a JSON file that is *not* valid JSON.
    with open(os.path.join(root, "data.json"), "w") as fh:
        fh.write('{"name":"old","nums":[1,2,3],"keep":true}')
    with open(os.path.join(root, "broken.json"), "w") as fh:
        fh.write('{"valid":1}')
    # Pretty-printed JSON that gets MINIFIED (same values) in the working tree:
    # a "formatting only" change (raw diff non-empty, expanded diff empty).
    with open(os.path.join(root, "reformat.json"), "w") as fh:
        fh.write('{\n  "x": 1,\n  "y": [1, 2, 3]\n}\n')
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
    with open(os.path.join(root, "data.json"), "w") as fh:
        fh.write('{"name":"new","nums":[1,2,9],"keep":true,"added":42}')
    with open(os.path.join(root, "broken.json"), "w") as fh:
        fh.write('{not valid json,,}')
    with open(os.path.join(root, "reformat.json"), "w") as fh:
        fh.write('{"x":1,"y":[1,2,3]}')  # same values, just minified
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

    def test_pretty_json_text(self):
        # Pretty-printing expands and preserves the document's key order.
        out = server._pretty_json_text('{"b":1,"a":2}')
        self.assertEqual(out, '{\n  "b": 1,\n  "a": 2\n}\n')
        # An empty / whitespace-only side is treated as an empty document.
        self.assertEqual(server._pretty_json_text(""), "")
        self.assertEqual(server._pretty_json_text("   \n"), "")
        self.assertIsNone(server._pretty_json_text(None))
        # Invalid JSON signals a fallback (None).
        self.assertIsNone(server._pretty_json_text("{nope}"))
        # Non-ASCII is kept literal (ensure_ascii=False).
        self.assertEqual(server._pretty_json_text('"é"'), '"é"\n')


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

    def test_new_comment_has_open_status_and_empty_replies(self):
        c = server.make_comment(self.cfg, {"path": "a.txt", "text": "hi"})
        self.assertEqual(c["status"], "open")
        self.assertEqual(c["replies"], [])

    def test_path_must_be_in_root(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "../x", "text": "hi"})


# ---------------------------------------------------------------------------
class ReplyValidationTests(unittest.TestCase):
    def test_requires_text(self):
        with self.assertRaises(server.HttpError):
            server.make_reply({"author": "agent", "text": "  "})

    def test_requires_known_author(self):
        with self.assertRaises(server.HttpError):
            server.make_reply({"author": "robot", "text": "hi"})

    def test_valid_reply(self):
        r = server.make_reply({"author": "agent", "text": "done"})
        self.assertEqual(r["author"], "agent")
        self.assertEqual(r["text"], "done")
        self.assertIn("id", r)
        self.assertIn("createdAt", r)

    def test_validate_status_rejects_unknown(self):
        with self.assertRaises(server.HttpError):
            server.validate_status("closed")

    def test_validate_status_accepts_known(self):
        self.assertEqual(server.validate_status("resolved"), "resolved")


# ---------------------------------------------------------------------------
class AuthorIdentityTests(unittest.TestCase):
    def setUp(self):
        self.cfg = make_cfg(tempfile.mkdtemp(prefix="ar-id-"))

    def test_comment_defaults_to_human(self):
        c = server.make_comment(self.cfg, {"path": "a.txt", "text": "hi"})
        self.assertEqual(c["authorRole"], "human")
        self.assertEqual(c["authorLabel"], "Human")
        self.assertIsNone(c["agent"])

    def test_comment_review_agent_label(self):
        c = server.make_comment(self.cfg, {
            "path": "a.txt", "text": "bug", "authorRole": "review-agent",
            "agent": "copilot", "model": "opus-4.8"})
        self.assertEqual(c["authorRole"], "review-agent")
        self.assertEqual(c["authorLabel"], "ReviewAgent-copilot-opus-4.8")

    def test_comment_legacy_agent_maps_to_author_agent(self):
        c = server.make_comment(self.cfg, {"path": "a.txt", "text": "x",
                                           "author": "agent"})
        self.assertEqual(c["authorRole"], "author-agent")

    def test_comment_rejects_bad_role(self):
        with self.assertRaises(server.HttpError):
            server.make_comment(self.cfg, {"path": "a.txt", "text": "x",
                                           "authorRole": "boss"})

    def test_explicit_label_wins(self):
        c = server.make_comment(self.cfg, {
            "path": "a.txt", "text": "x", "authorRole": "review-agent",
            "label": "ReviewAgent-Copilot-GPT5"})
        self.assertEqual(c["authorLabel"], "ReviewAgent-Copilot-GPT5")

    def test_reply_keeps_legacy_author_and_adds_role(self):
        r = server.make_reply({"authorRole": "review-agent", "agent": "copilot",
                               "model": "gpt-5", "text": "looks fine"})
        self.assertEqual(r["author"], "agent")          # backward-compat field
        self.assertEqual(r["authorRole"], "review-agent")
        self.assertEqual(r["authorLabel"], "ReviewAgent-copilot-gpt-5")

    def test_reply_human(self):
        r = server.make_reply({"author": "human", "text": "thanks"})
        self.assertEqual(r["author"], "human")
        self.assertEqual(r["authorRole"], "human")


# ---------------------------------------------------------------------------
class AgentConfigTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="ar-state-")
        self._old = os.environ.get("AR_STATE_DIR")
        os.environ["AR_STATE_DIR"] = self.state

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AR_STATE_DIR", None)
        else:
            os.environ["AR_STATE_DIR"] = self._old

    def test_no_config_review_always_available(self):
        # Review is now always available via built-in presets; author still
        # reflects an optional config.json entry.
        summ = server.agent_summary()
        self.assertTrue(summ["agents"]["review"])
        self.assertFalse(summ["agents"]["author"])
        ids = [c["id"] for c in summ["reviewChoices"]]
        self.assertIn("copilot", ids)
        self.assertIn("opencode", ids)
        self.assertIn("custom", ids)

    def test_config_review_appears_as_choice(self):
        with open(os.path.join(self.state, "config.json"), "w") as fh:
            json.dump({"agents": {
                "review": {"command": ["copilot", "-p", "{prompt}"],
                           "agent": "copilot", "model": "opus-4.8"}}}, fh)
        summ = server.agent_summary()
        self.assertTrue(summ["agents"]["review"])
        self.assertIn("config", [c["id"] for c in summ["reviewChoices"]])


# ---------------------------------------------------------------------------
class ReviewAgentSelectionTests(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="ar-state-")
        self._old = os.environ.get("AR_STATE_DIR")
        os.environ["AR_STATE_DIR"] = self.state
        self.root = make_repo()
        self.cfg = make_cfg(self.root)

    def tearDown(self):
        if self._old is None:
            os.environ.pop("AR_STATE_DIR", None)
        else:
            os.environ["AR_STATE_DIR"] = self._old

    def _stage_precommit(self):
        os.makedirs(self.cfg.precommit_dir, exist_ok=True)
        with open(os.path.join(self.cfg.precommit_dir, "commit-message.md"), "w") as fh:
            fh.write("feat: the change\n")

    def test_default_selection_is_copilot(self):
        self.assertEqual(server.selected_review_agent(self.cfg), "copilot")

    def test_save_setting_persists_and_reloads(self):
        res = server.save_setting(self.cfg, {"reviewAgent": "opencode"})
        self.assertEqual(res["reviewAgent"], "opencode")
        self.assertTrue(os.path.isfile(server.setting_path(self.cfg)))
        self.assertEqual(server.selected_review_agent(self.cfg), "opencode")
        self.assertEqual(server.agent_summary(self.cfg)["reviewAgent"], "opencode")

    def test_save_setting_rejects_unknown(self):
        with self.assertRaises(server.HttpError) as e:
            server.save_setting(self.cfg, {"reviewAgent": "rm-rf"})
        self.assertEqual(e.exception.code, 400)

    def test_invalid_saved_selection_falls_back(self):
        with open(server.setting_path(self.cfg), "w") as fh:
            json.dump({"reviewAgent": "gone"}, fh)
        self.assertEqual(server.selected_review_agent(self.cfg), "copilot")

    def test_custom_agent_returns_manual_prompt_no_spawn(self):
        self._stage_precommit()
        server.save_setting(self.cfg, {"reviewAgent": "custom"})
        res = server.trigger_review(self.cfg)
        self.assertEqual(res["status"], "manual")
        self.assertIsNone(res["command"])
        self.assertIn("CROSS-REVIEW", res["prompt"])
        # no job/active marker was created
        self.assertIsNone(server.active_job(self.cfg))

    def test_selected_preset_command_is_used(self):
        self._stage_precommit()
        server.save_setting(self.cfg, {"reviewAgent": "opencode"})
        spec = server._resolve_review_spec(self.cfg)
        self.assertEqual(spec["id"], "opencode")
        self.assertEqual(spec["command"][:2], ["opencode", "run"])

    def test_model_choice_persists_per_agent(self):
        server.save_setting(self.cfg, {"reviewAgent": "copilot"})
        res = server.save_setting(self.cfg, {"agent": "copilot",
                                             "reviewModel": "gpt-5.5"})
        self.assertEqual(res["reviewModel"], "gpt-5.5")
        self.assertEqual(server.selected_review_model(self.cfg, "copilot"), "gpt-5.5")
        # a different agent keeps its own (empty) model
        self.assertEqual(server.selected_review_model(self.cfg, "claude"), "")

    def test_model_flag_appended_to_command(self):
        server.save_setting(self.cfg, {"reviewAgent": "copilot",
                                       "agent": "copilot", "reviewModel": "gpt-5.4"})
        spec = server._resolve_review_spec(self.cfg)
        self.assertIn("--model", spec["command"])
        self.assertIn("gpt-5.4", spec["command"])
        self.assertEqual(spec["model"], "gpt-5.4")

    def test_unknown_model_rejected(self):
        with self.assertRaises(server.HttpError) as e:
            server.save_setting(self.cfg, {"agent": "copilot",
                                           "reviewModel": "evil; rm -rf"})
        self.assertEqual(e.exception.code, 400)

    def test_agent_summary_exposes_models(self):
        summary = server.agent_summary(self.cfg)
        by_id = {c["id"]: c for c in summary["reviewChoices"]}
        self.assertIn("gpt-5.5", by_id["copilot"]["models"])
        self.assertEqual(by_id["opencode"]["models"], [])
        self.assertIn("reviewModel", summary)

    def test_clearing_model_falls_back_to_default(self):
        server.save_setting(self.cfg, {"agent": "copilot", "reviewModel": "gpt-5.5"})
        server.save_setting(self.cfg, {"agent": "copilot", "reviewModel": ""})
        self.assertEqual(server.selected_review_model(self.cfg, "copilot"), "")
        spec = server._resolve_review_spec(self.cfg)
        self.assertNotIn("--model", spec["command"])


# ---------------------------------------------------------------------------
class TaskAndCommitTests(unittest.TestCase):
    def setUp(self):
        self.root = make_repo()
        self.cfg = make_cfg(self.root)

    def test_drop_task_writes_file(self):
        res = server.drop_task(self.cfg, {"action": "address-all"})
        self.assertEqual(res["action"], "address-all")
        path = os.path.join(self.cfg.work_dir, "tasks", res["taskId"] + ".json")
        self.assertTrue(os.path.isfile(path))

    def test_drop_task_rejects_unknown_action(self):
        with self.assertRaises(server.HttpError):
            server.drop_task(self.cfg, {"action": "rm-rf"})

    def test_drop_task_blocked_while_job_active(self):
        # Simulate an in-flight job owned by THIS (alive) process.
        jobs = os.path.join(self.cfg.work_dir, "jobs")
        os.makedirs(jobs, exist_ok=True)
        with open(os.path.join(jobs, "active.json"), "w") as fh:
            json.dump({"kind": "review", "pid": os.getpid(), "jobId": "x"}, fh)
        with self.assertRaises(server.HttpError) as e:
            server.drop_task(self.cfg, {"action": "address-all"})
        self.assertEqual(e.exception.code, 409)

    def test_read_job_returns_command_and_log(self):
        jobs = os.path.join(self.cfg.work_dir, "jobs")
        os.makedirs(jobs, exist_ok=True)
        jid = "20260101T000000-deadbeef"
        with open(os.path.join(jobs, jid + ".json"), "w") as fh:
            json.dump({"jobId": jid, "pid": 1, "command": ["copilot", "-p", "x"],
                       "prompt": "review this"}, fh)
        with open(os.path.join(jobs, jid + ".log"), "w") as fh:
            fh.write("reviewing...\nfiled 2 comments\n")
        job = server.read_job(self.cfg, jid)
        self.assertEqual(job["command"], ["copilot", "-p", "x"])
        self.assertIn("filed 2 comments", job["log"])
        self.assertIn(job["status"], ("running", "done"))

    def test_read_job_unknown(self):
        with self.assertRaises(server.HttpError):
            server.read_job(self.cfg, "nope")

    def test_commit_uses_precommit_message(self):
        os.makedirs(self.cfg.precommit_dir, exist_ok=True)
        with open(os.path.join(self.cfg.precommit_dir, "commit-message.md"), "w") as fh:
            fh.write("feat: the change\n")
        res = server.do_commit(self.cfg, {"addAll": True, "requireResolved": False},
                               open_count=0)
        self.assertEqual(res["status"], "ok")
        self.assertTrue(res["sha"])
        log = subprocess.run(["git", "-C", self.root, "log", "-1", "--pretty=%s"],
                             capture_output=True, text=True)
        self.assertIn("feat: the change", log.stdout)

    def test_commit_blocked_by_open_comments(self):
        with self.assertRaises(server.HttpError) as e:
            server.do_commit(self.cfg, {"addAll": True}, open_count=3)
        self.assertEqual(e.exception.code, 409)

    def test_commit_explicit_message(self):
        res = server.do_commit(self.cfg, {"addAll": True, "requireResolved": False,
                                          "message": "chore: inline msg"}, open_count=0)
        self.assertEqual(res["status"], "ok")

    def test_review_requires_precommit(self):
        state = tempfile.mkdtemp(prefix="ar-state-")
        old = os.environ.get("AR_STATE_DIR")
        os.environ["AR_STATE_DIR"] = state
        try:
            with open(os.path.join(state, "config.json"), "w") as fh:
                json.dump({"agents": {"review": {
                    "command": ["python", "-c", "pass"], "agent": "x", "model": "y"}}}, fh)
            # No precommit message staged -> refuse (before any spawn).
            with self.assertRaises(server.HttpError) as e:
                server.trigger_review(self.cfg)
            self.assertEqual(e.exception.code, 400)
            self.assertIn("commit message", e.exception.message)
        finally:
            if old is None:
                os.environ.pop("AR_STATE_DIR", None)
            else:
                os.environ["AR_STATE_DIR"] = old


# ---------------------------------------------------------------------------
class AddressTaskMarkerTests(unittest.TestCase):
    """The author's next-task.py claim/done should set/clear the single active-job
    marker so a racing commit or cross-review is blocked while it addresses."""

    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="ar-nt-state-")
        self.root = make_repo()
        self.cfg = make_cfg(self.root)
        with open(os.path.join(self.state, "session.json"), "w") as fh:
            json.dump({"workDir": self.cfg.work_dir, "authorPid": os.getpid()}, fh)
        self.scripts = server.scripts_dir()

    def _run(self, *args):
        env = dict(os.environ, AR_STATE_DIR=self.state)
        return subprocess.run(
            [sys.executable, os.path.join(self.scripts, "next-task.py"), *args],
            capture_output=True, text=True, env=env)

    def test_claim_sets_and_done_clears_active_marker(self):
        res = server.drop_task(self.cfg, {"action": "address-all"})
        tid = res["taskId"]
        # Claim it -> active marker written; guard now blocks a racing job.
        r = self._run()
        self.assertEqual(r.returncode, 0, r.stderr)
        busy = server.active_job(self.cfg)
        self.assertIsNotNone(busy)
        self.assertEqual(busy["kind"], "address-all")
        with self.assertRaises(server.HttpError) as e:
            server.drop_task(self.cfg, {"action": "address-all"})
        self.assertEqual(e.exception.code, 409)
        # Finishing clears the marker so work can flow again.
        r2 = self._run("--done", tid)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        self.assertIsNone(server.active_job(self.cfg))
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

    def test_store_reply_and_status_with_fake_runner(self):
        items = []
        next_id = [200]

        def fake_runner(args, input_text=None):
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
            return json.dumps(items)  # list

        store = server.GitHubIssueCommentStore("o/r", 7, runner=fake_runner)
        store.save({"id": "z1", "path": "a.txt", "line": 1, "side": None, "range": None,
                    "text": "do x", "author": None, "createdAt": "2026-01-01T00:00:00Z",
                    "status": "open", "replies": []})
        store.add_reply("z1", {"id": "r1", "author": "agent", "text": "done",
                               "createdAt": "2026-01-02T00:00:00Z"})
        store.set_status("z1", "resolved")
        got = store.list()[0]
        self.assertEqual(got["status"], "resolved")
        self.assertEqual(len(got["replies"]), 1)
        self.assertEqual(got["replies"][0]["author"], "agent")


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

    def test_diff_json_raw_is_single_line(self):
        # Without pretty, a minified JSON change is one removed + one added line.
        st, data = self.get("/api/diff?path=data.json")
        self.assertNotIn("pretty", data)
        self.assertIn('-{"name":"old"', data["unified"])
        self.assertIn('+{"name":"new"', data["unified"])

    def test_diff_json_pretty_is_line_oriented(self):
        # With pretty=1, both sides are expanded so the diff is line-oriented:
        # only the actually-changed fields show as -/+ lines, not the whole blob.
        st, data = self.get("/api/diff?path=data.json&pretty=1")
        self.assertTrue(data.get("pretty"))
        self.assertFalse(data.get("binary"))
        u = data["unified"]
        self.assertIn("diff --git a/data.json b/data.json", u)
        self.assertIn('-  "name": "old"', u)
        self.assertIn('+  "name": "new"', u)
        # Only the changed array element churns; the rest stays as context.
        self.assertIn("-    3\n", u)
        self.assertIn("+    9\n", u)
        self.assertIn("     1,\n", u)   # unchanged array element -> context line
        # The new key appears as an addition.
        self.assertIn('+  "added": 42', u)
        # A real value change is not "formatting only".
        self.assertFalse(data.get("formattingOnly"))

    def test_diff_json_pretty_formatting_only(self):
        # reformat.json is the same data, just minified in the working tree: the
        # raw diff is non-empty but the expanded diff is empty -> formattingOnly.
        st, pretty = self.get("/api/diff?path=reformat.json&pretty=1")
        self.assertTrue(pretty.get("pretty"))
        self.assertEqual(pretty["unified"], "")
        self.assertTrue(pretty.get("formattingOnly"))
        # The underlying raw diff is genuinely non-empty (whitespace changed).
        st, raw = self.get("/api/diff?path=reformat.json")
        self.assertTrue(raw["unified"].strip())

    def test_diff_json_pretty_falls_back_when_invalid(self):
        # broken.json is valid JSON in the base but not in the working tree, so
        # the server can't expand it and falls back to the raw diff (no pretty).
        st, data = self.get("/api/diff?path=broken.json&pretty=1")
        self.assertNotEqual(data.get("pretty"), True)
        self.assertTrue(data["unified"].strip())

    def test_diff_pretty_ignored_for_non_json(self):
        # pretty=1 on a non-JSON file is a no-op (raw diff, no pretty flag).
        st, data = self.get("/api/diff?path=a.txt&pretty=1")
        self.assertNotIn("pretty", data)
        self.assertIn("+line2 CHANGED", data["unified"])

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

    def test_comment_reply_appends_to_thread(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 3, "text": "fix this"})
        cid = data["id"]
        st, res = self.post("/api/comments/reply?id=" + cid,
                            {"author": "agent", "text": "done in abc123"})
        self.assertEqual(st, 200)
        self.assertEqual(res["comment"]["replies"][0]["author"], "agent")
        self.assertEqual(res["comment"]["replies"][0]["text"], "done in abc123")
        _, listed = self.get("/api/comments")
        match = [c for c in listed["comments"] if c["id"] == cid][0]
        self.assertEqual(len(match["replies"]), 1)

    def test_comment_reply_rejects_bad_author(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 3, "text": "x"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/comments/reply?id=" + data["id"],
                      {"author": "nobody", "text": "hi"})
        self.assertEqual(e.exception.code, 400)

    def test_comment_status_patch(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 4, "text": "x"})
        cid = data["id"]
        st, res = self._send("PATCH", "/api/comments?id=" + cid, {"status": "resolved"})
        self.assertEqual(st, 200)
        self.assertEqual(res["comment"]["status"], "resolved")
        _, listed = self.get("/api/comments")
        match = [c for c in listed["comments"] if c["id"] == cid][0]
        self.assertEqual(match["status"], "resolved")

    def test_comment_status_rejects_unknown(self):
        _, data = self.post("/api/comments", {"path": "a.txt", "line": 4, "text": "x"})
        with self.assertRaises(urllib.error.HTTPError) as e:
            self._send("PATCH", "/api/comments?id=" + data["id"], {"status": "closed"})
        self.assertEqual(e.exception.code, 400)

    def test_reply_missing_comment(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/comments/reply?id=nope", {"author": "agent", "text": "hi"})
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

    def test_agents_endpoint_shape(self):
        st, data = self.get("/api/agents")
        self.assertEqual(st, 200)
        self.assertIn("review", data["agents"])
        self.assertIn("author", data["agents"])
        self.assertIsInstance(data["agents"]["review"], bool)
        self.assertIn("configPath", data)
        # new: selectable review-agent picker
        self.assertIn("reviewAgent", data)
        ids = [c["id"] for c in data["reviewChoices"]]
        self.assertIn("opencode", ids)
        self.assertIn("custom", ids)

    def test_post_without_body_read_keeps_keepalive_intact(self):
        # Regression: a POST handler that doesn't read its body must not leave
        # the body in the socket, or it bleeds into the NEXT keep-alive request
        # (method "{}GET" -> HTTP 501). Reuse ONE connection for POST then GET.
        import http.client
        conn = http.client.HTTPConnection("127.0.0.1", self.port)
        try:
            conn.request("POST", "/api/agent/review", body=b"{}",
                         headers={"Content-Type": "application/json",
                                  "X-AR-Token": "secret"})
            r1 = conn.getresponse(); r1.read()   # 400 (no precommit) is fine
            conn.request("GET", "/api/manifest", headers={"X-AR-Token": "secret"})
            r2 = conn.getresponse(); r2.read()
            self.assertEqual(r2.status, 200)     # was 501 before the drain fix
        finally:
            conn.close()

    def test_task_drop_endpoint(self):
        st, data = self.post("/api/task", {"action": "address-all"})
        self.assertEqual(st, 200)
        self.assertIn("taskId", data)
        path = os.path.join(self.cfg.work_dir, "tasks", data["taskId"] + ".json")
        self.assertTrue(os.path.isfile(path))

    def test_task_drop_rejects_bad_action(self):
        with self.assertRaises(urllib.error.HTTPError) as e:
            self.post("/api/task", {"action": "danger"})
        self.assertEqual(e.exception.code, 400)


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


class StaticTokenInjectionTests(unittest.TestCase):
    """The same-origin shell (review.html) gets the session token injected so it
    authenticates without a ?token= query; other static pages do not."""

    @classmethod
    def setUpClass(cls):
        cls.root = make_repo()
        cls.site = tempfile.mkdtemp(prefix="ar-site-")
        with open(os.path.join(cls.site, "review.html"), "w") as fh:
            fh.write("<!DOCTYPE html><html><head><title>shell</title></head>"
                     "<body></body></html>")
        with open(os.path.join(cls.site, "index.html"), "w") as fh:
            fh.write("<!DOCTYPE html><html><head><title>home</title></head>"
                     "<body></body></html>")
        cls.cfg = make_cfg(cls.root, token="secret", site_dir=cls.site)
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

    def _raw(self, path):
        url = "http://127.0.0.1:%d%s" % (self.port, path)
        with urllib.request.urlopen(url) as r:
            return r.read().decode("utf-8")

    def test_review_html_has_token_meta(self):
        body = self._raw("/review.html")
        self.assertIn('<meta name="ar-token" content="secret">', body)

    def test_index_html_has_no_token_meta(self):
        body = self._raw("/")
        self.assertNotIn("ar-token", body)


class SessionStorageTests(unittest.TestCase):
    """Per-repo persistent comment folder keying (scripts/common.py)."""

    @classmethod
    def setUpClass(cls):
        scripts = os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "skills", "agentic-review", "scripts"))
        sys.path.insert(0, scripts)
        import common as ar_common  # noqa: E402
        cls.C = ar_common

    def test_session_key_is_stable_for_same_path(self):
        k1 = self.C.session_key("/some/repo/path")
        k2 = self.C.session_key("/some/repo/path")
        self.assertEqual(k1, k2)

    def test_session_key_differs_for_different_paths(self):
        a = self.C.session_key("/repo/one")
        b = self.C.session_key("/repo/two")
        self.assertNotEqual(a, b)

    def test_session_key_distinguishes_same_basename(self):
        # Two different repos that share a basename must not collide.
        a = self.C.session_key("/home/alice/proj")
        b = self.C.session_key("/home/bob/proj")
        self.assertNotEqual(a, b)

    def test_session_key_is_filesystem_safe(self):
        k = self.C.session_key("/weird/name with spaces & symbols!")
        self.assertTrue(all(c.isalnum() or c in "._-" for c in k), k)

    def test_session_dir_is_under_comments_root(self):
        d = self.C.session_dir("/some/repo")
        self.assertEqual(os.path.dirname(d), self.C.COMMENTS_ROOT)


class MetaJsonIgnoredTests(unittest.TestCase):
    """A meta.json sharing the comments folder must not read as a comment."""

    def test_meta_json_is_not_a_comment(self):
        d = tempfile.mkdtemp(prefix="ar-meta-")
        store = server.FileCommentStore(d)
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump({"repoRoot": "/x", "branch": "main"}, fh)
        self.assertEqual(store.list(), [])
        store.save({"id": "c1", "path": "a.py", "line": 1, "text": "hi",
                    "createdAt": "2026-01-01T00:00:00Z"})
        got = store.list()
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["id"], "c1")


if __name__ == "__main__":
    unittest.main(verbosity=2)
