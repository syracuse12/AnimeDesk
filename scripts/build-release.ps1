[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root '.release'
$stage = Join-Path $out 'payload'
$resolvedOut = [System.IO.Path]::GetFullPath($out)
function Assert-ReleasePath([string] $candidate) {
    $resolved = [System.IO.Path]::GetFullPath($candidate)
    if (-not $resolved.StartsWith($resolvedOut + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release path is outside the output directory: $resolved"
    }
}
Assert-ReleasePath $stage
$nodeVersion = 'v24.18.0'
# The version is single-sourced from package.json so a tag cannot drift from the
# artifact name.
$version = (Get-Content -Raw (Join-Path $root 'package.json') | ConvertFrom-Json).version
if (-not $version) { throw 'package.json has no version.' }
$installerName = "AnimeDesk-Setup-$version.exe"
$nodeArchive = "node-$nodeVersion-win-x64.zip"
$pinnedNodeSha256 = '0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { throw '.NET Framework C# compiler is required on the build machine.' }
# Vendored WebView2 assemblies. Referenced by full path: csc's /lib: search did
# not resolve them reliably from a quoted relative path.
$wvLib = Join-Path $root 'installer\lib'
$wvCore = Join-Path $wvLib 'Microsoft.Web.WebView2.Core.dll'
$wvForms = Join-Path $wvLib 'Microsoft.Web.WebView2.WinForms.dll'
$wvLoader = Join-Path $wvLib 'WebView2Loader.dll'
foreach ($required in $wvCore, $wvForms, $wvLoader) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing vendored WebView2 assembly: $required" }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\hls.js\LICENSE'))) { throw 'Run npm ci on the build machine first.' }

Push-Location $root
try {
    & npm.cmd run verify
    if ($LASTEXITCODE -ne 0) { throw 'Verification failed.' }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null

    $nodeZip = Join-Path $out $nodeArchive
    $shaFile = Join-Path $out 'SHASUMS256.txt'
    if (-not (Test-Path -LiteralPath $nodeZip)) {
        Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/$nodeArchive" -OutFile $nodeZip -TimeoutSec 600
    }
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$nodeVersion/SHASUMS256.txt" -OutFile $shaFile -TimeoutSec 120
    $line = Get-Content -LiteralPath $shaFile | Where-Object { $_ -match "^[a-f0-9]{64}  $([regex]::Escape($nodeArchive))$" } | Select-Object -First 1
    if (-not $line) { throw 'The official Node checksum list has no entry for this archive.' }
    $expected = $line.Substring(0, 64)
    $actual = (Get-FileHash -LiteralPath $nodeZip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected -or $actual -ne $pinnedNodeSha256) { throw 'Node archive checksum mismatch.' }

    $extract = Join-Path $out 'node-extract'
    Assert-ReleasePath $extract
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $extract
    $nodeRoot = Join-Path $extract "node-$nodeVersion-win-x64"
    New-Item -ItemType Directory -Force -Path (Join-Path $stage 'runtime'), (Join-Path $stage 'notices') | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeRoot 'node.exe') -Destination (Join-Path $stage 'runtime\node.exe')
    Copy-Item -LiteralPath (Join-Path $nodeRoot 'LICENSE') -Destination (Join-Path $stage 'notices\Node-LICENSE.txt')
    foreach ($name in @('hls.js', 'react', 'react-dom', 'scheduler', 'loose-envify', 'js-tokens')) {
        Copy-Item -LiteralPath (Join-Path $root "node_modules\$name\LICENSE") -Destination (Join-Path $stage "notices\$name-LICENSE.txt")
    }
    Copy-Item -LiteralPath (Join-Path $root 'licenses\Apache-2.0.txt') -Destination (Join-Path $stage 'notices\Apache-2.0.txt')
    Copy-Item -LiteralPath (Join-Path $root 'THIRD-PARTY-NOTICES.md') -Destination (Join-Path $stage 'notices\THIRD-PARTY-NOTICES.md')
    Copy-Item -LiteralPath (Join-Path $root 'server') -Destination $stage -Recurse
    Remove-Item -LiteralPath (Join-Path $stage 'server\providers\archive.ts') -Force
    Copy-Item -LiteralPath (Join-Path $root 'shared') -Destination $stage -Recurse
    Copy-Item -LiteralPath (Join-Path $root 'dist') -Destination $stage -Recurse
    '{"type":"module"}' | Set-Content -LiteralPath (Join-Path $stage 'package.json') -Encoding ASCII
    Copy-Item -LiteralPath (Join-Path $root 'RELEASE.md') -Destination $stage

    & $csc /nologo /target:winexe /out:"$(Join-Path $stage 'AnimeDesk.exe')" /r:System.Windows.Forms.dll /r:System.Drawing.dll "/r:$wvCore" "/r:$wvForms" (Join-Path $root 'installer\AppHost.cs')
    if ($LASTEXITCODE -ne 0) { throw 'App host compilation failed.' }
    # WebView2 ships next to the host: the managed wrappers are resolved from
    # the app directory and the loader locates the Evergreen runtime.
    Copy-Item -LiteralPath $wvCore -Destination $stage
    Copy-Item -LiteralPath $wvForms -Destination $stage
    Copy-Item -LiteralPath $wvLoader -Destination $stage
    Copy-Item -LiteralPath (Join-Path $wvLib 'WebView2-LICENSE.txt') -Destination (Join-Path $stage 'notices\WebView2-LICENSE.txt')
    $manifest = Get-ChildItem -LiteralPath $stage -File -Recurse | ForEach-Object {
        [pscustomobject]@{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = $_.Length }
    }
    $manifest | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $out 'payload-manifest.json') -Encoding UTF8
    $payloadZip = Join-Path $out 'AnimeDesk-payload.zip'
    if (Test-Path -LiteralPath $payloadZip) { Remove-Item -LiteralPath $payloadZip -Force }
    Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $payloadZip -CompressionLevel Optimal
    & $csc /nologo /target:winexe /main:Setup /out:"$(Join-Path $out $installerName)" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:Microsoft.CSharp.dll /r:System.IO.Compression.dll /r:System.IO.Compression.FileSystem.dll "/r:$wvCore" "/r:$wvForms" "/resource:$payloadZip,AnimeDeskPayload" (Join-Path $root 'installer\AppHost.cs') (Join-Path $root 'installer\Setup.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    Write-Host "Installer: $(Join-Path $out $installerName)"
    Write-Host "Payload: $payloadZip"
    Write-Host "Manifest: $(Join-Path $out 'payload-manifest.json')"
}
finally { Pop-Location }
