"""agentic-review bridge: cross-review agent orchestration.

The portal's cross-review buttons drive three things from here:

 1. **Trigger cross-review** — spawn a BRAND-NEW reviewer agent session (its own
    fresh process, not the human's working agent) that reads the diff + the
    proposed commit message and files review comments back.
 2. **Address all open comments** — drop a task file the already-running, idle
    author agent picks up (it self-arms a poll at launch). No process is spawned
    here; the existing author keeps its context.
 3. **LGTM → commit (→ push)** — a deterministic, bridge-direct git commit.

Security: the command that gets EXECUTED comes ONLY from the user-level config at
``~/.agentic-review/config.json`` (never from repo content or the shell request
body), is run as an argument LIST (no shell interpolation; the only substitution
is the bridge-built ``{prompt}``), and is gated by a single-active-job guard.
"""
import json
import os
import subprocess
import time
import uuid

from ar_core import Config, HttpError, NO_WINDOW, PYTHON_EXE, git, now_iso


# ---------------------------------------------------------------------------
# config: agent command templates (user-level, outside any repo)
# ---------------------------------------------------------------------------
def _state_dir():
    return os.environ.get("AR_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".agentic-review")


def config_path():
    return os.path.join(_state_dir(), "config.json")


def load_agents():
    """Read the configured agent templates, or {} if none/invalid."""
    try:
        with open(config_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    agents = data.get("agents")
    return agents if isinstance(agents, dict) else {}


def _valid_spec(spec):
    return bool(isinstance(spec, dict)
                and isinstance(spec.get("command"), list)
                and spec["command"]
                and all(isinstance(p, str) for p in spec["command"]))


# ---------------------------------------------------------------------------
# built-in review-agent presets
# ---------------------------------------------------------------------------
# The COMMANDS here are hardcoded in our own source — they are NEVER read from
# repo content. So letting the human pick one by id from the portal (and storing
# that id in the repo work folder) cannot smuggle an arbitrary command into
# execution: the security model (only trusted, non-repo sources choose the
# command) is preserved. The "custom" preset spawns NOTHING — the bridge just
# builds the review prompt and hands it back for the portal to display, so the
# human can paste it into whatever agent they like.
REVIEW_PRESETS = {
    "copilot": {"label": "GitHub Copilot CLI", "agent": "copilot",
                "command": ["copilot", "-p", "{prompt}", "--allow-all-tools"],
                "modelFlag": ["--model", "{model}"],
                "models": ["gpt-5.5", "gpt-5.4", "claude-opus-4.8",
                           "claude-sonnet-4.5", "claude-sonnet-4.6"]},
    "claude": {"label": "Claude Code", "agent": "claude",
               "command": ["claude", "-p", "{prompt}",
                           "--dangerously-skip-permissions"],
               "modelFlag": ["--model", "{model}"],
               "models": ["opus", "sonnet", "haiku"]},
    "opencode": {"label": "opencode", "agent": "opencode",
                 "command": ["opencode", "run", "{prompt}"],
                 "modelFlag": ["--model", "{model}"],
                 "models": []},
    "codex": {"label": "Codex CLI", "agent": "codex",
              "command": ["codex", "exec", "{prompt}"],
              "modelFlag": ["--model", "{model}"],
              "models": []},
    "custom": {"label": "Bring your own (show prompt only)", "agent": "custom",
               "command": None},
}
DEFAULT_REVIEW_AGENT = "copilot"


def _agent_models(spec):
    """Validated model list for a spec (only if it can actually inject one)."""
    if spec.get("command") is None or not spec.get("modelFlag"):
        return []
    models = spec.get("models") or []
    return [m for m in models if isinstance(m, str) and m]


def available_review_agents():
    """All selectable review agents: built-in presets + the user's config.json
    ``review`` entry (as id ``config``) when one is present and valid."""
    agents = dict(REVIEW_PRESETS)
    spec = load_agents().get("review")
    if _valid_spec(spec):
        agents["config"] = {"label": spec.get("label") or "Custom (config.json)",
                            "agent": spec.get("agent") or "",
                            "model": spec.get("model") or "",
                            "command": list(spec["command"])}
    return agents


def _review_order(agents):
    ordered = [a for a in REVIEW_PRESETS if a in agents]
    ordered += [a for a in agents if a not in REVIEW_PRESETS]
    return ordered


# ---------------------------------------------------------------------------
# setting: which review agent is selected (repo-level, changeable anytime)
# ---------------------------------------------------------------------------
def setting_path(cfg: Config):
    return os.path.join(cfg.work_dir, "setting.json")


def load_setting(cfg: Config):
    try:
        with open(setting_path(cfg), "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def selected_review_agent(cfg: Config):
    """The chosen review-agent id, defaulting to copilot when unset/invalid."""
    agents = available_review_agents()
    sel = str(load_setting(cfg).get("reviewAgent") or "").strip()
    if sel in agents:
        return sel
    return DEFAULT_REVIEW_AGENT if DEFAULT_REVIEW_AGENT in agents \
        else next(iter(agents))


def selected_review_model(cfg: Config, agent_id=None):
    """The chosen model for the given (or current) review agent, or '' if none.

    Stored per-agent as ``reviewModels: {<agent>: <model>}`` so each agent keeps
    its own model. Validated against the agent's hardcoded model list, so the
    repo can never inject an arbitrary flag value.
    """
    agents = available_review_agents()
    aid = agent_id or selected_review_agent(cfg)
    spec = agents.get(aid) or {}
    valid = _agent_models(spec)
    models = load_setting(cfg).get("reviewModels") or {}
    sel = str(models.get(aid) or "").strip()
    return sel if sel in valid else ""


def save_setting(cfg: Config, body):
    """UI-facing: persist the human's review-agent + model choice. Both are
    validated against the known ids/lists so the repo can never inject a
    command or a flag value."""
    body = body or {}
    agents = available_review_agents()
    cur = load_setting(cfg)
    agent_id = str(cur.get("reviewAgent") or selected_review_agent(cfg)).strip()

    if "reviewAgent" in body:
        sel = str(body.get("reviewAgent") or "").strip()
        if sel not in agents:
            raise HttpError(400, "unknown review agent %r (choices: %s)"
                            % (sel, ", ".join(_review_order(agents))))
        agent_id = sel

    models = dict(cur.get("reviewModels") or {})
    if "reviewModel" in body:
        target = str(body.get("agent") or agent_id).strip()
        valid = _agent_models(agents.get(target) or {})
        model = str(body.get("reviewModel") or "").strip()
        if model and model not in valid:
            raise HttpError(400, "unknown model %r for agent %r (choices: %s)"
                            % (model, target, ", ".join(valid) or "none"))
        if model:
            models[target] = model
        else:
            models.pop(target, None)

    out = {"reviewAgent": agent_id, "reviewModels": models}
    path = setting_path(cfg)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    os.replace(tmp, path)
    return {"status": "ok", "reviewAgent": agent_id,
            "reviewModel": selected_review_model(cfg, agent_id)}


def agent_summary(cfg: Config = None):
    """What the shell needs to render the review-agent picker and gate buttons."""
    agents = available_review_agents()
    choices = [{"id": aid,
                "label": agents[aid].get("label") or aid,
                "spawns": agents[aid].get("command") is not None,
                "models": _agent_models(agents[aid]),
                "model": selected_review_model(cfg, aid) if cfg is not None else ""}
               for aid in _review_order(agents)]
    cur_agent = selected_review_agent(cfg) if cfg is not None else DEFAULT_REVIEW_AGENT
    return {
        # 'review' is now ALWAYS available (built-in presets); 'author' still
        # reflects an optional config.json entry (unused by Address all).
        "agents": {"review": True, "author": _valid_spec(load_agents().get("author"))},
        "reviewChoices": choices,
        "reviewAgent": cur_agent,
        "reviewModel": selected_review_model(cfg, cur_agent) if cfg is not None else "",
        "configPath": config_path(),
        "settingPath": setting_path(cfg) if cfg is not None else None,
    }


def _resolve_review_spec(cfg: Config):
    """The concrete spec (label/agent/command) for the currently selected agent."""
    agents = available_review_agents()
    sel = selected_review_agent(cfg)
    spec = dict(agents[sel])
    spec["id"] = sel
    spec.setdefault("role", "review-agent")
    spec["label"] = spec.get("label") or sel
    # Append the chosen model flag (validated preset value only) so the reviewer
    # runs on the model the human picked.
    model = selected_review_model(cfg, sel)
    if model and spec.get("command") is not None and spec.get("modelFlag"):
        spec["command"] = list(spec["command"]) + \
            [p.replace("{model}", model) for p in spec["modelFlag"]]
        spec["model"] = model
        spec["label"] = "%s · %s" % (spec["label"], model)
    return spec


# ---------------------------------------------------------------------------
# scripts dir (absolute, so a spawned agent can run them from any cwd)
# ---------------------------------------------------------------------------
def scripts_dir():
    here = os.path.dirname(os.path.abspath(__file__))      # .../local-server
    repo = os.path.dirname(here)                            # repo root
    return os.path.join(repo, "skills", "agentic-review", "scripts")


# ---------------------------------------------------------------------------
# jobs + tasks live as FILES under the repo work folder (no status endpoints)
# ---------------------------------------------------------------------------
def _jobs_dir(cfg):
    d = os.path.join(cfg.work_dir, "jobs")
    os.makedirs(d, exist_ok=True)
    return d


def _tasks_dir(cfg):
    d = os.path.join(cfg.work_dir, "tasks")
    os.makedirs(d, exist_ok=True)
    return d


def _new_id():
    return time.strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]


def _pid_alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", "PID eq %d" % int(pid)],
                             capture_output=True, text=True, creationflags=NO_WINDOW)
        return str(pid) in out.stdout
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError):
        return False


def active_job(cfg):
    """The single in-flight agent job, or None (clears a stale marker)."""
    marker = os.path.join(_jobs_dir(cfg), "active.json")
    try:
        with open(marker, "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except (OSError, ValueError):
        return None
    if _pid_alive(job.get("pid")):
        return job
    try:
        os.remove(marker)
    except OSError:
        pass
    return None


def _set_active(cfg, kind, pid, job_id):
    marker = os.path.join(_jobs_dir(cfg), "active.json")
    with open(marker, "w", encoding="utf-8") as fh:
        json.dump({"kind": kind, "pid": pid, "jobId": job_id,
                   "startedAt": now_iso()}, fh, indent=2)


def _guard_idle(cfg):
    busy = active_job(cfg)
    if busy:
        raise HttpError(409, "an agent job is already running (%s, pid %s)"
                        % (busy.get("kind"), busy.get("pid")))


# ---------------------------------------------------------------------------
# spawn a detached agent process (cross-platform), with identity in the env
# ---------------------------------------------------------------------------
def _spawn(spec, prompt, cwd, log_path):
    """Spawn the configured agent detached; return (proc, resolved_command)."""
    cmd = [part.replace("{prompt}", prompt) for part in spec["command"]]
    env = dict(os.environ)
    env["AR_ROLE"] = spec.get("role") or "review-agent"
    env["AR_AGENT"] = spec.get("agent") or ""
    env["AR_MODEL"] = spec.get("model") or ""
    env["AR_LABEL"] = spec.get("label") or ""
    log = open(log_path, "ab")
    kwargs = dict(stdout=log, stderr=log, stdin=subprocess.DEVNULL, cwd=cwd, env=env)
    if os.name == "nt":
        flags = 0
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        kwargs["creationflags"] = flags
    else:
        kwargs["start_new_session"] = True
    try:
        proc = subprocess.Popen(cmd, **kwargs)
    finally:
        # The child inherited its own copy of the handle; close the parent's so
        # we don't leak one open fd (and lock the log file on Windows) per spawn.
        log.close()
    return proc, cmd


def _review_prompt(cfg):
    scripts = scripts_dir()
    # Use the bridge's own Python executable, not a bare "python3": on Windows
    # python3 is often absent, which would leave a spawned reviewer unable to run
    # comment.py and file any findings.
    py = PYTHON_EXE
    # Derive the precommit path from cfg (it is configurable via --precommit-dir /
    # AR_PRECOMMIT_DIR); a hardcoded path would send the reviewer to a file that
    # doesn't exist under a custom dir, so it would review blind.
    pre_rel = os.path.relpath(cfg.precommit_dir, cfg.root).replace(os.sep, "/")
    return (
        "You are performing a CROSS-REVIEW of the current uncommitted changes in "
        "this repository, acting as the ReviewAgent. Do NOT edit any code — only "
        "file review comments.\n\n"
        "1. Read what the author intended: open the proposed commit message(s) "
        "under %s/ (e.g. %s/commit-message.md) if present.\n"
        "2. Read the diff under review: run `git diff %s` and `git status` to see "
        "every change.\n"
        "3. For each genuine issue (bug, logic error, security, unclear code) file "
        "a high-signal review comment (skip nitpicks):\n"
        "     \"%s\" \"%s/comment.py\" --path <file> --line <n> --text \"<finding>\"\n"
        "4. Finish with a brief file-level summary comment (omit --line):\n"
        "     \"%s\" \"%s/comment.py\" --path <file> --text \"<summary>\"\n"
        % (pre_rel, pre_rel, cfg.diff_base, py, scripts, py, scripts)
    )


def _precommit_text(cfg):
    """Return the staged proposed commit message(s), or '' if none/empty.

    A cross-review without this is blind — the reviewer has no statement of what
    the author intended — so trigger_review refuses without it.
    """
    pdir = cfg.precommit_dir
    if not os.path.isdir(pdir):
        return ""
    chunks = []
    try:
        names = sorted(os.listdir(pdir))
    except OSError:
        return ""
    for name in names:
        full = os.path.join(pdir, name)
        if not os.path.isfile(full) or name.startswith("."):
            continue
        try:
            with open(full, "r", encoding="utf-8") as fh:
                chunks.append(fh.read())
        except OSError:
            continue
    return "\n".join(chunks).strip()


# ---------------------------------------------------------------------------
# Part 1 — trigger cross-review (brand-new reviewer session)
# ---------------------------------------------------------------------------
def trigger_review(cfg: Config):
    spec = _resolve_review_spec(cfg)
    if not _precommit_text(cfg):
        raise HttpError(400, "stage a proposed commit message first so the reviewer "
                        "knows what the change is meant to do "
                        "(run agentic-review:precommit).")
    prompt = _review_prompt(cfg)
    # "Bring your own": we DON'T spawn anything — just hand the prompt back for
    # the portal to display so the human can run it in their own agent.
    if spec.get("command") is None:
        return {"status": "manual", "reviewAgent": spec["id"],
                "label": spec.get("label"), "command": None, "prompt": prompt}
    _guard_idle(cfg)
    job_id = _new_id()
    log_path = os.path.join(_jobs_dir(cfg), job_id + ".log")
    proc, cmd = _spawn(spec, prompt, cfg.root, log_path)
    _set_active(cfg, "review", proc.pid, job_id)
    # Persist a job record (file, not endpoint) so the UI's progress modal can
    # show the exact command + prompt we sent and stream the stdout.
    record = {"jobId": job_id, "kind": "review", "pid": proc.pid,
              "reviewAgent": spec["id"], "label": spec.get("label"),
              "command": cmd, "prompt": prompt, "startedAt": now_iso()}
    with open(os.path.join(_jobs_dir(cfg), job_id + ".json"), "w",
              encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
    return {"status": "ok", "jobId": job_id, "pid": proc.pid,
            "reviewAgent": spec["id"], "label": spec.get("label"),
            "command": cmd, "prompt": prompt}


def read_job(cfg: Config, job_id):
    """UI-facing: the job's command + prompt + live stdout + running/done status.

    This endpoint exists for the SHELL to render progress (per the project rule
    that APIs serve the UI, not agents). Agents never call it.
    """
    if not job_id or "/" in job_id or "\\" in job_id or ".." in job_id:
        raise HttpError(400, "invalid job id")
    rec_path = os.path.join(_jobs_dir(cfg), job_id + ".json")
    try:
        with open(rec_path, "r", encoding="utf-8") as fh:
            record = json.load(fh)
    except (OSError, ValueError):
        raise HttpError(404, "no such job: %s" % job_id)
    log_text = ""
    try:
        with open(os.path.join(_jobs_dir(cfg), job_id + ".log"), "r",
                  encoding="utf-8", errors="replace") as fh:
            log_text = fh.read()
    except OSError:
        pass
    if len(log_text) > 20000:               # tail only
        log_text = log_text[-20000:]
    running = _pid_alive(record.get("pid"))
    return {"jobId": job_id, "status": "running" if running else "done",
            "command": record.get("command"), "prompt": record.get("prompt"),
            "log": log_text}


# ---------------------------------------------------------------------------
# Part 2 — drop an author task (the idle author agent polls the file inbox)
# ---------------------------------------------------------------------------
TASK_ACTIONS = ("address-all",)


def drop_task(cfg: Config, body):
    action = (body or {}).get("action") or "address-all"
    if action not in TASK_ACTIONS:
        raise HttpError(400, "unknown task action: %s (expected %s)"
                        % (action, ", ".join(TASK_ACTIONS)))
    # Don't queue an author edit task while a job (e.g. a review) is in flight —
    # the author could otherwise start editing while the reviewer is still
    # reading/posting, the very race the active-job marker guards against.
    _guard_idle(cfg)
    task_id = _new_id()
    task = {"id": task_id, "action": action, "status": "pending",
            "createdAt": now_iso()}
    path = os.path.join(_tasks_dir(cfg), task_id + ".json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(task, fh, indent=2)
    os.replace(tmp, path)
    return {"status": "ok", "taskId": task_id, "action": action}


# ---------------------------------------------------------------------------
# Part 3A — bridge-direct commit (deterministic, no model)
# ---------------------------------------------------------------------------
def do_commit(cfg: Config, body, open_count):
    _guard_idle(cfg)
    body = body or {}
    require_resolved = body.get("requireResolved", True)
    if require_resolved and open_count:
        raise HttpError(409, "%d open comment(s) remain; resolve them or pass "
                        "requireResolved=false." % open_count)

    message = body.get("message")
    if not message or not str(message).strip():
        msg_path = os.path.join(cfg.precommit_dir, "commit-message.md")
        try:
            with open(msg_path, "r", encoding="utf-8") as fh:
                message = fh.read()
        except OSError:
            raise HttpError(400, "no commit message: provide 'message' or stage one "
                            "with agentic-review:precommit.")
    if not message.strip():
        raise HttpError(400, "refusing to commit with an empty message.")

    if body.get("addAll"):
        git(cfg, "add", "-A")

    # Write the message to a temp file under the work dir and commit with -F so
    # multi-line / unicode messages are preserved exactly.
    msg_file = os.path.join(cfg.work_dir, "COMMIT_MSG.tmp")
    with open(msg_file, "w", encoding="utf-8") as fh:
        fh.write(message)
    try:
        proc = git(cfg, "commit", "-F", msg_file, check=False)
    finally:
        try:
            os.remove(msg_file)
        except OSError:
            pass
    if proc.returncode != 0:
        detail = (proc.stdout or "") + (proc.stderr or "")
        raise HttpError(400, "git commit failed: %s" % detail.strip())

    sha = git(cfg, "rev-parse", "HEAD").stdout.strip()
    result = {"status": "ok", "sha": sha, "pushed": False}
    if body.get("push"):
        push = git(cfg, "push", check=False)
        result["pushed"] = push.returncode == 0
        result["pushOutput"] = ((push.stdout or "") + (push.stderr or "")).strip()
        if push.returncode != 0:
            result["status"] = "committed-not-pushed"
    return result
