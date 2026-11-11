import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Start `npm run demo` (or `npm run preview:demo`) first. This opens a headless
// browser against the fixture demo only, never the Tauri app or a real repository.
const url = process.env.DEMO_URL || 'http://127.0.0.1:1421';
const out = new URL('../artifacts/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const external = [];
page.on('pageerror', e => errors.push(e.message));
page.on('request', req => { if (!req.url().startsWith(url) && !req.url().startsWith('data:')) external.push(req.url()); });
const samples = {};
const policyViolations = [];
const enforceCsp = process.env.DEMO_CSP === '1';
if (enforceCsp) {
  const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
  await page.route(url + '/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': config.app.security.csp } });
  });
  await page.exposeFunction('recordPolicyViolation', directive => policyViolations.push(directive));
  await page.addInitScript(() => document.addEventListener('securitypolicyviolation', event => window.recordPolicyViolation(event.violatedDirective)));
}
try {
  await page.goto(url);
  await page.locator('.demo-banner').waitFor();
  const settled = async renderer => {
    await page.getByLabel('Diff renderer').selectOption(renderer);
    await page.locator(renderer === 'classic' ? '.code-line.added' : '.pierre-view [data-line-type="change-addition"]').first().waitFor();
    if (renderer !== 'classic') {
      // Wait for Shiki tokens, not just Pierre's initial plain-text render.
      await page.waitForFunction(() => document.querySelector('.pierre-view')?.shadowRoot?.querySelector('[data-line] span[style]'));
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  for (const renderer of ['classic', 'pierre-unified', 'pierre-split']) {
    await settled(renderer);
    await page.screenshot({ path: fileURLToPath(new URL(`${renderer}-light.png`, out)) });
    // Browser roundtrip + selector + render + 2 frames. A warmed UI comparison,
    // not an isolated algorithm benchmark. All renderers use the same fixture.
    samples[renderer] = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      await settled(renderer);
      samples[renderer].push(Number((performance.now() - start).toFixed(1)));
    }
  }
  await page.getByRole('button', { name: 'new line 4', exact: true }).click();
  await page.getByLabel('Comment text').fill('The larger preview limit is useful. Keep the timeout guard for complex diffs.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await page.locator('.pierre-comment').waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('pierre-comment.png', out)) });
  await page.locator('#theme-select').selectOption('dark');
  await page.waitForTimeout(150);
  await page.screenshot({ path: fileURLToPath(new URL('pierre-split-dark.png', out)) });
  const report = {
    url, browser: browser.version(), fixture: 'demo/fixture.ts; 33 old / 36 new lines',
    measurement: '15 warmed UI selections; includes Playwright roundtrip and two animation frames; milliseconds',
    timings: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, {
      median: [...values].sort((a, b) => a - b)[7], min: Math.min(...values), max: Math.max(...values), samples: values,
    }])), errors, externalRequests: external, enforceCsp, policyViolations,
  };
  await writeFile(new URL('demo-results.json', out), JSON.stringify(report, null, 2) + '\n');
  await writeFile(new URL('demo-gallery.html', out), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Pierre diff comparison</title><style>body{font:16px system-ui;background:#edf1f6;color:#17202d;margin:32px}img{width:100%;border:1px solid #aab8cc;border-radius:8px}section{margin:32px 0}a{color:#2155b5}pre{white-space:pre-wrap}h1{margin-bottom:8px}</style><h1>Classic / Pierre diff comparison</h1><p>Same in-memory fixture, new Pierre toolbar and file icons. No repository files were read or written.</p>${['classic-light','pierre-unified-light','pierre-split-light','pierre-comment','pierre-split-dark'].map(name => `<section><h2>${name}</h2><a href="${name}.png"><img src="${name}.png" alt="${name}"></a></section>`).join('')}<h2>Measured warmed UI timings</h2><pre>${JSON.stringify(report, null, 2)}</pre></html>`);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || external.length || policyViolations.length) process.exitCode = 1;
} finally { await browser.close(); }
