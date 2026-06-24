/* agentic-review shell — core foundation.
 * Config (bridge base + token), tiny DOM helpers, the API client, the shared
 * `state` singleton, and small formatting utilities. This module has no
 * dependencies on the feature modules, so everything else can import from it.
 *
 * Pure static. Talks ONLY to the local bridge server resolved from the query
 * string (?api= / ?port=) and authenticates with ?token= via the X-AR-Token
 * header. No project data is baked into this page.
 */

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
export var BASE = resolveBase();
// Token sources, in order: explicit ?token= (used by the cross-origin hosted
// shell), else a <meta name="ar-token"> the bridge injects into the same-origin
// page (so opening http://127.0.0.1:<port>/review.html "just works", no query).
function metaToken() {
  var m = document.querySelector('meta[name="ar-token"]');
  return (m && m.getAttribute("content")) || "";
}
var TOKEN = qs("token") || metaToken();

// ---- tiny DOM helpers -------------------------------------------------
export var $ = function (id) { return document.getElementById(id); };
export function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

// ---- API client -------------------------------------------------------
function headers(extra) {
  var h = Object.assign({}, extra || {});
  if (TOKEN) h["X-AR-Token"] = TOKEN;
  return h;
}
export async function apiGet(path) {
  var res = await fetch(BASE + path, { mode: "cors", headers: headers() });
  var data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.message || ("HTTP " + res.status));
  return data;
}
export async function apiPost(path, body) {
  return apiSend("POST", path, body);
}
export async function apiSend(method, path, body) {
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
export var state = {
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

// ---- connection status / notices -------------------------------------
export function setConn(text, ok) {
  var p = $("conn");
  p.textContent = text;
  p.className = "pill" + (ok === true ? " ok" : ok === false ? " err" : "");
}
export function showNotice(text, isError) {
  var c = $("content");
  clear(c);
  c.appendChild(el("div", "notice" + (isError ? " error" : ""), text));
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
export function langFromPath(p) {
  var ext = (p.split(".").pop() || "").toLowerCase();
  return EXT_LANG[ext] || null;
}
export function fmtTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}
