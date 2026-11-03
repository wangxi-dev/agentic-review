import { describe, expect, it } from 'vitest';
import { normalizeDiffText, reviewPatch } from './diff';

const patch = (old: string, next: string) => reviewPatch('sample.ts', old, next)!;
const changes = (old: string, next: string) => patch(old, next).hunks.flatMap(hunk => hunk.lines.filter(line => /^[+-]/.test(line)));

describe('review diffs', () => {
  it.each(['lf-to-crlf', 'crlf-to-lf', 'mixed'])('keeps unchanged lines as context with %s line endings', mode => {
    let old = 'header\nconst value = 1;\nfooter\n';
    let next = 'header\nconst value = 2;\nfooter\n';
    if (mode === 'lf-to-crlf') next = next.replace(/\n/g, '\r\n');
    if (mode === 'crlf-to-lf') old = old.replace(/\n/g, '\r\n');
    if (mode === 'mixed') next = next.replace('header\n', 'header\r\n');
    expect(changes(old, next)).toEqual(['-const value = 1;', '+const value = 2;']);
    expect(patch(old, next).hunks[0].lines).toContain(' header');
    expect(patch(old, next).hunks[0].lines).toContain(' footer');
    expect(patch(old, next).hunks[0]).toMatchObject({ oldStart: 1, newStart: 1, oldLines: 3, newLines: 3 });
  });

  it('does not treat line-ending-only conversion as a whole-file rewrite', () => {
    expect(patch('a\nb\n', 'a\r\nb\r\n').hunks).toEqual([]);
    expect(normalizeDiffText('a\rb\r\n')).toBe('a\rb\n');
  });

  it('preserves indentation and trailing-whitespace changes', () => {
    expect(changes('  before\nend\n', '    before \r\nend\r\n')).toEqual(['-  before', '+    before ']);
  });

  it('preserves missing-final-newline differences', () => {
    expect(patch('a\n', 'a').hunks[0].lines).toContain('\\ No newline at end of file');
    expect(patch('a', 'a\r\n').hunks[0].lines).toContain('\\ No newline at end of file');
  });

  it('renders genuinely added and deleted files as all additions or removals', () => {
    expect(changes('', 'a\r\nb\r\n')).toEqual(['+a', '+b']);
    expect(changes('a\r\nb\r\n', '')).toEqual(['-a', '-b']);
  });

  it('keeps separated changes in separate hunks with correct line positions', () => {
    const old = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const next = old.replace('line 3\n', 'changed 3\n').replace('line 35\n', 'changed 35\n').replace(/\n/g, '\r\n');
    const result = patch(old, next);
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[1].oldStart).toBe(31);
    expect(result.hunks[1].newStart).toBe(31);
    expect(changes(old, next)).toEqual(['-line 3', '+changed 3', '-line 35', '+changed 35']);
  });
});
