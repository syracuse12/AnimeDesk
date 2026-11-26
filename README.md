# AnimeDesk

A local-first Windows desktop for watching anime: search a title, pick an episode,
choose sub or dub, and it plays in the app window.

The UI is a local React page. The backend is a local Node service bound to
`127.0.0.1`. There is no account, no telemetry and no cloud component of our own.

> **Status: pre-1.0, Windows only.** The hianime integration is unofficial and
> can break when the source site changes. Read [Known limits](#known-limits) and
> [docs/PRIVACY.md](docs/PRIVACY.md) before you rely on it.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Build](#build)
- [Checks](#checks)
- [Providers](#providers)
- [How it works](#how-it-works)
- [Affiliation](#affiliation)
- [Known limits](#known-limits)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Licence](#licence)

---

## Features

- Search across enabled providers, view series detail and full episode lists.
- Browse rows from AniList (trending, top rated, this season, genres) and title
  suggestions from Kitsu in the search box. They are metadata only: a card
  searches the catalogue for its title, so the providers still decide what is
  playable.
- Sub/dub toggle, disabled and explained when a series has no dub listed.
- In-app player: seeking, volume, speed, fullscreen, subtitle and audio-track
  selection, keyboard shortcuts, and a one-click hand-off to mpv.
- Per-episode quality choice on the detail page, which overrides the saved
  setting for that play only.
- Intro/outro skipping from AniSkip, plus per-episode manual ranges when AniSkip
  has no data. Automatic skipping is off by default.
- Autoplay next episode on real end-of-stream, with a countdown you can cancel.
- Local watch history with resume, remove and clear.
- Dark UI; settings for audio, autoplay, quality, volume, skip behaviour and the
  local library folder.

## Requirements

- **Windows 10 or 11, 64-bit.** There is no macOS or Linux build.
- **Node.js 24 or newer.** The service runs TypeScript directly through Node's
  native type stripping, so no build step is needed for the server.
- **The Microsoft Edge WebView2 runtime.** The app runs in its own window; this
  ships with Windows 10 and 11 via Edge. If it is missing, the installer offers
  to download and install Microsoft's signed runtime automatically.
- Optional: **mpv**, only as a fallback player for codecs the browser cannot
  decode. `npm run setup:mpv` fetches a verified build into `tools\mpv`.

Nothing is installed system-wide. Application data goes to
`%APPDATA%\AnimeDesk`; the WebView2 profile goes to `%LOCALAPPDATA%\AnimeDesk`.

## Install and run

**To just use it:** download `AnimeDesk-Setup-<version>.exe` from
[Releases](https://github.com/syracuse12/AnimeDesk/releases) and run it. It
installs under your user account with no admin rights, adds a Desktop shortcut,
and uninstalls from Settings > Apps. The installer is unsigned, so SmartScreen
will say "Windows protected your PC" — choose **More info > Run anyway**. Compare
the file against the `SHA256SUMS.txt` on the release if you want to be sure.

**From source:**

```powershell
git clone https://github.com/syracuse12/AnimeDesk.git
cd AnimeDesk
npm ci
npm start
```

Or double-click `Start AnimeDesk.cmd`, which installs dependencies on first run
and then starts the app.

The launcher builds the UI if it is missing, starts the service on a free loopback
port, waits for readiness, and only then opens the app window. Closing that window
stops the service. `npm run dev` is the same thing with Vite hot reload.

## Build

```powershell
npm run build          # production UI bundle into dist\
```

For a self-contained per-user Windows installer, see [RELEASE.md](RELEASE.md).
The build script fetches the pinned Node runtime, verifies its published SHA-256,
and compiles the host and installer with the .NET Framework compiler.

## Checks

```powershell
npm run verify         # typecheck + unit tests + production build
npm run test:ui        # browser UI regression run against the built app
npm run test:qa        # autoplay, persistence, mpv fallback, screenshots
npm run test:live      # live network probe: proxy playback, AniSkip, mpv
```

`test:live` needs the network and opens a real mpv window, so it is kept out of
`npm test`. `test:ui` and `test:qa` need Edge or Chrome; set `ANIMEDESK_BROWSER`
to use another binary.

## Providers

| Provider | What it is | Notes |
| --- | --- | --- |
| `hianime` | Third-party streaming index | **Shipped in the installer.** Widest catalogue, real sub **and** dub streams. Scrapes the same endpoints ani-cli uses. Unofficial; can break. |
| `archive` | Internet Archive animation collection | Development builds only. Rights vary per item; subtitles only, no dub. |
| `local` | Your own video folder | **Shipped in the installer.** One series per sub-folder. Nothing leaves the machine. |

Dub availability is read per series from the provider, never assumed. When a dub
is missing, the toggle is disabled and playback falls back to sub.

Providers are deliberately small modules behind one interface; adding one does
not touch the player, the history store or the UI. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## How it works

```
UI (React) --HTTP--> local Node service --HTTP--> stream CDN
                        |              \--> JSON IPC --> bundled mpv (fallback)
                        +-- providers (search / detail / resolve)
                        +-- stream proxy (Referer + playlist rewrite)
                        +-- AniSkip lookup, validated against real duration
                        +-- settings + history JSON in %APPDATA%\AnimeDesk
```

- The CDN answers `403` without the embed page as `Referer`, and a browser
  `<video>` cannot set `Referer` across origins. So the service fetches upstream
  itself and re-serves playlists, segments and subtitles from `127.0.0.1`.
  hls.js only ever talks to the local service. This is a per-request proxy, not a
  hosted relay.
- Proxy and artwork tokens are opaque, validated, capped and short-lived, so the
  service is not an open fetcher.
- mpv is controlled over a named pipe. Autoplay fires on mpv's `end-file` with
  reason `eof` or on the browser's `ended` event — never on a timer.
- The UI is a mirror: the service pushes session state over server-sent events.

## Affiliation

AnimeDesk is an independent project. It is **not affiliated with, endorsed by, or
sponsored by** any anime studio, licensor, distributor or streaming service, and
it does not host video. The `hianime` integration is an unofficial client of a
third-party index that AnimeDesk does not control; it ships as part of the product
and can change or break independently of this repository. AniList and AniSkip are
third-party APIs used for metadata and skip times.

The **MIT licence** covers AnimeDesk's own source code only. Anime, artwork,
subtitles and stream URLs belong to their rights holders and are not licensed to
you by this repository. See [docs/LICENSING.md](docs/LICENSING.md).

## Known limits

- `hianime` is unofficial scraping. No uptime guarantee; a site redesign can
  break search or resolve until the parser is updated.
- In-app playback needs a source the browser can decode. HEVC or exotic audio
  falls back to mpv through the button on the error card.
- AniSkip needs a MyAnimeList id, matched through AniList by exact title. A
  differently named series gets no timestamps rather than wrong ones; manual
  ranges cover that case.
- Discovery rows come from AniList and suggestions from Kitsu, so both need the
  network. A card is a search shortcut, not a playable link.
- The local provider labels every file as sub+dub; it only knows filenames.
- No downloads or offline cache, no MAL/AniList sync, no cross-series queue.
- The quality setting is a preference, not a guarantee. An exact rendition is
  used when it exists; otherwise the highest rendition at or below it, and the
  lowest one if every rendition is larger. Any substitution is stated in the
  player rather than left to look like the preference was honoured.
- Loopback guards do not authenticate other processes running as the same user.
  AnimeDesk is not designed to be exposed on a network.

## Repository layout

```
server/          service: routes, providers, stream proxy, mpv IPC, sessions
src/             React UI (app shell, player, design system)
shared/          types and skip-timing rules used by both sides
tests/           unit tests, browser suites, live probe, fixtures
docs/            architecture, development, privacy, licensing scope
scripts/         launchers, build, packaging and mpv setup
installer/       .NET Framework host and per-user installer sources
tools/mpv/       project-local fallback player (binaries not committed)
```

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, provider interface |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, tests, conventions |
| [docs/PRIVACY.md](docs/PRIVACY.md) | What is stored, what leaves the machine |
| [docs/LICENSING.md](docs/LICENSING.md) | Software licence vs. third-party media rights |
| [SECURITY.md](SECURITY.md) | Threat model and reporting |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution rules |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) | Bundled dependencies and licences |
| [RELEASE.md](RELEASE.md) | Packaging and release checklist |

## Licence

AnimeDesk source code is released under the [MIT licence](LICENSE).

That licence covers **our code only**. Anime, artwork, subtitles and stream URLs
belong to their respective rights holders; the MIT licence grants you nothing
over them. See [docs/LICENSING.md](docs/LICENSING.md).