/* agentic-review shell.
 * Pure static. Talks ONLY to the local bridge server resolved from the query
 * string (?api= / ?port=) and authenticates with ?token= via the X-AR-Token
 * header. No project data is baked into this page.
 */
(function () {
  "use strict";

  // ---- config from the query string ------------------------------------
  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }
  function resolveBase() {
    var api = qs("api");
    if (api) return api.replace(/\/+$/, "");
    var port = qs("port");
    if (port) return "http://localhost:" + port;
    // Same-origin fallback: the bridge can serve this page itself.
    if (location.protocol === "http:" && location.host) return location.origin;
    return "http://localhost:8900";
  }
  var BASE = resolveBase();
  var TOKEN = qs("token") || "";

  // ---- tiny DOM helpers -------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  // ---- API client -------------------------------------------------------
  function headers(extra) {
    var h = Object.assign({}, extra || {});
    if (TOKEN) h["X-AR-Token"] = TOKEN;
    return h;
  }
  async function apiGet(path) {
    var res = await fetch(BASE + path, { mode: "cors", headers: headers() });
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
    return data;
  }
  async function apiPost(path, body) {
    return apiSend("POST", path, body);
  }
  async function apiSend(method, path, body) {
    var opts = { method: method, mode: "cors", headers: headers() };
    if (body !== undefined) {
      opts.headers = headers({ "Content-Type": "application/json" });
      opts.body = JSON.stringify(body);
    }
    var res = await fetch(BASE + path, opts);
    var data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
    return data;
  }

  // ---- state ------------------------------------------------------------
  var state = {
    manifest: null,
    current: null,        // manifest entry
    mode: null,           // 'full' | 'diff' | 'preview'
    content: null,        // text content of current file
    comments: [],         // comments for current file
    allComments: [],      // all comments (for file-list dots)
    anchor: null          // {line, range:{start,end}|null, side}
  };

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
      state.manifest = await apiGet("/api/manifest");
      $("repo").textContent = state.manifest.root + "  (base " + state.manifest.base + ")";
      await loadAllComments();
      renderFileList();
    } catch (e) {
      showNotice("Failed to load manifest: " + e.message, true);
    }
  }

  async function loadAllComments() {
    try {
      var data = await apiGet("/api/comments");
      state.allComments = data.comments || [];
    } catch (e) { state.allComments = []; }
  }

  function commentsForPath(path) {
    return state.allComments.filter(function (c) { return c.path === path; });
  }

  function setConn(text, ok) {
    var p = $("conn");
    p.textContent = text;
    p.className = "pill" + (ok === true ? " ok" : ok === false ? " err" : "");
  }
  function showNotice(text, isError) {
    var c = $("content");
    clear(c);
    c.appendChild(el("div", "notice" + (isError ? " error" : ""), text));
  }

  // ---- file list --------------------------------------------------------
  function renderFileList() {
    var ul = $("files");
    clear(ul);
    var files = state.manifest.files || [];
    if (!files.length) {
      ul.appendChild(el("li", "muted", "No changes vs " + state.manifest.base));
      return;
    }
    files.forEach(function (f) {
      var li = el("li");
      li.dataset.path = f.path;
      if (commentsForPath(f.path).length) li.classList.add("has-comments");
      var letter = (f.status || "?")[0].toUpperCase();
      li.appendChild(el("span", "badge " + f.status, letter));
      var name = el("span", "name");
      var slash = f.path.lastIndexOf("/");
      if (slash >= 0) {
        name.appendChild(el("span", "path-dir", f.path.slice(0, slash + 1)));
      }
      name.appendChild(document.createTextNode(f.path.slice(slash + 1)));
      name.title = f.path + (f.oldPath ? " (was " + f.oldPath + ")" : "");
      li.appendChild(name);
      li.appendChild(el("span", "dot"));
      li.addEventListener("click", function () { openFile(f); });
      ul.appendChild(li);
    });
  }

  function markActiveFile(path) {
    Array.prototype.forEach.call($("files").children, function (li) {
      li.classList.toggle("active", li.dataset.path === path);
    });
  }

  // ---- open a file ------------------------------------------------------
  function availableModes(f) {
    if (f.renderer === "markdown") return ["preview", "full", "diff"];
    if (f.renderer === "html") return ["preview", "full", "diff"];
    if (f.renderer === "json") return ["tree", "full", "diff"];
    return ["diff", "full"];
  }

  async function openFile(f) {
    state.current = f;
    state.anchor = null;
    markActiveFile(f.path);
    $("cur-path").textContent = f.path;
    state.comments = commentsForPath(f.path);
    var modes = availableModes(f);
    state.mode = modes[0];
    renderModeTabs(modes);
    renderCommentPanel();
    await loadAndRender();
  }

  function renderModeTabs(modes) {
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

  async function loadAndRender() {
    var c = $("content");
    clear(c);
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
    } catch (e) {
      showNotice("Failed to render " + state.current.path + ": " + e.message, true);
    }
  }

  async function fetchContent() {
    if (state.content && state.content.path === state.current.path) {
      return state.content;
    }
    var data = await apiGet("/api/content?path=" + encodeURIComponent(state.current.path));
    state.content = { path: state.current.path, data: data };
    return state.content;
  }

  // ---- renderers --------------------------------------------------------
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

  // ---- inline comment helpers ------------------------------------------
  // Representative line for a comment (range -> its start line).
  function commentLine(cm) {
    if (cm.range) return cm.range.start;
    if (cm.line != null) return cm.line;
    return null;
  }
  // Map line-number -> [comments]; comments with no line are file-level.
  function commentMaps() {
    var byLineMap = {}, fileLevel = [];
    state.comments.forEach(function (cm) {
      var ln = commentLine(cm);
      if (ln == null) { fileLevel.push(cm); return; }
      (byLineMap[ln] = byLineMap[ln] || []).push(cm);
    });
    return { byLine: byLineMap, fileLevel: fileLevel };
  }
  function anchorText(cm) {
    if (cm.range) return "L" + cm.range.start + "–" + cm.range.end;
    if (cm.line != null) return "L" + cm.line;
    return "file";
  }
  // Build an inline thread element for a list of comments.
  function buildThread(comments) {
    var box = el("div", "thread");
    comments.forEach(function (cm) {
      box.appendChild(commentItem(cm, "thread-c"));
    });
    return box;
  }

  // A single comment with edit/delete controls, shared by inline + panel views.
  function commentItem(cm, cls) {
    var item = el("div", cls);
    var meta = el("div", "c-meta");
    var anchorSpan = el("span", "c-anchor", anchorText(cm) + (cm.side ? " " + cm.side : ""));
    anchorSpan.addEventListener("click", function () { jumpToLine(cm); });
    meta.appendChild(anchorSpan);
    meta.appendChild(el("span", "", fmtTime(cm.createdAt) + (cm.updatedAt ? " (edited)" : "")));
    var actions = el("span", "c-actions");
    var editBtn = el("button", "c-act", "edit");
    var delBtn = el("button", "c-act c-del", "delete");
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    meta.appendChild(actions);
    item.appendChild(meta);

    var textEl = el("div", "c-text", cm.text);
    item.appendChild(textEl);

    editBtn.addEventListener("click", function () { startEdit(item, cm, textEl); });
    delBtn.addEventListener("click", function () { deleteComment(cm); });
    return item;
  }

  function startEdit(item, cm, textEl) {
    if (item.querySelector(".c-edit")) return; // already editing
    var box = el("div", "c-edit");
    var ta = el("textarea", "c-edit-text");
    ta.value = cm.text;
    ta.rows = Math.min(8, Math.max(2, cm.text.split("\n").length));
    var row = el("div", "c-edit-row");
    var save = el("button", "", "save");
    var cancel = el("button", "ghost", "cancel");
    row.appendChild(save); row.appendChild(cancel);
    box.appendChild(ta); box.appendChild(row);
    textEl.style.display = "none";
    item.insertBefore(box, textEl.nextSibling);
    ta.focus();
    cancel.addEventListener("click", function () {
      box.remove(); textEl.style.display = "";
    });
    save.addEventListener("click", async function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      save.disabled = true;
      try {
        await apiSend("PUT", "/api/comments?id=" + encodeURIComponent(cm.id), { text: text });
        await refreshAfterCommentChange();
      } catch (e) {
        save.disabled = false;
        alert("Edit failed: " + e.message);
      }
    });
  }

  async function deleteComment(cm) {
    if (!window.confirm("Delete this comment?")) return;
    try {
      await apiSend("DELETE", "/api/comments?id=" + encodeURIComponent(cm.id));
      await refreshAfterCommentChange();
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  }

  // Reload comments and re-render the panel, file list, and current view.
  async function refreshAfterCommentChange() {
    await loadAllComments();
    if (state.current) {
      state.comments = commentsForPath(state.current.path);
      renderCommentPanel();
      renderFileList();
      markActiveFile(state.current.path);
      await loadAndRender();
    }
  }
  // Show file-level comments as a banner at the top of the content area.
  function renderFileLevelThread() {
    var maps = commentMaps();
    if (!maps.fileLevel.length) return;
    var c = $("content");
    var wrap = el("div", "file-thread");
    wrap.appendChild(el("div", "panel-title", "File-level comments"));
    wrap.appendChild(buildThread(maps.fileLevel));
    c.insertBefore(wrap, c.firstChild);
  }

  function decorateCodeLines(container) {
    var maps = commentMaps();
    var rows = container.querySelectorAll("table.hljs-ln tr");
    Array.prototype.forEach.call(rows, function (tr) {
      var td = tr.querySelector("td.hljs-ln-numbers");
      if (!td) return;
      var n = parseInt(td.getAttribute("data-line-number"), 10);
      td.addEventListener("click", function (ev) { onLineClick(n, ev, container); });
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

  async function renderDiff() {
    var c = $("content");
    var data = await apiGet("/api/diff?path=" + encodeURIComponent(state.current.path));
    clear(c);
    if (!data.unified || !data.unified.trim()) {
      c.appendChild(el("div", "notice", "No textual diff (file may be binary or unchanged)."));
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

  async function renderPreview() {
    var got = await fetchContent();
    var c = $("content");
    clear(c);
    if (state.current.renderer === "markdown") {
      renderMarkdownBlocks(c, got.data.content);
    } else if (state.current.renderer === "html") {
      var note = el("div", "preview-note",
        "Rendered in a sandboxed iframe (scripts disabled). Comments below are file-level; use full mode to anchor to a line.");
      c.appendChild(note);
      var frame = el("iframe", "sandbox");
      frame.setAttribute("sandbox", "");           // no scripts, no same-origin
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.srcdoc = got.data.content;
      c.appendChild(frame);
      var maps = commentMaps();
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

  // ---- comment panel ----------------------------------------------------
  function updateAnchorLabel() {
    var lbl = $("anchor-label");
    if (!state.anchor) {
      lbl.textContent = "File-level comment"; lbl.classList.remove("set");
    } else if (state.anchor.range) {
      lbl.textContent = "Lines " + state.anchor.range.start + "–" + state.anchor.range.end +
        " (" + state.anchor.side + ")";
      lbl.classList.add("set");
    } else {
      lbl.textContent = "Line " + state.anchor.line + " (" + state.anchor.side + ")";
      lbl.classList.add("set");
    }
  }

  function renderCommentPanel() {
    updateAnchorLabel();
    $("comment-count").textContent = String(state.comments.length);
    var ul = $("comment-list");
    clear(ul);
    if (!state.comments.length) {
      ul.appendChild(el("li", "muted small", "No comments on this file yet."));
      return;
    }
    state.comments.slice().sort(byLine).forEach(function (cm) {
      var li = el("li");
      li.appendChild(commentItem(cm, "panel-c"));
      ul.appendChild(li);
    });
  }

  function byLine(a, b) {
    var la = a.range ? a.range.start : (a.line || 0);
    var lb = b.range ? b.range.start : (b.line || 0);
    return la - lb;
  }

  function jumpToLine(cm) {
    var line = cm.range ? cm.range.start : cm.line;
    if (line == null) return;
    if (state.mode !== "full") {
      state.mode = "full";
      renderModeTabs(availableModes(state.current));
      loadAndRender().then(function () {
        setTimeout(function () { scrollToLine(line); }, 150);
      });
    } else {
      scrollToLine(line);
    }
  }
  function scrollToLine(line) {
    var td = document.querySelector('td.hljs-ln-numbers[data-line-number="' + line + '"]');
    if (td) { td.parentNode.scrollIntoView({ block: "center" }); td.parentNode.classList.add("sel-line"); }
  }

  async function submitComment(ev) {
    ev.preventDefault();
    var text = $("comment-text").value.trim();
    var status = $("comment-status");
    if (!text) { status.textContent = "Write something first."; status.className = "small err"; return; }
    if (!state.current) { status.textContent = "Open a file first."; status.className = "small err"; return; }
    var body = {
      path: state.current.path,
      line: state.anchor ? state.anchor.line : null,
      side: state.anchor ? state.anchor.side : null,
      range: state.anchor ? state.anchor.range : null,
      text: text
    };
    status.textContent = "saving…"; status.className = "small muted";
    try {
      await apiPost("/api/comments", body);
      status.textContent = "saved ✓"; status.className = "small";
      $("comment-text").value = "";
      state.anchor = null;
      await refreshAfterCommentChange();
    } catch (e) {
      status.textContent = "failed: " + e.message; status.className = "small err";
    }
  }

  // ---- utils ------------------------------------------------------------
  var EXT_LANG = {
    js: "javascript", mjs: "javascript", cjs: "javascript", ts: "typescript",
    jsx: "javascript", tsx: "typescript", py: "python", rb: "ruby", go: "go",
    rs: "rust", java: "java", c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp",
    cs: "csharp", php: "php", sh: "bash", bash: "bash", zsh: "bash",
    json: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini",
    html: "xml", htm: "xml", xml: "xml", css: "css", scss: "scss",
    sql: "sql", md: "markdown", markdown: "markdown", kql: "sql"
  };
  function langFromPath(p) {
    var ext = (p.split(".").pop() || "").toLowerCase();
    return EXT_LANG[ext] || null;
  }
  function fmtTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? iso : d.toLocaleString();
  }

  // ---- wire up ----------------------------------------------------------
  $("comment-form").addEventListener("submit", submitComment);
  $("comment-clear").addEventListener("click", function () {
    state.anchor = null; updateAnchorLabel();
    var sel = $("content").querySelectorAll("tr.sel-line, tr.d2h-sel, .md-block.sel-block");
    Array.prototype.forEach.call(sel, function (r) {
      r.classList.remove("sel-line"); r.classList.remove("d2h-sel"); r.classList.remove("sel-block");
    });
  });
  $("reload").addEventListener("click", loadManifest);

  loadManifest();
})();
