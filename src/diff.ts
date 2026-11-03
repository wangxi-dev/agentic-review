import { structuredPatch } from 'diff';

// Git blobs often use LF while Windows working-tree files use CRLF.
// Preserve whitespace and final-newline differences; normalize only CRLF.
export const normalizeDiffText = (source: string): string => source.replace(/\r\n/g, '\n');

export function reviewPatch(path: string, old: string, next: string) {
  return structuredPatch(path, path, normalizeDiffText(old), normalizeDiffText(next), '', '', {
    context: 4,
    timeout: 1000,
  });
}
