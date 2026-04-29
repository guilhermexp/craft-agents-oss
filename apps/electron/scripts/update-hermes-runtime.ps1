# Update the dev/local bundled Hermes runtime for Craft.
# This is intentionally disabled for packaged apps by the RPC handler.

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent (Split-Path -Parent $ElectronDir)

$DefaultHermesSrc = Join-Path $RepoRoot "..\hermes-agent"
$AltHermesSrc = Join-Path $ElectronDir "..\..\..\hermes-agent"
if (!(Test-Path $DefaultHermesSrc) -and (Test-Path $AltHermesSrc)) {
  $DefaultHermesSrc = (Resolve-Path $AltHermesSrc).Path
}
$HermesSrc = if ($env:HERMES_SRC) { $env:HERMES_SRC } elseif ($env:HERMES_SOURCE_DIR) { $env:HERMES_SOURCE_DIR } else { $DefaultHermesSrc }
$BundleScript = Join-Path $ScriptDir "bundle-hermes.ps1"

if (!(Test-Path $BundleScript)) {
  throw "bundle-hermes.ps1 not found at $BundleScript"
}
if (!(Test-Path $HermesSrc)) {
  throw "Hermes source not found at $HermesSrc. Set HERMES_SRC and retry."
}
if (!(Test-Path (Join-Path $HermesSrc "pyproject.toml"))) {
  throw "pyproject.toml missing in Hermes source: $HermesSrc"
}

Write-Host "Hermes source: $HermesSrc"
try {
  git -C $HermesSrc rev-parse --is-inside-work-tree | Out-Null
  $before = git -C $HermesSrc rev-parse --short HEAD
  Write-Host "Hermes commit before: $before"
  if ($env:HERMES_SKIP_PULL -ne "1") {
    git -C $HermesSrc pull --ff-only
  } else {
    Write-Host "Skipping git pull because HERMES_SKIP_PULL=1"
  }
  $after = git -C $HermesSrc rev-parse --short HEAD
  Write-Host "Hermes commit after: $after"
} catch {
  Write-Host "Hermes source is not a git checkout; bundling current files."
}

$env:HERMES_SRC = $HermesSrc
& $BundleScript

$Adapter = Join-Path $ElectronDir "resources\vendor\hermes\hermes-agent\acp_adapter\server.py"
$Python = Join-Path $ElectronDir "resources\vendor\hermes\hermes-venv\Scripts\python.exe"
if ((Test-Path $Adapter) -and (Test-Path $Python)) {
  & $Python -m py_compile $Adapter
  Write-Host "ACP adapter validated: $Adapter"
}

Write-Host "Hermes runtime updated. Restart Craft to use the new bundled runtime."
