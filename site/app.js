(function () {
  "use strict";

  function qs(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  // Resolve the local server base URL from the query string:
  //   ?api=http://localhost:8900   (full base URL), or
  //   ?port=8900                   (-> http://localhost:8900)
  function resolveBase() {
    var api = qs("api");
    if (api) return api.replace(/\/+$/, "");
    var port = qs("port");
    if (port) return "http://localhost:" + port;
    return "";
  }

  var baseInput = document.getElementById("base");
  var statusEl = document.getElementById("status");
  var outEl = document.getElementById("out");

  function setStatus(text, ok) {
    statusEl.textContent = text;
    statusEl.className = ok === undefined ? "" : (ok ? "ok" : "err");
  }

  function show(obj) {
    outEl.textContent = typeof obj === "string" ? obj : JSON.stringify(obj, null, 2);
  }

  function base() {
    return (baseInput.value || "").replace(/\/+$/, "");
  }

  async function ping() {
    var b = base();
    if (!b) { setStatus("no server URL", false); return; }
    setStatus("connecting\u2026");
    try {
      var res = await fetch(b + "/ping", { method: "GET", mode: "cors" });
      var data = await res.json();
      setStatus("connected (" + res.status + ")", res.ok);
      show(data);
    } catch (e) {
      setStatus("failed: " + e.message, false);
      show("GET " + b + "/ping failed:\n" + e);
    }
  }

  async function post() {
    var b = base();
    if (!b) { setStatus("no server URL", false); return; }
    setStatus("posting\u2026");
    try {
      var res = await fetch(b + "/comments", {
        method: "POST",
        mode: "cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hello: "agentic-review", ts: Date.now() })
      });
      var data = await res.json();
      setStatus("POST ok (" + res.status + ")", res.ok);
      show(data);
    } catch (e) {
      setStatus("failed: " + e.message, false);
      show("POST " + b + "/comments failed:\n" + e);
    }
  }

  document.getElementById("ping").addEventListener("click", ping);
  document.getElementById("post").addEventListener("click", post);

  // Initialise from the query string and auto-test if a server was provided.
  var resolved = resolveBase();
  baseInput.value = resolved || "http://localhost:8900";
  if (resolved) {
    ping();
  }
})();
