import { describe, expect, it } from 'vitest';
import { parseAppearance, resolvedTheme } from './appearance';

describe('appearance preferences', () => {
  it('defaults to light with readable standard text regardless of OS theme', () => {
    expect(parseAppearance(null)).toEqual({ theme: 'light', textSize: 'standard' });
    expect(resolvedTheme('light', true)).toBe('light');
  });
  it('validates persisted values and tolerates invalid storage', () => {
    for (const value of ['broken', 'null', '42', '{}', '{"theme":"pink","textSize":"tiny"}']) {
      expect(parseAppearance(value)).toEqual({ theme: 'light', textSize: 'standard' });
    }
    expect(parseAppearance('{"theme":"dark","textSize":"extra-large"}')).toEqual({ theme: 'dark', textSize: 'extra-large' });
  });
  it('follows the OS only when System is explicitly selected', () => {
    expect(resolvedTheme('system', true)).toBe('dark');
    expect(resolvedTheme('system', false)).toBe('light');
    expect(resolvedTheme('dark', false)).toBe('dark');
  });
});
