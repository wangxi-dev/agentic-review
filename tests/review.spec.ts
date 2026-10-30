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
  await expect(page.locator('.hljs-comment').first()).toBeVisible();
  await expect(page.locator('.code-line').nth(1).locator('.hljs-comment')).toContainText('comment */');
  await page.getByRole('button', { name: 'Git commit', exact: true }).click();
  await expect(page.locator('#content')).toContainText('historical');
  await page.getByLabel('Commit revision').fill('invalid');
  await page.getByRole('button', { name: 'Load commit', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unknown revision');
  await expect(page.locator('#content')).toContainText('historical');
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
  await expect(page.locator('.html-preview')).toHaveAttribute('sandbox', '');
  await expect(iframe.locator('script')).toHaveCount(0);
  await expect(iframe.locator('a')).not.toHaveAttribute('href');
  expect(await page.evaluate(() => (window as any).compromised)).toBeUndefined();
  expect(external).toEqual([]);
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
  await page.locator('[data-path="images/sample.webp"]').click();
  await expect(page.locator('#view-tabs')).not.toContainText('Diff');
  await expect(page.locator('.image-dimensions')).toHaveText('640 × 360 px');
});
