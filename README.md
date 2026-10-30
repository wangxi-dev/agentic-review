# agentic-review

A standalone **Tauri desktop app** for reading local repositories and leaving review comments. No Python bridge, browser setup, accounts, AI integrations, or agent skills.

- **Use the app:** [Launch](#launch), [appearance](#appearance-and-readability), [review modes](#three-review-modes), and [comments/export](#comments-and-export).
- **Get an EXE:** [Download a GitHub build](#download-a-github-build) or [build on Windows](#build-on-windows).
- **Maintain the build:** [Build and CI guide](docs/build-and-ci.md), including workflow activation and troubleshooting.

## Launch

Double-click `agentic-review.exe`, then **Open folder…** and choose a Git working tree. Selecting a subfolder opens its Git root. Linked Git worktrees are supported; bare repositories and non-Git folders are not.

From the directory containing the extracted executable, you can also open a repository directly in PowerShell:

```powershell
.\agentic-review.exe "C:\work\my-repository"
.\agentic-review.exe .
```

The second command reviews the current directory, which must be inside a Git working tree. If the executable is elsewhere, use its full path, for example `& "C:\Apps\agentic-review.exe" "C:\work\my-repository"`. Relative repository paths are resolved from the process's current working directory; without a path, the app starts at its welcome screen.

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

**Refresh** reloads the file list and current contents; there is no automatic file watching. Git diff shows the net working-tree difference against `HEAD`, not separate staged and unstaged patches, so changes that cancel each other out will not appear. The app does not stage, commit, check out, or modify source files. A rename retains the previous path; deleted files can be read and commented on from the old side.

### Reading files

- **Source:** syntax highlighting, line numbers, and inline comments.
- **Diff:** highlighted unified changes with separate old/new line anchors.
- **Preview:** rendered Markdown and sandboxed HTML, available alongside source; **PNG, JPG/JPEG, and WebP** files open as images.
- Click a source/diff line number to anchor a comment. Shift-click another line on the same side for a range.
- Click a Markdown block to anchor a comment to its starting source line. For HTML line comments, switch to Source.
- Use the file filter to find paths; directory groups are collapsible.

HTML scripts, navigation, forms, and external resources are blocked. Markdown is sanitized; links do not navigate away from the app. Embedded data images are supported. External or repository-relative images/stylesheets are not loaded; inline HTML styles are supported. Mermaid fences are displayed as code rather than executed.

Text previews require UTF-8 and are limited to **5 MiB**. Unsupported binary files, symbolic links, submodules, and oversized files show an explanatory notice and still allow file-level comments. Files over 250,000 characters skip syntax highlighting; source/diff views stop at 20,000 rows, and diff computation has a one-second time limit to keep the UI responsive. JSON files use Source and Diff, not a tree or a pretty-printed JSON comparison.

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

- JSON is the editable persistence format and is reloaded when the repository opens. Close the app before editing that file manually, then reopen the repository; external changes are not watched or merged.
- Markdown is a readable export; editing it does not update the app.
- Both exports contain **all comments**, across all files, modes, and commits, including resolved comments and comments on files that no longer exist.
- Each comment records its path, previous path for renames, mode, base/revision hashes, old/new side, line/range, status, and timestamps.
- Working-tree comments record the baseline commit, but **do not snapshot working-tree file contents**. Line anchors are not automatically rebased after subsequent edits. Historical commit comments can reopen their recorded commit while it remains available in Git.
- **This file** shows comments from every review of the current file, with their context labels. Inline comments only show for the active review context. **All comments** includes every file; clicking a comment opens its recorded context.
- Malformed or unsupported JSON is not silently overwritten: fix or rename the file before opening the repository.
- Each export is replaced atomically. The pair is not a single filesystem transaction; if one write fails, use Export comments to retry both. Use one app instance per repository to avoid competing saves.
- Export always writes to the Git root; there is currently no alternate destination picker. The root must be writable. Copy the exported files elsewhere if needed.
- The JSON store is limited to **20 MiB** and **10,000 comments**, with **100,000 UTF-8 bytes per comment**. The editor also limits input length.

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

## Download a GitHub build

Once [the workflow](.github/workflows/windows-build.yml) and its helper scripts are committed and pushed to the default branch, with GitHub Actions enabled, **[Build Windows app](https://github.com/wangxi-dev/agentic-review/actions/workflows/windows-build.yml)** builds a Windows x64 executable and installer on:

- Every push to `main`.
- Pull requests targeting `main`.
- Manual runs: **Actions → Build Windows app → Run workflow**.

After a successful run, open its **Summary → Artifacts** and download `agentic-review-windows-x64-<version>-<run-number>-<attempt>`. A download link also appears in the build summary. You must be signed in to GitHub to download Actions artifacts.

Extract the ZIP. It contains:

```text
agentic-review.exe                        # standalone executable
agentic-review_<version>_x64-setup.exe     # per-user Windows installer
README.txt                               # usage, requirements, and source commit
SHA256SUMS.txt                            # checksums for the included files
```

Artifacts are retained for **30 days**; rerun the workflow to generate a fresh download. These are **unsigned** builds, so Windows SmartScreen may warn about an unrecognized application. The workflow does not automatically publish a GitHub Release.

### CI configuration

The workflow in `.github/workflows/windows-build.yml` uses a GitHub-hosted Windows 2022 runner with Node.js 24, Rust stable, the installed MSVC/Windows SDK toolchain, and Microsoft Edge. It builds the frontend, runs the CI-helper/unit/Rust/browser tests and Rust formatting/lint checks, then builds the release executable and NSIS installer with the Cargo lockfile enforced. When test outputs exist, `windows-test-diagnostics-<run-number>-<attempt>` is uploaded separately and retained for **7 days**; it does not contain the app. The interactive WebView2 native smoke test remains a local test.

See the [build and CI guide](docs/build-and-ci.md) if the workflow is not visible, a build fails, or an artifact has expired. A local validation does not imply that a hosted build has run successfully; check the specific GitHub run before downloading.

**No PAT, TPS credentials, signing certificate, or custom repository secrets are required.** The workflow has read-only repository permissions. It uses `scripts/use-public-npm.mjs` to replace only the TPS tarball URLs in the runner's copy of `package-lock.json`, then runs `npm ci` against public npm. Locked versions and integrity hashes are preserved; unknown package sources cause a failure rather than silently switching feeds. Your checked-in `.npmrc` and local TPS setup are unchanged.

To verify a downloaded executable's checksum in PowerShell, compare this output with `SHA256SUMS.txt`:

```powershell
Get-FileHash .\agentic-review.exe -Algorithm SHA256
```

## Build on Windows

Build prerequisites:

- Node.js **24 recommended** (22.12+ supported) and npm
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
src-tauri/target/release/bundle/nsis/agentic-review_<version>_x64-setup.exe
```

For only the executable, without building an installer:

```powershell
npm run tauri -- build --no-bundle
```

All renderers are bundled locally, not loaded from CDNs. The build configuration currently targets the Windows NSIS installer; other Tauri platforms require their native toolchains and a corresponding bundle target.

## Tests

```powershell
npm test                 # comment context, anchor, and appearance unit tests
npm run test:ci          # CI registry preparation / lockfile integrity tests
npm run test:rust        # real temporary Git repositories + export/security tests
npm run test:ui          # Edge browser UI tests with mocked native IPC
npm run test:native      # built release EXE + real Tauri IPC + WebView2 (Windows)
```

Run `npm run build` before `npm run test:rust` in a clean checkout so the frontend assets are present. `test:ui` requires Microsoft Edge and covers theme persistence, text sizing, text contrast, previews, image comparison, and comment workflows. `test:native` requires a release build first; it launches the executable against a temporary repository, checks all three modes and image formats, writes/reloads the actual exports, and verifies appearance settings survive restarting the app. Screenshots are saved as `test-results/native-review.png`, `native-dark.png`, and `native-images.png`. Its temporary debugging port is enabled only for that test process, not in the shipped app configuration.

## Source layout

```text
.github/workflows/            Windows CI build and downloadable artifacts
docs/build-and-ci.md          CI activation, build maintenance, troubleshooting
scripts/                     Public-registry CI preparation and artifact staging
src/                         TypeScript review UI, renderers, native IPC adapter
src-tauri/src/repository.rs   Read-only Git access, safe file reads, comment persistence
src-tauri/src/main.rs         Native commands, startup path, application setup
src-tauri/src/tests.rs        Git and persistence tests
src-tauri/tauri.conf.json     Desktop window, CSP, installer configuration
tests/                       Browser integration tests and native smoke test
examples/                    Small files for trying source and preview renderers
```

The files in `examples/` and `tests/fixtures/` are demonstration content, not application configuration. Open this repository in **Full folder** mode to try them without changing or committing any files.

The previous `local-server/`, `site/`, `skills/`, AI review/checker workflows, and their obsolete documentation have been deleted rather than retained as a compatibility layer.
