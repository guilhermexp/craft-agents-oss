# ===========================================================================
# Hermes Agent — pre-build bundling script (Windows)
#
# Builds a self-contained Hermes runtime under
# apps/electron/resources/vendor/hermes/ with:
#   - Python (relocatable, via uv)
#   - hermes-venv with Hermes deps installed
#   - hermes-agent source
#   - ripgrep
#
# Usage (from apps/electron):
#   pwsh scripts/bundle-hermes.ps1
#
# Env vars:
#   $env:HERMES_SRC          path to Hermes source clone (default: ../../hermes-agent)
#   $env:HERMES_PYTHON_VER   default 3.13
#   $env:HERMES_RG_VERSION   default 14.1.1
# ===========================================================================

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ElectronDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot    = Resolve-Path (Join-Path $ElectronDir "../..")

$HermesSrc = if ($env:HERMES_SRC) { $env:HERMES_SRC } else { Join-Path $RepoRoot "../hermes-agent" }
$PythonVer = if ($env:HERMES_PYTHON_VER) { $env:HERMES_PYTHON_VER } else { "3.13" }
$RgVersion = if ($env:HERMES_RG_VERSION) { $env:HERMES_RG_VERSION } else { "14.1.1" }

$VendorDir = Join-Path $ElectronDir "resources/vendor/hermes"

Write-Host ""
Write-Host "Hermes Bundle (Craft Agents) — Windows" -ForegroundColor Cyan
Write-Host "  Hermes src: $HermesSrc"
Write-Host "  Output:     $VendorDir"
Write-Host ""

# Prerequisites
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Host "uv not found. Install: powershell -c 'irm https://astral.sh/uv/install.ps1 | iex'" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $HermesSrc "pyproject.toml"))) {
    Write-Host "Hermes source not found / missing pyproject.toml at: $HermesSrc" -ForegroundColor Red
    exit 1
}

# 1. Clean
Write-Host "Cleaning $VendorDir ..." -ForegroundColor Cyan
if (Test-Path $VendorDir) { Remove-Item -Recurse -Force $VendorDir }
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null
foreach ($d in @("python", "hermes-venv", "hermes-agent", "bin")) {
    New-Item -ItemType Directory -Force -Path (Join-Path $VendorDir $d) | Out-Null
}

# 2. Python via uv
Write-Host "Installing Python $PythonVer via uv..." -ForegroundColor Cyan
& uv python install $PythonVer | Out-Null

$PythonExe = (& uv python find $PythonVer).Trim()
$PythonDir = Split-Path -Parent (Split-Path -Parent $PythonExe)
Copy-Item -Recurse -Force "$PythonDir/*" (Join-Path $VendorDir "python")
Write-Host "Python copied" -ForegroundColor Green

# 3. Create venv
Write-Host "Creating venv..." -ForegroundColor Cyan
$BundledPython = Join-Path $VendorDir "python/python.exe"
& $BundledPython -m venv (Join-Path $VendorDir "hermes-venv")

$VenvPython = Join-Path $VendorDir "hermes-venv/Scripts/python.exe"

# 4. Install Hermes (non-editable so the venv is relocatable)
Write-Host "Installing Hermes (non-editable)..." -ForegroundColor Cyan
$env:UV_PROJECT_ENVIRONMENT = (Join-Path $VendorDir "hermes-venv")
& uv pip install --python $VenvPython $HermesSrc

# 5. Copy Hermes source
Write-Host "Copying Hermes source..." -ForegroundColor Cyan
$CoreFiles = @(
    "run_agent.py", "model_tools.py", "toolsets.py", "cli.py",
    "hermes_constants.py", "hermes_state.py", "hermes_time.py", "hermes_logging.py",
    "utils.py", "mcp_serve.py", "toolset_distributions.py", "trajectory_compressor.py",
    "pyproject.toml"
)
foreach ($f in $CoreFiles) {
    $src = Join-Path $HermesSrc $f
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $VendorDir "hermes-agent") }
}
$CoreDirs = @("agent", "tools", "hermes_cli", "gateway", "acp_adapter", "acp_registry", "plugins", "skills")
foreach ($d in $CoreDirs) {
    $src = Join-Path $HermesSrc $d
    if (Test-Path $src) { Copy-Item -Recurse -Force $src (Join-Path $VendorDir "hermes-agent") }
}

# 6. ripgrep
Write-Host "Downloading ripgrep $RgVersion..." -ForegroundColor Cyan
$RgUrl  = "https://github.com/BurntSushi/ripgrep/releases/download/$RgVersion/ripgrep-$RgVersion-x86_64-pc-windows-msvc.zip"
$TmpZip = Join-Path $env:TEMP "rg.zip"
$TmpDir = Join-Path $env:TEMP "rg-extract"
Invoke-WebRequest -Uri $RgUrl -OutFile $TmpZip
Expand-Archive -Force -Path $TmpZip -DestinationPath $TmpDir
Copy-Item -Force (Join-Path $TmpDir "ripgrep-$RgVersion-x86_64-pc-windows-msvc/rg.exe") (Join-Path $VendorDir "bin/rg.exe")
Remove-Item -Recurse -Force $TmpZip, $TmpDir

# 7. Strip
Write-Host "Stripping caches..." -ForegroundColor Cyan
Get-ChildItem -Recurse -Force -Directory -Filter "__pycache__" $VendorDir | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -Force -File -Filter "*.pyc" $VendorDir | Remove-Item -Force -ErrorAction SilentlyContinue

# 8. Patch pyvenv.cfg for relocatability
$PyvenvCfg = Join-Path $VendorDir "hermes-venv/pyvenv.cfg"
if (Test-Path $PyvenvCfg) {
    (Get-Content $PyvenvCfg) -replace "^home = .*", "home = ..\python" | Set-Content $PyvenvCfg
}

# 9. Smoke test
Write-Host "Smoke test..." -ForegroundColor Cyan
& $VenvPython -c "import sys; print('  Python', sys.version.split()[0], 'OK')"
& $VenvPython -c "import acp_adapter; print('  acp_adapter import OK')"

Write-Host ""
Write-Host "Hermes bundle built at $VendorDir" -ForegroundColor Green
