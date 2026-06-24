/* agentic-review shell — entry point / uber-orchestrator.
 *
 * The shell is a pure static page that talks ONLY to the local bridge server
 * resolved from the query string (?api= / ?port=) and authenticates with
 * ?token= via the X-AR-Token header. No project data is baked into this page.
 *
 * The functionality is split into ES modules under ./js/:
 *   core.js      config, DOM helpers, API client, shared state, utils
 *   manifest.js  manifest helpers, the file list, and the all-files tree
 *   viewer.js    openFile + the full/diff/preview/JSON renderers
 *   comments.js  comment data + inline/panel UI + the submit form
 *   checks.js    checker plugin menu, per-file + check-all runs, findings
 *   mermaid.js   Mermaid diagrams in the markdown preview
 * This file only bootstraps the connection and wires the top-level controls.
 */
import { state, $, BASE, apiGet, setConn, showNotice } from "./js/core.js";
import {
  reloadManifest, renderTree, setFileMode, manifestHas
} from "./js/manifest.js";
import { loadAndRender } from "./js/viewer.js";
import {
  submitComment, commentsForPath, renderCommentPanel, updateAnchorLabel
} from "./js/comments.js";
import { loadCheckers, runChecks } from "./js/checks.js";

// ---- connection / manifest -------------------------------------------
async function loadManifest() {
  setConn("connecting…", null);
  try {
    var ping = await apiGet("/ping");
    setConn("connected · " + ping.version, true);
  } catch (e) {
    setConn("server unreachable", false);
    showNotice("Cannot reach the local bridge server at " + BASE +
      ".\n\n" + e.message +
      "\n\nStart it with the agentic-review skill, or check ?port=/?api=/?token=.",
      true);
    return;
  }
  try {
    await reloadManifest();
    await loadCheckers();
  } catch (e) {
    showNotice("Failed to load manifest: " + e.message, true);
  }
}

// Re-sync the manifest and re-render whatever file is open (clearing any
// cached content), so a committed/reverted change is picked up immediately.
async function refreshAll() {
  state.content = null;
  state.tree = null;  // force the file tree to refetch too
  try {
    await reloadManifest();
  } catch (e) {
    showNotice("Failed to refresh: " + e.message, true);
    return;
  }
  if (state.fileMode === "all") renderTree();
  if (state.current && (manifestHas(state.current.path) || state.current.pseudo)) {
    state.comments = commentsForPath(state.current.path);
    renderCommentPanel();
    await loadAndRender();
  } else if (state.current) {
    state.current = null;
    showNotice("Select a file.", false);
  }
}

// ---- wire up ----------------------------------------------------------
$("comment-form").addEventListener("submit", submitComment);
$("comment-clear").addEventListener("click", function () {
  state.anchor = null;
  updateAnchorLabel();
  var sel = $("content").querySelectorAll("tr.sel-line, tr.d2h-sel, .md-block.sel-block");
  Array.prototype.forEach.call(sel, function (r) {
    r.classList.remove("sel-line"); r.classList.remove("d2h-sel"); r.classList.remove("sel-block");
  });
});
$("reload").addEventListener("click", refreshAll);
$("tab-changed").addEventListener("click", function () { setFileMode("changed"); });
$("tab-all").addEventListener("click", function () { setFileMode("all"); });
$("run-checks").addEventListener("click", runChecks);
$("checks-toggle").addEventListener("click", function (ev) {
  ev.stopPropagation();
  $("checks-menu").hidden = !$("checks-menu").hidden;
});
document.addEventListener("click", function (ev) {
  if (!$("checks").contains(ev.target)) $("checks-menu").hidden = true;
});

loadManifest();
