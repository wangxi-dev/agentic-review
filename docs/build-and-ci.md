# Windows builds and GitHub Actions

[Back to the README](../README.md)

This guide describes the configuration in [windows-build.yml](../.github/workflows/windows-build.yml). The configured deliverable is **Windows x64**, not ARM64, macOS, or Linux. No executable is committed to Git; builds are distributed as Actions artifacts.

## Activate the workflow

1. Commit and push the workflow, `scripts/` helpers, package files, and related documentation to the repository's default branch (`main`). A local workflow file alone does not create a hosted build.
2. In repository **Settings → Actions → General**, make sure the workflow's actions are permitted by the repository or organization policy. The workflow uses `actions/checkout`, `actions/setup-node`, `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, and `actions/upload-artifact`.
3. Open **Actions → Build Windows app**. The push to `main` should trigger a run. You can also select **Run workflow** after the workflow is present on the default branch; this requires appropriate repository permissions.
4. Wait for **Test and package Windows x64** to succeed. Local syntax checks or a local EXE build are not evidence of a successful hosted run.

Further pushes to `main`, pull requests targeting `main`, and manual runs trigger builds. A tag push alone does not trigger this workflow. Fork pull requests may require maintainer approval before running. A newer run for the same branch or pull request cancels an older in-progress run.

**No custom repository secrets are needed for CI.** The job requests only `contents: read`, and checkout does not persist Git credentials. A developer still needs repository write access to push the configuration; permission to change workflow files may also be required by the account/token being used. Do not put a GitHub PAT, TPS credentials, or the local `.secrets/` folder in the repository or downloadable ZIP.

## Download and use a build

Open a completed run's **Summary → Artifacts**, or use the download link in its build summary. Sign in to GitHub to download the artifact.

| Artifact | Contents | Retention |
| --- | --- | --- |
| `agentic-review-windows-x64-<version>-<run-number>-<attempt>` | EXE, installer, usage instructions, checksums | 30 days |
| `windows-test-diagnostics-<run-number>-<attempt>` | Available browser screenshots/reports; no EXE | 7 days |

The attempt suffix distinguishes reruns of the same workflow run. Browser diagnostics are uploaded when output exists and the run is not cancelled; a failure before browser tests may have no diagnostics.

Extract the app artifact ZIP before running anything. Its top level contains:

```text
agentic-review.exe
agentic-review_<version>_x64-setup.exe
README.txt
SHA256SUMS.txt
```

The standalone EXE can be copied elsewhere and launched directly. The NSIS installer provides a per-user installation. Both require **Git on PATH** and **Microsoft Edge WebView2 Runtime**. The installer can install WebView2 if missing, which may require an internet connection. No Node.js, Rust, Python, npm-feed access, or local bridge server is needed to run the installed app.

From the extracted directory in PowerShell:

```powershell
.\agentic-review.exe "C:\work\my-repository"
```

The installer is not documented to add the executable to `PATH`; use its shortcut or the executable's actual path.

These builds are **unsigned**. SmartScreen may warn that the publisher is unrecognized. Check the repository, run, and source commit, and run only software you trust. `README.txt` records the commit and build-run link. Compare each executable's hash against `SHA256SUMS.txt`:

```powershell
Get-FileHash .\agentic-review.exe -Algorithm SHA256
Get-FileHash .\agentic-review_0.2.0_x64-setup.exe -Algorithm SHA256
# Substitute the actual installer filename from your ZIP.
```

Checksums detect corrupted or changed downloads; they are not a digital signature. Expired artifacts must be rebuilt. No GitHub Release, permanent download URL, automatic updater, or code-signing certificate is configured by this workflow.

## What CI runs

The job uses **Windows 2022**, **Node.js 24**, and **Rust stable** with `rustfmt` and `clippy`. MSVC, a Windows SDK, and Microsoft Edge come from the hosted runner image. npm and Rust dependency caches speed up repeat builds; Rust caches are saved only from `main`.

The build sequence is:

1. Test the public-registry preparation helper.
2. Normalize the runner's npm lockfile download URLs and install locked dependencies from public npm.
3. Type-check and build frontend assets with `npm run build`.
4. Run frontend unit tests with `npm test`.
5. Check Rust formatting, run Rust tests, and run Clippy with warnings treated as errors.
6. Run headless Edge UI tests with two workers.
7. Build the release EXE and NSIS installer with `npm run package -- --ci -- --locked`. Tauri also runs its configured frontend build hook.
8. Stage exactly the expected executable and installer, write usage instructions and checksums, and upload the artifact.

The Cargo lockfile is enforced for Rust tests, linting, and packaging. The artifact helper rejects missing executables and non-empty staging directories to avoid publishing an incomplete build or unrelated leftover files.

**`npm run test:native` is not run in hosted CI.** It exercises the real desktop window and WebView2, including close/restart behavior, and remains a local Windows smoke test. Hosted browser tests use mocked native IPC; Rust tests exercise real temporary Git repositories and filesystem exports.

## TPS locally, public npm in CI

The checked-in [`.npmrc`](../.npmrc) selects the TPS npm feed, and [package-lock.json](../package-lock.json) contains TPS tarball URLs. `npm ci --registry=https://registry.npmjs.org` alone does not remove those locked private-feed URLs.

Before installation, [use-public-npm.mjs](../scripts/use-public-npm.mjs) changes only the known TPS download prefix to `https://registry.npmjs.org/` in the runner's copy of the lockfile. Versions, dependency metadata, and integrity checksums are unchanged. npm still verifies the downloaded tarballs against those checksums. Unknown sources, unexpected URLs, or missing integrity hashes fail preparation instead of silently changing dependencies.

This temporary change is not committed back, and `.npmrc` stays unchanged. The app currently uses public npm packages. Adding a private-only dependency requires deliberately revisiting this CI setup; URL normalization cannot make private packages public.

For a local TPS checkout, use your user-level credential helper as needed:

```powershell
vsts-npm-auth -config .npmrc -F
npm ci
```

To reproduce **only the public npm installation step**, use a disposable checkout with public npm network access:

```powershell
node scripts/use-public-npm.mjs
npm ci --registry=https://registry.npmjs.org
```

That command rewrites the checkout's lockfile. Do not run it in a working copy whose dependency edits you want to preserve, and do not commit its temporary registry rewrite. Restricted local networks may still require TPS even though GitHub-hosted runners can use public npm.

## Local build and validation

Install Node.js 24, Rust stable/MSVC, Visual Studio's C++ build tools and Windows SDK, Git, and WebView2. CI/helper PowerShell scripts use **PowerShell 7** (`pwsh`). Run these commands from the repository root after installing npm dependencies:

```powershell
npm run desktop                 # development window with frontend reload
npm run build                   # type-check and generate dist/ assets
npm test
npm run test:ci
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
npm run test:ui -- --workers=2
npm run package -- --ci -- --locked
npm run test:native              # requires the release executable built above
```

Stop the development process before starting the browser tests if it occupies port 1420. Generate `dist/` before compiling Rust tests in a fresh checkout. Close any running copy of the release EXE before rebuilding it so Windows does not lock the output file.

Build outputs:

```text
src-tauri/target/release/agentic-review.exe
src-tauri/target/release/bundle/nsis/agentic-review_<version>_x64-setup.exe
```

For the standalone EXE without an installer:

```powershell
npm run tauri -- build --no-bundle -- --locked
```

After a **full** build, you can test the CI artifact-staging helper locally using a new, empty output directory:

```powershell
pwsh -NoProfile -File .\scripts\stage-windows-artifacts.ps1 -OutputDirectory "$env:TEMP\agentic-review-check"
```

Staging requires both the EXE and the version-matched installer, so an EXE-only build in a clean checkout is insufficient. The helper generates files but does not ZIP, upload, or publish them; `actions/upload-artifact` supplies the downloadable ZIP in CI.

## Updating versions and dependencies

- Keep the application version consistent in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`; update the corresponding root-package records in both lockfiles. The installer/artifact version is read from `tauri.conf.json`.
- Update dependencies through npm/Cargo and commit both the manifests and their lockfiles. Do not remove integrity hashes to work around a failed download.
- Run the validation steps above before pushing a version or dependency change.
- Code signing, other platforms/architectures, and publishing releases require separate configuration; do not expect a version bump or tag to enable them.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Workflow or **Run workflow** button is missing | Confirm the workflow and helpers reached the default branch, Actions is enabled, and you have permission to run workflows. |
| Workflow push gets HTTP 403 | Check the Git account/token's repository and workflow-file permissions. This is push authentication, not a CI secret requirement. |
| Local npm install gets HTTP 401 | Refresh your user-level TPS credentials; do not paste a PAT into the project `.npmrc`. |
| Hosted npm installation tries TPS | Check that the preparation step ran before `npm ci` and the command explicitly selects public npm. |
| Public npm returns 404 or an integrity error | Verify the exact locked version and its public tarball; check whether a private-only dependency was added. Do not bypass integrity validation. |
| Unknown package source during preparation | Review the dependency and intentionally update CI access rules if needed; the helper allows only known TPS/public npm locations. |
| MSVC/linker/SDK error in a local build | Install the C++ build tools and Windows SDK and use the MSVC Rust toolchain. |
| Edge test cannot launch | Ensure Microsoft Edge is installed; on hosted CI, check the runner-image logs for changes. |
| Release EXE is locked during rebuild | Close that app instance, then rebuild. Preserve any unsaved comments first. |
| Installer missing during staging | Complete the NSIS build and check that its version matches `tauri.conf.json`. |
| Staging directory is not empty | Choose a new empty output directory; do not mix files from different builds. |
| Artifact is missing or expired | Inspect the packaging/upload step. Failed or cancelled runs may not produce an app artifact; rerun expired builds. |

For review behavior, preview restrictions, and comment persistence, see the [README](../README.md).
