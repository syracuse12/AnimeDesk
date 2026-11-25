# Privacy

AnimeDesk is local-first by construction. There is no account, no analytics, no
crash reporting and no server of ours in the path.

## What stays on your machine

| Data | Location | Format |
| --- | --- | --- |
| Settings | `%APPDATA%\AnimeDesk\settings.json` | JSON |
| Watch history and resume points | `%APPDATA%\AnimeDesk\history.json` | JSON |
| Manual skip ranges | `%APPDATA%\AnimeDesk\skips.json` | JSON |
| Resolved MAL ids | `%APPDATA%\AnimeDesk\mal.json` | JSON |
| WebView2 profile, cache, cookies for the app window | `%LOCALAPPDATA%\AnimeDesk\distribution-window` | Chromium profile |
| Scratch downloads and probe output | `%APPDATA%\AnimeDesk\tmp` | mixed |

The `distribution` build keeps its data in a `distribution` subfolder so it never
mixes with a development run.

Nothing above is uploaded anywhere. Deleting the folders removes every trace,
and the installer's uninstaller does exactly that.

## What leaves the machine, and to whom

Only requests needed to fulfil what you asked for:

| Destination | When | What it sees |
| --- | --- | --- |
| The selected provider's hosts | Search, detail, resolve | Your search text, the series/episode you opened, your IP |
| Stream CDN | Playback | Segment requests proxied through your machine, your IP |
| `graphql.anilist.co` | Title matching for skip data | The series title |
| `api.aniskip.com` | Skip lookup | The MyAnimeList id and episode number |

No third-party scripts, fonts, tag managers or beacons are loaded by the UI. All
assets are bundled locally.

## What the remote parties can infer

The same things any browser visit would tell them: your IP address, a user agent,
and which title and episode you are watching. AnimeDesk adds no identifiers of its
own to outbound requests, and forwards no credentials to the browser.

## The one caveat: cookies

AnimeDesk does not ship cookies or session tokens. Where a provider needs one, it
is obtained at runtime and kept in memory or in the local browser profile for that
run. If a source starts requiring an account, the requests still come from your
machine and your IP, so the source sees your session, not a shared one.

## What is deliberately not collected

- No install id, machine id or UUID.
- No usage counters, feature flags or A/B assignment.
- No error reports leaving the machine; failures go to stdout only.
- No telemetry on which provider or episode you chose.

## Data you supply

A local library path is stored in settings. It is a plain path; it is not scanned
for anything except the file listing you asked for, and no filename leaves the
machine.

## Local exposure

The service listens on `127.0.0.1` on a port chosen at launch. It is reachable by
anything else running as the same Windows user, and by nothing off the machine
unless you forward the port yourself. It is not designed as a network service.

## Removing your data

```powershell
Remove-Item -Recurse "$env:APPDATA\AnimeDesk"
Remove-Item -Recurse "$env:LOCALAPPDATA\AnimeDesk"
```

With the installer, use the uninstaller instead; it removes both.

## Privacy of the repository itself

The published repository contains no API keys, cookies, personal paths or
captured account data. See the audit summary in [RELEASE.md](../RELEASE.md).