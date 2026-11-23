# Architecture

AnimeDesk is three cooperating local pieces plus a provider layer. Everything runs
on one machine and talks over loopback.

```
+---------------------+   HTTP (loopback)   +----------------------+
|  UI  (React 18)     |-------------------->|  Local Node service  |
|  src/               |<--------------------|  server/             |
+---------------------+   SSE session state +----------------------+
                                                 |   |   |
                    +----------------------------+   |   +------------------+
                    v                                v                      v
             providers (search/detail/resolve)   stream proxy        mpv (JSON IPC)
                    |                                |                      |
                    v                                v                      v
             remote sources                  upstream CDN            named pipe
```

## Why the proxy exists

The stream CDN rejects requests without the embed page as `Referer`, and a browser
`<video>` element cannot set `Referer` for a cross-origin request. The service
therefore fetches upstream itself and re-serves the playlist, every segment and
the subtitle track from `127.0.0.1`. hls.js only ever talks to the local service.

This is a **request proxy**, not a relay: bytes pass through, they are not
buffered whole and nothing is re-hosted publicly.

Proxy rules:

- One opaque token per upstream URL, HMAC-derived, format-checked, with a cap on
  live tokens and both an absolute lifetime and an idle timeout.
- Only `http`/`https` upstreams, resolved through the guarded resolver.
- Playlist bodies are rewritten to local token URLs; relative URIs resolve against
  the final URL after redirects.
- Local-file tokens resolve and re-check the real path against the library root on
  every request.

## Provider interface

`server/providers/types.ts` is the contract. A provider supplies search, detail and
resolve, declares its id and label, and declares per-series dub capability. It
never touches the UI, the store or the player.

| Provider | Transport | Notes |
| --- | --- | --- |
| `hianime` | HTML/embed scraping | Unofficial; parse failures degrade to empty results |
| `archive` | Internet Archive metadata API | Subtitle-only; rights vary per item |
| `local` | Filesystem | One directory per series; no network |

The provider registry (`server/providers/index.ts`) decides what is enabled. The
`distribution` profile registers `local` only.

## Layers

| Layer | Path | Responsibility |
| --- | --- | --- |
| UI shell | `src/App.tsx` | Search, detail, history, settings screens |
| Player | `src/components/Player.tsx` | hls.js, controls, skip overlay, autoplay |
| API client | `src/api.ts` | Typed calls to the local service |
| HTTP server | `server/main.ts` | Routing, host/origin guards, SSE |
| Outbound | `server/http.ts` | Public-address policy, redirect deadline, body caps |
| Proxy | `server/proxy.ts` | Token minting, playlist rewrite, byte streaming |
| Artwork | `server/artwork.ts` | Tokenised, signature-checked image cache |
| Sessions | `server/playback/sessions.ts` | Play state, progress, autoplay hand-off |
| mpv | `server/player/mpv.ts` | Process spawn, named-pipe JSON IPC, event stream |
| Store | `server/store.ts` | Atomic JSON persistence for settings/history/skips |
| Shared | `shared/` | Types, selection rules, session merge, skip timing |

`shared/` is imported by both sides, so its rules are unit-tested directly
instead of being duplicated in the UI and the service.

## Data flow for one episode

1. UI posts to `/api/play` with provider, series id, episode and audio track.
2. The provider resolves a stream URL (and subtitle URL, if any).
3. The service mints proxy tokens and creates a session.
4. UI opens the local playlist URL through hls.js, or asks for an mpv hand-off.
5. Progress is posted on a debounce and on pause/seek; history is written
   atomically.
6. End of stream is detected from mpv `end-file`/`eof` or the browser `ended`
   event. Autoplay schedules the next episode from that signal, never a timer.

## Persistence

Plain JSON under `%APPDATA%\AnimeDesk`: `settings.json`, `history.json`,
`skips.json`, `mal.json`. Writes are atomic (temp file then rename) and bounded
(500 history entries, 2000 skip ranges). A failed write emits an event so the UI
can say so instead of pretending it saved.

## Packaging

`installer/` holds a .NET Framework host and a per-user installer. The host starts
the bundled runtime on a random loopback port, waits for readiness, opens the
window, and stops the service when the window closes. `scripts/build-release.ps1`
assembles and verifies the payload. See [RELEASE.md](../RELEASE.md).

## Deliberate non-goals

- No server-rendered or publicly hosted deployment.
- No database; JSON is enough at this size and is greppable.
- No framework beyond React, no state library, no CSS framework.
- No Electron or Tauri: both add a second runtime or a toolchain for a window we
  already get from the browser's `--app` mode.