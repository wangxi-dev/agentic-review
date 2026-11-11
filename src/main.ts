import { call, pickFolder, ask, handleClose } from './bridge';
import { element, canPreview, isImage, renderContent } from './render';
import { connectAppearanceControls } from './appearance';
import { disposePierre, parseDiffRenderer, selectPierre, type DiffRenderer } from './pierre';
import { connectIcons, fileIcon, icon } from './icons';
import { fileMatcher, fileStatus } from './files';
import { anchorLabel, contextLabel, sameContext } from './types';
import type { Anchor, Commit, Context, FileContent, FileEntry, FileSearch, Mode, Opened, ReviewComment, ReviewDocument, Snapshot, View } from './types';
import './styles.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
let documentData: ReviewDocument | null = null;
let snapshot: Snapshot | null = null;
let selected: FileEntry | null = null;
let content: FileContent | null = null;
let view: View = 'source';
let renderer: DiffRenderer = 'classic';
try { renderer = parseDiffRenderer(localStorage.getItem('agentic-review.diff-renderer')); } catch { /* Session defaults. */ }
let anchor: Anchor = { side: 'new', line: null, endLine: null };
let editing: string | null = null;
let busy = false;
let dirty = false;
let mode: Mode = 'diff';
let activeContext: Context | null = null;
const folders = new Map<string, FileEntry[]>();
const expandedFolders = new Set<string>();
let searchResult: FileSearch | null = null;
let searchVersion = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
let searching = false;
const draft = () => $('comment-text') as HTMLTextAreaElement;

function showError(error: unknown): void {
  $('error-text').textContent = String(error);
  $('error').hidden = false;
}
function controls(): void {
  const opened = !!documentData;
  $('open-folder').toggleAttribute('disabled', busy);
  $('export').toggleAttribute('disabled', busy || !opened);
  $('copy-comments').toggleAttribute('disabled', busy || !opened);
  $('copy-export-path').toggleAttribute('disabled', busy);
  $('refresh').toggleAttribute('disabled', busy || !opened);
  $<HTMLInputElement>('file-filter').disabled = busy || !opened;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
    button.disabled = busy || !opened;
    button.classList.toggle('active', button.dataset.mode === mode);
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  $('revision-form').hidden = mode !== 'commit';
  $('revision-form').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button').forEach(node => { node.disabled = busy; });
  draft().disabled = busy || !selected;
  $('add-comment').toggleAttribute('disabled', busy || !selected);
  $('add-comment').textContent = editing ? 'Save edit' : 'Add comment';
  $('cancel-edit').hidden = !editing;
  for (const id of ['files', 'content', 'comment-list', 'view-tabs', 'clear-anchor', 'cancel-edit']) $(id).inert = busy;
  document.body.classList.toggle('busy', busy);
}
async function run(action: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  $('error').hidden = true;
  controls();
  try { await action(); } catch (error) { showError(error); }
  finally { busy = false; controls(); }
}
async function persist(showPaths = false): Promise<void> {
  if (!documentData) return;
  $('save-status').textContent = 'Saving comments…';
  try {
    const paths = await call<string[]>('save_comments', { document: documentData });
    const markdownPath = paths.find(path => path.endsWith('.md')) ?? '';
    const jsonPath = paths.find(path => path.endsWith('.json')) ?? '';
    $<HTMLInputElement>('markdown-path').value = markdownPath;
    $<HTMLInputElement>('json-path').value = jsonPath;
    $('export-location').textContent = markdownPath;
    $('export-location').title = paths.join('\n');
    if (showPaths) $('export-result').hidden = false;
    dirty = false;
    $('save-status').textContent = `Saved ${documentData.comments.length} comment(s) · JSON + Markdown`;
  } catch (error) {
    dirty = true;
    $('save-status').textContent = 'Not saved · use Export comments to retry';
    throw error;
  }
}
async function canNavigate(): Promise<boolean> {
  if (dirty) await persist();
  if (draft().value.trim() && !(await ask('Discard the comment draft before navigating?'))) return false;
  resetDraft();
  return true;
}
function resetDraft(): void {
  draft().value = '';
  editing = null;
  anchor = { side: 'new', line: null, endLine: null };
  updateAnchor();
}
function updateAnchor(): void {
  $('anchor-label').textContent = anchorLabel(anchor);
  selectPierre($('content'), anchor);
  document.querySelectorAll<HTMLElement>('#content [data-old], #content [data-new]').forEach(row => {
    const line = Number(row.dataset[anchor.side]);
    row.classList.toggle('selected-line', anchor.line !== null && line >= anchor.line && line <= (anchor.endLine ?? anchor.line));
  });
}
function currentComments(): ReviewComment[] {
  return documentData?.comments.filter(c => c.path === selected?.path && activeContext && sameContext(c.context, activeContext)) ?? [];
}
function drawContent(): void {
  if (!selected || !content || !activeContext) return;
  renderContent($('content'), { path: selected.path, view, renderer, content, comments: currentComments(), onAnchor: (next, shift) => {
    if (editing) return;
    if (shift && anchor.line !== null && next.line !== null && anchor.side === next.side) {
      anchor = { side: next.side, line: Math.min(anchor.line, next.line), endLine: Math.max(anchor.line, next.line) };
    } else { anchor = next; }
    updateAnchor();
    draft().focus();
  } });
  updateAnchor();
}
function drawTabs(): void {
  const tabs = $('view-tabs');
  tabs.replaceChildren();
  if (!selected || !activeContext) return;
  const views: View[] = isImage(selected.path)
    ? (activeContext.mode === 'folder' ? ['preview'] : ['diff', 'preview'])
    : (activeContext.mode === 'folder' ? ['source'] : ['diff', 'source']);
  if (!isImage(selected.path) && canPreview(selected.path)) views.push('preview');
  for (const name of views) {
    const button = element('button', view === name ? 'active' : '', name[0].toUpperCase() + name.slice(1));
    button.prepend(icon(name === 'diff' ? 'diff' : name === 'preview' ? 'preview' : 'source'));
    button.setAttribute('aria-pressed', String(view === name));
    button.addEventListener('click', () => { view = name; drawTabs(); drawContent(); });
    tabs.append(button);
  }
  if (view === 'diff' && !isImage(selected.path)) {
    const label = element('label', 'renderer-control', 'Renderer');
    const select = element('select');
    select.setAttribute('aria-label', 'Diff renderer');
    for (const [value, text] of [['classic', 'Classic'], ['pierre-unified', 'Pierre · Unified'], ['pierre-split', 'Pierre · Split']]) {
      const option = element('option', '', text);
      option.value = value;
      select.append(option);
    }
    select.value = renderer;
    select.addEventListener('change', () => {
      renderer = parseDiffRenderer(select.value);
      try { localStorage.setItem('agentic-review.diff-renderer', renderer); } catch { /* Session-only preference. */ }
      drawContent();
    });
    label.append(select);
    tabs.append(label);
  }
  if (/\.json$/i.test(selected.path)) {
    const button = element('button', view === 'pretty' ? 'active' : '', view === 'pretty' ? 'Original JSON' : 'Prettify JSON');
    button.setAttribute('aria-pressed', String(view === 'pretty'));
    button.title = 'Format JSON for viewing without changing the file. Use Source for line comments.';
    button.addEventListener('click', () => { view = view === 'pretty' ? 'source' : 'pretty'; drawTabs(); drawContent(); });
    tabs.append(button);
  }
}
function fileButton(file: FileEntry): HTMLButtonElement {
  const button = element('button', `file ${selected?.path === file.path ? 'active' : ''}`);
  button.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  button.dataset.path = file.path;
  const status = fileStatus(file.status);
  const marker = element('span', `file-status status-${file.status}`, status.symbol);
  marker.title = status.label;
  marker.setAttribute('aria-label', status.label);
  button.append(marker, fileIcon(file.path), element('span', 'file-name', file.path.split('/').pop()!));
  const count = documentData?.comments.filter(c => c.path === file.path).length ?? 0;
  if (count) button.append(element('span', 'comment-dot', String(count)));
  button.addEventListener('click', () => void run(async () => { if (await canNavigate()) await openFile(file); }));
  return button;
}
function drawFolder(host: HTMLElement, files: FileEntry[]): void {
  for (const file of files) {
    if (!file.directory) { host.append(fileButton(file)); continue; }
    const group = element('details', 'file-group lazy-folder');
    const summary = element('summary', '', file.path.split('/').pop()!);
    summary.prepend(icon('folder'));
    summary.dataset.directory = file.path;
    group.open = expandedFolders.has(file.path);
    const children = element('div', 'folder-children');
    group.append(summary, children);
    if (group.open) drawFolder(children, folders.get(file.path) ?? []);
    group.addEventListener('toggle', () => {
      if (!group.isConnected) return;
      if (!group.open) { expandedFolders.delete(file.path); return; }
      expandedFolders.add(file.path);
      if (folders.has(file.path)) { children.replaceChildren(); drawFolder(children, folders.get(file.path)!); return; }
      const root = documentData?.root;
      const current = snapshot;
      if (!root) return;
      children.replaceChildren(element('div', 'empty-small', 'Loading…'));
      void call<FileEntry[]>('list_folder', { root, directory: file.path }).then(entries => {
        if (snapshot !== current) return;
        folders.set(file.path, entries);
        children.replaceChildren();
        drawFolder(children, entries);
        if (!entries.length) children.append(element('div', 'empty-small', 'Empty folder.'));
      }).catch(error => {
        if (snapshot !== current) return;
        children.replaceChildren(element('div', 'empty-small', 'Could not load folder. Collapse and expand to retry.'));
        showError(error);
      });
    });
    host.append(group);
  }
}
function drawFiles(): void {
  const host = $('files');
  host.replaceChildren();
  const filter = $<HTMLInputElement>('file-filter').value.trim();
  if (mode === 'folder' && !filter) {
    $('file-count').textContent = String(snapshot?.files.length ?? 0);
    drawFolder(host, snapshot?.files ?? []);
    if (!snapshot?.files.length) host.append(element('div', 'empty-small', 'No files to review.'));
    return;
  }
  if (mode === 'folder' && searching) {
    $('file-count').textContent = '…';
    host.append(element('div', 'empty-small', 'Searching filenames…'));
    return;
  }
  const matches = fileMatcher(filter);
  const files = mode === 'folder' ? searchResult?.files ?? [] : snapshot?.files.filter(file => matches(file.path)) ?? [];
  $('file-count').textContent = mode === 'folder' ? `${files.length}${searchResult?.truncated ? '+' : ''}` : String(snapshot?.files.length ?? 0);
  if (mode === 'folder' && searchResult?.truncated) host.append(element('div', 'notice', 'Showing the first 500 matches. Refine your search.'));
  if (!files.length) {
    host.append(element('div', 'empty-small', filter ? 'No files match your filter.' : mode === 'diff' ? 'Working tree is clean.' : 'No files to review.'));
    return;
  }
  // Group full paths by directory. Nested groups can be collapsed without rebuilding the list.
  const groups = new Map<string, HTMLElement>();
  for (const file of files) {
    if (file.directory) { drawFolder(host, [file]); continue; }
    const slash = file.path.lastIndexOf('/');
    const directory = slash < 0 ? '.' : file.path.slice(0, slash);
    let group = groups.get(directory);
    if (!group) {
      const details = element('details', 'file-group');
      details.open = true;
      const summary = element('summary', '', directory === '.' ? 'Repository root' : directory);
      summary.prepend(icon('folder'));
      details.append(summary);
      group = element('div');
      details.append(group);
      host.append(details);
      groups.set(directory, group);
    }
    group.append(fileButton(file));
  }
}
async function openFile(file: FileEntry, context = snapshot?.context): Promise<void> {
  if (!documentData || !context) return;
  const result = await call<FileContent>('read_file', { root: documentData.root, path: file.path, oldPath: file.oldPath, context });
  selected = file;
  content = result;
  activeContext = context;
  view = canPreview(file.path) ? 'preview' : context.mode === 'folder' ? 'source' : 'diff';
  $('file-path').textContent = file.path;
  $('file-path').title = file.path;
  $('file-meta').hidden = false;
  $('file-meta').textContent = `${contextLabel(context)}${file.oldPath ? ` · Renamed from ${file.oldPath}` : ''}${file.status === 'D' ? ' · Deleted' : ''}`;
  drawFiles(); drawTabs(); drawContent(); drawComments();
}
function clearFile(message: string): void {
  disposePierre($('content'));
  selected = null; content = null; activeContext = null;
  $('file-path').textContent = 'Review workspace';
  $('file-meta').hidden = true;
  $('view-tabs').replaceChildren();
  $('content').replaceChildren(element('div', 'empty', message));
  drawComments();
}
async function loadSnapshot(nextMode = mode): Promise<void> {
  if (!documentData) return;
  const next = await call<Snapshot>('review_snapshot', {
    root: documentData.root, mode: nextMode,
    revision: nextMode === 'commit' ? $<HTMLInputElement>('revision').value.trim() || 'HEAD' : null,
  });
  const previous = selected?.path;
  searchVersion++;
  clearTimeout(searchTimer);
  searching = false;
  searchResult = null;
  folders.clear();
  expandedFolders.clear();
  snapshot = next;
  mode = nextMode;
  $('context-label').textContent = contextLabel(next.context);
  $('files-note').textContent = mode === 'folder' ? 'Expand folders to load · search all filenames · * and ? wildcards' : mode === 'commit' ? 'Committed snapshot · first-parent comparison' : 'Staged + unstaged + untracked · vs HEAD';
  clearFile(next.files.length ? 'Select a file to begin reviewing.' : mode === 'diff' ? 'Nothing to review — your working tree is clean.' : 'No files in this review.');
  drawFiles();
  const file = mode === 'folder' ? undefined : next.files.find(f => !f.directory && f.path === previous) ?? next.files.find(f => !f.directory);
  if (file) await openFile(file);
  if ($<HTMLInputElement>('file-filter').value.trim()) filterFiles();
}
async function refreshCommits(): Promise<void> {
  if (!documentData) return;
  const commits = await call<Commit[]>('list_commits', { root: documentData.root });
  $('commits').replaceChildren(...commits.map(commit => {
    const option = element('option');
    option.value = commit.hash;
    option.label = `${commit.hash.slice(0, 8)} · ${commit.subject} · ${commit.author} · ${commit.date.slice(0, 10)}`;
    return option;
  }));
}
async function openRepository(path: string): Promise<void> {
  if (!(await canNavigate())) return;
  const opened = await call<Opened>('open_repository', { path });
  documentData = opened.document;
  dirty = false;
  snapshot = null;
  mode = 'diff';
  clearFile('Loading repository…');
  $('root').textContent = opened.root;
  $('root').title = opened.root;
  $('export-result').hidden = true;
  $('export-location').textContent = `${opened.root.replace(/[\\/]$/, '')}${opened.root.includes('\\') ? '\\' : '/'}agentic-review.comments.md`;
  $('export-location').title = $('export-location').textContent ?? '';
  $('save-status').textContent = `${opened.document.comments.length} saved comment(s) loaded · autosave on changes`;
  $<HTMLInputElement>('file-filter').value = '';
  $<HTMLInputElement>('revision').value = 'HEAD';
  await loadSnapshot();
  await refreshCommits();
}
const chooseFolder = () => void run(async () => { const path = await pickFolder(); if (path) await openRepository(path); });

async function changeComments(change: () => void): Promise<void> {
  if (!documentData) return;
  change();
  documentData.updatedAt = new Date().toISOString();
  dirty = true;
  drawComments(); drawFiles(); drawContent();
  await persist();
}
function drawComments(): void {
  const list = $('comment-list');
  list.replaceChildren();
  const all = documentData?.comments ?? [];
  $('comment-count').textContent = String(all.length);
  const comments = $<HTMLSelectElement>('comment-scope').value === 'all' ? all : all.filter(c => c.path === selected?.path);
  if (!comments.length) list.append(element('div', 'empty-small', 'No comments yet. Read, select a line, and leave a note.'));
  for (const comment of comments) {
    const card = element('article', `comment-card ${comment.status}`);
    const heading = element('button', 'comment-anchor', `${comment.path} · ${anchorLabel(comment)}`);
    heading.title = 'Open the file and recorded review context';
    heading.addEventListener('click', () => void run(async () => {
      if (!(await canNavigate())) return;
      await openFile({ path: comment.path, oldPath: comment.oldPath, status: '' }, comment.context);
      anchor = { side: comment.side, line: comment.line, endLine: comment.endLine, quote: comment.quote };
      if (comment.quote) view = 'preview';
      else if (comment.line !== null) view = comment.side === 'old' && content?.new !== null ? 'diff' : 'source';
      drawTabs(); drawContent();
      const target = document.querySelector<HTMLElement>(`#content [data-${comment.side}="${comment.line}"]`);
      target?.scrollIntoView({ block: 'center' });
    }));
    card.append(heading, element('div', 'comment-context', contextLabel(comment.context)), element('p', 'comment-body', comment.text));
    const actions = element('div', 'comment-actions');
    const status = element('button', 'status-button', comment.status === 'open' ? '○ Open' : '✓ Resolved');
    status.title = 'Toggle resolved status';
    status.addEventListener('click', () => void run(() => changeComments(() => {
      comment.status = comment.status === 'open' ? 'resolved' : 'open';
      comment.updatedAt = new Date().toISOString();
    })));
    const edit = element('button', '', 'Edit');
    edit.addEventListener('click', () => void run(async () => {
      if (!(await canNavigate())) return;
      await openFile({ path: comment.path, oldPath: comment.oldPath, status: '' }, comment.context);
      editing = comment.id;
      anchor = { side: comment.side, line: comment.line, endLine: comment.endLine, quote: comment.quote };
      draft().value = comment.text;
      updateAnchor();
      // Focus after run() re-enables the form.
      setTimeout(() => draft().focus(), 0);
    }));
    const remove = element('button', 'delete-comment', 'Delete');
    remove.addEventListener('click', () => void run(async () => {
      if (!(await ask('Delete this comment?'))) return;
      await changeComments(() => {
        documentData!.comments = documentData!.comments.filter(c => c.id !== comment.id);
        if (editing === comment.id) resetDraft();
      });
    }));
    actions.append(status, element('span', 'spacer'), edit, remove);
    card.append(actions);
    if (!activeContext || !sameContext(comment.context, activeContext)) card.append(element('div', 'comment-context', 'From another review snapshot · click to open'));
    list.append(card);
  }
}

connectAppearanceControls();
connectIcons();
if (import.meta.env.MODE === 'demo') {
  const banner = element('div', 'demo-banner', 'DEMO · Fixture repository · Comments stay in memory; no files are read or written. Use Renderer to compare Classic and Pierre.');
  document.querySelector('.repository-bar')!.after(banner);
}
$('open-folder').addEventListener('click', chooseFolder);
$('welcome-open').addEventListener('click', chooseFolder);
$('dismiss-error').addEventListener('click', () => { $('error').hidden = true; });
$('export').addEventListener('click', () => void run(() => persist(true)));
$('dismiss-export').addEventListener('click', () => { $('export-result').hidden = true; });
$('copy-export-path').addEventListener('click', () => void run(async () => {
  await navigator.clipboard.writeText($<HTMLInputElement>('markdown-path').value);
  $('save-status').textContent = 'Markdown file path copied';
}));
$('copy-comments').addEventListener('click', () => void run(async () => {
  if (!documentData) return;
  const markdown = await call<string>('comments_markdown', { document: documentData });
  await navigator.clipboard.writeText(markdown);
  $('save-status').textContent = `Copied all ${documentData.comments.length} comment(s) · Markdown`;
}));
$('refresh').addEventListener('click', () => void run(async () => { if (await canNavigate()) { await loadSnapshot(); await refreshCommits(); } }));
function filterFiles(): void {
  clearTimeout(searchTimer);
  const version = ++searchVersion;
  const query = $<HTMLInputElement>('file-filter').value.trim();
  searchResult = null;
  searching = mode === 'folder' && !!query;
  drawFiles();
  if (!searching || !documentData) return;
  const root = documentData.root;
  searchTimer = setTimeout(() => {
    void call<FileSearch>('search_files', { root, query }).then(result => {
      if (version !== searchVersion) return;
      searchResult = result;
      searching = false;
      drawFiles();
    }).catch(error => {
      if (version !== searchVersion) return;
      searching = false;
      drawFiles();
      showError(error);
    });
  }, 200);
}
$('file-filter').addEventListener('input', filterFiles);
$('comment-scope').addEventListener('change', drawComments);
$('clear-anchor').addEventListener('click', () => { if (!editing) { anchor = { side: 'new', line: null, endLine: null }; updateAnchor(); } });
$('cancel-edit').addEventListener('click', () => { resetDraft(); controls(); });
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => {
  button.addEventListener('click', () => void run(async () => { if (await canNavigate()) await loadSnapshot(button.dataset.mode as Mode); }));
});
$('revision-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => { if (await canNavigate()) await loadSnapshot('commit'); });
});
$('comment-form').addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    const text = draft().value.trim();
    if (!text || !documentData || !selected || !activeContext) return;
    await changeComments(() => {
      const now = new Date().toISOString();
      const existing = documentData!.comments.find(c => c.id === editing);
      if (existing) { existing.text = text; existing.updatedAt = now; }
      else documentData!.comments.push({ id: crypto.randomUUID(), path: selected!.path, oldPath: selected!.oldPath, context: { ...activeContext! }, ...anchor, text, status: 'open', createdAt: now, updatedAt: now });
      resetDraft();
    });
  });
});
draft().addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') $('comment-form').dispatchEvent(new Event('submit', { cancelable: true })); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); chooseFolder(); }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void run(() => persist(true)); }
});

controls();
void handleClose(async () => {
  if (busy) { showError('Please wait for the current operation to finish before closing.'); return false; }
  if (dirty || draft().value.trim()) return ask('There are unsaved comments or an unfinished draft. Close and discard them?');
  return true;
}).catch(showError);
void run(async () => {
  const path = await call<string | null>('startup_path');
  if (path) await openRepository(path);
});
