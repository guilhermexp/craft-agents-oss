# Update the dev/local bundled Hermes runtime for Craft.
# This is intentionally disabled for packaged apps by the RPC handler.
#
# SDK-style update: Hermes upstream is treated as a pinned dependency. This
# script mirrors update-hermes-runtime.sh for Windows:
#   1. Resolve HERMES_VERSION or apps/electron/scripts/hermes-version.txt.
#   2. Optionally persist the pin when HERMES_PERSIST_PIN=1.
#   3. Delegate to bundle-hermes.ps1, which clones/fetches NousResearch
#      upstream into .hermes-cache/source and applies Craft overlay patches.
#
# The user's sibling/fork checkout is never used unless HERMES_SRC is set.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$BundleScript = Join-Path $ScriptDir "bundle-hermes.ps1"
$PinFile = Join-Path $ScriptDir "hermes-version.txt"

if (!(Test-Path $BundleScript)) {
  throw "bundle-hermes.ps1 not found at $BundleScript"
}

if ($env:HERMES_VERSION) {
  $RunPin = $env:HERMES_VERSION
} elseif (Test-Path $PinFile) {
  $RunPin = (Get-Content $PinFile | Where-Object { $_.Trim() -and -not $_.Trim().StartsWith('#') } | Select-Object -First 1)
} else {
  $RunPin = "upstream/main"
}

Write-Host "Hermes update — pin: $RunPin"

if ($env:HERMES_PERSIST_PIN -eq "1" -and $env:HERMES_VERSION) {
  @(
    "# Hermes upstream pin. One line, no quotes. Can be a tag, branch, or commit SHA.",
    "# Bundle/update scripts read this. Click-Update bumps it via HERMES_VERSION env.",
    $env:HERMES_VERSION
  ) | Set-Content -Path $PinFile
  Write-Host "Persisted pin to $PinFile"
}

$env:HERMES_VERSION = $RunPin
& $BundleScript

$Adapter = Join-Path $ElectronDir "resources\vendor\hermes\hermes-agent\acp_adapter\server.py"
$Python = Join-Path $ElectronDir "resources\vendor\hermes\hermes-venv\Scripts\python.exe"
if ((Test-Path $Adapter) -and (Test-Path $Python)) {
  & $Python -m py_compile $Adapter
  Write-Host "ACP adapter validated: $Adapter"
}

Write-Host "Hermes runtime updated. Restart Craft to use the new bundled runtime."
