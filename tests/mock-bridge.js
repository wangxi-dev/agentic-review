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
  if (command === 'review_snapshot') {
    if (args.revision === 'invalid') throw 'Unknown revision';
    return {
      context: { mode: args.mode, revision: args.mode === 'commit' ? hash : null, base: args.mode === 'commit' ? previous : hash },
      files: [
        { path: 'src/main.ts', oldPath: null, status: args.mode === 'folder' ? '' : 'M' },
        { path: 'docs/readme.md', oldPath: null, status: 'A' },
        { path: 'examples/page.html', oldPath: null, status: 'A' },
        { path: 'gone.ts', oldPath: null, status: 'D' },
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
    if (args.path === 'gone.ts') next = null;
    if (args.context.mode === 'folder') old = null;
    if (args.context.mode === 'commit' && args.path.endsWith('main.ts')) next = 'const historical = true;\n';
    return { old, new: next, oldNotice: null, newNotice: null, oldImage: null, newImage: null };
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
