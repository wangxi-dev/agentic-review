import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const imageFixtures = Object.fromEntries(['sample.png', 'changed.png', 'sample.jpg', 'sample.webp'].map(name => [name,
  `data:image/${name.endsWith('.jpg') ? 'jpeg' : name.split('.').pop()};base64,${readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString('base64')}`,
]));
const bridge = readFileSync(new URL('./mock-bridge.js', import.meta.url), 'utf8')
  .replace('const imageFixtures = {};', `const imageFixtures = ${JSON.stringify(imageFixtures)};`);
test.beforeEach(async ({ page }) => {
  await page.route('**/src/bridge.ts', route => route.fulfill({ contentType: 'application/javascript', body: bridge }));
});

async function open(page: import('@playwright/test').Page) {
  await page.goto('/?startup=1');
  await expect(page.locator('#file-path')).toHaveText('src/main.ts');
  await expect(page.locator('#add-comment')).toBeEnabled();
}

test('folder picker, modes, source highlighting, and historical commit content', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Your code. Your review.')).toBeVisible();
  await page.getByRole('button', { name: 'Choose repository…' }).click();
  await expect(page.locator('#root')).toContainText('review-fixture');
  await expect(page.locator('.code-line.added')).toContainText('const value = 2');
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await expect(page.locator('#view-tabs')).not.toContainText('Diff');
  await page.locator('[data-directory="src"]').click();
  await page.locator('[data-path="src/main.ts"]').click();
  await expect(page.locator('.hljs-comment').first()).toBeVisible();
  await expect(page.locator('.code-line').nth(1).locator('.hljs-comment')).toContainText('comment */');
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await expect(page.locator('#content')).toContainText('historical');
  await page.getByLabel('Commit revision').fill('invalid');
  await page.getByRole('button', { name: 'Load commit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown revision');
  await expect(page.locator('#content')).toContainText('historical');
});

test('LF versus CRLF keeps context lines and shows only the real change with ASCII markers', async ({ page }) => {
  await page.addInitScript(() => { (window as any).testNewlineMode = 'changed'; });
  await open(page);
  await expect(page.locator('.code-line.removed')).toHaveCount(1);
  await expect(page.locator('.code-line.added')).toHaveCount(1);
  await expect(page.locator('.code-line[data-old="4"][data-new="4"] code')).toHaveText('console.log(value);');
  await expect(page.locator('.code-line.removed .diff-marker')).toHaveText('-');
  await expect(page.locator('.code-line.added .diff-marker')).toHaveText('+');
  await expect(page.locator('.code-line.removed code')).toHaveText('const value = 1;');
  await expect(page.locator('.code-line.added code')).toHaveText('const value = 2;');
  await page.getByRole('button', { name: 'old line 3', exact: true }).click();
  await expect(page.locator('#anchor-label')).toHaveText('Old line 3');
  await page.getByRole('button', { name: 'new line 3', exact: true }).click();
  await expect(page.locator('#anchor-label')).toHaveText('New line 3');
  await expect(page.locator('[data-path="docs/readme.md"] .file-status')).toHaveText('+');
  await expect(page.locator('[data-path="gone.ts"] .file-status')).toHaveText('-');
  await expect(page.locator('[data-path="scratch.txt"] .file-status')).toHaveText('+');
  await expect(page.locator('[data-path="scratch.txt"] .file-status')).toHaveAttribute('aria-label', 'Untracked');
});

test('line-ending-only conversions do not show every line as replaced', async ({ page }) => {
  await page.addInitScript(() => { (window as any).testNewlineMode = 'only'; });
  await open(page);
  await expect(page.locator('#content')).toContainText('line-ending-only change');
  await expect(page.locator('.code-line.added, .code-line.removed')).toHaveCount(0);
});

test('diff keeps untracked folders collapsed and expands one level at a time', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('button', { name: 'Git diff', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-directory="scratch"]')).toBeVisible();
  await expect(page.locator('[data-path="scratch/deep/file.txt"]')).toHaveCount(0);
  await page.locator('[data-directory="scratch"]').click();
  await expect(page.locator('[data-directory="scratch/deep"]')).toBeVisible();
  await expect(page.locator('[data-path="scratch/deep/file.txt"]')).toHaveCount(0);
  await page.locator('[data-directory="scratch/deep"]').click();
  await page.locator('[data-path="scratch/deep/file.txt"]').click();
  await expect(page.locator('#file-path')).toHaveText('scratch/deep/file.txt');
});

test('full folder loads only immediate children and searches nested filenames with wildcards', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await expect(page.locator('[data-directory="src"]')).toBeVisible();
  await expect(page.locator('[data-path="src/main.ts"]')).toHaveCount(0);
  await expect(page.locator('#file-path')).toHaveText('Review workspace');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'list_folder').length)).toBe(0);
  await page.locator('[data-directory="src"]').click();
  await expect(page.locator('[data-path="src/main.ts"]')).toBeVisible();
  await page.locator('[data-directory="src"]').click();
  await page.locator('[data-directory="src"]').click();
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'list_folder').length)).toBe(1);
  await page.getByLabel('Filter files').fill('*.json');
  await expect(page.locator('#file-count')).toHaveText('3');
  await expect(page.locator('[data-path="config/data.json"]')).toBeVisible();
  await expect(page.locator('[data-path="src/main.ts"]')).toHaveCount(0);
  await page.locator('[data-path="config/data.json"]').click();
  await expect(page.locator('#file-path')).toHaveText('config/data.json');
  await page.getByLabel('Filter files').fill('data?.json');
  await expect(page.locator('#files')).toContainText('No files match');
  await page.getByLabel('Filter files').fill('');
  await expect(page.locator('[data-directory="src"]')).toBeVisible();
  await expect(page.locator('[data-path="src/main.ts"]')).toBeVisible();
});

test('JSON prettify preserves numeric text, leaves files unchanged and keeps line anchors in Source', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await page.locator('[data-path="root.json"]').click();
  await expect(page.locator('.code-line')).toHaveCount(1);
  await page.getByRole('button', { name: 'Prettify JSON', exact: true }).click();
  await expect(page.locator('#content')).toContainText('file unchanged');
  await expect(page.locator('#content')).toContainText('9007199254740993');
  expect(await page.locator('.code-line').count()).toBeGreaterThan(5);
  await expect(page.locator('#content button.line-number')).toHaveCount(0);
  await page.getByRole('button', { name: 'Original JSON', exact: true }).click();
  await expect(page.locator('.code-line')).toHaveCount(1);
  await page.getByRole('button', { name: 'new line 1', exact: true }).click();
  await expect(page.locator('#anchor-label')).toHaveText('New line 1');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments').length)).toBe(0);
  await page.locator('[data-directory="config"]').click();
  await page.locator('[data-path="config/bad.json"]').click();
  await page.getByRole('button', { name: 'Prettify JSON', exact: true }).click();
  await expect(page.locator('#content')).toContainText('Cannot prettify JSON');
  await expect(page.locator('#content')).toContainText('{invalid');
});

test('old/new line comments, ranges, autosave, edit, resolve, delete, and reload', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'old line 3', exact: true }).click();
  await page.getByLabel('Comment text').fill('Please keep this behavior.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Saved 1');
  await expect(page.locator('.inline-comment')).toContainText('Please keep this behavior.');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByRole('button', { name: 'new line 3', exact: true }).click();
  await page.getByRole('button', { name: 'new line 4', exact: true }).click({ modifiers: ['Shift'] });
  await expect(page.locator('#anchor-label')).toHaveText('New line 3–4');
  await page.getByLabel('Comment text').fill('Review this range.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const saved = await page.evaluate(() => (window as any).testSaved);
  expect(saved.comments).toHaveLength(2);
  expect(saved.comments[0].side).toBe('old');
  expect(saved.comments[1].endLine).toBe(4);
  await page.locator('.comment-card').first().getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Comment text').fill('Edited comment.');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await page.locator('.comment-card').first().getByRole('button', { name: '○ Open' }).click();
  await expect(page.locator('.comment-card').first()).toHaveClass(/resolved/);
  await page.getByRole('button', { name: 'Open folder…', exact: true }).click();
  await expect(page.locator('.comment-card').first()).toContainText('Edited comment.');
  await page.locator('.comment-card').last().getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Saved 1');
  await expect(page.locator('.comment-card')).toHaveCount(1);
});

test('Markdown blocks are rendered and anchored to source lines; HTML is isolated', async ({ page }) => {
  const external: string[] = [];
  page.on('request', request => { if (request.url().includes('evil.invalid')) external.push(request.url()); });
  await open(page);
  await page.locator('[data-path="docs/readme.md"]').click();
  await expect(page.locator('.markdown h1')).toHaveText('Hello review');
  await page.locator('.markdown p').click();
  await expect(page.locator('#anchor-label')).toHaveText('New line 3');
  await page.getByLabel('Comment text').fill('Clarify the paragraph.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('.inline-comment')).toContainText('Clarify the paragraph.');
  await page.locator('[data-path="examples/page.html"]').click();
  const iframe = page.frameLocator('.html-preview');
  await expect(iframe.locator('h1')).toHaveText('HTML preview');
  await expect(page.locator('.html-preview')).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(iframe.locator('script')).toHaveCount(0);
  await expect(iframe.locator('a')).not.toHaveAttribute('href');
  expect(await page.evaluate(() => (window as any).compromised)).toBeUndefined();
  expect(external).toEqual([]);
});

test('exports show full selectable paths and copy the Markdown path', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await expect(page.getByRole('region', { name: 'Exported comment files' })).toBeHidden();
  await page.getByRole('button', { name: 'Export comments', exact: true }).click();
  await expect(page.getByLabel('Exported Markdown path')).toHaveValue('C:\\review-fixture\\agentic-review.comments.md');
  await expect(page.getByLabel('Exported JSON path')).toHaveValue('C:\\review-fixture\\agentic-review.comments.json');
  await page.getByRole('button', { name: 'Copy path', exact: true }).click();
  await expect(page.locator('#save-status')).toHaveText('Markdown file path copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('C:\\review-fixture\\agentic-review.comments.md');
});

test('copy all comments includes other files, contexts and resolved comments without saving', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Copied all 0');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments').length)).toBe(0);
  await page.getByLabel('Comment text').fill('First file note');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.comment-card').getByRole('button', { name: '○ Open' }).click();
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await page.locator('[data-path="gone.ts"]').click();
  await page.getByLabel('Comment text').fill('Historical deleted file note');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  const saves = await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments').length);
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Copied all 2');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('src/main.ts');
  expect(copied).toContain('resolved');
  expect(copied).toContain('First file note');
  expect(copied).toContain('gone.ts');
  expect(copied).toContain('commit');
  expect(copied).toContain('Historical deleted file note');
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments').length)).toBe(saves);
  await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw new Error('Clipboard unavailable'); }; });
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Clipboard unavailable');
  await expect(page.getByRole('button', { name: 'Copy all comments', exact: true })).toBeEnabled();
});

test('HTML selections are saved, edited, reopened and copied with their quoted text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page);
  await page.locator('[data-path="examples/page.html"]').click();
  const frame = page.frameLocator('.html-preview');
  await expect(frame.locator('h1')).toHaveText('HTML preview');
  const comment = page.getByRole('button', { name: 'Comment on selection', exact: true });
  await expect(comment).toBeDisabled();
  await frame.locator('h1').evaluate(node => {
    const range = node.ownerDocument.createRange();
    range.selectNodeContents(node);
    const selection = node.ownerDocument.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(comment).toBeEnabled();
  await comment.click();
  await expect(page.getByLabel('Comment text')).toBeFocused();
  await expect(page.locator('#anchor-label')).toContainText('HTML selection: “HTML preview”');
  await page.getByLabel('Comment text').fill('Please clarify this heading.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  expect(await page.evaluate(() => (window as any).testSaved.comments[0].quote)).toBe('HTML preview');
  await page.locator('.comment-card').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Comment text').fill('Use a more specific heading.');
  await page.getByRole('button', { name: 'Save edit', exact: true }).click();
  await page.getByRole('button', { name: 'Open folder…', exact: true }).click();
  await page.getByLabel('Comment scope').selectOption('all');
  await page.locator('.comment-anchor').click();
  await expect(page.frameLocator('.html-preview').locator('h1')).toBeVisible();
  await expect(page.locator('#anchor-label')).toContainText('HTML preview');
  await page.getByRole('button', { name: 'Copy all comments', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Copied all 1');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, '\n')).toContain('Selected HTML text:\nHTML preview');
  expect(copied).toContain('Use a more specific heading.');
  await page.locator('#clear-anchor').click();
  await expect(page.locator('#anchor-label')).toHaveText('File-level comment');
});

test('save failures retain comments and can be retried; drafts block navigation', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).failSave = true; });
  await page.getByLabel('Comment text').fill('Never lose this comment.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Not saved');
  await expect(page.locator('.comment-card')).toContainText('Never lose this comment.');
  await page.evaluate(() => { (window as any).failSave = false; });
  await page.getByRole('button', { name: 'Export comments', exact: true }).click();
  await expect(page.locator('#save-status')).toContainText('Saved 1');
  await page.getByLabel('Comment text').fill('Unfinished draft');
  await page.evaluate(() => { (window as any).testConfirm = false; });
  await page.locator('[data-path="docs/readme.md"]').click();
  await expect(page.locator('#file-path')).toHaveText('src/main.ts');
  await expect(page.getByLabel('Comment text')).toHaveValue('Unfinished draft');
  expect(await page.evaluate(() => (window as any).testClose())).toBe(false);
});

test('comments across modes stay exported and deleted-file source uses old anchors', async ({ page }) => {
  await open(page);
  await page.locator('[data-path="gone.ts"]').click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('#content')).toContainText('Deleted file');
  await page.getByRole('button', { name: 'old line 1', exact: true }).click();
  await page.getByLabel('Comment text').fill('Why delete this?');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await page.getByLabel('Comment text').fill('Commit note');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.getByLabel('Comment scope').selectOption('all');
  await expect(page.locator('.comment-card')).toHaveCount(2);
  const saved = await page.evaluate(() => (window as any).testSaved);
  expect(saved.comments.map((c: any) => c.context.mode)).toEqual(['diff', 'commit']);
  await page.screenshot({ path: 'test-results/review-workspace.png', fullPage: true });
});

test('light is the default; theme and text size persist without disrupting a review', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('light');
  await page.getByRole('button', { name: 'new line 3', exact: true }).click();
  await page.getByLabel('Comment text').fill('Keep this review draft intact.');
  const fontSize = await page.locator('.code-line:not(.hunk) code').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
  expect(await page.locator('.code-line:not(.hunk) code').first().evaluate(node => Number(getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(600);
  await page.evaluate(() => { (window as any).originalCode = document.querySelector('.code-table'); });
  await page.getByLabel('Theme', { exact: true }).selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Text size', { exact: true }).selectOption('extra-large');
  expect(await page.locator('.code-line:not(.hunk) code').first().evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThan(fontSize * 1.2);
  await expect(page.getByLabel('Comment text')).toHaveValue('Keep this review draft intact.');
  await expect(page.locator('#anchor-label')).toHaveText('New line 3');
  expect(await page.evaluate(() => (window as any).originalCode === document.querySelector('.code-table'))).toBe(true);
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments').length)).toBe(0);
  await page.reload();
  await expect(page.getByLabel('Theme', { exact: true })).toHaveValue('dark');
  await expect(page.getByLabel('Text size', { exact: true })).toHaveValue('extra-large');
  await page.getByLabel('Theme', { exact: true }).selectOption('system');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Theme', { exact: true }).selectOption('light');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('both themes have readable text contrast and fit the minimum window at every text size', async ({ page }) => {
  await open(page);
  await page.getByLabel('Comment text').fill('Use a clearer name here so the intention is easy to understand.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  for (const theme of ['light', 'dark']) {
    await page.getByLabel('Theme', { exact: true }).selectOption(theme);
    const failures = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const luminance = (token: string) => {
        const hex = style.getPropertyValue(`--${token}`).trim().slice(1);
        const rgb = [0, 2, 4].map(index => parseInt(hex.slice(index, index + 2), 16) / 255)
          .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      };
      const pairs = ['ink', 'muted', 'syntax-keyword', 'syntax-string', 'syntax-number', 'syntax-title', 'syntax-attribute', 'syntax-comment']
        .flatMap(fg => ['surface', 'panel', 'added-bg', 'removed-bg', 'selected'].map(bg => [fg, bg]));
      pairs.push(['on-accent', 'accent'], ['ink', 'comment-bg'], ['ink', 'resolved-bg'], ['muted', 'raised']);
      return pairs.flatMap(([fg, bg]) => {
        const a = luminance(fg), b = luminance(bg);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return ratio >= 4.5 ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)}`];
      });
    });
    expect(failures).toEqual([]);
    await page.screenshot({ path: `test-results/redesign-${theme}.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 1000, height: 640 });
  for (const size of ['standard', 'large', 'extra-large']) {
    await page.getByLabel('Text size', { exact: true }).selectOption(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('#export')).toBeInViewport();
    await expect(page.locator('#add-comment')).toBeInViewport();
    await expect(page.getByLabel('Theme', { exact: true })).toBeInViewport();
  }
});

test('PNG, JPEG, and WebP render; image diff, original size, deleted images, and comments work', async ({ page }) => {
  await open(page);
  for (const extension of ['png', 'jpg', 'webp']) {
    await page.locator(`[data-path="images/sample.${extension}"]`).click();
    await expect(page.locator('.review-image')).toBeVisible();
    await expect(page.locator('.image-dimensions')).toHaveText('640 × 360 px');
    await expect(page.locator('#view-tabs')).not.toContainText('Source');
    expect(await page.locator('.review-image').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(640);
  }
  await page.locator('[data-path="images/sample.png"]').click();
  await page.getByRole('button', { name: 'Diff', exact: true }).click();
  await expect(page.locator('.review-image')).toHaveCount(2);
  const sources = await page.locator('.review-image').evaluateAll(images => images.map(image => image.getAttribute('src')));
  expect(sources[0]).not.toBe(sources[1]);
  await page.locator('.image-card').last().getByRole('button', { name: '100%', exact: true }).click();
  await expect(page.locator('.image-stage').last()).toHaveClass(/actual-size/);
  await page.getByRole('button', { name: 'Comment on old image', exact: true }).click();
  await expect(page.locator('#anchor-label')).toContainText('Old version');
  await page.getByLabel('Comment text').fill('Keep the original artwork.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  expect(await page.evaluate(() => (window as any).testSaved.comments[0].side)).toBe('old');
  await page.screenshot({ path: 'test-results/image-comparison.png', fullPage: true });
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await expect(page.locator('.review-image')).toHaveAttribute('src', imageFixtures['sample.png']);
  await page.locator('[data-path="images/deleted.png"]').click();
  await expect(page.locator('#content')).toContainText('Deleted image');
  await expect(page.locator('.review-image')).toBeVisible();
  await page.locator('[data-path="images/invalid.png"]').click();
  await expect(page.locator('#content')).toContainText('Invalid image header');
  await expect(page.locator('.review-image')).toHaveCount(0);
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await page.locator('[data-directory="images"]').click();
  await page.locator('[data-path="images/sample.webp"]').click();
  await expect(page.locator('#view-tabs')).not.toContainText('Diff');
  await expect(page.locator('.image-dimensions')).toHaveText('640 × 360 px');
});
