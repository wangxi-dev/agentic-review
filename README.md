# agentic-review

A standalone **Tauri desktop app** for reading local repositories and leaving review comments. No Python bridge, browser setup, accounts, AI integrations, or agent skills.

## Launch

Double-click `agentic-review.exe`, then **Open folder…** and choose a Git working tree. Selecting a subfolder opens its Git root. Linked Git worktrees are supported; bare repositories and non-Git folders are not.

You can also open a repository directly:

```powershell
agentic-review.exe "C:\work\my-repository"
agentic-review.exe .
```

The executable needs **Git on PATH** and the **Microsoft Edge WebView2 Runtime** (normally present on Windows 10/11). It does not need Node.js, Rust, Python, a local server, or an internet connection at runtime. The NSIS installer can install WebView2 if missing; that first-time runtime installation may require internet access.

## Appearance and readability

The app defaults to **Light** mode with high-contrast text, heavier font weights, 16 px source text, and larger comment/toolbar labels. Use the controls in the top bar:

- **Theme:** Light, Dark, or System. System follows Windows appearance changes; Light stays light even if Windows uses dark mode.
- **Text size:** Standard, Large, or Extra large. This scales the interface, source/diffs, Markdown, and comments together.

Both preferences are remembered locally across restarts and repositories. Switching appearance does not reload your file, clear your comment draft, or write anything into the repository. Syntax highlighting and diff colors adapt to the selected theme. Images retain their original colors, and sandboxed HTML retains its authored appearance.

## Three review modes

| Mode | Files and contents |
| --- | --- |
| **Git diff** | Combined staged + unstaged changes against `HEAD`, plus untracked, non-ignored files. An unborn repository uses an empty baseline. |
| **Git commit** | A selected commit against its **first parent**, using the actual committed contents, not the working tree. A root commit uses an empty baseline. Enter a hash, branch, or tag; the revision field suggests the latest 200 commits from `HEAD`. |
| **Full folder** | Current tracked and untracked files, excluding ignored untracked files and deleted files. Tracked files remain visible even if they match ignore rules. |

**Refresh** reloads the file list and current contents. The app does not stage, commit, check out, or modify source files. A rename retains the previous path; deleted files can be read and commented on from the old side.

### Reading files

- **Source:** syntax highlighting, line numbers, and inline comments.
- **Diff:** highlighted unified changes with separate old/new line anchors.
- **Preview:** rendered Markdown and sandboxed HTML, available alongside source; **PNG, JPG/JPEG, and WebP** files open as images.
- Click a source/diff line number to anchor a comment. Shift-click another line on the same side for a range.
- Click a Markdown block to anchor a comment to its starting source line. For HTML line comments, switch to Source.
- Use the file filter to find paths; directory groups are collapsible.

HTML scripts, navigation, forms, and external resources are blocked. Markdown is sanitized; links do not navigate away from the app. Embedded data images are supported. External or repository-relative images/stylesheets are not loaded; inline HTML styles are supported. Mermaid fences are displayed as code rather than executed.

Text previews require UTF-8 and are limited to **5 MiB**. Unsupported binary files, symbolic links, submodules, and oversized files show an explanatory notice and still allow file-level comments. Files over 250,000 characters skip syntax highlighting, views stop at 20,000 rows, and complex diffs have a time limit to keep the UI responsive.

### Image review

Open a `.png`, `.jpg`, `.jpeg`, or `.webp` file directly from the file list in any review mode. Images are loaded locally from the working tree or the selected Git commit, not via a filesystem web server.

- **Preview** shows the image with its pixel dimensions and a transparency checkerboard.
- **Fit / 100%** switches between fitting the pane and the image's original pixel size; oversized images can be scrolled.
- **Diff** shows before/after images side by side (stacked in narrow panes), including added, deleted, and renamed images. This is a visual comparison, not a computed pixel-difference map.
- **Comment on old/new image** creates a file-level comment on that version. Image region annotations are not supported.

Image files are limited to **20 MiB per version**. File signatures are checked before displaying; corrupt or unsupported data shows an explanatory notice. For sample assets, see `tests/fixtures/sample.{png,jpg,webp}`. Standalone image previews do not enable external or relative-image fetching inside Markdown/HTML documents.

## Comments and export

Every add, edit, resolve/reopen, or delete automatically writes **both** files to the opened Git root:

```text
<git-root>/agentic-review.comments.json
<git-root>/agentic-review.comments.md
```

**Export comments** writes them on demand, including an empty review, and retries a failed save. No files are written just by browsing a repository. The footer shows save status; failed writes leave comments in memory and display an error. Finish a save before closing, or explicitly discard unsaved changes. Unsaved drafts require confirmation before navigating away.

- JSON is the editable persistence format and is reloaded when the repository opens.
- Markdown is a readable export; editing it does not update the app.
- Both exports contain **all comments**, across all files, modes, and commits, including resolved comments and comments on files that no longer exist.
- Each comment records its path, previous path for renames, mode, base/revision hashes, old/new side, line/range, status, and timestamps.
- Working-tree comments record the baseline commit, but **do not snapshot working-tree file contents**. Line anchors are not automatically rebased after subsequent edits. Historical commit comments can reopen their recorded commit while it remains available in Git.
- **This file** shows comments from every review of the current file, with their context labels. Inline comments only show for the active review context. **All comments** includes every file; clicking a comment opens its recorded context.
- Malformed or unsupported JSON is not silently overwritten: fix or rename the file before opening the repository.
- Each export is replaced atomically. The pair is not a single filesystem transaction; if one write fails, use Export comments to retry both. Use one app instance per repository to avoid competing saves.

Export files are excluded from the app's file list, but they are ordinary files and may appear in `git status`. Add the following to the reviewed repository's `.gitignore` if you do not want to commit them:

```gitignore
agentic-review.comments.json
agentic-review.comments.md
```

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+O | Open a repository |
| Ctrl/Cmd+S | Export comments |
| Ctrl/Cmd+Enter in the comment box | Add/save comment |

## Build on Windows

Build prerequisites:

- Node.js 22.12+ and npm
- Rust stable with the MSVC toolchain
- Visual Studio C++ Build Tools and a Windows SDK
- Git and WebView2

This checkout uses the **TPS npm feed** in `.npmrc`. Credentials belong in your user-level npm configuration, never in this repository. If authentication expires, refresh with your installed credential helper:

```powershell
vsts-npm-auth -config .npmrc -F
npm ci
npm run desktop
```

Build the executable and Windows installer:

```powershell
npm run package
```

Artifacts:

```text
src-tauri/target/release/agentic-review.exe
src-tauri/target/release/bundle/nsis/agentic-review_0.2.0_x64-setup.exe
```

For only the executable, without building an installer:

```powershell
npm run tauri -- build --no-bundle
```

All renderers are bundled locally, not loaded from CDNs. The build configuration currently targets the Windows NSIS installer; other Tauri platforms require their native toolchains and a corresponding bundle target.

## Tests

```powershell
npm test                 # comment context, anchor, and appearance unit tests
npm run test:rust        # real temporary Git repositories + export/security tests
npm run test:ui          # Edge browser UI tests with mocked native IPC
npm run test:native      # built release EXE + real Tauri IPC + WebView2 (Windows)
```

`test:ui` requires Microsoft Edge and covers theme persistence, text sizing, text contrast, previews, image comparison, and comment workflows. `test:native` requires a release build first; it launches the executable against a temporary repository, checks all three modes and image formats, writes/reloads the actual exports, and verifies appearance settings survive restarting the app. Screenshots are saved as `test-results/native-review.png`, `native-dark.png`, and `native-images.png`. Its temporary debugging port is enabled only for that test process, not in the shipped app configuration.

## Source layout

```text
src/                         TypeScript review UI, renderers, native IPC adapter
src-tauri/src/repository.rs   Read-only Git access, safe file reads, comment persistence
src-tauri/src/main.rs         Native commands, startup path, application setup
src-tauri/src/tests.rs        Git and persistence tests
src-tauri/tauri.conf.json     Desktop window, CSP, installer configuration
tests/                       Browser integration tests and native smoke test
examples/                    Small files for trying source and preview renderers
```

The previous `local-server/`, `site/`, `skills/`, AI review/checker workflows, and their obsolete documentation have been deleted rather than retained as a compatibility layer.
