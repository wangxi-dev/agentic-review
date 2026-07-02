/* Cross-review controls: the topbar buttons + agent/model pickers.
 *   ⇄ Cross-review   — spawn a brand-new reviewer agent (POST /api/agent/review)
 *                       and open a modal showing the command + prompt + live
 *                       stdout (polled from GET /api/job) until it finishes.
 *   ✎ Address all    — drop an "address all open comments" task for the idle
 *                       author agent (POST /api/task)
 *   ✓ LGTM → commit  — deterministic, bridge-direct git commit (POST /api/commit)
 *
 * Buttons are gated on GET /api/agents. /api/job is a UI-only endpoint (the shell
 * renders progress with it); agents never call it.
 *
 * Progress is tracked by a single module-level job controller that keeps polling
 * /api/job independently of the modal DOM: the modal can be HIDDEN (not closed)
 * and reopened from the topbar status icon while the reviewer keeps running. The
 * poll does a LIGHT comments-only refresh so the page no longer appears to
 * constantly reload the open file.
 */
import { $, el, clear, apiGet, apiPost } from "./core.js";
import { refreshCommentsOnly } from "./comments.js";

function setStatus(text, isError) {
  var s = $("xr-status");
  if (!s) return;
  s.textContent = text || "";
  s.className = "xr-status small" + (isError ? " err" : "");
}

// Latest /api/agents choices, so the model picker can repopulate when the agent
// dropdown changes without another round-trip.
var lastChoices = [];

async function refreshAgents() {
  var review = $("xr-review"), address = $("xr-address"), sel = $("xr-agent");
  // "Address all" never needs a configured command: it only drops a task file
  // that the ALREADY-RUNNING (idle) author agent picks up. So it's always
  // enabled as long as the bridge is reachable.
  gate(address, true, "");
  try {
    var data = await apiGet("/api/agents");
    // Cross-review is now ALWAYS available: the reviewer command comes from a
    // built-in preset (or the user's config.json), chosen in the dropdown.
    gate(review, data.agents && data.agents.review, "");
    lastChoices = data.reviewChoices || [];
    populateAgents(sel, lastChoices, data.reviewAgent);
    populateModels(data.reviewAgent);
  } catch (e) {
    gate(review, false, "agents unavailable: " + e.message);
  }
}

// Fill the agent picker and select the persisted choice. Changing it POSTs the
// new selection to /api/setting so it sticks (and can be changed at any moment),
// then repopulates the model picker for the newly chosen agent.
function populateAgents(sel, choices, current) {
  if (!sel) return;
  if (sel.options.length !== choices.length) {
    clear(sel);
    choices.forEach(function (c) {
      var o = el("option", "", c.label + (c.spawns ? "" : " · manual"));
      o.value = c.id;
      sel.appendChild(o);
    });
  }
  if (current) sel.value = current;
  if (sel.dataset.bound !== "1") {
    sel.dataset.bound = "1";
    sel.addEventListener("change", async function () {
      try {
        await apiPost("/api/setting", { reviewAgent: sel.value });
        setStatus("review agent set to " + sel.value);
      } catch (e) {
        setStatus("could not save agent: " + e.message, true);
      }
      populateModels(sel.value);
    });
  }
}

// Fill the model picker for a given agent id from the cached choices. Agents with
// no selectable models (opencode, codex, "bring your own") hide the dropdown.
function populateModels(agentId) {
  var msel = $("xr-model");
  if (!msel) return;
  var choice = lastChoices.filter(function (c) { return c.id === agentId; })[0];
  var models = (choice && choice.models) || [];
  if (!models.length) {
    msel.hidden = true;
    clear(msel);
    return;
  }
  msel.hidden = false;
  clear(msel);
  var def = el("option", "", "default model");
  def.value = "";
  msel.appendChild(def);
  models.forEach(function (m) {
    var o = el("option", "", m);
    o.value = m;
    msel.appendChild(o);
  });
  msel.value = (choice && choice.model) || "";
  if (msel.dataset.bound !== "1") {
    msel.dataset.bound = "1";
    msel.addEventListener("change", async function () {
      var agent = $("xr-agent") ? $("xr-agent").value : agentId;
      try {
        await apiPost("/api/setting", { agent: agent, reviewModel: msel.value });
        setStatus(msel.value ? ("model set to " + msel.value)
                             : "using the agent's default model");
      } catch (e) {
        setStatus("could not save model: " + e.message, true);
      }
    });
  }
}

function gate(btn, enabled, disabledTitle) {
  if (!btn) return;
  btn.disabled = !enabled;
  btn.title = enabled ? btn.dataset.title : disabledTitle;
}

export function initCrossReview() {
  var review = $("xr-review"), address = $("xr-address"), commit = $("xr-commit");
  if (!review) return; // topbar without the controls

  review.addEventListener("click", async function () {
    review.disabled = true;
    setStatus("starting reviewer…");
    try {
      var r = await apiPost("/api/agent/review", {});
      if (r.status === "manual") {
        // "Bring your own": nothing was spawned. Show the prompt to copy.
        setStatus("copy the prompt and run it in your own agent.");
        openManualModal(r);
      } else {
        setStatus("reviewer running — see the progress window.");
        startJob(r);
      }
    } catch (e) {
      setStatus("review failed: " + e.message, true);
    } finally {
      setTimeout(refreshAgents, 500);
    }
  });

  address.addEventListener("click", async function () {
    setStatus("queuing task for the author agent…");
    try {
      await apiPost("/api/task", { action: "address-all" });
      setStatus("task queued — the author agent will address all open comments.");
      pollComments(60, 4000);
    } catch (e) {
      setStatus("could not queue task: " + e.message, true);
    }
  });

  commit.addEventListener("click", async function () {
    var push = window.confirm("Push to the remote after committing?\n\nOK = commit AND push\nCancel = commit only");
    var body = { addAll: true, push: push, requireResolved: true };
    if (!window.confirm("Commit all changes using the proposed commit message"
        + (push ? " and PUSH" : "") + "?")) return;
    commit.disabled = true;
    setStatus("committing…");
    try {
      var r = await apiPost("/api/commit", body);
      var msg = "committed " + (r.sha || "").slice(0, 8);
      if (push) msg += r.pushed ? " · pushed ✓" : " · push FAILED";
      setStatus(msg, !push ? false : !r.pushed);
      await refreshCommentsOnly();
    } catch (e) {
      // 409 when open threads remain (or push asked but not resolved).
      if (/open comment/i.test(e.message) &&
          window.confirm(e.message + "\n\nCommit anyway (ignore open comments)?")) {
        try {
          body.requireResolved = false;
          var r2 = await apiPost("/api/commit", body);
          setStatus("committed " + (r2.sha || "").slice(0, 8) +
                    (push ? (r2.pushed ? " · pushed ✓" : " · push FAILED") : ""));
          await refreshCommentsOnly();
        } catch (e2) {
          setStatus("commit failed: " + e2.message, true);
        }
      } else {
        setStatus("commit failed: " + e.message, true);
      }
    } finally {
      commit.disabled = false;
    }
  });

  var jobBtn = $("xr-job");
  if (jobBtn) jobBtn.addEventListener("click", function () { showJobModal(); });

  refreshAgents();
}

// Lightweight progress for "Address all": poll the comment store (NOT the whole
// page) a few times so the human watches replies / resolutions stream in without
// the open file re-rendering under them.
function pollComments(times, everyMs) {
  var n = 0;
  var t = setInterval(async function () {
    n += 1;
    try { await refreshCommentsOnly(); } catch (e) { /* transient */ }
    if (n >= times) clearInterval(t);
  }, everyMs);
}

// ---- background job controller ---------------------------------------
// One in-flight cross-review at a time. The controller owns the poll loop and
// the topbar status icon; the modal is just an optional view onto it.
var job = null;   // { id, command, prompt, status, log, pollErrors, timer, overlay }

function startJob(start) {
  if (job && job.timer) clearTimeout(job.timer);
  job = {
    id: start.jobId,
    command: (start.command || []).join(" "),
    prompt: start.prompt || "",
    status: "running",
    log: "waiting for output…",
    pollErrors: 0,
    timer: null,
    overlay: null,
  };
  updateJobButton();
  showJobModal();
  pollJob();
}

function pollJob() {
  if (!job) return;
  apiGet("/api/job?id=" + encodeURIComponent(job.id)).then(async function (data) {
    if (!job) return;
    job.pollErrors = 0;
    job.log = data.log || "waiting for output…";
    if (data.status === "done") {
      job.status = "done";
    } else if (job.status !== "done") {
      job.status = "running";
    }
    updateJobButton();
    updateJobModal();
    // Light refresh so streamed-in review comments appear without nuking the
    // open file / scroll position.
    try { await refreshCommentsOnly(); } catch (e) { /* transient */ }
    if (job.status === "done") {
      setStatus("review complete — see the comments.");
      return; // stop polling
    }
    job.timer = setTimeout(pollJob, 2500);
  }).catch(function (e) {
    if (!job) return;
    job.pollErrors += 1;
    if (job.pollErrors <= 5) {
      // transient — keep polling, note it but don't declare failure
      job.status = "reconnecting";
      updateJobButton();
      updateJobModal();
      job.timer = setTimeout(pollJob, 2500);
      return;
    }
    job.status = "error";
    job.log = (job.log || "") + "\n[poll error: " + e.message + "]";
    updateJobButton();
    updateJobModal();
  });
}

// The topbar pill that reflects job state and reopens a hidden modal.
function updateJobButton() {
  var btn = $("xr-job"), icon = $("xr-job-icon"), label = $("xr-job-label");
  if (!btn) return;
  if (!job) { btn.hidden = true; return; }
  btn.hidden = false;
  var map = {
    running: ["●", "reviewing…", "running"],
    reconnecting: ["◐", "reconnecting…", "running"],
    done: ["✓", "review done", "done"],
    error: ["!", "review error", "error"],
  };
  var m = map[job.status] || map.running;
  if (icon) icon.textContent = m[0];
  if (label) label.textContent = m[1];
  btn.className = "xr-job state-" + m[2];
  btn.title = "Show the cross-review progress window (" + job.status + ")";
}

// ---- review progress modal (hide-not-close) --------------------------
// Builds/attaches the overlay for the CURRENT job. Hiding detaches the overlay
// but leaves the controller polling; reopening rebuilds it from live job state.
function showJobModal() {
  if (!job) return;
  if (job.overlay) return; // already visible

  var overlay = el("div", "xr-modal-overlay");
  var box = el("div", "xr-modal");
  var head = el("div", "xr-modal-head");
  head.appendChild(el("strong", "", "Cross-review in progress"));
  var pill = el("span", "pill", "");
  pill.dataset.role = "pill";
  head.appendChild(pill);
  head.appendChild(el("span", "spacer"));
  var hide = el("button", "ghost", "hide");
  hide.title = "Hide this window — the review keeps running in the background";
  head.appendChild(hide);
  box.appendChild(head);

  box.appendChild(el("div", "xr-modal-label", "Command"));
  box.appendChild(el("pre", "xr-modal-cmd", job.command));

  var promptWrap = el("details", "xr-modal-prompt");
  promptWrap.appendChild(el("summary", "", "Prompt sent to the reviewer"));
  promptWrap.appendChild(el("pre", "", job.prompt));
  box.appendChild(promptWrap);

  box.appendChild(el("div", "xr-modal-label", "Output (stdout)"));
  var logEl = el("pre", "xr-modal-log", job.log);
  logEl.dataset.role = "log";
  box.appendChild(logEl);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  job.overlay = overlay;

  function hideModal() {
    if (job) job.overlay = null;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }
  hide.addEventListener("click", hideModal);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) hideModal(); });

  updateJobModal();
}

// Push current job state into the open overlay (if any). No-op when hidden.
function updateJobModal() {
  if (!job || !job.overlay) return;
  var pill = job.overlay.querySelector('[data-role="pill"]');
  var logEl = job.overlay.querySelector('[data-role="log"]');
  if (pill) {
    var text = { running: "running…", reconnecting: "reconnecting…",
                 done: "done ✓", error: "error" }[job.status] || "running…";
    var cls = job.status === "done" ? "pill ok"
            : job.status === "error" ? "pill err" : "pill";
    pill.textContent = text;
    pill.className = cls;
  }
  if (logEl) {
    var atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
    logEl.textContent = job.log || "waiting for output…";
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }
}

// ---- "bring your own" modal ------------------------------------------
// No agent was spawned; show the built review prompt so the human can copy it
// into whatever agent they prefer.
function openManualModal(start) {
  var overlay = el("div", "xr-modal-overlay");
  var box = el("div", "xr-modal");
  var head = el("div", "xr-modal-head");
  head.appendChild(el("strong", "", "Bring your own reviewer"));
  head.appendChild(el("span", "spacer"));
  var close = el("button", "ghost", "close");
  head.appendChild(close);
  box.appendChild(head);

  box.appendChild(el("div", "xr-modal-label",
    "No process was started. Copy this prompt and run it in your own agent "
    + "(it files comments via comment.py):"));
  var pre = el("pre", "xr-modal-log", start.prompt || "");
  box.appendChild(pre);
  var copy = el("button", "", "Copy prompt");
  copy.addEventListener("click", function () {
    if (navigator.clipboard) navigator.clipboard.writeText(start.prompt || "");
    copy.textContent = "Copied ✓";
  });
  box.appendChild(copy);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
  function teardown() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }
  close.addEventListener("click", teardown);
  overlay.addEventListener("click", function (e) { if (e.target === overlay) teardown(); });
}
