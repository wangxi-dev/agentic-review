import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('This native smoke test targets Windows/WebView2.');
const temporary = await mkdtemp(join(tmpdir(), 'agentic-review-native-'));
const root = join(temporary, 'repository with spaces');
await mkdir(join(root, 'nested'), { recursive: true });
await mkdir(join(root, 'z-images'), { recursive: true });
for (const extension of ['png', 'jpg', 'webp']) {
  await writeFile(join(root, 'z-images', `sample.${extension}`), await readFile(new URL(`./fixtures/sample.${extension}`, import.meta.url)));
}
await mkdir('test-results', { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
git('init', '-b', 'main');
git('config', 'user.name', 'Native Test');
git('config', 'user.email', 'native@example.invalid');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
git('config', 'core.hooksPath', '.no-hooks');
await writeFile(join(root, 'main.ts'), 'const value = 1;\nconsole.log(value);\n');
await writeFile(join(root, 'nested', 'config.json'), '{"big":9007199254740993,"nested":{"items":[1,2]}}');
await writeFile(join(root, 'nested', 'readme.md'), '# Native Markdown\n\nA **rendered** paragraph.\n');
await writeFile(join(root, 'preview.html'), '<style>h1{color:purple}</style><h1>Native HTML</h1><script>window.compromised = true</script>');
git('add', '-A'); git('commit', '-m', 'Initial commit');
await writeFile(join(root, 'main.ts'), 'const value = 2;\nconsole.log(value);\n');
await writeFile(join(root, 'z-images', 'sample.png'), await readFile(new URL('./fixtures/changed.png', import.meta.url)));
git('add', '-A'); git('commit', '-m', 'Second commit');
// Reproduce Git LF blobs versus Windows CRLF working-tree contents.
await writeFile(join(root, 'main.ts'), 'const value = 3;\r\nconsole.log(value);\r\n');
await writeFile(join(root, 'z-images', 'sample.png'), await readFile(new URL('./fixtures/sample.png', import.meta.url)));

const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const executable = resolve(process.env.AGENTIC_REVIEW_EXE || 'src-tauri/target/release/agentic-review.exe');
let app;
let browser;
async function launch() {
  app = spawn(executable, ['nested'], {
    cwd: root,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: join(temporary, 'webview') },
    stdio: 'ignore',
  });
  let spawnError;
  app.on('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (spawnError) throw spawnError;
    if (app.exitCode !== null) throw new Error(`App exited: ${app.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) break;
    } catch { /* WebView2 is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? await context.waitForEvent('page');
  page.setDefaultTimeout(15000);
  await page.waitForFunction(() => document.getElementById('file-path')?.textContent === 'main.ts');
  await page.waitForFunction(() => !document.getElementById('add-comment')?.disabled);
  return page;
}
async function stop() {
  await browser?.close().catch(() => {});
  browser = undefined;
  if (app?.pid) {
    try { execFileSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* already closed */ }
  }
  app = undefined;
  await new Promise(resolve => setTimeout(resolve, 1000));
}
async function closeNormally() {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${app.pid}).CloseMainWindow()`], { stdio: 'ignore', windowsHide: true });
  for (let attempt = 0; attempt < 50 && app.exitCode === null; attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.notEqual(app.exitCode, null, 'Native close handler must allow a saved review to close.');
}
try {
  let page = await launch();
  assert.equal(await page.locator('#root').textContent(), root);
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  assert.ok(await page.locator('.code-line:not(.hunk) code').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
  assert.match(await page.locator('#content').textContent(), /const value = 3/);
  assert.equal(await page.locator('.code-line.added').count(), 1);
  assert.equal(await page.locator('.code-line.removed').count(), 1);
  assert.equal(await page.locator('.code-line.added .diff-marker').textContent(), '+');
  assert.equal(await page.locator('.code-line.removed .diff-marker').textContent(), '-');
  assert.equal(await page.locator('.code-line[data-old="2"][data-new="2"] code').textContent(), 'console.log(value);');
  await page.getByRole('button', { name: 'new line 1', exact: true }).click();
  await page.getByLabel('Comment text').fill('Native persisted review comment.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent?.startsWith('Saved 1'));
  const comments = JSON.parse(await readFile(join(root, 'agentic-review.comments.json'), 'utf8'));
  assert.equal(comments.comments[0].text, 'Native persisted review comment.');
  assert.equal(comments.comments[0].line, 1);
  assert.match(await readFile(join(root, 'agentic-review.comments.md'), 'utf8'), /Native persisted review comment/);
  await page.getByRole('button', { name: 'Export comments', exact: true }).click();
  await page.locator('#export-result').waitFor();
  assert.equal(await page.getByLabel('Exported Markdown path').inputValue(), join(root, 'agentic-review.comments.md'));
  await page.getByRole('button', { name: 'Copy path', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent === 'Markdown file path copied');
  const clipboard = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(clipboard(), join(root, 'agentic-review.comments.md'));
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent?.startsWith('Copied all 1'));
  assert.match(clipboard(), /Native persisted review comment/);
  await page.getByRole('button', { name: 'Dismiss export paths', exact: true }).click();
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('context-label')?.textContent?.startsWith('Commit ') && document.getElementById('content')?.textContent?.includes('const value = 2'));
  assert.match(await page.locator('#content').textContent(), /const value = 2/);
  assert.doesNotMatch(await page.locator('#content').textContent(), /const value = 3/);
  await page.locator('[data-path="z-images/sample.png"]').click();
  await page.waitForFunction(() => document.querySelector('.review-image')?.naturalWidth === 640);
  assert.equal(await page.locator('.review-image').getAttribute('src'), `data:image/png;base64,${(await readFile(new URL('./fixtures/changed.png', import.meta.url))).toString('base64')}`);
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('file-path')?.textContent === 'Review workspace' && !document.getElementById('refresh')?.disabled);
  assert.equal(await page.locator('[data-path="z-images/sample.png"]').count(), 0);
  await page.locator('[data-directory="z-images"]').click();
  for (const extension of ['png', 'jpg', 'webp']) {
    await page.locator(`[data-path="z-images/sample.${extension}"]`).click();
    await page.waitForFunction(() => document.querySelector('.review-image')?.naturalWidth === 640);
  }
  await page.getByLabel('Filter files').fill('*.json');
  await page.locator('[data-path="nested/config.json"]').click();
  await page.getByRole('button', { name: 'Prettify JSON', exact: true }).click();
  assert.match(await page.locator('#content').textContent(), /9007199254740993/);
  assert.ok(await page.locator('.code-line').count() > 5);
  assert.equal(await readFile(join(root, 'nested', 'config.json'), 'utf8'), '{"big":9007199254740993,"nested":{"items":[1,2]}}');
  await page.getByLabel('Filter files').fill('');
  await page.locator('[data-directory="nested"]').click();
  await page.locator('[data-path="nested/readme.md"]').click();
  await page.locator('.markdown h1').waitFor();
  assert.equal(await page.locator('.markdown h1').textContent(), 'Native Markdown');
  await page.locator('[data-path="preview.html"]').click();
  await page.frameLocator('.html-preview').locator('h1').waitFor();
  assert.equal(await page.frameLocator('.html-preview').locator('h1').textContent(), 'Native HTML');
  assert.equal(await page.frameLocator('.html-preview').locator('script').count(), 0);
  await page.frameLocator('.html-preview').locator('h1').evaluate(node => {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const selection = node.ownerDocument.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.getByRole('button', { name: 'Comment on selection', exact: true }).click();
  await page.getByLabel('Comment text').fill('Native selected heading comment.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent?.startsWith('Saved 2'));
  assert.equal(JSON.parse(await readFile(join(root, 'agentic-review.comments.json'), 'utf8')).comments[1].quote, 'Native HTML');
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('save-status')?.textContent?.startsWith('Copied all 2'));
  assert.match(clipboard(), /Selected HTML text:[\s\S]*Native HTML/);
  await page.getByRole('button', { name: 'Git diff', exact: true }).click();
  await page.locator('[data-path="z-images/sample.png"]').click();
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.review-image')].length === 2 && [...document.querySelectorAll('.review-image')].every(image => image.naturalWidth === 640));
  await page.screenshot({ path: 'test-results/native-images.png' });
  await page.locator('[data-path="main.ts"]').click();
  await page.locator('.comment-card').waitFor();
  assert.equal(await page.locator('[data-path="agentic-review.comments.json"]').count(), 0);
  await page.screenshot({ path: 'test-results/native-review.png' });
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await page.getByLabel('Text size', { exact: true }).selectOption('large');
  await page.screenshot({ path: 'test-results/native-dark.png' });
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('agentic-review.appearance.v1'))), { theme: 'dark', textSize: 'large' });
  await closeNormally();
  await stop();
  page = await launch();
  assert.match(await page.locator('.comment-card').textContent(), /Native persisted review comment/);
  assert.equal(await page.locator('#error').isVisible(), false);
  assert.equal(await page.getByLabel('Theme', { exact: true }).inputValue(), 'dark');
  assert.equal(await page.getByLabel('Text size', { exact: true }).inputValue(), 'large');
  await closeNormally();
  console.log('Native smoke test passed: all review modes, lazy folders, filename glob search, JSON prettify, Markdown/HTML selection comments, clipboard and copyable export paths, PNG/JPEG/WebP, image comparison, theme/text-size persistence, exports, reload, and native close.');
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    console.error('Native page error:', await page.locator('#error').textContent().catch(() => 'unavailable'));
    await page.screenshot({ path: 'test-results/native-failure.png' }).catch(() => {});
  }
  throw error;
} finally {
  await stop();
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
