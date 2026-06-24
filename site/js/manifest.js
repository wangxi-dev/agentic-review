/* Manifest, file list, and the all-files tree.
 * Owns the manifest helpers, the "Changed" file list, the "All files" tree
 * (with the Changed | All toggle), and openFromManifest (used by the
 * check-all report to jump back into a file).
 */
import { state, $, el, clear, apiGet } from "./core.js";
import { commentsForPath, loadAllComments } from "./comments.js";
import { openFile } from "./viewer.js";
import { jumpToCheckLine } from "./checks.js";

// ---- manifest helpers -------------------------------------------------
export function manifestPaths() {
  return ((state.manifest && state.manifest.files) || []).map(function (f) { return f.path; });
}
export function manifestHas(path) {
  return manifestPaths().indexOf(path) !== -1;
}
export function diffBaseLabel() {
  return (state.manifest && state.manifest.base) || "the diff base";
}

// Fetch the manifest + comments and re-render the file list. Returns the
// set of file paths currently considered changed.
export async function reloadManifest() {
  state.manifest = await apiGet("/api/manifest");
  $("repo").textContent = state.manifest.root + "  (base " + state.manifest.base + ")";
  await loadAllComments();
  renderFileList();
  if (state.current) markActiveFile(state.current.path);
  return manifestPaths();
}

// ---- file list --------------------------------------------------------
export function renderFileList() {
  var ul = $("files");
  clear(ul);
  var files = (state.manifest && state.manifest.files) || [];
  if (!files.length) {
    ul.appendChild(el("li", "muted", "No changes vs " + state.manifest.base));
    return;
  }
  files.forEach(function (f) {
    var li = el("li");
    li.dataset.path = f.path;
    if (f.pseudo) li.classList.add("pseudo");
    if (commentsForPath(f.path).length) li.classList.add("has-comments");
    var letter = f.status === "precommit" ? "\u270e" : (f.status || "?")[0].toUpperCase();
    li.appendChild(el("span", "badge " + f.status, letter));
    var name = el("span", "name");
    if (f.pseudo && f.label) {
      name.appendChild(document.createTextNode(f.label));
      name.title = f.label + " (" + f.path + ")";
    } else {
      var slash = f.path.lastIndexOf("/");
      if (slash >= 0) {
        name.appendChild(el("span", "path-dir", f.path.slice(0, slash + 1)));
      }
      name.appendChild(document.createTextNode(f.path.slice(slash + 1)));
      name.title = f.path + (f.oldPath ? " (was " + f.oldPath + ")" : "");
    }
    li.appendChild(name);
    li.appendChild(el("span", "dot"));
    li.addEventListener("click", function () { openFile(f); });
    ul.appendChild(li);
  });
}

export function markActiveFile(path) {
  Array.prototype.forEach.call($("files").children, function (li) {
    li.classList.toggle("active", li.dataset.path === path);
  });
  Array.prototype.forEach.call($("tree").querySelectorAll(".tree-file"), function (row) {
    row.classList.toggle("active", row.dataset.path === path);
  });
}

// ---- file-mode toggle (Changed | All files) ---------------------------
export function setFileMode(mode) {
  state.fileMode = mode;
  $("tab-changed").classList.toggle("active", mode === "changed");
  $("tab-all").classList.toggle("active", mode === "all");
  $("files").hidden = mode !== "changed";
  $("tree").hidden = mode !== "all";
  if (mode === "all") renderTree();
}

export async function renderTree() {
  var container = $("tree");
  if (!state.tree) {
    clear(container);
    container.appendChild(el("div", "muted small", "loading…"));
    try {
      state.tree = await apiGet("/api/tree");
    } catch (e) {
      clear(container);
      container.appendChild(el("div", "notice error", "Failed to load file tree: " + e.message));
      return;
    }
  }
  clear(container);
  container.appendChild(buildTreeList(state.tree.entries, 0));
  if (state.current) markActiveFile(state.current.path);
}

function buildTreeList(entries, depth) {
  var ul = el("ul", "tree-list");
  entries.forEach(function (entry) { ul.appendChild(buildTreeNode(entry, depth)); });
  return ul;
}

function buildTreeNode(entry, depth) {
  var li = el("li", "tree-node");
  if (entry.type === "dir") {
    var row = el("div", "tree-row tree-dir");
    // Show 2 levels expanded; deeper folders collapse until clicked.
    var collapsed = depth >= 1;
    var caret = el("span", "tree-caret", collapsed ? "\u25b8" : "\u25be");
    row.appendChild(caret);
    row.appendChild(el("span", "tree-name", entry.name + "/"));
    li.appendChild(row);
    var childUl = buildTreeList(entry.children || [], depth + 1);
    childUl.hidden = collapsed;
    li.appendChild(childUl);
    row.addEventListener("click", function () {
      childUl.hidden = !childUl.hidden;
      caret.textContent = childUl.hidden ? "\u25b8" : "\u25be";
    });
  } else {
    var frow = el("div", "tree-row tree-file");
    frow.dataset.path = entry.path;
    if (entry.status) {
      frow.appendChild(el("span", "badge " + entry.status, entry.status[0].toUpperCase()));
    } else {
      frow.appendChild(el("span", "tree-indent"));
    }
    frow.appendChild(el("span", "tree-name", entry.name));
    frow.appendChild(el("span", "dot"));
    if (commentsForPath(entry.path).length) frow.classList.add("has-comments");
    frow.addEventListener("click", function () { openFile(entry); });
    li.appendChild(frow);
  }
  return li;
}

// Open a file by path from the current manifest (used by the check-all report).
export function openFromManifest(path, line) {
  var entry = ((state.manifest && state.manifest.files) || [])
    .filter(function (f) { return f.path === path; })[0]
    || { path: path, kind: "text", renderer: "code" };
  setFileMode("changed");
  openFile(entry).then(function () {
    if (line) jumpToCheckLine(line);
  });
}
