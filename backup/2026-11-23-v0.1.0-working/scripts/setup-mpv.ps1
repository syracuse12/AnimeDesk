# AnimeDesk - project-local mpv setup
#
# Downloads an official mpv Windows build (shinchiro/mpv-winbuild-cmake) into
# .\tools\mpv so the player can be used without a system-wide install.
# Nothing outside this folder is modified.

[CmdletBinding()]
param(
    [string] $Tag = 'latest',
    [switch] $Force
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $root 'tools'
$mpvDir = Join-Path $toolsDir 'mpv'
$mpvExe = Join-Path $mpvDir 'mpv.exe'

if ((Test-Path -LiteralPath $mpvExe) -and -not $Force) {
    Write-Host "mpv already present: $mpvExe (use -Force to reinstall)"
    exit 0
}

$headers = @{ 'User-Agent' = 'AnimeDesk-Setup' }
$release = if ($Tag -eq 'latest') {
    Invoke-RestMethod -Uri 'https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest' -Headers $headers -TimeoutSec 60
} else {
    Invoke-RestMethod -Uri "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/tags/$Tag" -Headers $headers -TimeoutSec 60
}

$asset = $release.assets |
    Where-Object { $_.name -match '^mpv-x86_64-\d{8}-git-[0-9a-f]+\.7z$' } |
    Select-Object -First 1
if (-not $asset) { throw 'Could not find an x86_64 mpv archive in the release.' }

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$archive = Join-Path $toolsDir $asset.name
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size / 1MB, 1)) MB)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive -Headers $headers -TimeoutSec 600

if (Test-Path -LiteralPath $mpvDir) { Remove-Item -LiteralPath $mpvDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $mpvDir | Out-Null

# Windows' bundled bsdtar reads .7z archives.
& tar.exe -xf $archive -C $mpvDir
if ($LASTEXITCODE -ne 0) { throw "Extracting $($asset.name) failed (tar exit $LASTEXITCODE)." }
Remove-Item -LiteralPath $archive -Force

if (-not (Test-Path -LiteralPath $mpvExe)) { throw "mpv.exe was not found after extraction in $mpvDir" }

$version = (& $mpvExe --version 2>&1 | Select-Object -First 1)
Write-Host "Installed project-local player: $version"
Write-Host "Path: $mpvExe"
