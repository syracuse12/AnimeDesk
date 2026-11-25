<#
  boundhub-playlist.ps1 - list / play the private videos your account can watch.

  Reads the harvested pair file (hash + v-acctoken per video, which are
  permanent) and resolves them to fresh CDN URLs on demand. Do NOT cache the
  resolved CDN URLs - their keys expire in ~5 minutes.

  Usage:
    .\boundhub-playlist.ps1                 # numbered list
    .\boundhub-playlist.ps1 -Play 3         # play item 3
    .\boundhub-playlist.ps1 -Resolve 3      # print item 3's CDN URL
    .\boundhub-playlist.ps1 -All            # resolve everything (slow)

  Rebuild the pair file with harv2.cjs after new friend requests are accepted.
#>
[CmdletBinding()]
param(
  [string]$Pairs = (Join-Path $env:TEMP 'ftok.txt'),
  [int]$Play = 0,
  [int]$Resolve = 0,
  [switch]$All,
  [ValidateSet('vlc', 'mpv', 'ffplay')][string]$Player = 'vlc'
)

$ErrorActionPreference = 'Stop'
$UA = 'VLC/3.0.20 LibVLC/3.0.20'

if (-not (Test-Path $Pairs)) { throw "No pair file at $Pairs - run harv2.cjs first." }

$items = @()
foreach ($line in Get-Content $Pairs) {
  $f = $line.Trim().Split('|')
  if ($f.Count -lt 6) { continue }
  $items += [pscustomobject]@{ Id = $f[0]; Uploader = $f[1]; Server = $f[2]; Hash = $f[3]; Path = $f[4]; Token = $f[5] }
}

if (-not $items.Count) { throw "Pair file $Pairs is empty." }

function Resolve-Item($it) {
  $u = "https://www.boundhub.com/get_file/$($it.Server)/$($it.Hash)/$($it.Path)/?v-acctoken=$($it.Token)"
  for ($i = 1; $i -le 3; $i++) {
    $loc = (& curl.exe -4 -s -o NUL -w '%{redirect_url}' --max-time 20 -A $UA $u 2>$null)
    if ($loc -and $loc -match 'cdn\.bdsmactually') { return $loc }
    Start-Sleep -Milliseconds 900
  }
  return $null
}

function Show-List {
  $n = 0
  foreach ($it in $items) {
    $n++
    Write-Host ('{0,3}  {1}  (uploader {2})' -f $n, $it.Id, $it.Uploader)
  }
  Write-Host ("`n{0} videos. Use -Play <n> or -Resolve <n>." -f $items.Count)
}

if ($Play -gt 0 -or $Resolve -gt 0) {
  $idx = if ($Play -gt 0) { $Play } else { $Resolve }
  if ($idx -lt 1 -or $idx -gt $items.Count) { throw "Index out of range (1..$($items.Count))." }
  $it = $items[$idx - 1]
  $url = Resolve-Item $it
  if (-not $url) { throw "Could not resolve $($it.Id)." }
  if ($Resolve -gt 0) { Write-Output $url; return }
  switch ($Player) {
    'vlc' { if (Test-Path 'C:\Program Files\VideoLAN\VLC\vlc.exe') { & 'C:\Program Files\VideoLAN\VLC\vlc.exe' $url } else { & vlc $url } }
    'mpv' { & mpv $url }
    'ffplay' { & ffplay -autoexit $url }
  }
  return
}

if ($All) {
  $ok = 0; $bad = 0
  foreach ($it in $items) {
    $url = Resolve-Item $it
    if ($url) { $ok++; Write-Output ("$($it.Id)`t$url") } else { $bad++; Write-Output ("$($it.Id)`tFAILED") }
  }
  Write-Host "`nresolved=$ok failed=$bad"
  return
}

Show-List