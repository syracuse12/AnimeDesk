[CmdletBinding()]
param(
    [ValidateSet('aurora/qwen3-coder-480b-a35b-instruct-turbo', 'gen/deepseek-v4.1-flash-free')]
    [string] $Model = 'aurora/qwen3-coder-480b-a35b-instruct-turbo',

    [string] $Prompt = 'Reply with exactly: ANIMEDESK READY'
)

$ErrorActionPreference = 'Stop'

# One-shot model call routed through the real launcher, so the same credential
# loading, endpoint validation, --standalone isolation and model selection apply.
$launcher = Join-Path $PSScriptRoot 'Invoke-AnimeDeskOpenCode.ps1'

& $launcher -Model $Model run $Prompt
$code = $LASTEXITCODE

if ($code -ne 0) { throw "Connectivity test failed with exit code $code (model $Model)." }
Write-Output ''
Write-Output "Connectivity test passed with $Model (exit code 0)."
