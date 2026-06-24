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
    current: null,        // manifest/tree entry
    mode: null,           // 'full' | 'diff' | 'preview' | 'tree'
    content: null,        // text content of current file
    comments: [],         // comments for current file
    allComments: [],      // all comments (for file-list dots)
    anchor: null,         // {line, range:{start,end}|null, side}
    fileMode: "changed",  // 'changed' | 'all'
    tree: null,           // cached /api/tree result
    checkers: [],         // available checker plugins
    checkSelection: null, // {id: bool} which checkers to run
    checkResults: {}      // path -> [{id, name, findings, error?}]
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
      await reloadManifest();
      await loadCheckers();
    } catch (e) {
      showNotice("Failed to load manifest: " + e.message, true);
    }
  }

  // Discover available checker plugins once (built-in + user checkers).
  async function loadCheckers() {
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

  // Fetch the manifest + comments and re-render the file list. Returns the
  // set of file paths currently considered changed.
  async function reloadManifest() {
    state.manifest = await apiGet("/api/manifest");
    $("repo").textContent = state.manifest.root + "  (base " + state.manifest.base + ")";
    await loadAllComments();
    renderFileList();
    if (state.current) markActiveFile(state.current.path);
    return manifestPaths();
  }

  function manifestPaths() {
    return ((state.manifest && state.manifest.files) || []).map(function (f) { return f.path; });
  }
  function manifestHas(path) {
    return manifestPaths().indexOf(path) !== -1;
  }
  function diffBaseLabel() {
    return (state.manifest && state.manifest.base) || "the diff base";
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

  function markActiveFile(path) {
    Array.prototype.forEach.call($("files").children, function (li) {
      li.classList.toggle("active", li.dataset.path === path);
    });
    Array.prototype.forEach.call($("tree").querySelectorAll(".tree-file"), function (row) {
      row.classList.toggle("active", row.dataset.path === path);
    });
  }

  // ---- open a file ------------------------------------------------------
  function availableModes(f) {
    if (f.pseudo) return ["preview", "full"];  // proposed commit message: no diff
    var changed = !!f.status;
    if (f.renderer === "markdown") return ["preview", "full", "diff"];
    if (f.renderer === "html") return ["preview", "full", "diff"];
    if (f.renderer === "json") return ["tree", "full", "diff"];
    // Unchanged files (browsed from the tree) have no diff; show source first.
    return changed ? ["diff", "full"] : ["full", "diff"];
  }

  async function openFile(f) {
    state.current = f;
    state.anchor = null;
    state.content = null;
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

  // ---- file-mode toggle (Changed | All files) ---------------------------
  function setFileMode(mode) {
    state.fileMode = mode;
    $("tab-changed").classList.toggle("active", mode === "changed");
    $("tab-all").classList.toggle("active", mode === "all");
    $("files").hidden = mode !== "changed";
    $("tree").hidden = mode !== "all";
    if (mode === "all") renderTree();
  }

  async function renderTree() {
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
      renderChecksSummary();
    } catch (e) {
      showNotice("Failed to render " + state.current.path + ": " + e.message, true);
    }
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

  async function runChecks() {
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

  // Open a file by path from the current manifest (used by the check-all report).
  function openFromManifest(path, line) {
    var entry = ((state.manifest && state.manifest.files) || [])
      .filter(function (f) { return f.path === path; })[0]
      || { path: path, kind: "text", renderer: "code" };
    setFileMode("changed");
    openFile(entry).then(function () {
      if (line) jumpToCheckLine(line);
    });
  }

  function currentFindings() {
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

  function renderChecksSummary() {
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

  function jumpToCheckLine(line) {
    if (state.mode !== "full") {
      state.mode = "full";
      renderModeTabs(availableModes(state.current));
      loadAndRender().then(function () { setTimeout(function () { scrollToLine(line); }, 150); });
    } else {
      scrollToLine(line);
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
      updateTreeCommentDots();
      markActiveFile(state.current.path);
      await loadAndRender();
    }
  }

  // Toggle the has-comments dot on existing tree rows without rebuilding the
  // tree (so the user's expand/collapse state is preserved).
  function updateTreeCommentDots() {
    Array.prototype.forEach.call($("tree").querySelectorAll(".tree-file"), function (row) {
      row.classList.toggle("has-comments", commentsForPath(row.dataset.path).length > 0);
    });
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

  async function renderDiff() {
    var c = $("content");
    var data = await apiGet("/api/diff?path=" + encodeURIComponent(state.current.path));
    clear(c);
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

  // An empty (or binary) diff for a listed file. Distinguish binary, a genuinely
  // unchanged file, and a stale file list (e.g. the change was just committed or
  // reverted since the manifest loaded).
  async function renderEmptyDiff(c, data) {
    if (data.binary) {
      c.appendChild(el("div", "notice",
        "Binary file — no textual diff. (Switch to full mode if it is actually text.)"));
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

  loadManifest();
})();
