import { describe, expect, it } from 'vitest';
import { fileMatcher, fileStatus, prettyJson } from './files';

it('uses clear ASCII added/deleted markers and labels untracked files separately', () => {
  expect(fileStatus('A')).toEqual({ symbol: '+', label: 'Added' });
  expect(fileStatus('?')).toEqual({ symbol: '+', label: 'Untracked' });
  expect(fileStatus('D')).toEqual({ symbol: '-', label: 'Deleted' });
  expect(fileStatus('M')).toEqual({ symbol: 'M', label: 'Modified' });
});

describe('filename search', () => {
  it('searches paths with plain text and matches filename wildcards at any depth', () => {
    expect(fileMatcher('config')('src/config/app.json')).toBe(true);
    expect(fileMatcher('*.json')('src/config/APP.JSON')).toBe(true);
    expect(fileMatcher('*.json')('src/config/app.json.bak')).toBe(false);
    expect(fileMatcher('app?.json')('src/app1.json')).toBe(true);
    expect(fileMatcher('src/*.json')('src/config/app.json')).toBe(true);
    expect(fileMatcher('src/*.json')('other/app.json')).toBe(false);
    expect(fileMatcher('[a]*.json')('src/[a]test.json')).toBe(true);
    expect(fileMatcher('')('anything')).toBe(true);
  });
});

describe('display-only JSON formatting', () => {
  it('indents nested JSON while preserving large numbers, exponents, duplicate keys and strings', () => {
    const source = '{"n":9007199254740993,"n":1e+30,"nested":[{},[],{"text":"a\\\"b,[]:{}"}]}';
    const result = prettyJson(source);
    expect(result).toContain('"n": 9007199254740993');
    expect(result).toContain('"n": 1e+30');
    expect(result).toContain('    {}');
    expect(result).toContain('"text": "a\\\"b,[]:{}"');
    expect(JSON.parse(result)).toEqual(JSON.parse(source));
    expect(prettyJson(result)).toBe(result);
  });
  it('handles empty containers and primitives, and rejects invalid JSON', () => {
    for (const source of ['{}', '[]', 'null', 'true', '123', '"hello"']) expect(prettyJson(source)).toBe(source);
    expect(() => prettyJson('{invalid}')).toThrow();
    expect(() => prettyJson('['.repeat(202) + '0' + ']'.repeat(202))).toThrow('deeply nested');
  });
});
