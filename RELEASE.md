# Release

How AnimeDesk is packaged, and what must be true before a build is handed out.

## Packaging choice

The release keeps the Node service, the Vite-built React UI, hls.js, and a
dedicated WebView2 window. A small .NET Framework host starts the bundled Node
runtime on a random loopback port, waits for readiness, opens the window, and
asks the service to stop when the window closes. A per-user installer places the
curated payload under `%LOCALAPPDATA%\Programs\AnimeDesk`, creates Desktop and
Start Menu shortcuts, and registers an uninstaller under HKCU. No administrator
rights are needed. The package targets 64-bit Windows 10 or later and treats the
Microsoft Edge WebView2 runtime as a checked prerequisite.

Electron would add a second Chromium runtime plus a larger packaging and licensing
surface. Tauri would need a Rust migration. WebView2 reuses the Chromium already
on the machine, so the host stays small and the playback path is unchanged.

## Build

On the build machine:

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-release.ps1
```

The script runs `npm run verify`, downloads the official Node 24.18.0 Windows x64
zip, checks its published SHA-256, copies only the runtime, built UI, server,
shared code, host and notices, then compiles the installer with the Windows .NET
Framework compiler.

Outputs land only under `.release\`, which is git-ignored. Binaries are therefore
**not** in source history; a release attaches them as artifacts or GitHub Release
assets.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\smoke-release.ps1
```

installs under the current user, exercises the bundled service and local media,
checks history across a restart, and uninstalls. It refuses to overwrite an
existing release install.

`payload-manifest.json` records every packaged file and its SHA-256. Verify the
installer's checksum before publishing it.

## Distribution profile

The installed host forces `ANIMEDESK_PROFILE=distribution`. Data goes to
`%APPDATA%\AnimeDesk\distribution`; the WebView2 profile goes to
`%LOCALAPPDATA%\AnimeDesk\distribution-window`. The development build and its
data stay separate. The uninstaller removes the release's data and profile as well
as binaries, shortcuts and the registry entry.

The profile ships the `hianime` catalogue and the local library. `archive` stays
development-only because its per-item rights are unresolved. AniList discovery and
suggestions, AniSkip, remote stream proxying and remote artwork all work in this
profile now. The mpv fallback remains absent because no mpv binary is bundled, so
browser codec support decides what plays. Local files must be ones the user is
authorised to play.

## Pre-release checklist

- [ ] `npm run verify`, `npm run test:ui`, `npm run test:qa` all pass
- [ ] `npm audit --omit=dev` clean
- [ ] No secret, personal path or captured profile data in `git ls-files`
- [ ] Clean Windows 10 VM: install, launch, play, close, reopen, uninstall, with
      no separately installed Node
- [ ] .NET Framework 4.x confirmed present on a clean install, or documented as a
      prerequisite
- [ ] Notices match the actual payload byte for byte
- [ ] Installer checksum recorded next to the artifact
- [ ] Defender/SmartScreen behaviour observed and noted (the installer is
      unsigned)

## Known gaps

- No code signing, so SmartScreen warns.
- .NET Framework 4.x availability is unverified on a clean Windows 10 image.
- mpv and FFmpeg are not in the payload; adding them needs the licence and source
  work described in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Rights for `hianime` playback are not established for recipients; the release
  should only claim sources each user may access.

## Repository audit trail

The publication snapshot was prepared from a private development checkout and
committed with a fresh history. What was inspected, excluded and remediated is in
[docs/PUBLICATION-AUDIT.md](docs/PUBLICATION-AUDIT.md), together with the
file manifest of the snapshot.