"""Shared helpers for the agentic-review skill commands.

Pure stdlib, cross-platform (Windows / macOS / Linux). No shell assumptions.
"""
import hashlib
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# scripts/ -> agentic-review/ -> skills/ -> <repo root>
REPO_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", ".."))
SERVER = os.path.join(REPO_ROOT, "local-server", "server.py")

STATE_DIR = os.environ.get("AR_STATE_DIR") or os.path.join(
    os.path.expanduser("~"), ".agentic-review")
STATE_FILE = os.path.join(STATE_DIR, "session.json")

# Persistent, user-level home for per-repo review comment folders. Comments live
# OUTSIDE the repo (and outside temp dirs) so they survive a reviewer/bridge
# restart and are only ever removed on an explicit prune ('cleanup --sessions').
COMMENTS_ROOT = os.path.join(STATE_DIR, "comments")

# Loopback port allocation. Rather than every session starting its scan at the
# same 8900 (which makes concurrent launches race for the exact same port),
# each session prefers a port derived from its repo path inside this window, and
# then scans the window for the first actually-free one. Different repos land in
# different lanes; the same repo relaunches on the same lane (predictable URL).
DEFAULT_PORT = 8900
PORT_WINDOW = 200  # candidate ports: 8900..9099


def session_key(repo_root):
    """A stable, filesystem-safe key for a repo's review session.

    Same repo path -> same key, so relaunching the bridge for that repo reuses
    the same comment folder (comments are never lost on restart). Different repos
    get distinct keys. Readable prefix + short hash of the real path for
    uniqueness (two repos can share a basename).
    """
    real = os.path.realpath(repo_root)
    base = os.path.basename(real.rstrip(os.sep)) or "repo"
    slug = re.sub(r"[^A-Za-z0-9._-]", "-", base).strip("-.") or "repo"
    digest = hashlib.sha1(real.encode("utf-8", "replace")).hexdigest()[:8]
    return "%s-%s" % (slug[:40], digest)


def session_dir(repo_root):
    """Absolute path to the persistent comment folder for a repo."""
    return os.path.join(COMMENTS_ROOT, session_key(repo_root))


def list_session_dirs():
    """All per-repo comment folders under COMMENTS_ROOT (may be empty)."""
    try:
        names = sorted(os.listdir(COMMENTS_ROOT))
    except OSError:
        return []
    return [os.path.join(COMMENTS_ROOT, n) for n in names
            if os.path.isdir(os.path.join(COMMENTS_ROOT, n))]


def die(msg, code=1):
    sys.stderr.write("agentic-review: %s\n" % msg)
    sys.exit(code)


def load_state():
    if not os.path.isfile(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (ValueError, OSError):
        return None


def save_state(state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(state, fh, indent=2)
    os.replace(tmp, STATE_FILE)


def clear_state():
    try:
        os.remove(STATE_FILE)
    except OSError:
        pass


def base_url(state):
    return "http://127.0.0.1:%d" % int(state["port"])


def _request(method, url, token, body=None, timeout=10):
    data = None
    headers = {}
    if token:
        headers["X-AR-Token"] = token
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def api_get(state, path):
    return _request("GET", base_url(state) + path, state.get("token"))


def api_post(state, path, body=None):
    return _request("POST", base_url(state) + path, state.get("token"), body=body)


def api_send(state, method, path, body=None):
    """Issue an arbitrary-method request (e.g. PATCH) to the bridge."""
    return _request(method, base_url(state) + path, state.get("token"), body=body)


def ping(port, timeout=1.0):
    try:
        _request("GET", "http://127.0.0.1:%d/ping" % port, None, timeout=timeout)
        return True
    except (urllib.error.URLError, OSError, ValueError):
        return False


def find_free_port(start, window=PORT_WINDOW, avoid=None, base=DEFAULT_PORT):
    """First free loopback TCP port for a session server.

    Candidates are the window ``[base, base+window)``. Scanning begins at
    ``start`` (a repo-derived preferred port) and wraps around the window, so a
    start near the top still reaches the lower ports. Ports in ``avoid`` are
    skipped — launch.py passes ports a previous attempt already lost to a racing
    session so the retry lands somewhere new.

    The OS-level bind check rejects any port already held by *any* process on
    the machine, including another live agentic-review session's server, so
    concurrent sessions never share a port.
    """
    avoid = set(avoid or ())
    window = max(1, window)
    # An explicit AR_PORT outside the default window scans forward from itself.
    if not (base <= start < base + window):
        base, begin = start, 0
    else:
        begin = start - base
    for i in range(window):
        p = base + (begin + i) % window
        if p in avoid:
            continue
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind(("127.0.0.1", p))
            return p
        except OSError:
            continue
        finally:
            s.close()
    die("no free port in range %d-%d" % (base, base + window - 1))


def preferred_port(seed, base=DEFAULT_PORT, window=PORT_WINDOW):
    """A stable, repo-derived starting port inside ``[base, base+window)``.

    Hashing the real repo path spreads different repos/worktrees across the
    window so simultaneous launches rarely pick the same port to begin with;
    combined with find_free_port's scan + launch.py's retry, actual collisions
    self-heal. The same repo always prefers the same port.
    """
    real = os.path.realpath(seed)
    digest = hashlib.sha1(real.encode("utf-8", "replace")).digest()
    offset = int.from_bytes(digest[:4], "big") % max(1, window)
    return base + offset


def python_exe():
    return sys.executable or "python3"


def spawn_detached(args, log_path):
    """Start a background process that survives this script, cross-platform."""
    log = open(log_path, "ab")
    kwargs = dict(stdout=log, stderr=log, stdin=subprocess.DEVNULL, cwd=REPO_ROOT)
    if os.name == "nt":
        # New process group, detached from this console.
        flags = 0
        flags |= getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        kwargs["creationflags"] = flags
    else:
        kwargs["start_new_session"] = True
    return subprocess.Popen(args, **kwargs)


def process_alive(pid):
    if not pid:
        return False
    if os.name == "nt":
        out = subprocess.run(
            ["tasklist", "/FI", "PID eq %d" % pid],
            capture_output=True, text=True)
        return str(pid) in out.stdout
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def terminate(pid):
    if not pid:
        return
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(pid), "/F"],
                           capture_output=True)
        else:
            os.kill(pid, 15)  # SIGTERM
    except (OSError, ValueError):
        pass


def git_toplevel(start=None):
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, cwd=start or os.getcwd())
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, ValueError):
        pass
    return start or os.getcwd()


def run_git(args, cwd=None):
    """Run a git command in cwd and return stripped stdout ('' on failure)."""
    try:
        out = subprocess.run(["git", *args], capture_output=True, text=True,
                             cwd=cwd or os.getcwd())
        if out.returncode == 0:
            return out.stdout.strip()
    except (OSError, ValueError):
        pass
    return ""
