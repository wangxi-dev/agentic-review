// A small, vendored subset of Pierre's SVGs (Apache-2.0 / MIT; see NOTICE). No React runtime or
// external asset requests; filenames and user content never become markup.
const assets = import.meta.glob('./assets/pierre/*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const names = {
  folder: 'folder', file: 'file', typescript: 'lang-typescript', javascript: 'lang-javascript',
  python: 'lang-python', rust: 'lang-rust', markdown: 'lang-markdown', json: 'braces', image: 'image',
  open: 'IconFolderOpen', copy: 'IconCopy', export: 'IconFileExport', refresh: 'IconRefresh',
  commit: 'IconCommit', diff: 'IconDiffUnified', split: 'IconDiffSplit', folders: 'IconFolders',
  source: 'IconCode', preview: 'IconEye', comment: 'IconComment',
} as const;
export type IconName = keyof typeof names;
export function icon(name: IconName): HTMLElement {
  const span = document.createElement('span');
  span.className = `icon icon-${name}`;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = assets[`./assets/pierre/${names[name]}.svg`].replace(/fill="black"/g, 'fill="currentColor"');
  return span;
}
export function fileIcon(path: string): HTMLElement {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, IconName> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', py: 'python', rs: 'rust', md: 'markdown', json: 'json', png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', svg: 'image' };
  return icon(map[ext] ?? 'file');
}
export function connectIcons(): void {
  const controls: Record<string, IconName> = {
    'open-folder': 'open', 'welcome-open': 'open', 'copy-comments': 'copy', export: 'export', refresh: 'refresh',
  };
  for (const [id, name] of Object.entries(controls)) {
    const button = document.getElementById(id);
    if (button) {
      if (id === 'refresh') button.textContent = 'Refresh';
      button.prepend(icon(name));
    }
  }
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach(button =>
    button.prepend(icon(button.dataset.mode === 'commit' ? 'commit' : button.dataset.mode === 'folder' ? 'folders' : 'diff')));
  document.querySelectorAll<HTMLElement>('.brand-icon, .welcome-icon').forEach(mark => mark.replaceChildren(icon('comment')));
}
