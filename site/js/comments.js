/* Comments: data + UI.
 * Loading/saving/editing/deleting comments, building inline comment threads
 * (shared by the full/diff/preview renderers and the side panel), anchoring,
 * and the comment-submit form.
 */
import {
  state, $, el, clear, apiGet, apiPost, apiSend, fmtTime
} from "./core.js";
import { renderFileList, markActiveFile } from "./manifest.js";
import {
  renderModeTabs, availableModes, loadAndRender, scrollToLine
} from "./viewer.js";

// ---- comment data -----------------------------------------------------
export async function loadAllComments() {
  try {
    var data = await apiGet("/api/comments");
    state.allComments = data.comments || [];
  } catch (e) { state.allComments = []; }
}

export function commentsForPath(path) {
  return state.allComments.filter(function (c) { return c.path === path; });
}

// ---- inline comment helpers ------------------------------------------
// Representative line for a comment (range -> its start line).
export function commentLine(cm) {
  if (cm.range) return cm.range.start;
  if (cm.line != null) return cm.line;
  return null;
}
// Map line-number -> [comments]; comments with no line are file-level.
export function commentMaps() {
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

// Lifecycle statuses the human (or agent) can set on a comment thread.
var STATUSES = ["open", "needs-discussion", "resolved", "rejected", "wont-fix"];
function commentStatus(cm) { return cm.status || "open"; }

// Build an inline thread element for a list of comments.
export function buildThread(comments) {
  var box = el("div", "thread");
  comments.forEach(function (cm) {
    box.appendChild(commentItem(cm, "thread-c"));
  });
  return box;
}

// A single comment (with its reply thread + status) shared by inline + panel.
function commentItem(cm, cls) {
  var item = el("div", cls + " status-" + commentStatus(cm));
  var meta = el("div", "c-meta");
  var anchorSpan = el("span", "c-anchor", anchorText(cm) + (cm.side ? " " + cm.side : ""));
  anchorSpan.addEventListener("click", function () { jumpToLine(cm); });
  meta.appendChild(anchorSpan);
  meta.appendChild(statusChip(cm));
  meta.appendChild(el("span", "", fmtTime(cm.createdAt) + (cm.updatedAt ? " (edited)" : "")));
  var actions = el("span", "c-actions");
  var replyBtn = el("button", "c-act", "reply");
  var editBtn = el("button", "c-act", "edit");
  var delBtn = el("button", "c-act c-del", "delete");
  actions.appendChild(replyBtn);
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  meta.appendChild(actions);
  item.appendChild(meta);

  var textEl = el("div", "c-text", cm.text);
  item.appendChild(textEl);

  var replies = cm.replies || [];
  if (replies.length) item.appendChild(buildReplies(replies));

  editBtn.addEventListener("click", function () { startEdit(item, cm, textEl); });
  delBtn.addEventListener("click", function () { deleteComment(cm); });
  replyBtn.addEventListener("click", function () { startReply(item, cm); });
  return item;
}

// The status chip is also the human's control: click it to cycle / pick a status.
function statusChip(cm) {
  var cur = commentStatus(cm);
  var sel = el("select", "c-status-sel status-" + cur);
  STATUSES.forEach(function (s) {
    var opt = el("option", "", s);
    opt.value = s;
    if (s === cur) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.title = "Set this comment's status";
  sel.addEventListener("change", function () { setStatus(cm, sel.value); });
  sel.addEventListener("click", function (e) { e.stopPropagation(); });
  return sel;
}

// Render the back-and-forth replies, distinguishing human vs agent visually.
function buildReplies(replies) {
  var wrap = el("div", "c-replies");
  replies.forEach(function (r) {
    var who = r.author === "agent" ? "agent" : "human";
    var row = el("div", "c-reply reply-" + who);
    var head = el("div", "c-reply-meta");
    head.appendChild(el("span", "c-reply-who", who));
    head.appendChild(el("span", "", fmtTime(r.createdAt)));
    row.appendChild(head);
    row.appendChild(el("div", "c-text", r.text));
    wrap.appendChild(row);
  });
  return wrap;
}

function startReply(item, cm) {
  if (item.querySelector(".c-reply-box")) return; // already replying
  var box = el("div", "c-reply-box");
  var ta = el("textarea", "c-edit-text");
  ta.placeholder = "Reply to this comment…";
  ta.rows = 2;
  var row = el("div", "c-edit-row");
  var send = el("button", "", "send reply");
  var cancel = el("button", "ghost", "cancel");
  row.appendChild(send); row.appendChild(cancel);
  box.appendChild(ta); box.appendChild(row);
  item.appendChild(box);
  ta.focus();
  cancel.addEventListener("click", function () { box.remove(); });
  send.addEventListener("click", async function () {
    var text = ta.value.trim();
    if (!text) { ta.focus(); return; }
    send.disabled = true;
    try {
      await apiPost("/api/comments/reply?id=" + encodeURIComponent(cm.id),
                    { author: "human", text: text });
      await refreshAfterCommentChange();
    } catch (e) {
      send.disabled = false;
      alert("Reply failed: " + e.message);
    }
  });
}

async function setStatus(cm, status) {
  if (status === commentStatus(cm)) return;
  try {
    await apiSend("PATCH", "/api/comments?id=" + encodeURIComponent(cm.id), { status: status });
    await refreshAfterCommentChange();
  } catch (e) {
    alert("Status change failed: " + e.message);
  }
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
export async function refreshAfterCommentChange() {
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
export function updateTreeCommentDots() {
  Array.prototype.forEach.call($("tree").querySelectorAll(".tree-file"), function (row) {
    row.classList.toggle("has-comments", commentsForPath(row.dataset.path).length > 0);
  });
}
// Show file-level comments as a banner at the top of the content area.
export function renderFileLevelThread() {
  var maps = commentMaps();
  if (!maps.fileLevel.length) return;
  var c = $("content");
  var wrap = el("div", "file-thread");
  wrap.appendChild(el("div", "panel-title", "File-level comments"));
  wrap.appendChild(buildThread(maps.fileLevel));
  c.insertBefore(wrap, c.firstChild);
}

// ---- comment panel ----------------------------------------------------
export function updateAnchorLabel() {
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

export function renderCommentPanel() {
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

export async function submitComment(ev) {
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
