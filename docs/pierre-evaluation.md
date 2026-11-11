# Pierre diff experiment

## Recommendation

Keep Classic as the default for now. Pierre is worth offering as an optional renderer for split view, word-level highlights and expandable context. Do not remove our `diff` dependency or switch every review to Pierre yet.

The prototype keeps our timeout-bounded `reviewPatch` computation and passes its result to Pierre. Source, Markdown, HTML and image rendering are unchanged. Git reads, comment persistence and the Tauri backend are unchanged.

## What was evaluated

- App baseline: `04a4f20` on `main`.
- Pierre source inspected at commit `769893a3` (`trees 1.0.0 (#1285)`); that checkout was not modified.
- Tested package: published `@pierre/diffs` **1.6.4**, pinned in our lockfile. The checkout declares the same package version but is not identical to that release: its line-click callback uses `side`; the published declaration uses `annotationSide`. The adapter targets the installed package.
- Installed dependencies: app `diff` **8.0.4**; Pierre's `diff` **9.0.0**; Shiki **4.6.0**. There is no React runtime dependency.
- Icons: selected SVGs from `@pierre/icons` **0.9.0** (Apache-2.0) and `@pierre/vscode-icons` **0.0.9** (MIT), vendored with both licenses under `src/assets/pierre/`.

Pierre uses jsdiff internally. Replacing the custom viewer with Pierre would primarily replace rendering and interactions, not eliminate the diff algorithm dependency. This prototype deliberately shares our patch between viewers so anchors and Windows newline normalization remain comparable.

## Visible differences

| Area | Classic | Pierre experiment |
| --- | --- | --- |
| Layout | Unified | Unified or side-by-side |
| Changed text | Whole-line background | Whole-line plus word-level highlight |
| Syntax | highlight.js | Shiki, GitHub high-contrast light/dark themes |
| Context | Fixed four lines | Expandable unchanged context |
| Context anchors | Old and new gutters | Unified exposes new-side context; Split exposes both |
| Comments | Existing inline notes | Existing comments mapped into Pierre annotations |
| Selection | Click / shift-click | Same behavior, with a keyboard adapter for the vanilla gutter |
| Large files | Existing row/highlighting/time limits | Falls back to Classic above 250,000 combined characters or 4,000 combined source lines |

The new toolbar, review mode, view tab, folder and language icons are decorative; accessible names, text labels and `+` / `-` Git status markers remain. The Windows EXE/installer icon has not changed. Light mode and readable 16 px source text remain the defaults, with existing theme/text-size controls.

Switching renderers retains the draft and anchor. The renderer preference is stored locally. Disposal cancels pending loads and releases the previous view and theme observer. A failed lazy import or synchronous render falls back to Classic with a notice.

## Measurements

Measured locally on Windows with headless Microsoft Edge **155.0.4283.60**. These are exploratory measurements, not a general performance claim.

`npm run demo:benchmark` measures from `renderContent` to highlighted DOM plus two animation frames in the development build. Each cell is the median of five warmed samples after discarding the first run. Both versions contain the stated number of lines. No worker pool or persistent renderer cache is used by this adapter.

| Fixture | Classic | Pierre Unified | Pierre Split |
| --- | ---: | ---: | ---: |
| 40 lines, one edit | 31.6 ms | 48.3 ms | 48.3 ms |
| 1,000 lines, one edit | 29.6 ms | 181.6 ms | 181.3 ms |
| 500 lines, every declaration changed | 119.4 ms | 231.2 ms | 232.0 ms |
| 2,500 lines, one edit | 68.1 ms | 69.3 ms, Classic fallback | 67.9 ms, Classic fallback |

The two-frame wait contributes a substantial floor to these numbers. They include patch parsing, highlighting and rendering, not just algorithm execution. Raw samples are in `artifacts/benchmark-results.json`. Cold start, sustained memory use and very large virtualized diffs remain unmeasured.

Production frontend assets before integration were about **1.12 MB** uncompressed (one JS entry plus CSS). With the experiment they are about **12.28 MB** across **405 assets**, or **2.60 MB** when summing per-file gzip sizes. Most of that increase is lazy-loaded language/theme assets; it still increases the desktop build's embedded assets. The main app JS entry grows from **1,098.63 kB** to about **1,123.93 kB** (gzip **354.51 → 363.57 kB**). These are frontend assets, not EXE/installer sizes.

## Verification

- `npm test`: **23 passing** unit tests, including six adapter tests.
- `npm run test:ui -- --workers=4`: **24 passing** browser tests, including all 16 existing tests and eight Pierre tests.
- `npm run test:ci`: **5 passing** lockfile/feed helper tests.
- `npm run build` and `npm run build:demo`: successful typecheck and production builds. Vite still reports large-chunk warnings.
- Built fixture demo exercised in Edge with the unchanged Tauri CSP supplied as an HTTP response header: no page errors, external requests or CSP violations in the capture run.
- Checked old/new and context anchors, keyboard activation, ranges, saved annotations, draft retention, theme changes, preference persistence, cleanup, CRLF normalization, empty/added/deleted files, missing final newline, inert source markup, and fallback behavior.
- Screenshots captured and inspected for Classic, Pierre Unified, Pierre Split, inline comments, and dark mode.

Follow-up: `npm run tauri -- build --no-bundle -- --locked` successfully built the Windows x64 release EXE on 2026-11-11 (10,980,864 bytes / 10.47 MiB). The build also regenerated the production frontend, without demo mode. The executable is written to `src-tauri/target/release/agentic-review.exe`; see [the build guide](build-and-ci.md) for prerequisites.

The desktop app was not launched. Native WebView2 interaction, Rust tests and the installer build have not been run. The browser CSP check does not replace native validation.

## Before making Pierre the default

1. Test the actual packaged WebView2 app, especially syntax loading, clipboard/export and interaction cleanup.
2. Limit bundled languages/themes or configure a smaller highlighter build.
3. Keep renderer instances/caches across comment updates, then measure again. Evaluate workers/virtualization before lifting the conservative limits.
4. Decide whether Unified's new-side-only context gutter is acceptable or add an explicit old-side context action.
5. Verify hunk expansion, comments in collapsed context, minimum-window readability, and repeated navigation over a longer native session.

## Run the comparison

```powershell
npm ci
npm run demo
```

Open **http://127.0.0.1:1421** and choose Classic, Pierre Unified or Pierre Split in the Renderer dropdown. The demo uses an in-memory fixture repository; comments reset on reload and no repository files are read or written. The normal desktop build still uses the native IPC adapter.

With the development demo running, use a second terminal:

```powershell
npm run demo:capture
npm run demo:benchmark
```

Both scripts require Microsoft Edge. Screenshots, the gallery and raw timing samples are generated under ignored `artifacts/`. They are not included in the repository. Open `artifacts/demo-gallery.html` after capturing.

To preview the production demo instead, stop the development demo and run `npm run build:demo` followed by `npm run preview:demo`. Demo output goes to `dist-demo/`, separate from the native build's `dist/`. The benchmark script requires the development server because it imports source modules.
