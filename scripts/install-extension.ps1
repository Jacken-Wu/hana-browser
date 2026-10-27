# Copies the built extension to a stable directory and opens the extensions page.
# Run from the repository root:  .\scripts\install-extension.ps1

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo 'extensions\dsh-browser\dist'
# Copy into the repository instead of %LOCALAPPDATA%: this keeps the loaded
# directory stable across rebuilds and avoids sandboxed shells redirecting the
# environment variable to a private path.
$target = Join-Path $repo 'extension-build'

if (-not (Test-Path $dist)) {
  Write-Host "Build output not found: $dist" -ForegroundColor Red
  Write-Host "Run the build first:" -ForegroundColor Yellow
  Write-Host "  `$env:PATH = `"$repo\extensions\dsh-browser\node_modules\.bin;`$env:PATH`""
  Write-Host "  node `"$repo\extensions\dsh-browser\scripts\build.mjs`""
  exit 1
}

if (-not (Test-Path (Join-Path $dist 'manifest.json'))) {
  Write-Host "dist/manifest.json is missing; the build did not finish." -ForegroundColor Red
  exit 1
}

if (Test-Path $target) {
  Write-Host "Removing previous copy: $target"
  Remove-Item $target -Recurse -Force
}

New-Item -ItemType Directory -Path $target -Force | Out-Null
Copy-Item (Join-Path $dist '*') $target -Recurse -Force

Write-Host ""
Write-Host "Extension copied to:" -ForegroundColor Green
Write-Host "  $target" -ForegroundColor Cyan

try {
  Set-Clipboard -Value $target
  Write-Host "Path copied to clipboard."
} catch {
  # Clipboard is best effort.
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Open edge://extensions (or chrome://extensions)"
Write-Host "  2. Turn on Developer mode"
Write-Host "  3. Click 'Load unpacked' and select the directory printed above"
Write-Host "  4. If the extension is already loaded, click Reload instead"
Write-Host ""

$edge = Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'
if (Test-Path $edge) {
  try {
    Start-Process $edge 'edge://extensions/'
    Write-Host "Opened the Edge extensions page."
  } catch {
    Write-Host "Could not open the extensions page automatically; open it manually."
  }
}
