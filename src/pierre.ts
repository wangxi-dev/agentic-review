import { formatPatch } from 'diff';
import { normalizeDiffText, reviewPatch } from './diff';
import type { FileDiff, FileDiffMetadata } from '@pierre/diffs';
import type { Anchor, FileContent, ReviewComment } from './types';

export type DiffRenderer = 'classic' | 'pierre-unified' | 'pierre-split';
export const parseDiffRenderer = (value: string | null): DiffRenderer =>
  value === 'pierre-unified' || value === 'pierre-split' ? value : 'classic';

// Keep the experiment bounded until worker/virtualized rendering is evaluated.
export function pierreEligible(old: string, next: string): boolean {
  return old.length + next.length <= 250000
    && old.split('\n').length + next.split('\n').length <= 4000;
}

// Both viewers consume the same timeout-bounded patch. Pierre adds rendering,
// line matching and word highlights; it does not replace the underlying jsdiff.
export function pierreMetadata(
  processFile: typeof import('@pierre/diffs').processFile,
  path: string, content: FileContent, patch: NonNullable<ReturnType<typeof reviewPatch>>,
): FileDiffMetadata {
  // Patch headers cannot safely represent every legal Git filename. Use a fixed
  // header and restore the display path without ever interpolating it into a patch.
  const metadata = processFile(formatPatch({ ...patch, oldFileName: 'file', newFileName: 'file' }), {
    oldFile: { name: path, contents: normalizeDiffText(content.old ?? '') },
    newFile: { name: path, contents: normalizeDiffText(content.new ?? '') },
    throwOnError: true,
  });
  if (!metadata) throw new Error('Pierre could not parse this patch.');
  metadata.name = path;
  metadata.prevName = undefined;
  metadata.type = content.old === null ? 'new' : content.new === null ? 'deleted' : 'change';
  return metadata;
}

interface Mount {
  cancelled: boolean;
  view?: FileDiff<ReviewComment>;
  observer?: MutationObserver;
  anchor?: Anchor;
}
const mounts = new WeakMap<HTMLElement, Mount>();

export function disposePierre(host: HTMLElement): void {
  const mount = mounts.get(host);
  if (!mount) return;
  mount.cancelled = true;
  mount.observer?.disconnect();
  mount.view?.cleanUp();
  mounts.delete(host);
}

export function selectPierre(host: HTMLElement, anchor: Anchor): void {
  const mount = mounts.get(host);
  if (!mount) return;
  mount.anchor = anchor;
  mount.view?.setSelectedLines(anchor.line === null ? null : {
    start: anchor.line, end: anchor.endLine ?? anchor.line,
    side: anchor.side === 'old' ? 'deletions' : 'additions',
  });
}

export function renderPierre(host: HTMLElement, options: {
  path: string;
  content: FileContent;
  patch: NonNullable<ReturnType<typeof reviewPatch>>;
  renderer: Exclude<DiffRenderer, 'classic'>;
  comments: ReviewComment[];
  onAnchor: (anchor: Anchor, shift: boolean) => void;
  fallback: (error: unknown) => void;
}): void {
  const mount: Mount = { cancelled: false };
  mounts.set(host, mount);
  // Use Pierre's custom element: its connection lifecycle applies theme styles
  // and schedules highlighting. A plain div accepts a shadow root but is unstyled.
  const container = document.createElement('diffs-container');
  container.className = 'pierre-view';
  const loading = document.createElement('div');
  loading.className = 'notice';
  loading.textContent = 'Loading Pierre diff renderer…';
  container.append(loading);
  host.append(container);
  // Loading this chunk only on demand keeps Shiki out of the classic startup path.
  void import('@pierre/diffs').then(({ FileDiff, processFile }) => {
    if (mount.cancelled) return;
    const metadata = pierreMetadata(processFile, options.path, options.content, options.patch);
    const theme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    const anchorLine = (line: number, side: 'old' | 'new', shift: boolean) =>
      options.onAnchor({ line, side, endLine: null }, shift);
    const view = new FileDiff<ReviewComment>({
      diffStyle: options.renderer === 'pierre-split' ? 'split' : 'unified',
      theme: { light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' },
      themeType: theme(),
      disableFileHeader: true,
      diffIndicators: 'classic',
      lineDiffType: 'word-alt',
      overflow: 'scroll',
      hunkSeparators: 'line-info',
      tokenizeMaxLength: 250000,
      disableErrorHandling: true,
      unsafeCSS: '[data-column-number][role="button"] { cursor: pointer; } [data-column-number]:focus-visible { outline: 2px solid var(--diffs-fg); outline-offset: -2px; } pre { font-weight: 500; }',
      onLineNumberClick: ({ lineNumber, annotationSide, event }) =>
        anchorLine(lineNumber, annotationSide === 'deletions' ? 'old' : 'new', event.shiftKey),
      renderAnnotation: ({ metadata: comment }) => {
        const note = document.createElement('div');
        note.className = `inline-comment pierre-comment ${comment.status}`;
        note.textContent = `${comment.status === 'resolved' ? '✓' : '●'} ${comment.text}`;
        return note;
      },
      // Pierre's vanilla gutter is pointer-based. Supply equivalent keyboard
      // activation and accessible names without changing its pointer handlers.
      onPostRender: (node, _view, phase) => {
        if (phase === 'unmount') return;
        node.shadowRoot?.querySelectorAll<HTMLElement>('[data-column-number]').forEach(gutter => {
          const line = Number(gutter.dataset.columnNumber);
          if (!line) return;
          const side = gutter.dataset.lineType === 'change-deletion'
            || gutter.closest('[data-deletions]') ? 'old' : 'new';
          gutter.setAttribute('role', 'button');
          gutter.setAttribute('aria-label', `${side} line ${line}`);
          gutter.tabIndex = 0;
          gutter.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              anchorLine(line, side, event.shiftKey);
            }
          };
        });
      },
    });
    mount.view = view;
    loading.remove();
    view.render({ fileContainer: container, fileDiff: metadata,
      lineAnnotations: options.comments.filter(c => c.line !== null).map(c => ({
        lineNumber: c.line!, side: c.side === 'old' ? 'deletions' : 'additions', metadata: c,
      })),
    });
    if (mount.anchor) selectPierre(host, mount.anchor);
    mount.observer = new MutationObserver(() => view.setThemeType(theme()));
    mount.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }).catch(error => {
    if (mount.cancelled) return;
    disposePierre(host);
    options.fallback(error);
  });
}
