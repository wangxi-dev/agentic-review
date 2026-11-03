export type Mode = 'diff' | 'commit' | 'folder';
export interface Context { mode: Mode; revision: string | null; base: string | null }
export interface ReviewComment {
  id: string;
  path: string;
  oldPath: string | null;
  context: Context;
  side: 'old' | 'new';
  line: number | null;
  endLine: number | null;
  quote?: string | null;
  text: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
}
export interface ReviewDocument {
  schemaVersion: number;
  root: string;
  updatedAt: string;
  comments: ReviewComment[];
}
export interface Opened { root: string; document: ReviewDocument }
export interface FileEntry { path: string; oldPath: string | null; status: string; directory?: boolean }
export interface FileSearch { files: FileEntry[]; truncated: boolean }
export interface Snapshot { context: Context; files: FileEntry[] }
export interface Commit { hash: string; subject: string; author: string; date: string }
export interface FileContent {
  old: string | null;
  new: string | null;
  oldNotice: string | null;
  newNotice: string | null;
  oldImage: string | null;
  newImage: string | null;
}
export interface Anchor { side: 'old' | 'new'; line: number | null; endLine: number | null; quote?: string | null }
export type View = 'diff' | 'source' | 'preview' | 'pretty';

export function sameContext(a: Context, b: Context): boolean {
  return a.mode === b.mode && a.revision === b.revision && a.base === b.base;
}
export function anchorLabel(anchor: Anchor): string {
  if (anchor.quote) return `${anchor.side === 'old' ? 'Old' : 'New'} HTML selection: “${anchor.quote}”`;
  return anchor.line === null ? (anchor.side === 'old' ? 'Old version · file-level comment' : 'File-level comment') : `${anchor.side === 'old' ? 'Old' : 'New'} line ${anchor.line}${anchor.endLine && anchor.endLine !== anchor.line ? `–${anchor.endLine}` : ''}`;
}
export function contextLabel(context: Context): string {
  if (context.mode === 'commit') return `Commit ${context.revision?.slice(0, 8)}`;
  if (context.mode === 'folder') return 'Full folder';
  return `Working tree vs ${context.base?.slice(0, 8) ?? 'empty tree'}`;
}
