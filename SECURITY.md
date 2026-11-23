# Security policy

## Supported versions

Only the latest release on `main` is supported. AnimeDesk is pre-1.0 and Windows
only.

## Reporting a vulnerability

Open a private advisory on GitHub (Security → Advisories → *Report a
vulnerability*). If you cannot, open a normal issue **without** exploit details
and say a private report is coming.

Please include the version, the Windows build, reproduction steps and the impact
you believe it has. Do not include API keys, cookies or personal file paths you
would rather not publish.

There is no bounty and no guaranteed response time.

## Threat model

AnimeDesk is a single-user desktop app. The service listens on loopback only and
is not designed to be reachable from a network.

**In scope**

- Anything that lets a malicious *remote* page, stream host, artwork host or
  redirect make the local service fetch, read or write something it should not.
- Path traversal out of the library folder, out of `dist`, or out of the data
  directory.
- Token forgery or reuse that turns the proxy into an open fetcher.
- Command or argument injection into the mpv child process or the app-window
  launch.
- Persistence of attacker-controlled content into history, settings or skip data
  that later executes.

**Out of scope**

- Another process running as the same Windows user. It can already read the
  same files; loopback guards are not an authentication boundary.
- The remote source being wrong, slow, geo-blocked or gone.
- Rights questions about media. Those are in [docs/LICENSING.md](docs/LICENSING.md).
- A local attacker who can replace `server/` or `tools/mpv/mpv.exe` on disk.

## Controls that already exist

- Service binds `127.0.0.1` and checks `Host`, `Origin` and browser fetch
  metadata on API routes.
- Outbound requests go through a resolver that rejects non-public addresses on
  every DNS answer and every redirect hop, pins the connection, and applies a
  deadline and a body cap.
- Stream and artwork tokens are random, format-checked, capped in number and
  expire; upstream credentials are never forwarded to the browser.
- Local file serving resolves and re-checks the real path against the configured
  library root.
- Artwork bytes are signature-checked and size-capped before they are cached.
- mpv is spawned with an explicit argument vector, never a shell string.

## Not claimed

- No code signing. Windows SmartScreen will warn on the unsigned installer.
- No sandbox around mpv, and no sandbox beyond the browser's own for the UI.
- No supply-chain attestation. `package-lock.json` pins versions and integrity
  hashes, and that is all.