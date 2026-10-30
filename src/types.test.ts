import { describe, expect, it } from 'vitest';
import { anchorLabel, contextLabel, sameContext } from './types';

describe('comment review contexts', () => {
  it('does not mix commit, working-tree, or different base comments', () => {
    const context = { mode: 'diff' as const, base: 'abc', revision: null };
    expect(sameContext(context, { ...context })).toBe(true);
    expect(sameContext(context, { ...context, base: 'def' })).toBe(false);
    expect(sameContext(context, { ...context, mode: 'folder' })).toBe(false);
    expect(sameContext(context, { ...context, mode: 'commit', revision: 'abc' })).toBe(false);
  });
  it('labels old-side ranges and file comments', () => {
    expect(anchorLabel({ side: 'old', line: 3, endLine: 8 })).toBe('Old line 3–8');
    expect(anchorLabel({ side: 'new', line: null, endLine: null })).toBe('File-level comment');
    expect(contextLabel({ mode: 'diff', base: null, revision: null })).toBe('Working tree vs empty tree');
  });
});
