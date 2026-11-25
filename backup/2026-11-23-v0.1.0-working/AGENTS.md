# AnimeDesk agent instructions

## Scope

- This workspace is for the AnimeDesk project only.
- Work only inside `C:\Users\thatj\Desktop\AnimeDesk`.
- Never modify, move or delete anything under `C:\Users\thatj\Desktop\Northbridge Web`.
- Do not change global OpenCode settings, global environment variables or the
  shared background service.

## Running OpenCode

- Use `Start AnimeDesk OpenCode.cmd` (or `Invoke-AnimeDeskOpenCode.ps1`).
- The launcher sets the router endpoint/key for the process and starts with
  `--standalone`; do not bypass it by wiring a different provider.
- Do not run `opencode service` or `opencode serve` from this workspace.

## Model and credentials

- Default model: `aurora/qwen3-coder-480b-a35b-instruct-turbo`.
- Fallback model: `gen/deepseek-v4.1-flash-free`. Select it with
  `Invoke-AnimeDeskOpenCode.ps1 -Fallback run "<prompt>"`, with
  `-Model gen/deepseek-v4.1-flash-free`, or with `/models` in the TUI.
- Credentials live only in the shared Northbridge credential file referenced by
  the launcher. Never copy, echo, log or commit API keys, and never modify that
  file or anything else under `C:\Users\thatj\Desktop\Northbridge Web`.
- Do not add a `.env` file containing the key to this folder.
- The previous Gen-only configuration is preserved in
  `backup\2026-11-23-gen-deepseek\` as the rollback option.

## Change discipline

- Keep changes small, verify them, and record what was verified.
- Ask before adding dependencies, spending money, or making external
  commitments.
- This workspace currently contains no anime application code; do not start
  building the product without an explicit instruction.
