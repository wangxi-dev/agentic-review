/* Mermaid diagrams for the markdown preview pane.
 * Lazily initialises mermaid in strict mode and upgrades ```mermaid fenced
 * code blocks into sanitized inline SVG. Invalid diagrams keep their source
 * block; if mermaid never loaded, fenced blocks are left untouched.
 */
import { el } from "./core.js";

// Lazily initialise mermaid once, in strict mode. Returns false if the lib
// never loaded so callers can leave the fenced code block untouched.
var _mermaidReady = null;
export function initMermaid() {
  if (!window.mermaid) return false;
  if (_mermaidReady === null) {
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",     // no click bindings / inline scripts
        htmlLabels: false,           // labels as <text>, survive SVG sanitize
        flowchart: { htmlLabels: false },
        theme: "default"
      });
      _mermaidReady = true;
    } catch (e) {
      _mermaidReady = false;
    }
  }
  return _mermaidReady;
}

var _mermaidSeq = 0;
export async function renderMermaidIn(container) {
  // If mermaid or the sanitizer is unavailable, leave fenced blocks as-is.
  if (!initMermaid() || !window.DOMPurify) return;
  var codes = container.querySelectorAll("pre > code.language-mermaid");
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    var pre = code.parentNode;
    if (!pre || !pre.parentNode) continue;
    var src = code.textContent;
    var id = "mmd-" + (++_mermaidSeq);
    try {
      var out = await window.mermaid.render(id, src);
      // Sanitize the produced SVG (SVG profile) before it touches the DOM.
      var clean = DOMPurify.sanitize(out.svg,
        { USE_PROFILES: { svg: true, svgFilters: true } });
      var fig = el("div", "mermaid");
      fig.innerHTML = clean;
      pre.parentNode.replaceChild(fig, pre);
    } catch (e) {
      // Invalid diagram: keep the source block, flag it inertly.
      pre.classList.add("mermaid-error");
      var note = el("div", "mermaid-error-note",
        "Mermaid: " + ((e && e.message) ? e.message : "could not render diagram"));
      pre.parentNode.insertBefore(note, pre);
    } finally {
      // Remove any temporary measurement node mermaid may leave behind.
      var leftover = document.getElementById("d" + id) ||
                     document.getElementById(id);
      if (leftover && leftover.parentNode &&
          !container.contains(leftover)) {
        leftover.parentNode.removeChild(leftover);
      }
    }
  }
}
