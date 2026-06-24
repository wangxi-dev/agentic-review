/* Checker plugins: the checks ▾ menu, per-file runs, the repo-wide
 * "run on all changed files" report, and the inline/summary rendering of
 * findings for the open file.
 */
import { state, $, el, clear, apiGet, showNotice } from "./core.js";
import {
  loadAndRender, availableModes, renderModeTabs, scrollToLine
} from "./viewer.js";
import { openFromManifest, markActiveFile } from "./manifest.js";

// Discover available checker plugins once (built-in + user checkers).
export async function loadCheckers() {
  try {
    var data = await apiGet("/api/checkers");
    state.checkers = data.checkers || [];
    if (!state.checkSelection) {
      state.checkSelection = {};
      state.checkers.forEach(function (c) { state.checkSelection[c.id] = true; });
    }
  } catch (e) { state.checkers = []; }
  buildChecksMenu();
  // Keep the checks control available whenever any checker exists, so the
  // "Run on all changed files" action is always reachable.
  $("checks").style.display = state.checkers.length ? "" : "none";
}

// ---- checker plugins (UI) --------------------------------------------
function buildChecksMenu() {
  var menu = $("checks-menu");
  clear(menu);
  if (!state.checkers.length) {
    menu.appendChild(el("div", "ck-empty", "No checkers found. Add CLIs to .agentic-review/checkers/"));
    return;
  }
  state.checkers.forEach(function (c) {
    var row = el("label", "ck");
    var cb = el("input");
    cb.type = "checkbox";
    cb.checked = !!(state.checkSelection && state.checkSelection[c.id]);
    cb.addEventListener("change", function () {
      state.checkSelection[c.id] = cb.checked;
    });
    row.appendChild(cb);
    var txt = el("div");
    txt.appendChild(el("div", "", c.name + (c.builtin ? "" : " (custom)")));
    if (c.description) txt.appendChild(el("div", "ck-desc", c.description));
    row.appendChild(txt);
    menu.appendChild(row);
  });
  var all = el("button", "ck-all", "▶ Run on all changed files");
  all.addEventListener("click", function () { $("checks-menu").hidden = true; runAllChecks(); });
  menu.appendChild(all);
}

function selectedCheckerIds() {
  return state.checkers
    .filter(function (c) { return state.checkSelection[c.id]; })
    .map(function (c) { return c.id; });
}

export async function runChecks() {
  if (!state.current) return;
  if (state.current.pseudo) return;
  var ids = selectedCheckerIds();
  if (!ids.length) { alert("Select at least one checker."); return; }
  var btn = $("run-checks");
  var prev = btn.textContent;
  btn.textContent = "running…"; btn.disabled = true;
  try {
    var data = await apiGet("/api/check?path=" + encodeURIComponent(state.current.path) +
      "&checkers=" + encodeURIComponent(ids.join(",")));
    state.checkResults[state.current.path] = data.results || [];
    await loadAndRender();  // re-render so inline markers + summary appear
  } catch (e) {
    alert("Checks failed: " + e.message);
  } finally {
    btn.textContent = prev; btn.disabled = false;
  }
}

// Repo-level: run the selected checkers across every changed file and show a
// consolidated report. Each finding links to the file/line.
async function runAllChecks() {
  var ids = selectedCheckerIds();
  if (!ids.length) { alert("Select at least one checker."); return; }
  var c = $("content");
  clear(c);
  c.appendChild(el("div", "notice", "running checks on all changed files…"));
  var data;
  try {
    data = await apiGet("/api/check-all?checkers=" + encodeURIComponent(ids.join(",")));
  } catch (e) {
    showNotice("Check-all failed: " + e.message, true);
    return;
  }
  state.current = null;
  markActiveFile(null);
  $("cur-path").textContent = "Checks · all changed files";
  clear($("modes"));
  $("run-checks").disabled = true;
  renderCheckAllReport(data);
}

function renderCheckAllReport(data) {
  var c = $("content");
  clear(c);
  var s = data.summary || { errors: 0, warnings: 0, filesWithFindings: 0 };
  var box = el("div", "checks-summary");
  box.appendChild(el("div", "panel-title",
    "All changed files vs " + data.base + " — " + s.errors + " error(s), " +
    s.warnings + " warning(s) across " + s.filesWithFindings + " file(s)"));
  if (!data.files.length) {
    box.appendChild(el("div", "checks-ok", "✓ No issues found in changed files."));
    c.appendChild(box);
    return;
  }
  data.files.forEach(function (fileRes) {
    var group = el("div", "checks-group");
    var head = el("div", "ca-file");
    head.textContent = fileRes.path;
    head.addEventListener("click", function () { openFromManifest(fileRes.path); });
    group.appendChild(head);
    fileRes.results.forEach(function (r) {
      if (r.error) {
        var er = el("div", "check-finding");
        er.appendChild(el("span", "sev error", "E"));
        er.appendChild(el("span", "cf-msg", r.name + ": " + r.error));
        group.appendChild(er);
      }
      (r.findings || []).forEach(function (f) {
        var row = el("div", "check-finding");
        row.appendChild(el("span", "cf-loc", f.line ? ("L" + f.line) : "file"));
        row.appendChild(el("span", "sev " + f.severity, f.severity[0]));
        row.appendChild(el("span", "cf-msg", f.message + "  (" + r.name + ")"));
        row.addEventListener("click", function () { openFromManifest(fileRes.path, f.line); });
        group.appendChild(row);
      });
    });
    box.appendChild(group);
  });
  c.appendChild(box);
}

export function currentFindings() {
  var results = state.checkResults[state.current && state.current.path] || [];
  var byLine = {}, fileLevel = [], errors = 0, warnings = 0;
  results.forEach(function (r) {
    (r.findings || []).forEach(function (f) {
      var item = { checker: r.name, severity: f.severity, rule: f.rule, message: f.message, line: f.line };
      if (f.severity === "error") errors++; else if (f.severity === "warning") warnings++;
      if (f.line) (byLine[f.line] = byLine[f.line] || []).push(item);
      else fileLevel.push(item);
    });
  });
  return { results: results, byLine: byLine, fileLevel: fileLevel, errors: errors, warnings: warnings };
}

export function renderChecksSummary() {
  var results = state.checkResults[state.current && state.current.path];
  if (!results) return;  // checks not run for this file yet
  var f = currentFindings();
  var c = $("content");
  var box = el("div", "checks-summary");
  var total = f.errors + f.warnings + f.fileLevel.filter(function (x) { return x.severity === "info"; }).length;
  box.appendChild(el("div", "panel-title",
    "Checks: " + f.errors + " error(s), " + f.warnings + " warning(s)"));
  var anyError = results.some(function (r) { return r.error; });
  results.forEach(function (r) {
    if (r.error) {
      var er = el("div", "checks-group");
      er.appendChild(el("span", "sev error", "ERR"));
      er.appendChild(document.createTextNode(" " + r.name + ": " + r.error));
      box.appendChild(er);
    }
  });
  var all = f.fileLevel.concat(Object.keys(f.byLine).map(Number).sort(function (a, b) { return a - b; })
    .reduce(function (acc, ln) { return acc.concat(f.byLine[ln]); }, []));
  if (!all.length && !anyError) {
    box.appendChild(el("div", "checks-ok", "✓ No issues found."));
  }
  if (all.length) {
    var group = el("div", "checks-group");
    all.forEach(function (item) {
      var row = el("div", "check-finding");
      row.appendChild(el("span", "cf-loc", item.line ? ("L" + item.line) : "file"));
      row.appendChild(el("span", "sev " + item.severity, item.severity[0]));
      row.appendChild(el("span", "cf-msg", item.message + "  (" + item.checker + ")"));
      if (item.line) row.addEventListener("click", function () { jumpToCheckLine(item.line); });
      group.appendChild(row);
    });
    box.appendChild(group);
  }
  // Place the summary just under any file-level comment banner.
  c.insertBefore(box, c.firstChild);
}

export function jumpToCheckLine(line) {
  if (state.mode !== "full") {
    state.mode = "full";
    renderModeTabs(availableModes(state.current));
    loadAndRender().then(function () { setTimeout(function () { scrollToLine(line); }, 150); });
  } else {
    scrollToLine(line);
  }
}
