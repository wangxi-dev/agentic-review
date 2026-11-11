import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

// Demo builds substitute only the IPC boundary. Normal dev/release builds never
// include this adapter; production still requires Tauri to read repositories.
export default defineConfig(({ mode }) => ({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  plugins: mode === 'demo' ? [{
    name: 'fixture-repository',
    enforce: 'pre' as const,
    load(id: string) {
      if (!id.replace(/\\/g, '/').endsWith('/src/bridge.ts')) return;
      const images = Object.fromEntries(['sample.png', 'changed.png', 'sample.jpg', 'sample.webp'].map(name => [name,
        `data:image/${name.endsWith('.jpg') ? 'jpeg' : name.split('.').pop()};base64,${readFileSync(new URL(`./tests/fixtures/${name}`, import.meta.url)).toString('base64')}`,
      ]));
      return readFileSync(new URL('./demo/bridge.js', import.meta.url), 'utf8')
        .replace('const imageFixtures = {};', `const imageFixtures = ${JSON.stringify(images)};`);
    },
  }] : [],
  build: { target: 'es2022', outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
}));
