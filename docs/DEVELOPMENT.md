# Development

## Prerequisites

- Windows 10/11 x64
- Node.js 24 or newer (native TypeScript execution; there is no server build step)
- Edge or Chrome for the browser test suites; the app itself needs the WebView2 runtime, which ships with Edge
- Optional: `npm run setup:mpv` for the fallback player

```powershell
npm ci
npm run dev
```

`npm run dev` starts the service on port 47821 and Vite on 5173 with HMR, then
opens an app window. Both stay on loopback.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | HMR UI + service |
| `npm run build` | Production UI bundle into `dist\` |
| `npm start` | Production launcher: build if needed, run, open window |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (`node --test`) |
| `npm run verify` | typecheck + unit tests + build |
| `npm run test:ui` | Browser regression run against the built app |
| `npm run test:qa` | Autoplay, persistence, mpv fallback, screenshots |
| `npm run test:live` | Live network probe (needs network, opens mpv) |

## Test layout

| File group | Kind | Needs |
| --- | --- | --- |
| `tests/*.test.ts` | Unit, fixtures only | Node |
| `tests/ui.mjs`, `screens.mjs`, `layout.mjs` | Browser over CDP | Edge/Chrome, `dist` |
| `tests/autoplay.mjs`, `persistence.mjs`, `continue-watching.mjs` | Browser + real service | Edge/Chrome, fixtures |
| `tests/mpv-fallback.mjs` | Real mpv | mpv, Edge/Chrome |
| `tests/live.mjs` | Real network + mpv | network, mpv |

`tests/setup-library.mjs <dir>` builds a throwaway library from the fixtures. The
browser suites use it so they exercise the real provider, not a stub.

## Conventions

- TypeScript everywhere; `.ts`/`.tsx` only, no `.js` in `src/`, `server/` or
  `shared/`.
- Strict types. No `any` unless a boundary genuinely has none.
- Server modules do one thing and export functions; no classes except where state
  is unavoidable.
- Keep provider specifics inside the provider module. If the player has to know a
  source's quirks, the interface is wrong.
- Validate every inbound value: query strings, JSON bodies, path segments, tokens.
- Bound every outbound call: deadline, redirect cap, body cap, public-address check.
- Comments explain *why*, not *what*. A comment that restates the code is noise.

## Adding a provider

1. Create `server/providers/<id>.ts` exporting the interface from
   `server/providers/types.ts`.
2. Register it in `server/providers/index.ts`, gated by profile if it needs the
   network.
3. Add it to the provider table in the README and to
   [LICENSING.md](LICENSING.md) if it brings new rights questions.
4. Add a fixture-backed parse test and a security test for any new URL shape.
5. Do not assume dub availability; read it per series.

## Debugging

- Service output is plain stdout; it names the port it bound.
- `ANIMEDESK_PORT` pins the port. `ANIMEDESK_DATA_DIR` moves the data directory,
  which is how the tests stay isolated from your real history.
- `ANIMEDESK_PROFILE=distribution` reproduces the shipped provider set.
- mpv IPC is a named pipe; `--msg-level=all=v` on a manual run is the fastest way
  to see why a hand-off fails.

## Before you open a pull request

Run `npm run verify` at minimum. If you touched the player, the proxy, the store or
any provider, run the browser and QA suites too and say what you ran in the PR
template. See [CONTRIBUTING.md](../CONTRIBUTING.md).