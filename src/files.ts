export function fileStatus(status: string): { symbol: string; label: string } {
  const statuses: Record<string, { symbol: string; label: string }> = {
    A: { symbol: '+', label: 'Added' },
    '?': { symbol: '+', label: 'Untracked' },
    D: { symbol: '-', label: 'Deleted' },
    M: { symbol: 'M', label: 'Modified' },
    R: { symbol: 'R', label: 'Renamed' },
    C: { symbol: 'C', label: 'Copied' },
    T: { symbol: 'T', label: 'Type changed' },
    U: { symbol: 'U', label: 'Unmerged' },
  };
  return statuses[status] ?? { symbol: status || ' ', label: status || 'File' };
}

// Plain text searches paths; wildcard patterns match a whole filename (or path if '/' is used).
export function fileMatcher(query: string): (path: string) => boolean {
  query = query.trim().toLowerCase();
  if (!/[?*]/.test(query)) return path => path.toLowerCase().includes(query);
  const pattern = query.split('').map(ch => ch === '*' ? '.*' : ch === '?' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  const regex = new RegExp(`^${pattern}$`, 'i');
  return path => regex.test(query.includes('/') ? path : path.split('/').pop()!);
}

// Keep numeric lexemes and duplicate keys intact; JSON.stringify(JSON.parse(...)) can lose them.
export function prettyJson(source: string): string {
  JSON.parse(source);
  const tokens = source.match(/"(?:\\.|[^"\\])*"|[^\s"{}\[\],:]+|[{}\[\],:]/g) ?? [];
  let depth = 0;
  let output = '';
  const newline = () => { output += '\n' + '  '.repeat(depth); };
  tokens.forEach((token, index) => {
    if (depth > 200 || output.length > 10 * 1024 * 1024) throw new Error('JSON is too large or deeply nested to format for preview.');
    const previous = tokens[index - 1];
    if (token === '{' || token === '[') {
      output += token;
      if (tokens[index + 1] !== (token === '{' ? '}' : ']')) { depth++; newline(); }
    } else if (token === '}' || token === ']') {
      if (previous !== (token === '}' ? '{' : '[')) { depth--; newline(); }
      output += token;
    } else if (token === ',') { output += ','; newline(); }
    else if (token === ':') output += ': ';
    else output += token;
  });
  return output;
}
