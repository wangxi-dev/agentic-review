import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Uses source modules: run `npm run demo` first, not the built preview server.
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const results = [];
try {
  await page.goto(process.env.DEMO_URL || 'http://127.0.0.1:1421');
  await page.locator('.demo-banner').waitFor();
  for (const [name, lines, rewrite] of [['small', 40, false], ['sparse-1000', 1000, false], ['rewrite-500', 500, true], ['fallback-2500', 2500, false]]) {
    for (const renderer of ['classic', 'pierre-unified', 'pierre-split']) {
      const samples = [];
      let fallback = false;
      for (let sample = 0; sample < 6; sample++) {
        const result = await page.evaluate(async ({ lines, rewrite, renderer }) => {
          const { renderContent } = await import('/src/render.ts');
          const old = Array.from({ length: lines }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';
          const next = rewrite ? old.replaceAll('export const value', 'let changed') : old.replace('value20 = 20', 'value20 = 42');
          let host = document.getElementById('benchmark');
          if (!host) {
            host = document.createElement('div');
            host.id = 'benchmark';
            host.style.cssText = 'position:fixed;inset:0;width:1200px;height:800px;overflow:auto;z-index:100;background:white';
            document.body.append(host);
          }
          const start = performance.now();
          renderContent(host, { path: 'benchmark.ts', view: 'diff', renderer, comments: [], onAnchor: () => {},
            content: { old, new: next, oldNotice: null, newNotice: null, oldImage: null, newImage: null } });
          if (host.querySelector('.pierre-view')) {
            await new Promise((resolve, reject) => {
              const check = () => {
                if (host.querySelector('.pierre-view')?.shadowRoot?.querySelector('[data-line] span[style]')) return resolve();
                if (performance.now() - start > 15000) return reject(new Error('Highlighting exceeded 15 seconds'));
                requestAnimationFrame(check);
              };
              check();
            });
          }
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return { milliseconds: Number((performance.now() - start).toFixed(1)), fallback: host.textContent.includes('Large diff · showing Classic') };
        }, { lines, rewrite, renderer });
        if (sample > 0) samples.push(result.milliseconds); // Discard first run / highlighter warm-up.
        fallback = result.fallback;
      }
      results.push({ name, renderer, median: [...samples].sort((a, b) => a - b)[2], samples, fallback });
    }
  }
  const report = { browser: browser.version(), measurement: '5 warmed samples after discarding first run; renderContent to highlighted DOM plus two animation frames, milliseconds; dev build', results };
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/benchmark-results.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await browser.close(); }
