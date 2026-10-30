param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$config = Get-Content (Join-Path $root 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$release = Join-Path $root 'src-tauri/target/release'
$exe = Join-Path $release 'agentic-review.exe'
$installerName = "$($config.productName)_$($config.version)_x64-setup.exe"
$installer = Join-Path $release "bundle/nsis/$installerName"

# Never publish an incomplete build or stale files from a previous version.
foreach ($path in @($exe, $installer)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Expected build artifact is missing: $path"
    }
}
if ((Test-Path -LiteralPath $OutputDirectory) -and @(Get-ChildItem -LiteralPath $OutputDirectory -Force).Count -gt 0) {
    throw 'The artifact staging directory must be empty.'
}
$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot determine the build commit.' }
$buildRun = 'Local build (not a GitHub Actions run)'
if ($env:GITHUB_SERVER_URL -and $env:GITHUB_REPOSITORY -and $env:GITHUB_RUN_ID) {
    $buildRun = "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
Copy-Item -LiteralPath $exe -Destination $OutputDirectory
Copy-Item -LiteralPath $installer -Destination $OutputDirectory

$instructions = @"
agentic-review $($config.version) - Windows x64
Source commit: $commit

START HERE
Extract this ZIP before running the app.
Portable: double-click agentic-review.exe, or run from this directory in PowerShell:
  .\agentic-review.exe "C:\path\to\repository"
Installer: run $installerName for a per-user installation.
Use the installed shortcut or actual EXE path; do not assume it is on PATH.

Requirements: Git on PATH and Microsoft Edge WebView2 Runtime.
The installer can install WebView2 if missing (internet may be required).
Node.js, Rust, Python, and TPS access are NOT needed to run the app.

REVIEW FILES
1. Choose Open folder and select a Git working tree. Subfolders open their Git root.
2. Choose Git diff, Git commit, or Full folder. Git diff compares the working tree
   with HEAD; Git commit uses committed contents against the first parent.
3. Read highlighted source, Markdown/HTML previews, or PNG/JPEG/WebP images.
   Image Diff shows before/after versions; Fit and 100% control image display.
4. Change Theme (Light/Dark/System) or Text size in the top bar. Both are remembered.
5. Add file or line comments; shift-click line numbers for a range. Images support
   file-level comments on the old/new version, not region annotations.

COMMENTS AND EXPORT
Comment changes automatically save both files in the opened Git root:
  agentic-review.comments.json
  agentic-review.comments.md
Export comments writes both on demand, including an empty review, or retries a
failed save. All files/modes/commits are included, not just the visible comments.
The root must be writable. Check the save status before closing the app.
Reopening the repository loads JSON comments. Only one app instance should edit
comments in a repository at a time; close the app before manually editing JSON.

PREVIEW LIMITS
UTF-8 text: 5 MiB per file. Supported images: 20 MiB per version.
HTML scripts are always blocked. Relative and external resources in Markdown/HTML
are not fetched. Open supported image files directly from the file list instead.
The app reads Git/source files but does not stage, commit, or edit them.

VERIFY YOUR DOWNLOAD
These executables are unsigned. Windows SmartScreen may warn about an
unrecognized application. Only run builds from a source you trust.
SHA256SUMS.txt contains SHA-256 checksums for both executables and this file.
To calculate an EXE checksum in PowerShell:
  Get-FileHash .\agentic-review.exe -Algorithm SHA256
Checksums detect changes to files; they are not a publisher signature.

Build run: $buildRun
"@
Set-Content -LiteralPath (Join-Path $OutputDirectory 'README.txt') -Value $instructions -Encoding utf8
$checksums = Get-ChildItem -LiteralPath $OutputDirectory -File | Sort-Object Name | ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $($_.Name)"
}
Set-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Value $checksums -Encoding ascii

if ($env:GITHUB_OUTPUT) {
    Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "version=$($config.version)" -Encoding utf8
}
Write-Host "Staged Windows x64 executables and checksums in $OutputDirectory"
