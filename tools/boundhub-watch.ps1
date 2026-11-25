<#
  boundhub-watch.ps1 - resolve a BoundHub private video to a direct CDN URL and play it.

  Why this exists: private videos are gated server-side. The page only emits a
  hash + signed v-acctoken when the logged-in account is permitted to watch
  (uploader is a friend, or the video is public). The token is signed, so it
  cannot be forged; the hash is random, so it cannot be derived. This script
  drives the real logged-in browser to read the pair off the page, then resolves
  the redirect cookielessly and hands the URL to a player.

  Setup (once):
    & "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
        --remote-debugging-port=9222 --profile-directory=Default
    and log in to boundhub.com in that window.

  Usage:
    .\boundhub-watch.ps1 1045199
    .\boundhub-watch.ps1 https://www.boundhub.com/videos/1045199/give-me-freedom/
    .\boundhub-watch.ps1 1045199 -Print        # print the URL, launch no player
    .\boundhub-watch.ps1 1045199 -Preview      # grab public preview stills (no login)
    .\boundhub-watch.ps1 1045199 -Preview -Print  # list the still paths only
    .\boundhub-watch.ps1 1045199 -Player mpv
    .\boundhub-watch.ps1 1045199 -Out C:\tmp\a.mp4
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Video,
  [ValidateSet('auto', 'vlc', 'mpv', 'ffplay', 'default', 'only')][string]$Player = 'auto',
  [string]$Out,
  [int]$Port = 9222,
  [int]$Attempts = 4,
  # print the resolved URL only, launch no player (same as -Player only)
  [switch]$Print,
  # grab public preview stills instead of the stream (no login, no browser needed)
  [switch]$Preview
)

if ($Print) { $Player = 'only' }
# -Out on its own means "download", so don't pop a player unless one was named
if ($Out -and -not $PSBoundParameters.ContainsKey('Player') -and -not $Print) { $Player = 'only' }

$ErrorActionPreference = 'Stop'
$UA = 'VLC/3.0.20 LibVLC/3.0.20'
$CDP = "http://127.0.0.1:$Port"

function Get-Target {
  try { $l = Invoke-RestMethod "$CDP/json/list" -TimeoutSec 5 } catch { throw "CDP not reachable on port $Port - start Edge with --remote-debugging-port=$Port" }
  $t = $l | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $t) { throw 'No browser tab available.' }
  return $t.webSocketDebuggerUrl
}

function New-Session {
  $ws = [System.Net.WebSockets.ClientWebSocket]::new()
  $ws.ConnectAsync([uri](Get-Target), [Threading.CancellationToken]::None).Wait()
  return $ws
}

$script:msgId = 0
function Send-Cdp($ws, [string]$method, $params) {
  $script:msgId++
  $payload = @{ id = $script:msgId; method = $method; params = $params } | ConvertTo-Json -Depth 8 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $ws.SendAsync([ArraySegment[byte]]::new($bytes), 'Text', $true, [Threading.CancellationToken]::None).Wait()
  while ($true) {
    $buf = New-Object byte[] 262144
    $sb = [Text.StringBuilder]::new()
    do {
      $r = $ws.ReceiveAsync([ArraySegment[byte]]::new($buf), [Threading.CancellationToken]::None).Result
      [void]$sb.Append([Text.Encoding]::UTF8.GetString($buf, 0, $r.Count))
    } while (-not $r.EndOfMessage)
    $m = $sb.ToString() | ConvertFrom-Json
    if ($m.id -eq $script:msgId) { return $m }
  }
}

function Invoke-Js($ws, [string]$expr) {
  $r = Send-Cdp $ws 'Runtime.evaluate' @{ expression = $expr; returnByValue = $true; awaitPromise = $true }
  if ($r.result.exceptionDetails) { return $null }
  return $r.result.result.value
}

# --- normalise input -------------------------------------------------------
$slug = $null
if ($Video -match '/videos/(\d+)/?([a-z0-9\-]*)/?') { $id = $Matches[1]; $slug = $Matches[2] }
elseif ($Video -match '^\d+$') { $id = $Video }
else { throw "Cannot parse '$Video' - give a video id or a /videos/<id>/<slug>/ URL" }

$videoUrl = $null
if ($slug) { $videoUrl = "https://www.boundhub.com/videos/$id/$slug/" }

# --- preview stills -----------------------------------------------------------
# The screenshot CDN is NOT gated: the directory is floor(id/1000)*1000 and the
# stills return 200 for private videos the account cannot play. No login and no
# CDP session are needed, so this short-circuits before the browser is touched.
if ($Preview) {
  $dir = [Math]::Floor([int]$id / 1000) * 1000
  $base = "https://cnt.bondageobserver.com/contents/videos_screenshots/$dir/$id"
  $imgUa = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  $names = @('preview.jpg')
  for ($i = 1; $i -le 12; $i++) { $names += "timelines/timeline/120x90/$i.jpg" }
  $saved = @()
  foreach ($n in $names) {
    $flat = $n -replace '/', '-'
    $suffix = [IO.Path]::GetFileNameWithoutExtension($flat)
    if ($Out) {
      $target = if ($names.Count -gt 1) { $Out -replace '(\.[a-z]+)$', "-$suffix`$1" } else { $Out }
    } else { $target = Join-Path $env:TEMP "boundhub-$id-$flat" }
    $code = & curl.exe -4 -s -o $target -w '%{http_code}' -A $imgUa "$base/$n" 2>$null
    if ($code -eq '200') { $saved += $target } else { Remove-Item $target -ErrorAction SilentlyContinue }
  }
  if (-not $saved.Count) { throw "No preview still available for $id." }
  if ($Player -eq 'only') { $saved | Write-Output; return }
  $saved | ForEach-Object { Write-Host "Saved: $_"; Start-Process $_ }
  return
}

$ws = New-Session
[void](Send-Cdp $ws 'Page.enable' @{})
[void](Send-Cdp $ws 'Runtime.enable' @{})

# recover a tab stranded on /404.php
[void](Send-Cdp $ws 'Page.navigate' @{ url = 'https://www.boundhub.com/' })
Start-Sleep -Milliseconds 2500

# resolve a missing slug from the id
# bare /videos/<id>/ is the 404 stub; any junk slug works and the real one comes back
if (-not $videoUrl) {
  $found = Invoke-Js $ws "(async()=>{const r=await fetch('/videos/$id/a/',{credentials:'include'});const t=await r.text();const m=t.match(/https:\/\/www\.boundhub\.com\/videos\/$id\/[a-z0-9-]+\//);return m?m[0]:null})()"
  if (-not $found) { $ws.Dispose(); throw "No slug found for $id (video may not exist)." }
  $videoUrl = $found
}

$resolved = $null
for ($try = 1; $try -le $Attempts; $try++) {
  [void](Send-Cdp $ws 'Page.navigate' @{ url = $videoUrl })
  Start-Sleep -Milliseconds 3500

  $pair = Invoke-Js $ws "(()=>{const h=document.documentElement.innerHTML;const m=h.match(/video_url:\s*'([^']+)'/);return m?m[1]:null})()"
  if (-not $pair) {
    $gate = Invoke-Js $ws "(()=>{const h=document.documentElement.innerHTML;const i=h.indexOf('no-player');return i>=0?h.slice(i,i+600).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim():''})()"
    $ws.Dispose()
    if ($gate) { Write-Host "GATED: $gate"; exit 3 }
    throw "No player found for $id (page did not load, or not permitted)."
  }

  # resolve the redirect ourselves, cookieless - do not send it through the browser
  $loc = (& curl.exe -4 -s -o NUL -w '%{redirect_url}' --max-time 20 -A $UA $pair 2>$null)

  if ($loc -and $loc -match 'cdn\.bdsmactually') { $resolved = $loc; break }
  if ($loc -and $loc -match '60260166') { Write-Verbose "placeholder on attempt $try, retrying"; Start-Sleep -Milliseconds 1200; continue }
  Write-Verbose "no redirect on attempt $try"; Start-Sleep -Milliseconds 1200
}
$ws.Dispose()

if (-not $resolved) { throw "Could not resolve a stream for $id after $Attempts attempts." }

if ($Out) { Invoke-WebRequest $resolved -OutFile $Out -Headers @{ 'User-Agent' = $UA }; Write-Host "Saved: $Out" }
if ($Player -eq 'only') { Write-Output $resolved; return }

function Get-PlayerPath([string]$name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  $cands = @(
    "$env:ProgramFiles\VideoLAN\VLC\vlc.exe",
    "${env:ProgramFiles(x86)}\VideoLAN\VLC\vlc.exe",
    "$env:ProgramFiles\mpv\mpv.exe",
    "$env:LOCALAPPDATA\Programs\mpv\mpv.exe"
  )
  foreach ($p in $cands) { if ($p -and (Test-Path $p)) { return $p } }
  return $null
}

# auto: use a known player if one exists, otherwise hand the URL to the OS
if ($Player -eq 'auto') {
  foreach ($n in 'vlc', 'mpv', 'ffplay') {
    if (Get-PlayerPath $n) { $Player = $n; break }
  }
  if ($Player -eq 'auto') { $Player = 'default' }
}

Write-Host "Resolved: $id"
switch ($Player) {
  'vlc' { $exe = Get-PlayerPath 'vlc'; if ($exe) { & $exe $resolved } else { Write-Host 'vlc not found, opening in default app'; Start-Process $resolved } }
  'mpv' { $exe = Get-PlayerPath 'mpv'; if ($exe) { & $exe $resolved } else { Write-Host 'mpv not found, opening in default app'; Start-Process $resolved } }
  'ffplay' { $exe = Get-PlayerPath 'ffplay'; if ($exe) { & $exe -autoexit $resolved } else { Write-Host 'ffplay not found, opening in default app'; Start-Process $resolved } }
  'default' { Start-Process $resolved }
}