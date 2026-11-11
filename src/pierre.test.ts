import { describe, expect, it } from 'vitest';
import { processFile } from '@pierre/diffs';
import { reviewPatch } from './diff';
import { parseDiffRenderer, pierreEligible, pierreMetadata } from './pierre';
import type { FileContent } from './types';

const content = (old: string | null, next: string | null): FileContent => ({
  old, new: next, oldNotice: null, newNotice: null, oldImage: null, newImage: null,
});
const parse = (old: string | null, next: string | null, path = 'test.ts') =>
  pierreMetadata(processFile, path, content(old, next), reviewPatch(path, old ?? '', next ?? '')!);

describe('Pierre adapter', () => {
  it('keeps the conservative default and validates stored preferences', () => {
    expect(parseDiffRenderer(null)).toBe('classic');
    expect(parseDiffRenderer('invalid')).toBe('classic');
    expect(parseDiffRenderer('pierre-split')).toBe('pierre-split');
  });
  it('bounds both character count and combined source line count', () => {
    expect(pierreEligible('a', 'b')).toBe(true);
    expect(pierreEligible('a'.repeat(250000), 'b')).toBe(false);
    expect(pierreEligible('\n'.repeat(2000), '\n'.repeat(2000))).toBe(false);
  });
  it('normalizes CRLF without changing source line numbers', () => {
    const diff = parse('same\nconst a = 1;\ntail\n', 'same\r\nconst a = 2;\r\ntail\r\n');
    expect(diff.hunks).toHaveLength(1);
    expect(diff.deletionLines.join('')).toBe('same\nconst a = 1;\ntail\n');
    expect(diff.additionLines.join('')).toBe('same\nconst a = 2;\ntail\n');
  });
  it('preserves added/deleted semantics and empty versions', () => {
    expect(parse(null, 'new\n').type).toBe('new');
    expect(parse('old\n', null).type).toBe('deleted');
    expect(parse('', 'new\n').type).toBe('change');
  });
  it('preserves missing final newline and whitespace-only changes', () => {
    const diff = parse('x\n', 'x');
    expect(diff.deletionLines.join('')).toBe('x\n');
    expect(diff.additionLines.join('')).toBe('x');
    expect(parse(' x\n', '  x\n').hunks).toHaveLength(1);
  });
  it('does not parse user paths as patch headers', () => {
    const path = 'a\tfile\n--- fake.ts';
    const diff = parse('before\n', 'after\n', path);
    expect(diff.name).toBe(path);
    expect(diff.hunks).toHaveLength(1);
  });
});
