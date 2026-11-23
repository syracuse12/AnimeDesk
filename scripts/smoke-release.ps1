[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $root '.release\AnimeDesk-Setup-0.2.4.exe'
$install = Join-Path $env:LOCALAPPDATA 'Programs\AnimeDesk'
$desktop = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'AnimeDesk.lnk'
$menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'AnimeDesk.lnk'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AnimeDesk'
$releaseData = Join-Path $env:APPDATA 'AnimeDesk\distribution'
$releaseProfile = Join-Path $env:LOCALAPPDATA 'AnimeDesk\distribution-window'
if (-not (Test-Path -LiteralPath $installer)) { throw 'Build the installer first.' }
if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $key)) { throw 'An AnimeDesk release is already installed; smoke test will not replace it.' }
$installed = $false
try {
    $setup = Start-Process -FilePath $installer -ArgumentList '--silent' -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw "Installer exited $($setup.ExitCode)" }
    $installed = $true
    foreach ($file in @('AnimeDesk.exe', 'runtime\node.exe', 'dist\index.html', 'notices\Node-LICENSE.txt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $install $file))) { throw "Installed file missing: $file" }
    }
    if (-not (Test-Path -LiteralPath $desktop) -or -not (Test-Path -LiteralPath $menu) -or -not (Test-Path -LiteralPath $key)) {
        throw 'Shortcut or uninstall registration missing.'
    }
    $shell = New-Object -ComObject WScript.Shell
    foreach ($link in @($desktop, $menu)) {
        if ($shell.CreateShortcut($link).TargetPath -ne (Join-Path $install 'AnimeDesk.exe')) {
            throw "Shortcut target is incorrect: $link"
        }
    }
    $node = Join-Path $install 'runtime\node.exe'
    $version = & $node --version
    if ($version -ne 'v24.18.0') { throw "Bundled runtime version mismatch: $version" }
    $library = Join-Path $root '.release\smoke-library\Sample Show'
    New-Item -ItemType Directory -Force -Path $library | Out-Null
    Copy-Item -LiteralPath (Join-Path $root 'tests\fixtures\media\sample.mp4') -Destination (Join-Path $library 'Episode 1.mp4') -Force
    for ($launch = 1; $launch -le 2; $launch++) {
    $start = [System.Diagnostics.ProcessStartInfo]::new($node, 'server/main.ts')
    $start.WorkingDirectory = $install
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.EnvironmentVariables['ANIMEDESK_PROFILE'] = 'distribution'
    $start.EnvironmentVariables['ANIMEDESK_PORT'] = '0'
    $service = [System.Diagnostics.Process]::Start($start)
    try {
        $line = $service.StandardOutput.ReadLine()
        if ($line -notmatch 'service ready on http://127\.0\.0\.1:(\d+)') { throw "Bundled service did not start: $line" }
        $port = [int]$Matches[1]
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/status" -TimeoutSec 10
        if (($status.providers.id -join ',') -ne 'local') { throw 'Distribution service exposed another provider.' }
        if ($launch -eq 1) {
            $libraryRoot = Split-Path -Parent $library
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/settings" -Method Patch -ContentType 'application/json' -Body (@{localLibraryDir=$libraryRoot} | ConvertTo-Json) | Out-Null
            $search = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/search?q=Sample" -TimeoutSec 10
            if ($search.results.Count -ne 1) { throw 'Installed local search failed.' }
            $play = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/play" -Method Post -ContentType 'application/json' -Body (@{provider='local';animeId=$search.results[0].id;episodeNumber=1;audio='sub'} | ConvertTo-Json)
            if (-not $play.session.sessionId) { throw 'Installed local playback failed.' }
            $mediaRequest = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$port$($play.session.streamUrl)")
            $mediaRequest.AddRange(0, 15)
            $media = $mediaRequest.GetResponse()
            try {
                if ([int]$media.StatusCode -ne 206 -or $media.ContentLength -ne 16) { throw 'Installed media range request failed.' }
            } finally { $media.Dispose() }
            Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/sessions/$($play.session.sessionId)/progress?force=1" -Method Post -ContentType 'application/json' -Body '{"position":30,"duration":60}' | Out-Null
        } else {
            $history = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/history" -TimeoutSec 10
            if ($history.entries.Count -ne 1) { throw 'History did not persist after reopening.' }
        }
        $service.StandardInput.WriteLine('shutdown')
        if (-not $service.WaitForExit(5000)) { throw 'Bundled service did not shut down.' }
        if ($service.ExitCode -ne 0) { throw "Bundled service exited $($service.ExitCode)" }
    }
    finally {
        if (-not $service.HasExited) { $service.Kill(); $service.WaitForExit() }
        $service.Dispose()
    }
    }
    Write-Host "Installed runtime $version started and stopped on loopback port $port"
}
finally {
    if ($installed) {
        $uninstall = Start-Process -FilePath (Join-Path $install 'AnimeDesk.exe') -ArgumentList '--uninstall --silent' -Wait -PassThru
        if ($uninstall.ExitCode -ne 0) { throw "Uninstaller exited $($uninstall.ExitCode)" }
        $deadline = (Get-Date).AddSeconds(15)
        while ((Test-Path -LiteralPath $install) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
        if ((Test-Path -LiteralPath $install) -or (Test-Path -LiteralPath $desktop) -or (Test-Path -LiteralPath $menu) -or
            (Test-Path -LiteralPath $key) -or (Test-Path -LiteralPath $releaseData) -or (Test-Path -LiteralPath $releaseProfile)) {
            throw 'Uninstall left application files, release data, shortcuts or registration.'
        }
        Write-Host 'Uninstall removed files, shortcuts and registration'
    }
    $smokeLibrary = [System.IO.Path]::GetFullPath((Join-Path $root '.release\smoke-library'))
    $releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $root '.release'))
    if ($smokeLibrary.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $smokeLibrary)) { Remove-Item -LiteralPath $smokeLibrary -Recurse -Force }
}
