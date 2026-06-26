/* Viewer: opening a file and rendering its content.
 * Owns openFile + the mode tabs + loadAndRender dispatch, and every renderer
 * (full source, unified diff, markdown preview, JSON tree) plus the line/block
 * decoration that wires inline comments and checker findings into each view.
 */
import {
  state, $, el, clear, apiGet, showNotice, langFromPath
} from "./core.js";
import {
  commentsForPath, commentMaps, commentLine, buildThread,
  renderFileLevelThread, updateAnchorLabel, renderCommentPanel
} from "./comments.js";
import { currentFindings, renderChecksSummary } from "./checks.js";
import {
  markActiveFile, manifestHas, reloadManifest, diffBaseLabel
} from "./manifest.js";
import { renderMermaidIn } from "./mermaid.js";

// ---- open a file ------------------------------------------------------
export function availableModes(f) {
  if (f.orphan) return [];  // deleted / not in change set: thread only, no content
  if (f.pseudo) return ["preview", "full"];  // proposed commit message: no diff
  var changed = !!f.status;
  if (f.renderer === "markdown") return ["preview", "full", "diff"];
  if (f.renderer === "html") return ["preview", "full", "diff"];
  if (f.renderer === "json") return ["tree", "full", "diff"];
  // Unchanged files (browsed from the tree) have no diff; show source first.
  return changed ? ["diff", "full"] : ["full", "diff"];
}

export async function openFile(f) {
  state.current = f;
  state.anchor = null;
  state.content = null;
  state.jsonDiffRaw = false;
  state.htmlRunScripts = false;
  markActiveFile(f.path);
  $("cur-path").textContent = f.path;
  state.comments = commentsForPath(f.path);
  var modes = availableModes(f);
  state.mode = modes[0];
  renderModeTabs(modes);
  renderCommentPanel();
  // Checks control stays visible (for "run on all"); the per-file button is
  // only enabled for real text files (not the pseudo commit message/binaries).
  var canCheck = !f.pseudo && f.kind !== "binary" && state.checkers.length > 0;
  $("checks").style.display = state.checkers.length ? "" : "none";
  $("run-checks").disabled = !canCheck;
  $("run-checks").title = canCheck ? "Run code checks on this file"
    : "This file can't be checked; use the ▾ menu to run on all changed files";
  $("checks-menu").hidden = true;
  await loadAndRender();
}

export function renderModeTabs(modes) {
  var box = $("modes");
  clear(box);
  modes.forEach(function (m) {
    var b = el("button", state.mode === m ? "active" : "", m);
    b.addEventListener("click", function () {
      state.mode = m;
      Array.prototype.forEach.call(box.children, function (c) {
        c.classList.toggle("active", c.textContent === m);
      });
      loadAndRender();
    });
    box.appendChild(b);
  });
}

export async function loadAndRender() {
  var c = $("content");
  clear(c);
  // Orphaned comment thread: the anchor file is gone, so there is no content or
  // diff to show — surface the preserved thread instead of failing to load.
  if (state.current.orphan) {
    c.appendChild(el("div", "notice",
      "This file is no longer part of the review (deleted, or outside the "
      + "current change set). Its comment thread is preserved \u2014 see below "
      + "and in the panel on the right."));
    renderFileLevelThread();
    return;
  }
  c.appendChild(el("div", "notice", "loading…"));
  try {
    if (state.mode === "diff") {
      await renderDiff();
    } else if (state.mode === "preview") {
      await renderPreview();
    } else if (state.mode === "tree") {
      await renderJsonTree();
    } else {
      await renderFull();
    }
    renderFileLevelThread();
    renderChecksSummary();
  } catch (e) {
    showNotice("Failed to render " + state.current.path + ": " + e.message, true);
  }
}

export async function fetchContent() {
  if (state.content && state.content.path === state.current.path) {
    return state.content;
  }
  var data = await apiGet("/api/content?path=" + encodeURIComponent(state.current.path));
  state.content = { path: state.current.path, data: data };
  return state.content;
}

// ---- full source renderer --------------------------------------------
async function renderFull() {
  var c = $("content");
  var got;
  try {
    got = await fetchContent();
  } catch (e) {
    if (/binary/i.test(e.message)) { showNotice("Binary file — no text preview.", false); return; }
    throw e;
  }
  clear(c);
  var pre = el("pre", "code");
  var code = el("code");
  var lang = langFromPath(state.current.path);
  if (lang) code.className = "language-" + lang;
  code.textContent = got.data.content;
  pre.appendChild(code);
  c.appendChild(pre);
  if (window.hljs) {
    hljs.highlightElement(code);
    if (hljs.lineNumbersBlock) {
      hljs.lineNumbersBlock(code, { singleLine: true });
      // line-numbers plugin builds its table async; poll briefly.
      waitForLineNumbers(c);
    }
  }
}

function waitForLineNumbers(container, tries) {
  tries = tries || 0;
  var rows = container.querySelectorAll("tr");
  if (rows.length || tries > 20) { decorateCodeLines(container); return; }
  setTimeout(function () { waitForLineNumbers(container, tries + 1); }, 25);
}

function decorateCodeLines(container) {
  var maps = commentMaps();
  var checks = currentFindings().byLine;
  var rows = container.querySelectorAll("table.hljs-ln tr");
  Array.prototype.forEach.call(rows, function (tr) {
    var td = tr.querySelector("td.hljs-ln-numbers");
    if (!td) return;
    var n = parseInt(td.getAttribute("data-line-number"), 10);
    td.addEventListener("click", function (ev) { onLineClick(n, ev, container); });
    // Inline checker findings on this line (above any comment thread).
    if (checks[n]) {
      var severe = checks[n].some(function (f) { return f.severity === "error"; });
      tr.classList.add(severe ? "has-error" : "has-warning");
      var checkRow = el("tr", "check-row");
      var ccell = el("td");
      ccell.colSpan = 2;
      checks[n].forEach(function (f) {
        var line = el("div", "check-inline");
        line.appendChild(el("span", "sev " + f.severity, f.severity[0]));
        line.appendChild(el("span", "cf-msg", f.message + "  (" + f.checker + ")"));
        ccell.appendChild(line);
      });
      checkRow.appendChild(ccell);
      if (tr.nextSibling) tr.parentNode.insertBefore(checkRow, tr.nextSibling);
      else tr.parentNode.appendChild(checkRow);
    }
    if (maps.byLine[n]) {
      tr.classList.add("commented");
      var threadRow = el("tr", "thread-row");
      var cell = el("td");
      cell.colSpan = 2;
      cell.appendChild(buildThread(maps.byLine[n]));
      threadRow.appendChild(cell);
      if (tr.nextSibling) tr.parentNode.insertBefore(threadRow, tr.nextSibling);
      else tr.parentNode.appendChild(threadRow);
    }
  });
}

function onLineClick(n, ev, container) {
  if (ev.shiftKey && state.anchor && state.anchor.line != null) {
    var a = state.anchor.line, b = n;
    state.anchor = { line: null, range: { start: Math.min(a, b), end: Math.max(a, b) }, side: "new" };
  } else {
    state.anchor = { line: n, range: null, side: "new" };
  }
  highlightSelection(container);
  updateAnchorLabel();
  $("comment-text").focus();
}

function highlightSelection(container) {
  var rows = container.querySelectorAll("table.hljs-ln tr");
  var lo, hi;
  if (state.anchor && state.anchor.range) { lo = state.anchor.range.start; hi = state.anchor.range.end; }
  else if (state.anchor && state.anchor.line != null) { lo = hi = state.anchor.line; }
  Array.prototype.forEach.call(rows, function (tr) {
    var td = tr.querySelector("td.hljs-ln-numbers");
    if (!td) return;
    var n = parseInt(td.getAttribute("data-line-number"), 10);
    tr.classList.toggle("sel-line", lo != null && n >= lo && n <= hi);
  });
}

export function scrollToLine(line) {
  var td = document.querySelector('td.hljs-ln-numbers[data-line-number="' + line + '"]');
  if (td) { td.parentNode.scrollIntoView({ block: "center" }); td.parentNode.classList.add("sel-line"); }
}

// ---- diff renderer ----------------------------------------------------
async function renderDiff() {
  var c = $("content");
  var isJson = state.current.renderer === "json";
  // JSON files default to an expanded (pretty-printed) diff so minified
  // single-line JSON is readable; a toggle switches back to the raw line diff.
  var wantPretty = isJson && !state.jsonDiffRaw;
  var url = "/api/diff?path=" + encodeURIComponent(state.current.path);
  if (wantPretty) url += "&pretty=1";
  var data = await apiGet(url);
  clear(c);
  if (isJson) c.appendChild(jsonDiffToggle(data, wantPretty));
  if (!data.unified || !data.unified.trim() || data.binary) {
    await renderEmptyDiff(c, data);
    return;
  }
  if (window.Diff2Html && window.DOMPurify) {
    var html = Diff2Html.html(data.unified, {
      drawFileList: false, matching: "lines", outputFormat: "line-by-line"
    });
    var wrap = el("div");
    wrap.innerHTML = DOMPurify.sanitize(html);
    c.appendChild(wrap);
    decorateDiffLines(wrap);
  } else {
    // No diff lib or no sanitizer: show the raw unified diff inertly.
    var pre = el("pre", "diff-raw");
    pre.textContent = data.unified;
    c.appendChild(pre);
  }
}

// Toolbar shown above a JSON diff: switch between the expanded (pretty-printed)
// diff and the raw line diff. `data.pretty === true` means the server actually
// produced an expanded diff; if we asked for one but didn't get it, a side
// wasn't valid JSON and the server fell back to the raw diff.
function jsonDiffToggle(data, wantPretty) {
  var bar = el("div", "json-diff-bar");
  var prettyShown = wantPretty && data.pretty === true;
  var btn = el("button", "json-diff-toggle",
    prettyShown ? "Expanded JSON diff · show raw" : "Raw diff · show expanded");
  btn.title = prettyShown
    ? "Show the unmodified git line diff"
    : "Pretty-print both sides and diff those instead";
  btn.addEventListener("click", function () {
    // If we're showing the expanded diff, switch to raw; otherwise to expanded.
    state.jsonDiffRaw = prettyShown;
    loadAndRender();
  });
  bar.appendChild(btn);
  if (wantPretty && data.pretty !== true) {
    bar.appendChild(el("span", "json-diff-note",
      "Couldn't expand as JSON (a side isn't valid JSON, or is too large/binary); " +
      "showing the raw diff."));
  }
  return bar;
}

// An empty (or binary) diff for a listed file. Distinguish binary, a
// formatting-only JSON change, a genuinely unchanged file, and a stale file
// list (e.g. the change was just committed or reverted since the manifest
// loaded).
async function renderEmptyDiff(c, data) {
  if (data.binary) {
    c.appendChild(el("div", "notice",
      "Binary file — no textual diff. (Switch to full mode if it is actually text.)"));
    return;
  }
  // Expanded JSON diff came back empty even though the file changed textually:
  // the JSON is identical after pretty-printing (e.g. it was minified or
  // reformatted). Explain it and point at the raw diff (the toggle is shown).
  if (data.formattingOnly) {
    c.appendChild(el("div", "notice",
      "No semantic changes — this JSON is identical after pretty-printing; only " +
      "formatting/whitespace differs (e.g. it was minified or reformatted). " +
      "Switch to the raw diff to see the formatting change."));
    return;
  }
  var path = state.current.path;
  var wasListed = manifestHas(path);
  try { await reloadManifest(); } catch (e) { /* ignore; show generic message */ }
  var stillListed = manifestHas(path);
  if (wasListed && !stillListed) {
    var msg = el("div", "notice");
    msg.appendChild(document.createTextNode(
      "No changes vs " + diffBaseLabel() + " anymore — this file was committed " +
      "or reverted since the list loaded, so it dropped out of the review. " +
      "The file list has been refreshed."));
    c.appendChild(msg);
    markActiveFile(path);
    return;
  }
  c.appendChild(el("div", "notice",
    "No textual diff vs " + (data.base || diffBaseLabel()) + " (the file is unchanged). " +
    "To review committed history instead, relaunch with a different diff base " +
    "(e.g. AR_DIFF_BASE=HEAD~1 or a branch name)."));
}

// Attach anchoring + inline threads to a diff2html line-by-line table.
function decorateDiffLines(container) {
  var maps = commentMaps();
  var rows = container.querySelectorAll("tr");
  Array.prototype.forEach.call(rows, function (tr) {
    var lnCell = tr.querySelector(".d2h-code-linenumber");
    if (!lnCell) return;
    // line-by-line shows old (line-num1) and new (line-num2) numbers.
    var newDiv = lnCell.querySelector(".line-num2");
    var oldDiv = lnCell.querySelector(".line-num1");
    var newN = newDiv && parseInt(newDiv.textContent, 10);
    var oldN = oldDiv && parseInt(oldDiv.textContent, 10);
    var side = newN ? "new" : "old";
    var n = newN || oldN;
    if (!n) return;
    lnCell.addEventListener("click", function () {
      state.anchor = { line: n, range: null, side: side };
      Array.prototype.forEach.call(container.querySelectorAll("tr.d2h-sel"),
        function (r) { r.classList.remove("d2h-sel"); });
      tr.classList.add("d2h-sel");
      updateAnchorLabel();
      $("comment-text").focus();
    });
    // Inline existing comments anchored to this (new-side) line.
    if (side === "new" && maps.byLine[n]) {
      var threadRow = el("tr", "thread-row");
      var cell = el("td");
      cell.colSpan = tr.children.length || 2;
      cell.appendChild(buildThread(maps.byLine[n]));
      threadRow.appendChild(cell);
      if (tr.nextSibling) tr.parentNode.insertBefore(threadRow, tr.nextSibling);
      else tr.parentNode.appendChild(threadRow);
    }
  });
}

// ---- preview renderer (markdown / sandboxed html) --------------------
async function renderPreview() {
  var got = await fetchContent();
  var c = $("content");
  clear(c);
  if (state.current.renderer === "markdown") {
    renderMarkdownBlocks(c, got.data.content);
  } else if (state.current.renderer === "html") {
    renderHtmlPreview(c, got.data.content);
    var lineComments = state.comments.filter(function (cm) { return commentLine(cm) != null; });
    if (lineComments.length) {
      var below = el("div", "file-thread");
      below.appendChild(el("div", "panel-title", "Line comments"));
      below.appendChild(buildThread(lineComments));
      c.appendChild(below);
    }
  } else {
    await renderFull();
  }
}

// Render reviewed HTML in a sandboxed iframe. Default: scripts disabled
// (sandbox=""). A per-file "⚠ Run scripts" toggle re-creates the iframe with
// sandbox="allow-scripts" so interactive pages work — but never with
// allow-same-origin, so the reviewed page still cannot reach the shell's
// origin, cookies, or the bridge token. Toggling re-creates the iframe so
// scripts start fresh (and toggling off tears them down).
function renderHtmlPreview(c, content) {
  var run = state.htmlRunScripts === true;
  var bar = el("div", "preview-bar");
  var btn = el("button", run ? "run-scripts-toggle armed" : "run-scripts-toggle",
    run ? "⚠ Scripts running · disable" : "⚠ Run scripts");
  btn.title = run
    ? "Re-block scripts (recreates the iframe with sandbox=\"\")"
    : "Allow this page's scripts to run (sandbox=\"allow-scripts\", still no same-origin access)";
  btn.addEventListener("click", function () {
    state.htmlRunScripts = !run;
    loadAndRender();
  });
  bar.appendChild(btn);
  bar.appendChild(el("span", "preview-note",
    run
      ? "Scripts are ENABLED for this page (sandbox=\"allow-scripts\", no same-origin). "
        + "It cannot reach the shell, your cookies, or the bridge token. "
        + "Comments below are file-level; use full mode to anchor to a line."
      : "Rendered in a sandboxed iframe (scripts disabled). Comments below are "
        + "file-level; use full mode to anchor to a line."));
  c.appendChild(bar);
  var frame = el("iframe", "sandbox");
  // Never combine allow-scripts with allow-same-origin for reviewed code.
  frame.setAttribute("sandbox", run ? "allow-scripts" : "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = content;
  c.appendChild(frame);
}

// Render markdown as per-block elements mapped to source lines, so a block
// can be clicked to anchor a comment and existing comments show inline.
function renderMarkdownBlocks(container, src) {
  var body = el("div", "markdown-body");
  container.appendChild(body);
  if (!(window.marked && window.DOMPurify)) {
    // Safe fallback: show raw source inertly (never inject HTML).
    var pre = el("pre", "code");
    pre.textContent = src;
    body.appendChild(pre);
    return;
  }
  var tokens = marked.lexer(src);
  var totalLines = src.split("\n").length;
  // Compute the starting source line of each token.
  var line = 1;
  var blocks = [];
  tokens.forEach(function (tok) {
    var start = line;
    var nl = (tok.raw.match(/\n/g) || []).length;
    line += nl;
    if (tok.type === "space") return;
    blocks.push({ start: start, token: tok });
  });
  var maps = commentMaps();
  blocks.forEach(function (b, i) {
    var end = (i + 1 < blocks.length) ? blocks[i + 1].start - 1 : totalLines;
    var div = el("div", "md-block");
    div.dataset.start = b.start;
    div.dataset.end = end;
    div.innerHTML = DOMPurify.sanitize(marked.parser([b.token]));
    div.addEventListener("click", function (ev) {
      // don't hijack clicks on links
      if (ev.target.closest("a")) return;
      selectBlock(container, div, b.start);
    });
    body.appendChild(div);
    // Inline any comment whose anchored line falls within this block.
    var here = [];
    Object.keys(maps.byLine).forEach(function (k) {
      var ln = parseInt(k, 10);
      if (ln >= b.start && ln <= end) here = here.concat(maps.byLine[k]);
    });
    if (here.length) {
      div.classList.add("commented");
      body.appendChild(buildThread(here));
    }
  });
  // Upgrade ```mermaid fenced blocks into diagrams (preview pane only).
  renderMermaidIn(body);
}

function selectBlock(container, div, startLine) {
  Array.prototype.forEach.call(container.querySelectorAll(".md-block.sel-block"),
    function (b) { b.classList.remove("sel-block"); });
  div.classList.add("sel-block");
  state.anchor = { line: startLine, range: null, side: "new" };
  updateAnchorLabel();
  $("comment-text").focus();
}

// ---- JSON tree viewer (navigation) -----------------------------------
async function renderJsonTree() {
  var got;
  try {
    got = await fetchContent();
  } catch (e) {
    if (/binary/i.test(e.message)) { showNotice("Binary file — no preview.", false); return; }
    throw e;
  }
  var c = $("content");
  clear(c);
  var parsed;
  try {
    parsed = JSON.parse(got.data.content);
  } catch (e) {
    var note = el("div", "preview-note", "Invalid JSON: " + e.message + " — showing source.");
    c.appendChild(note);
    await renderFull();
    return;
  }
  var tree = el("div", "json-tree");
  tree.appendChild(jsonNode(null, parsed, true, 0));
  c.appendChild(tree);
}

function jsonNode(key, value, isLast, depth) {
  var row = el("div", "jt-node");
  var head = el("div", "jt-row");
  var isObj = value && typeof value === "object";
  var entries = isObj ? (Array.isArray(value)
    ? value.map(function (v, i) { return [i, v]; })
    : Object.keys(value).map(function (k) { return [k, value[k]]; })) : null;

  if (isObj) {
    var toggle = el("span", "jt-toggle", entries.length ? "▾" : "·");
    head.appendChild(toggle);
  } else {
    head.appendChild(el("span", "jt-toggle", " "));
  }
  if (key !== null) {
    head.appendChild(el("span", "jt-key", JSON.stringify(key)));
    head.appendChild(el("span", "jt-punct", ": "));
  }

  if (isObj) {
    var open = Array.isArray(value) ? "[" : "{";
    var close = Array.isArray(value) ? "]" : "}";
    head.appendChild(el("span", "jt-punct", open));
    var summary = el("span", "jt-summary",
      " " + entries.length + (Array.isArray(value) ? " items " : " keys ") + close);
    head.appendChild(summary);
    row.appendChild(head);
    var children = el("div", "jt-children");
    entries.forEach(function (kv, i) {
      children.appendChild(jsonNode(Array.isArray(value) ? null : kv[0],
        kv[1], i === entries.length - 1, depth + 1));
    });
    row.appendChild(children);
    var closing = el("div", "jt-row");
    closing.appendChild(el("span", "jt-toggle", " "));
    closing.appendChild(el("span", "jt-punct", close + (isLast ? "" : ",")));
    row.appendChild(closing);
    if (entries.length) {
      toggle.style.cursor = "pointer";
      toggle.addEventListener("click", function () {
        var collapsed = row.classList.toggle("jt-collapsed");
        toggle.textContent = collapsed ? "▸" : "▾";
      });
      head.addEventListener("click", function (ev) {
        if (ev.target === toggle) return;
      });
    }
  } else {
    var cls = value === null ? "jt-null"
      : typeof value === "string" ? "jt-string"
      : typeof value === "number" ? "jt-number" : "jt-boolean";
    head.appendChild(el("span", cls, JSON.stringify(value)));
    head.appendChild(el("span", "jt-punct", isLast ? "" : ","));
    row.appendChild(head);
  }
  return row;
}
