import hljs from 'highlight.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { normalizeDiffText, reviewPatch } from './diff';
import { prettyJson } from './files';
import type { Anchor, FileContent, ReviewComment, View } from './types';

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function language(path: string): string | undefined {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  const names: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', md: 'markdown', markdown: 'markdown', html: 'xml', htm: 'xml', cs: 'csharp', h: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', sh: 'bash', yml: 'yaml', ps1: 'powershell', vue: 'xml', svg: 'xml' };
  const name = names[extension] ?? extension;
  return hljs.getLanguage(name) ? name : undefined;
}
export const isImage = (path: string): boolean => /\.(png|jpe?g|webp)$/i.test(path);
export const canPreview = (path: string): boolean => isImage(path) || /\.(md|markdown|html?|xhtml)$/i.test(path);

// Split highlighted HTML into balanced lines without losing multiline token state.
export function highlightedLines(source: string, path: string): string[] {
  const lang = language(path);
  const html = lang && source.length <= 250000 ? hljs.highlight(source, { language: lang, ignoreIllegals: true }).value : escapeHtml(source);
  const open: string[] = [];
  const lines: string[] = [];
  let line = '';
  for (const token of html.split(/(<span\b[^>]*>|<\/span>|\n)/)) {
    if (token === '\n') {
      lines.push(line + '</span>'.repeat(open.length));
      line = open.join('');
    } else {
      line += token;
      if (token.startsWith('<span')) open.push(token);
      if (token === '</span>') open.pop();
    }
  }
  lines.push(line);
  return lines;
}

interface RenderOptions {
  path: string;
  view: View;
  content: FileContent;
  comments: ReviewComment[];
  onAnchor: (anchor: Anchor, shift: boolean) => void;
}

function lineButton(number: number | null, side: 'old' | 'new', onAnchor: RenderOptions['onAnchor']): HTMLElement {
  if (number === null) return element('span', 'line-number');
  const button = element('button', 'line-number', String(number));
  button.title = `Comment on ${side} line ${number}`;
  button.setAttribute('aria-label', `${side} line ${number}`);
  button.addEventListener('click', event => onAnchor({ side, line: number, endLine: null }, event.shiftKey));
  return button;
}

function inlineComments(comments: ReviewComment[]): HTMLElement {
  const box = element('div', 'inline-comments');
  for (const c of comments) {
    const note = element('div', `inline-comment ${c.status}`);
    note.append(element('span', 'inline-status', c.status === 'resolved' ? '✓' : '●'), element('span', '', c.text));
    box.append(note);
  }
  return box;
}

function renderLines(host: HTMLElement, rows: { old: number | null; new: number | null; html: string; type: string }[], options: RenderOptions): void {
  const byLine = new Map<string, ReviewComment[]>();
  for (const c of options.comments) {
    const key = `${c.side}:${c.line}`;
    byLine.set(key, [...(byLine.get(key) ?? []), c]);
  }
  const table = element('div', `code-table ${options.view}`);
  for (const row of rows.slice(0, 20000)) {
    const line = element('div', `code-line ${row.type}`);
    if (row.old !== null) line.dataset.old = String(row.old);
    if (row.new !== null) line.dataset.new = String(row.new);
    if (options.view === 'diff') line.append(lineButton(row.old, 'old', options.onAnchor));
    line.append(lineButton(options.view === 'diff' || row.new !== null ? row.new : row.old, row.new !== null ? 'new' : 'old', options.onAnchor));
    if (options.view === 'diff') {
      const marker = element('span', 'diff-marker', row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' ');
      marker.setAttribute('aria-label', row.type === 'added' ? 'Added line' : row.type === 'removed' ? 'Deleted line' : '');
      line.append(marker);
    }
    const code = element('code');
    code.innerHTML = row.html || ' ';
    line.append(code);
    table.append(line);
    const comments = [...(byLine.get(`old:${row.old}`) ?? []), ...(byLine.get(`new:${row.new}`) ?? [])].filter(c => c.line !== null);
    if (comments.length) table.append(inlineComments(comments));
  }
  host.append(table);
  if (rows.length > 20000) host.append(element('div', 'notice', 'Preview truncated at 20,000 rows. The file itself has not been changed.'));
}

export function sanitizedMarkdown(source: string): string {
  return DOMPurify.sanitize(marked.parse(source, { async: false }), {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
    FORBID_ATTR: ['style', 'id', 'name', 'srcset'],
  });
}

export function htmlDocument(source: string): string {
  const purifier = DOMPurify(window);
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (['src', 'poster', 'background'].includes(data.attrName) && !data.attrValue.startsWith('data:')) data.keepAttr = false;
  });
  const clean = purifier.sanitize(source, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'base', 'meta', 'link', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select'],
    FORBID_ATTR: ['href', 'action', 'srcset'],
  });
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">`;
  return clean.replace(/<head>/i, `<head>${policy}<style>body{font-family:system-ui,sans-serif;margin:24px;overflow-wrap:anywhere}img{max-width:100%}</style>`);
}

function preview(host: HTMLElement, source: string, options: RenderOptions, side: 'old' | 'new'): void {
  if (/\.(html?|xhtml)$/i.test(options.path)) {
    const toolbar = element('div', 'html-preview-toolbar');
    const hint = element('span', '', 'Select text in the preview, then comment. Scripts and external resources are blocked.');
    const comment = element('button', '', 'Comment on selection');
    comment.disabled = true;
    toolbar.append(hint, comment);
    const frame = element('iframe', 'html-preview');
    frame.title = `Preview of ${options.path}`;
    // Parent-side selection access only. Never allow scripts in this same-origin frame.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    let quote = '';
    frame.addEventListener('load', () => {
      const previewDocument = frame.contentDocument;
      if (!previewDocument) return;
      previewDocument.addEventListener('selectionchange', () => {
        quote = previewDocument.getSelection()?.toString().trim() ?? '';
        comment.disabled = !quote || new TextEncoder().encode(quote).length > 100000;
        comment.title = comment.disabled && quote ? 'Select at most 100,000 UTF-8 bytes.' : 'Attach the selected text to your comment';
      });
    });
    // Preserve the selection when focus moves from the frame to the toolbar.
    comment.addEventListener('mousedown', event => event.preventDefault());
    comment.addEventListener('click', () => {
      if (quote) options.onAnchor({ side, line: null, endLine: null, quote }, false);
    });
    frame.srcdoc = htmlDocument(source);
    host.append(toolbar, frame);
    return;
  }
  // Match Marked's newline normalization so block anchors agree with source line numbers.
  const normalized = source.replace(/\r\n|\r/g, '\n');
  const tokens = marked.lexer(normalized);
  const article = element('article', 'markdown');
  let line = 1;
  for (const token of tokens) {
    const start = line;
    line += (token.raw.match(/\n/g) ?? []).length;
    if (token.type === 'space' || token.type === 'def') continue;
    const block = element('section', 'markdown-block');
    // Retain document-level link definitions when rendering a block.
    const single = Object.assign([token], { links: tokens.links });
    block.innerHTML = DOMPurify.sanitize(marked.parser(single), {
      FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'video', 'audio'],
      FORBID_ATTR: ['style', 'id', 'name', 'srcset'],
    });
    block.dataset[side] = String(start);
    block.title = `Comment on ${side} line ${start}`;
    block.tabIndex = 0;
    const anchor = () => options.onAnchor({ side, line: start, endLine: null }, false);
    block.addEventListener('click', event => { event.preventDefault(); anchor(); });
    block.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); anchor(); } });
    block.querySelectorAll('img').forEach(img => { if (!img.getAttribute('src')?.startsWith('data:')) img.removeAttribute('src'); });
    block.querySelectorAll('pre code').forEach(code => {
      if ((code.textContent?.length ?? 0) <= 250000) hljs.highlightElement(code as HTMLElement);
    });
    article.append(block);
    const comments = options.comments.filter(c => c.side === side && c.line !== null && c.line >= start && c.line < Math.max(start + 1, line));
    if (comments.length) article.append(inlineComments(comments));
  }
  host.append(article);
}

function renderImages(host: HTMLElement, options: RenderOptions): void {
  const { content, view, path } = options;
  const hasNew = content.newImage != null || content.newNotice != null || content.new != null;
  const sides: ('old' | 'new')[] = view === 'diff' ? ['old', 'new'] : [hasNew ? 'new' : 'old'];
  if (!hasNew && view !== 'diff') host.append(element('div', 'notice', 'Deleted image · showing the old version.'));
  if (view === 'diff' && content.oldImage && content.oldImage === content.newImage) {
    host.append(element('div', 'notice', 'Image bytes are identical. The filename or file metadata may have changed.'));
  }
  const layout = element('div', 'image-layout');
  for (const side of sides) {
    const data = content[side === 'old' ? 'oldImage' : 'newImage'];
    const notice = content[side === 'old' ? 'oldNotice' : 'newNotice'];
    const figure = element('figure', 'image-card');
    figure.dataset.side = side;
    const heading = element('figcaption', 'image-heading');
    heading.append(element('strong', '', view === 'diff'
      ? (side === 'old' ? 'Before · old version' : 'After · new version')
      : (side === 'old' ? 'Old image' : 'Image preview')));
    figure.append(heading);
    if (!data) {
      figure.append(element('div', 'empty-small', notice ?? (view !== 'diff' ? 'Image is no longer available. Refresh the file list.' : side === 'old' ? 'No previous image — added file.' : 'No current image — deleted file.')));
    } else if (!/^data:image\/(png|jpeg|webp);base64,/.test(data)) {
      figure.append(element('div', 'notice', 'Unsupported image payload.'));
    } else {
      const toolbar = element('div', 'image-toolbar');
      const dimensions = element('span', 'image-dimensions', 'Loading image…');
      const stage = element('div', 'image-stage');
      const image = element('img', 'review-image');
      image.alt = `${side === 'old' ? 'Old' : 'New'} version of ${path}`;
      image.decoding = 'async';
      image.addEventListener('load', () => { dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight} px`; });
      image.addEventListener('error', () => {
        image.hidden = true;
        dimensions.textContent = 'Cannot decode image';
        stage.append(element('div', 'notice', 'This image is corrupt or cannot be decoded by the system image renderer.'));
      });
      image.src = data;
      const fit = element('button', 'active', 'Fit');
      const actual = element('button', '', '100%');
      fit.setAttribute('aria-pressed', 'true');
      actual.setAttribute('aria-pressed', 'false');
      fit.title = 'Fit image to the preview';
      actual.title = 'Show image at its original pixel size';
      const resize = (original: boolean) => {
        stage.classList.toggle('actual-size', original);
        fit.classList.toggle('active', !original);
        actual.classList.toggle('active', original);
        fit.setAttribute('aria-pressed', String(!original));
        actual.setAttribute('aria-pressed', String(original));
      };
      fit.addEventListener('click', () => resize(false));
      actual.addEventListener('click', () => resize(true));
      toolbar.append(dimensions, fit, actual);
      stage.append(image);
      figure.append(toolbar, stage);
    }
    const comment = element('button', 'image-comment', `Comment on ${side} image`);
    comment.addEventListener('click', () => options.onAnchor({ side, line: null, endLine: null }, false));
    // Missing sides have no content to annotate; failed previews still allow a file comment.
    if (data || notice) figure.append(comment);
    layout.append(figure);
  }
  host.append(layout);
}

export function renderContent(host: HTMLElement, options: RenderOptions): void {
  host.replaceChildren();
  const { content, view, path } = options;
  const fileComments = options.comments.filter(c => c.line === null);
  if (fileComments.length) host.append(inlineComments(fileComments));
  if (isImage(path) || content.oldImage || content.newImage) { renderImages(host, options); return; }
  const side = content.new !== null || content.newNotice !== null ? 'new' : 'old';
  const source = content[side];
  const notice = content[side === 'new' ? 'newNotice' : 'oldNotice'];
  if (view !== 'diff') {
    if (notice) { host.append(element('div', 'notice', notice)); return; }
    if (source === null) { host.append(element('div', 'notice', 'File is no longer available. Refresh the file list.')); return; }
    if (side === 'old') host.append(element('div', 'notice', 'Deleted file · showing the old version.'));
    if (view === 'preview') { preview(host, source, options, side); return; }
    if (view === 'pretty') {
      try {
        const formatted = prettyJson(source);
        host.append(element('div', 'notice', 'Formatted JSON · display only; file unchanged. Use Source for original line comments.'));
        const table = element('div', 'code-table source');
        const lines = highlightedLines(formatted, path);
        for (const [index, html] of lines.slice(0, 20000).entries()) {
          const row = element('div', 'code-line');
          const code = element('code');
          code.innerHTML = html || ' ';
          row.append(element('span', 'line-number', String(index + 1)), code);
          table.append(row);
        }
        host.append(table);
        if (lines.length > 20000) host.append(element('div', 'notice', 'Preview truncated at 20,000 rows.'));
        return;
      } catch (error) {
        host.append(element('div', 'notice', `Cannot prettify JSON: ${String(error)}. Showing original source.`));
      }
    }
    if (source.length > 250000) host.append(element('div', 'notice', 'Large file · syntax highlighting disabled for responsiveness.'));
    const lines = highlightedLines(source, path);
    renderLines(host, lines.map((html, i) => ({ old: side === 'old' ? i + 1 : null, new: side === 'new' ? i + 1 : null, html, type: '' })), options);
    return;
  }
  if (content.oldNotice || content.newNotice) {
    host.append(element('div', 'notice', [content.oldNotice && `Old: ${content.oldNotice}`, content.newNotice && `New: ${content.newNotice}`].filter(Boolean).join('\n')));
    return;
  }
  const old = content.old ?? '', next = content.new ?? '';
  const patch = reviewPatch(path, old, next);
  if (!patch) { host.append(element('div', 'notice', 'This diff is too complex to render quickly. Use Source to read the file.')); return; }
  if (old !== next && (old.includes('\r\n') || next.includes('\r\n'))) {
    host.append(element('div', 'notice', 'LF/CRLF line-ending differences are ignored in this diff. Source files are unchanged.'));
  }
  if (!patch.hunks.length) { host.append(element('div', 'notice', 'No textual changes. This may be a rename, a line-ending-only change, an empty file, a file-mode change, or a change since the last refresh.')); return; }
  const oldLines = highlightedLines(normalizeDiffText(old), path), newLines = highlightedLines(normalizeDiffText(next), path);
  const rows: { old: number | null; new: number | null; html: string; type: string }[] = [];
  for (const hunk of patch.hunks) {
    rows.push({ old: null, new: null, html: escapeHtml(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`), type: 'hunk' });
    let a = hunk.oldStart, b = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('\\')) { rows.push({ old: null, new: null, html: escapeHtml(line), type: 'hunk' }); continue; }
      const removed = line.startsWith('-'), added = line.startsWith('+');
      rows.push({ old: added ? null : a, new: removed ? null : b, html: (removed ? oldLines[a - 1] : newLines[b - 1]) ?? '', type: removed ? 'removed' : added ? 'added' : '' });
      if (!added) a++;
      if (!removed) b++;
    }
  }
  renderLines(host, rows, options);
}
