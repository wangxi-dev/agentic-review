import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const bridge = readFileSync(new URL('./mock-bridge.js', import.meta.url), 'utf8');
test.beforeEach(async ({ page }) => {
  await page.route('**/src/bridge.ts', route => route.fulfill({ contentType: 'application/javascript', body: bridge }));
});

for (const renderer of ['pierre-unified', 'pierre-split']) {
  test(`${renderer}: anchors, keyboard, ranges, comments, themes and switching`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/?startup=1');
    await page.getByLabel('Diff renderer').selectOption(renderer);
    await expect(page.locator('.pierre-view pre')).toBeVisible();
    await expect(page.locator('.pierre-view [data-line] span[style]').first()).toBeVisible();
    expect(await page.locator('.pierre-view pre').first().evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    await expect(page.getByRole('button', { name: 'old line 3', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'old line 3', exact: true }).click();
    await expect(page.locator('#anchor-label')).toHaveText('Old line 3');
    await page.getByRole('button', { name: 'new line 3', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#anchor-label')).toHaveText('New line 3');
    await page.getByRole('button', { name: 'new line 4', exact: true }).click({ modifiers: ['Shift'] });
    await expect(page.locator('#anchor-label')).toHaveText('New line 3–4');
    await page.getByLabel('Comment text').fill('Review this change.');
    await page.getByRole('button', { name: 'Add comment', exact: true }).click();
    await expect(page.locator('.pierre-comment')).toContainText('Review this change.');
    await expect(page.locator('.pierre-view [data-line] span[style]').first()).toBeVisible();
    const saved = await page.evaluate(() => (window as any).testSaved.comments[0]);
    expect(saved).toMatchObject({ side: 'new', line: 3, endLine: 4 });
    await page.getByLabel('Comment text').fill('Keep my draft');
    const lightBackground = await page.locator('.pierre-view pre').first().evaluate(el => getComputedStyle(el).backgroundColor);
    await page.locator('#theme-select').selectOption('dark');
    await page.locator('#text-size').selectOption('large');
    await expect(page.getByLabel('Comment text')).toHaveValue('Keep my draft');
    await expect.poll(() => page.locator('.pierre-view pre').first().evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(lightBackground);
    await page.getByLabel('Diff renderer').selectOption('classic');
    await expect(page.locator('.pierre-view')).toHaveCount(0);
    await expect(page.locator('.code-line.added')).toContainText('const value = 2');
    await expect(page.getByLabel('Comment text')).toHaveValue('Keep my draft');
    expect(errors).toEqual([]);
  });
}

test('line endings, deleted/added files, context sides and no-write browsing', async ({ page }) => {
  await page.addInitScript(() => { (window as any).testNewlineMode = 'changed'; });
  await page.goto('/?startup=1');
  await page.getByLabel('Diff renderer').selectOption('pierre-split');
  await expect(page.locator('#content')).toContainText('LF/CRLF');
  await page.getByRole('button', { name: 'old line 4', exact: true }).click();
  await expect(page.locator('#anchor-label')).toHaveText('Old line 4');
  await page.getByRole('button', { name: 'new line 4', exact: true }).click();
  await expect(page.locator('#anchor-label')).toHaveText('New line 4');
  await page.locator('[data-path="gone.ts"]').click();
  await expect(page.getByRole('button', { name: 'old line 3', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'new line 3', exact: true })).toHaveCount(0);
  await page.locator('[data-path="scratch.txt"]').click();
  await expect(page.getByRole('button', { name: 'new line 3', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testCalls.filter((c: any) => c.command === 'save_comments'))).toEqual([]);
});

test('line-ending-only changes remain an empty diff under Pierre', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).testNewlineMode = 'only';
    localStorage.setItem('agentic-review.diff-renderer', 'pierre-unified');
  });
  await page.goto('/?startup=1');
  await expect(page.locator('#content')).toContainText('No textual changes');
  await expect(page.locator('.pierre-view')).toHaveCount(0);
});

test('large files fall back and icons keep control labels and status markers', async ({ page }) => {
  await page.route('**/src/bridge.ts', route => route.fulfill({ contentType: 'application/javascript', body:
    bridge.replace("if (args.context.mode === 'folder') old = null;", "old = 'x\\n'.repeat(2500); next = old + 'new\\n';"),
  }));
  await page.goto('/?startup=1');
  await page.getByLabel('Diff renderer').selectOption('pierre-split');
  await expect(page.locator('#content')).toContainText('Large diff · showing Classic');
  await expect(page.getByRole('button', { name: 'Open folder…', exact: true })).toBeVisible();
  await expect(page.locator('#open-folder svg')).toHaveCount(1);
  await expect(page.locator('[data-path="src/main.ts"] .icon-typescript')).toHaveCount(1);
  await expect(page.locator('[data-path="gone.ts"] .file-status')).toHaveText('-');
});

test('failed lazy import falls back without losing the draft', async ({ page }) => {
  await page.route('**/*pierre_diffs.js*', route => route.abort());
  await page.goto('/?startup=1');
  await page.getByLabel('Comment text').fill('Unsaved draft');
  await page.getByLabel('Diff renderer').selectOption('pierre-split');
  await expect(page.locator('#content')).toContainText('Pierre could not render this diff; showing Classic');
  await expect(page.locator('.code-line.added')).toHaveCount(1);
  await expect(page.getByLabel('Comment text')).toHaveValue('Unsaved draft');
});

test('navigation cancels a pending renderer and preference survives reload', async ({ page }) => {
  await page.route('**/*pierre_diffs.js*', async route => {
    await new Promise(resolve => setTimeout(resolve, 300));
    await route.continue();
  });
  await page.goto('/?startup=1');
  await page.getByLabel('Diff renderer').selectOption('pierre-unified');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('.code-table.source')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Diff renderer')).toHaveValue('pierre-unified');
  await expect(page.locator('.pierre-view pre')).toBeVisible();
  await page.getByRole('button', { name: 'Full folder', exact: true }).click();
  await expect(page.locator('.pierre-view')).toHaveCount(0);
});

test('source markup stays inert and missing-final-newline markers are shown', async ({ page }) => {
  await page.route('**/src/bridge.ts', route => route.fulfill({ contentType: 'application/javascript', body:
    bridge.replace("if (args.context.mode === 'folder') old = null;", `old = 'before\\n'; next = '<img src=x onerror=window.compromised=true>';`),
  }));
  await page.goto('/?startup=1');
  await page.getByLabel('Diff renderer').selectOption('pierre-unified');
  await expect(page.locator('.pierre-view [data-no-newline]')).toContainText('No newline at end of file');
  await expect(page.locator('.pierre-view [data-line-type="change-addition"][data-line]')).toContainText('<img src=x');
  await expect(page.locator('.pierre-view img')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).compromised)).toBeUndefined();
});
