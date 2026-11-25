[CmdletBinding(PositionalBinding = $false)]
param(
    # Selected model. Aurora Qwen3 Coder is the default; Gen DeepSeek is the
    # explicit fallback (also available with -Fallback).
    [ValidateSet('aurora/qwen3-coder-480b-a35b-instruct-turbo', 'gen/deepseek-v4.1-flash-free')]
    [string] $Model = 'aurora/qwen3-coder-480b-a35b-instruct-turbo',

    # Shortcut for the Gen DeepSeek fallback model. One-shot `run` invocations
    # receive it as --model; for the interactive TUI use /models in-session.
    [switch] $Fallback,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]] $OpenCodeArgs
)

$ErrorActionPreference = 'Stop'

if ($Fallback) { $Model = 'gen/deepseek-v4.1-flash-free' }

$projectRoot = $PSScriptRoot
$credentialFile = 'C:\Users\thatj\Desktop\Northbridge Web\Automation\gen-llm-benchmark\.env.gen.local'

if (-not (Test-Path -LiteralPath $credentialFile -PathType Leaf)) {
    throw "The shared Gen credential file was not found at '$credentialFile'. AnimeDesk will not create or duplicate credentials; restore that file or update this launcher path."
}

$version = (& opencode --version | Select-Object -First 1)
if ($version -notmatch '^opencode v2\.') {
    throw "This launcher is verified for OpenCode v2.x; found '$version'. Review configuration before using another major version."
}

# Read the existing credential file without printing or copying its values.
# The same router endpoint and key serve both the `aurora` and `gen` providers;
# only the model identifier differs.
$values = @{}
foreach ($rawLine in Get-Content -LiteralPath $credentialFile) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith('#')) { continue }
    if ($line -notmatch '^([A-Z][A-Z0-9_]*)=(.*)$') {
        throw 'The existing Gen credential file contains an invalid entry.'
    }
    $value = $Matches[2].Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    $values[$Matches[1]] = $value
}

foreach ($required in 'GEN_LLM_BASE_URL', 'GEN_LLM_API_KEY', 'GEN_LLM_MODEL') {
    if (-not $values[$required]) { throw "Missing $required in the existing Gen credential file." }
}
if ($values.GEN_LLM_BASE_URL.TrimEnd('/') -ne 'https://llm-router.umbra.cx/v1') {
    throw 'The configured Gen endpoint is not the approved endpoint.'
}
if ($values.GEN_LLM_API_KEY -match '\s') {
    throw 'The existing Gen credential is malformed.'
}

$names = @('GEN_LLM_BASE_URL', 'GEN_LLM_API_KEY', 'GEN_LLM_MODEL')
$previous = @{}
foreach ($name in $names) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $values[$name], 'Process')
}

# Build the argument list. `run` accepts --model; the interactive interface is
# driven by opencode.jsonc, where Aurora Qwen3 Coder is the default.
$effectiveArgs = @()
if ($OpenCodeArgs.Count -gt 0 -and $OpenCodeArgs[0] -in 'service', 'serve') {
    throw 'Managed-service and web-server modes are disabled in this launcher so AnimeDesk cannot attach to the Northbridge background service.'
}

$runIndex = -1
for ($i = 0; $i -lt $OpenCodeArgs.Count; $i++) {
    if ($OpenCodeArgs[$i] -eq 'run') { $runIndex = $i; break }
    if (-not $OpenCodeArgs[$i].StartsWith('-')) { break }
}
if ($runIndex -ge 0) {
    $effectiveArgs += $OpenCodeArgs[0..$runIndex]
    $effectiveArgs += '--model', $Model
    if ($runIndex + 1 -lt $OpenCodeArgs.Count) {
        $effectiveArgs += $OpenCodeArgs[($runIndex + 1)..($OpenCodeArgs.Count - 1)]
    }
} else {
    $effectiveArgs = $OpenCodeArgs
}

$exitCode = 0
try {
    Push-Location -LiteralPath $projectRoot
    try {
        # --standalone gives AnimeDesk a private server rooted in this directory,
        # instead of reusing the shared background service.
        & opencode --standalone @effectiveArgs
        $exitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
}
finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
}

exit $exitCode
