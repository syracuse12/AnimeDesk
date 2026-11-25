# AnimeDesk

A private, ad-free Windows anime desk. Search a title, pick an episode, choose
sub or dub, and it plays in a bundled mpv window. Nothing is uploaded, there is
no account, no telemetry and no cloud service: the UI is a local React page and
the backend is a local Node service on `127.0.0.1`.

> **Version 0.1.0 - first working build.** Streaming relies on a third-party
> index that can change without notice; the Internet Archive and local-library
> providers are the fallbacks that do not.

## What it does

- Search across providers, view series detail and full episode lists.
- Sub/dub toggle, disabled and explained when a series has no dub listed.
- Plays HLS and progressive files through bundled mpv, with subtitles attached.
- Autoplay next episode on **real end-of-file**, with a countdown you can skip.
- Local watch history with resume, remove and clear.
- Dark UI, settings for audio, autoplay, quality, volume and library folder.

## Requirements

- Windows 10/11, Node.js 24 or newer (uses native TypeScript execution).
- WebView2 is not needed; the window is an Edge/Chrome `--app` window.
- `tools\mpv\mpv.exe` is already in the repo. If missing: `npm run setup:mpv`.

No global installs. Everything stays inside this folder and `%APPDATA%\AnimeDesk`.

## Run it

Double-click **`Start AnimeDesk.cmd`**, or:

```
npm install
npm start
```

The launcher builds the UI if needed, starts the service on port 47821 and opens
a dedicated app window. For UI work with hot reload use `npm run dev` instead
(Vite on 5173, same API).

## Checks

```
npm run verify      # typecheck + unit tests + production build
node tests/live.mjs # live probe: search, resolve, real mpv playback, seek, autoplay
```

`tests/live.mjs` needs the network and spawns real mpv windows; it is kept out of
`npm test` for that reason.

## Providers

| Provider | What it is | Notes |
| --- | --- | --- |
| `hianime` | Third-party streaming index | Best catalogue, real sub **and** dub streams. Scrapes the same endpoints ani-cli uses. Can break. |
| `archive` | Internet Archive animation collection | Public domain, legally safe, subtitle-only, no dub. |
| `local` | Your own video folder | One series per sub-folder. Nothing leaves the machine. |

Dub availability is read per series from the provider, never assumed. If a dub
is missing the toggle is disabled and says so, and playback falls back to sub.

## How it works

```
UI (React) --HTTP--> local Node service --JSON IPC--> bundled mpv
                        |
                        +-- providers (search / detail / resolve)
                        +-- settings + history JSON in %APPDATA%\AnimeDesk
```

- mpv is controlled over a named pipe, not screen-scraping. Autoplay fires on
  mpv's `end-file` event with reason `eof`, so it cannot run early on a timer.
- The UI is a mirror: the service pushes session state over server-sent events.
- Tauri was skipped because no Rust toolchain or .NET SDK is installed here;
  Node + React + mpv needs nothing extra and is fully local.

## Known limits

- `hianime` is unofficial scraping: no guarantee on uptime, and a site redesign
  can break search or resolve until the parser is updated.
- The local provider labels every file sub+dub; it only knows filenames.
- No downloads/offline cache, no MAL/AniList sync, no multi-language subtitles
  beyond what the source returns, no queueing across series.
- Quality setting prefers the matching HLS variant; it is a preference, not a
  guarantee.
- Windows only.

## Layout

```
server/          service: routes, providers, mpv IPC, playback sessions
src/             React UI
shared/types.ts  types used by both sides
tests/           unit tests + live probe + captured fixtures
tools/mpv/       bundled player
```

## Next milestone

Provider-independent reliability: a resolve retry/fallback across mirrors, a
better provider for dubs, and a small queue so a whole season can run
unattended.

---

# OpenCode workspace

Independent OpenCode workspace for the AnimeDesk project.

## Start

Double-click **`Start AnimeDesk OpenCode.cmd`**, or run:

```
Start AnimeDesk OpenCode.cmd
```

The launcher always:

- changes into `C:\Users\thatj\Desktop\AnimeDesk`;
- reuses the installed OpenCode executable (`opencode v2.x`);
- loads the router endpoint and key from the existing shared credential file into the process only;
- verifies the endpoint is `https://llm-router.umbra.cx/v1` and that the key is well formed;
- starts OpenCode with `--standalone`, so it never attaches to the shared background service or the Northbridge workspace;
- restores/clears those environment variables when OpenCode exits;
- blocks `service` and `serve` modes so AnimeDesk cannot attach to the Northbridge service.

## Models

| Role | Model ID |
| --- | --- |
| Default | `aurora/qwen3-coder-480b-a35b-instruct-turbo` |
| Fallback | `gen/deepseek-v4.1-flash-free` |

Both providers use the same OpenAI-compatible router endpoint and the same
existing key; only the model identifier differs.

Select the fallback explicitly for a one-shot run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Invoke-AnimeDeskOpenCode.ps1 -Fallback run "your prompt"
```

Or select either model for a one-shot run:

```powershell
.\Invoke-AnimeDeskOpenCode.ps1 -Model gen/deepseek-v4.1-flash-free run "your prompt"
.\Invoke-AnimeDeskOpenCode.ps1 -Model aurora/qwen3-coder-480b-a35b-instruct-turbo run "your prompt"
```

In the interactive interface the opening model comes from `opencode.jsonc`
(Aurora Qwen3 Coder). Switch to the Gen fallback in-session with `/models`;
both providers are enabled by the `policies` block.

## How the providers are configured

`opencode.jsonc` defines two providers with the same package and endpoint:

- `aurora` - `modelID: aurora/qwen3-coder-480b-a35b-instruct-turbo`
- `gen` - `modelID: deepseek-v4.1-flash-free`

Both use:

- `baseURL: {env:GEN_LLM_BASE_URL}`
- `env: ["GEN_LLM_API_KEY"]`

OpenCode resolves `{env:...}` at load time. If the launcher has not set
`GEN_LLM_BASE_URL` in the process, the provider has no endpoint and fails with:

```
Route.model(openai-compatible-chat) requires an endpoint baseURL
```

That is why the config file alone is not enough and the launcher must be used.

## Credentials

No API key is stored, copied or printed in this folder. The launcher reads the
existing local credential file:

```
C:\Users\thatj\Desktop\Northbridge Web\Automation\gen-llm-benchmark\.env.gen.local
```

It is read-only reuse. If that file is moved or deleted, AnimeDesk stops with an
explanation instead of creating a replacement key. No file in that folder is
modified, and no key is written to disk or logged.

`GEN_LLM_MODEL` is still read and passed through for compatibility, but it no
longer pins the default model; model choice lives in `opencode.jsonc` and the
launcher's validated `-Model` / `-Fallback` options.

## Verify connectivity

Non-interactive, one model turn, routed through the launcher:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Test-AnimeDeskConnection.ps1
```

Use `-Model gen/deepseek-v4.1-flash-free` to check the fallback instead.

## Aurora Qwen3 Coder migration - tested 23 November 2026 (adopted)

The earlier attempt to use `aurora/deepseek-v4-1-flash-uncensored` failed with
`model_forbidden` (admin-only model). `aurora/qwen3-coder-480b-a35b-instruct-turbo`
is available to this key and was adopted after real agent testing.

Evidence from the adopted configuration:

| Check | Result |
| --- | --- |
| `opencode models` with the shared credential | Lists `aurora/qwen3-coder-480b-a35b-instruct-turbo` and `gen/deepseek-v4.1-flash-free` |
| One-shot run through `Invoke-AnimeDeskOpenCode.ps1` | Reply `ANIMEDESK READY`; exit 0 |
| Real agent task through the launcher (`run --auto`) | Read `.tmp/aurora-agent-test/seed.txt`, created `notes.txt`, edited it to two lines, ran a harmless `powershell -NoProfile -Command "Write-Output ANIMEDESK_CMD_OK"`; exit 0 |
| Session record (`opencode session export --sanitize`) | Session model `providerID: aurora`, `id: qwen3-coder-480b-a35b-instruct-turbo`; every assistant message used the same model; `outcome: succeeded`; tool parts `read`, `write`, `edit`, `shell` all `completed`; `finish: tool-calls` |
| Tool reliability (`opencode stats --tools`) | 0% error rate across the recorded write/read/edit/shell calls |
| Fallback run (`-Fallback`) | Reply `FALLBACK READY` on `deepseek-v4.1-flash-free`; exit 0 |
| Isolation checks | Private server (`--standalone`), session directory AnimeDesk, `service status` refused by the launcher |

No fallback substitution occurred during the Aurora test: the recorded session
model stayed `aurora/qwen3-coder-480b-a35b-instruct-turbo` for all turns.

## Rollback

The previous working Gen-only configuration is preserved verbatim in:

```
backup\2026-11-23-gen-deepseek\
```

It contains `opencode.jsonc`, `Invoke-AnimeDeskOpenCode.ps1`,
`Test-AnimeDeskConnection.ps1`, `README.md` and `AGENTS.md`. To roll back, copy
those files back over the workspace copies. Alternatively, keep the current
files and only change `"model"` in `opencode.jsonc` to
`gen/deepseek-v4.1-flash-free`.

## Notes

- Requires OpenCode v2.x installed and on `PATH`.
- `service` and `serve` subcommands are blocked by the launcher to keep the
  workspace isolated.
- The interactive TUI has no `--model` flag; `-Model`/`-Fallback` apply to
  `run` invocations, and the TUI opens on the `opencode.jsonc` default.
- AnimeDesk intentionally does not touch Northbridge files or global settings.