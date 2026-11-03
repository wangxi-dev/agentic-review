// Replaces only the native IPC adapter in browser tests; the production app has no mock mode.
const root = 'C:\\review-fixture';
const hash = 'a'.repeat(40);
const previous = 'b'.repeat(40);
const imageFixtures = {}; // Populated by the test harness from actual image files.
const blank = () => ({ schemaVersion: 1, root, updatedAt: '', comments: [] });
let saved = blank();
window.testSaved = saved;
window.testCalls = [];
export async function call(command, args = {}) {
  window.testCalls.push({ command, args: structuredClone(args) });
  if (command === 'startup_path') return new URLSearchParams(location.search).get('startup') ? root : null;
  if (command === 'open_repository') return { root, document: structuredClone(saved) };
  if (command === 'list_commits') return [{ hash, subject: 'Fixture commit', author: 'Reviewer', date: '2026-10-30' }];
  const folderFiles = [
    'src/main.ts', 'docs/readme.md', 'examples/page.html',
    'images/sample.png', 'images/sample.jpg', 'images/sample.webp', 'images/invalid.png',
    'config/data.json', 'config/bad.json', 'root.json', 'scratch/deep/file.txt',
  ];
  if (command === 'list_folder' || (command === 'review_snapshot' && args.mode === 'folder')) {
    const prefix = args.directory ? args.directory + '/' : '';
    const paths = [...new Set(folderFiles.filter(path => path.startsWith(prefix)).map(path => prefix + path.slice(prefix.length).split('/')[0]))];
    const files = paths.map(path => ({ path, directory: folderFiles.some(f => f.startsWith(path + '/')), oldPath: null, status: '' }));
    return command === 'list_folder' ? files : { context: { mode: 'folder', base: hash, revision: null }, files };
  }
  if (command === 'search_files') {
    const { fileMatcher } = await import('/src/files.ts');
    return { files: folderFiles.filter(fileMatcher(args.query)).map(path => ({ path, oldPath: null, status: '' })), truncated: false };
  }
  if (command === 'review_snapshot') {
    if (args.revision === 'invalid') throw 'Unknown revision';
    return {
      context: { mode: args.mode, revision: args.mode === 'commit' ? hash : null, base: args.mode === 'commit' ? previous : hash },
      files: [
        { path: 'src/main.ts', oldPath: null, status: args.mode === 'folder' ? '' : 'M' },
        { path: 'docs/readme.md', oldPath: null, status: 'A' },
        { path: 'examples/page.html', oldPath: null, status: 'A' },
        { path: 'gone.ts', oldPath: null, status: 'D' },
        ...(args.mode === 'diff' ? [{ path: 'scratch', oldPath: null, status: '?', directory: true }, { path: 'scratch.txt', oldPath: null, status: '?' }] : []),
        { path: 'images/sample.png', oldPath: null, status: 'M' },
        { path: 'images/sample.jpg', oldPath: null, status: 'A' },
        { path: 'images/sample.webp', oldPath: null, status: 'A' },
        { path: 'images/deleted.png', oldPath: null, status: 'D' },
        { path: 'images/invalid.png', oldPath: null, status: 'A' },
      ].filter(f => args.mode !== 'folder' || f.status !== 'D'),
    };
  }
  if (command === 'read_file') {
    if (args.path.startsWith('images/')) {
      const name = args.path.split('/').pop();
      return {
        old: null, new: null, oldNotice: null,
        newNotice: name === 'invalid.png' ? 'Invalid image header' : null,
        oldImage: args.context.mode !== 'folder' && ['sample.png', 'deleted.png'].includes(name) ? imageFixtures['sample.png'] : null,
        newImage: name === 'deleted.png' || name === 'invalid.png' ? null : imageFixtures[name === 'sample.png' && args.context.mode !== 'commit' ? 'changed.png' : name],
      };
    }
    let old = '/* multiline\ncomment */\nconst value = 1;\nconsole.log(value);\n';
    let next = '/* multiline\ncomment */\nconst value = 2;\nconsole.log(value);\n';
    if (args.path.endsWith('.md')) { old = null; next = '# Hello review\n\nA **rendered** paragraph.\n\n```ts\nconst value = 2;\n```\n'; }
    if (args.path.endsWith('.html')) { old = null; next = '<html><head><style>h1{color:purple}</style></head><body><h1>HTML preview</h1><script>parent.window.compromised=true</script><img src="https://evil.invalid/beacon" onerror="parent.window.compromised=true"><a href="https://evil.invalid/">Bad navigation</a></body></html>'; }
    if (args.path.endsWith('.json')) { old = null; next = args.path.endsWith('bad.json') ? '{invalid' : '{"big":9007199254740993,"nested":{"items":[1,2]},"text":"hello"}'; }
    if (args.path === 'gone.ts') next = null;
    if (args.path === 'scratch.txt') old = null;
    if (args.path.endsWith('main.ts') && window.testNewlineMode) {
      if (window.testNewlineMode === 'only') next = old;
      next = next?.replace(/\n/g, '\r\n') ?? null;
    }
    if (args.context.mode === 'folder') old = null;
    if (args.context.mode === 'commit' && args.path.endsWith('main.ts')) next = 'const historical = true;\n';
    return { old, new: next, oldNotice: null, newNotice: null, oldImage: null, newImage: null };
  }
  if (command === 'comments_markdown') {
    return '# Review comments\n\nRepository: ' + args.document.root + '\n\n' + args.document.comments.map(c =>
      `## ${c.path} (${c.side})\nStatus: ${c.status}\nReview: ${c.context.mode}\n${c.quote ? 'Selected HTML text:\n' + c.quote + '\n' : ''}${c.text}\n`).join('\n');
  }
  if (command === 'save_comments') {
    if (window.failSave) throw 'Access denied: repository is read-only';
    saved = structuredClone(args.document);
    window.testSaved = saved;
    return [root + '\\agentic-review.comments.json', root + '\\agentic-review.comments.md'];
  }
  throw new Error('Unexpected command: ' + command);
}
export async function pickFolder() { return root; }
export async function ask() { return window.testConfirm !== false; }
export async function handleClose(check) { window.testClose = check; }
