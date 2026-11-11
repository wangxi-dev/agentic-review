export const before = `import { readFile } from './repository';
import type { ReviewComment } from './types';

const MAX_PREVIEW_BYTES = 1024 * 1024;

type ReviewOptions = {
  path: string;
  comments: ReviewComment[];
};

// Load a local file for review.
export async function openReview(options: ReviewOptions) {
  const { path, comments } = options;
  const content = await readFile(path);

  if (content.size > MAX_PREVIEW_BYTES) {
    return { notice: 'File too large', lines: [] };
  }

  const lines = content.text.split('\\n');
  const visibleComments = comments.filter(c => c.path === path);

  return {
    path,
    lines,
    comments: visibleComments,
    canComment: true,
  };
}

export function commentSummary(comments: ReviewComment[]) {
  return comments.length + ' comments';
}
`;

export const after = before
  .replace('1024 * 1024;', '5 * 1024 * 1024;')
  .replace('Load a local file for review.', 'Load a local file and preserve review anchors.')
  .replace("  const lines = content.text.split('\\n');", "  // Git blobs use LF; Windows working trees may use CRLF.\n  const normalized = content.text.replace(/\\r\\n/g, '\\n');\n  const lines = normalized.split('\\n');")
  .replace('c => c.path === path', "c => c.path === path && c.status === 'open'")
  .replace("  return comments.length + ' comments';", "  const open = comments.filter(c => c.status === 'open').length;\n  return `${open} open / ${comments.length} total`;");
