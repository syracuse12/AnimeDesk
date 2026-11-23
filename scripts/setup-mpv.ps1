# AnimeDesk - project-local mpv setup
#
# Downloads an official mpv Windows build (shinchiro/mpv-winbuild-cmake) into
# .\tools\mpv so the player can be used without a system-wide install.
# Nothing outside this folder is modified.

[CmdletBinding()]
param(
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

$archiveName = 'mpv-x86_64-20261111-git-bcde6b93cc.7z'
$expected = 'f259b5fd4b5c395617c948a4fadcdf55bba1c5282fb7c13e88626b3f71072baf'
$url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261111/$archiveName"

New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
$archive = Join-Path $toolsDir $archiveName
Write-Host "Downloading pinned mpv build $archiveName..."
Invoke-WebRequest -Uri $url -OutFile $archive -TimeoutSec 600

$actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
    throw 'The mpv archive digest does not match the release; existing mpv was not replaced.'
}

if (Test-Path -LiteralPath $mpvDir) { Remove-Item -LiteralPath $mpvDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $mpvDir | Out-Null

# Windows' bundled bsdtar reads .7z archives.
& tar.exe -xf $archive -C $mpvDir
if ($LASTEXITCODE -ne 0) { throw "Extracting $archiveName failed (tar exit $LASTEXITCODE)." }
Remove-Item -LiteralPath $archive -Force

if (-not (Test-Path -LiteralPath $mpvExe)) { throw "mpv.exe was not found after extraction in $mpvDir" }

$version = (& $mpvExe --version 2>&1 | Select-Object -First 1)
Write-Host "Installed project-local player: $version"
Write-Host "Path: $mpvExe"
