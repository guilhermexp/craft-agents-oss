# ===========================================================================
# Hermes Agent — pre-build bundling script (Windows)
#
# Treats Hermes upstream as a pinned dependency, matching bundle-hermes.sh:
#   1. Reads apps/electron/scripts/hermes-version.txt, or $env:HERMES_VERSION.
#   2. Maintains a clean NousResearch/hermes-agent clone in
#      apps/electron/scripts/.hermes-cache/source.
#   3. Applies Craft overlay patches from apps/electron/scripts/hermes-patches/.
#   4. Builds a self-contained runtime under apps/electron/resources/vendor/hermes/.
#
# Usage (from apps/electron):
#   pwsh scripts/bundle-hermes.ps1
#
# Env vars:
#   $env:HERMES_VERSION      upstream tag/branch/SHA to bundle.
#   $env:HERMES_SRC          explicit local source override; skips cache + patches.
#   $env:HERMES_PYTHON_VER   default 3.13
#   $env:HERMES_RG_VERSION   default 14.1.1
#   $env:HERMES_REMOTE_URL   default https://github.com/NousResearch/hermes-agent.git
# ===========================================================================

$ErrorActionPreference = "Stop"

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ElectronDir = Resolve-Path (Join-Path $ScriptDir "..")
$RepoRoot    = Resolve-Path (Join-Path $ElectronDir "../..")

$PythonVer = if ($env:HERMES_PYTHON_VER) { $env:HERMES_PYTHON_VER } else { "3.13" }
$RgVersion = if ($env:HERMES_RG_VERSION) { $env:HERMES_RG_VERSION } else { "14.1.1" }

$VendorDir = Join-Path $ElectronDir "resources/vendor/hermes"
$PatchesDir = Join-Path $ScriptDir "hermes-patches"
$PinFile = Join-Path $ScriptDir "hermes-version.txt"
$CacheDir = Join-Path $ScriptDir ".hermes-cache"
$CacheSrc = Join-Path $CacheDir "source"
$HermesRemoteUrl = if ($env:HERMES_REMOTE_URL) { $env:HERMES_REMOTE_URL } else { "https://github.com/NousResearch/hermes-agent.git" }

function Resolve-HermesPin {
    if ($env:HERMES_VERSION) { return $env:HERMES_VERSION }
    if (Test-Path $PinFile) {
        foreach ($line in Get-Content $PinFile) {
            $trimmed = $line.Trim()
            if ($trimmed -and -not $trimmed.StartsWith('#')) { return $trimmed }
        }
    }
    return "upstream/main"
}

$HermesPin = Resolve-HermesPin
$ApplyPatches = $true
$HermesResolvedSha = ""

function Ensure-HermesCacheClone {
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    if (!(Test-Path (Join-Path $CacheSrc ".git"))) {
        Write-Host "Cloning Hermes upstream into cache..." -ForegroundColor Cyan
        if (Test-Path $CacheSrc) { Remove-Item -Recurse -Force $CacheSrc }
        git clone --filter=blob:none $HermesRemoteUrl $CacheSrc
    }

    $dirty = git -C $CacheSrc status --porcelain
    if ($dirty) {
        Write-Host "Cache had local edits — re-cloning fresh" -ForegroundColor Yellow
        Remove-Item -Recurse -Force $CacheSrc
        git clone --filter=blob:none $HermesRemoteUrl $CacheSrc
    }

    git -C $CacheSrc fetch --all --tags --prune --quiet
    $ref = $HermesPin
    if ($ref.StartsWith("upstream/")) { $ref = "origin/" + $ref.Substring("upstream/".Length) }

    git -C $CacheSrc rev-parse --verify $ref 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        $originRef = "origin/$HermesPin"
        git -C $CacheSrc rev-parse --verify $originRef 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot resolve Hermes pin '$HermesPin' in $CacheSrc" }
        $ref = $originRef
    }

    git -C $CacheSrc -c advice.detachedHead=false checkout --quiet $ref
    git -C $CacheSrc reset --hard --quiet $ref
    return (git -C $CacheSrc rev-parse --short HEAD).Trim()
}

if ($env:HERMES_SRC -and (Test-Path $env:HERMES_SRC)) {
    $HermesSrc = $env:HERMES_SRC
    $ApplyPatches = $false
    $HermesResolvedSha = "override"
    Write-Host "Using HERMES_SRC override: $HermesSrc (skipping pin/cache/patches)" -ForegroundColor Yellow
} else {
    $HermesSrc = $CacheSrc
    $HermesResolvedSha = Ensure-HermesCacheClone
}

if ($ApplyPatches -and (Test-Path $PatchesDir)) {
    $Patches = Get-ChildItem -Path $PatchesDir -Filter "*.patch" | Sort-Object Name
    if ($Patches.Count -gt 0) {
        Write-Host "Applying $($Patches.Count) Craft overlay patch(es)..." -ForegroundColor Cyan
        foreach ($Patch in $Patches) {
            git -C $HermesSrc apply --check $($Patch.FullName) 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw "Patch failed --check: $($Patch.Name). Pin '$HermesPin' (resolved $HermesResolvedSha) does not match the patch's expected upstream state."
            }
            git -C $HermesSrc apply $($Patch.FullName)
            Write-Host "  OK $($Patch.Name)" -ForegroundColor Green
        }
    }
}

Write-Host ""
Write-Host "Hermes Bundle (Craft Agents) — Windows" -ForegroundColor Cyan
Write-Host "  Pin:        $HermesPin -> $HermesResolvedSha"
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
& uv pip install --python $VenvPython "${HermesSrc}[web,acp,messaging]"
& uv pip install --python $VenvPython playwright websockets
& $VenvPython -m playwright install chromium
git -C $HermesSrc rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
    $sourceBuildStatus = git -C $HermesSrc status --porcelain -- build
    if ($sourceBuildStatus -match "^\?\? build/") {
        Remove-Item -Recurse -Force (Join-Path $HermesSrc "build")
    }
}

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

# 5b. Craft ACP/MCP changes are applied as overlay patches before install/copy.

# 6. Build/copy Hermes Web Dashboard assets
$WebDistSrc = Join-Path $HermesSrc "hermes_cli/web_dist"
$WebDir = Join-Path $HermesSrc "web"
$WebDistDest = Join-Path $VendorDir "hermes-agent/hermes_cli/web_dist"
if ((Test-Path (Join-Path $WebDistSrc "index.html"))) {
    Write-Host "Copying existing Hermes web dashboard assets..." -ForegroundColor Cyan
    if (Test-Path $WebDistDest) { Remove-Item -Recurse -Force $WebDistDest }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WebDistDest) | Out-Null
    Copy-Item -Recurse -Force $WebDistSrc $WebDistDest
    Write-Host "Web dashboard assets copied" -ForegroundColor Green
} elseif ((Test-Path (Join-Path $WebDir "package.json")) -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host "Building Hermes web dashboard assets..." -ForegroundColor Cyan
    Push-Location $WebDir
    try {
        if (Test-Path (Join-Path $WebDir "package-lock.json")) {
            & npm ci --silent
        } else {
            & npm install --silent
        }
        & npm run build
    } finally {
        Pop-Location
    }
    if (Test-Path (Join-Path $WebDistSrc "index.html")) {
        if (Test-Path $WebDistDest) { Remove-Item -Recurse -Force $WebDistDest }
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $WebDistDest) | Out-Null
        Copy-Item -Recurse -Force $WebDistSrc $WebDistDest
        Write-Host "Web dashboard assets built and copied" -ForegroundColor Green
    } else {
        Write-Host "Hermes web build finished but web_dist was not found" -ForegroundColor Yellow
    }
} else {
    Write-Host "Hermes web dashboard assets unavailable (no hermes_cli/web_dist and npm/web source missing)" -ForegroundColor Yellow
}

# 7. ripgrep
Write-Host "Downloading ripgrep $RgVersion..." -ForegroundColor Cyan
$RgUrl  = "https://github.com/BurntSushi/ripgrep/releases/download/$RgVersion/ripgrep-$RgVersion-x86_64-pc-windows-msvc.zip"
$TmpZip = Join-Path $env:TEMP "rg.zip"
$TmpDir = Join-Path $env:TEMP "rg-extract"
Invoke-WebRequest -Uri $RgUrl -OutFile $TmpZip
Expand-Archive -Force -Path $TmpZip -DestinationPath $TmpDir
Copy-Item -Force (Join-Path $TmpDir "ripgrep-$RgVersion-x86_64-pc-windows-msvc/rg.exe") (Join-Path $VendorDir "bin/rg.exe")
Remove-Item -Recurse -Force $TmpZip, $TmpDir

# 8. Strip
Write-Host "Stripping caches..." -ForegroundColor Cyan
Get-ChildItem -Recurse -Force -Directory -Filter "__pycache__" $VendorDir | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -Force -File -Filter "*.pyc" $VendorDir | Remove-Item -Force -ErrorAction SilentlyContinue

# 9. Patch pyvenv.cfg for relocatability
$PyvenvCfg = Join-Path $VendorDir "hermes-venv/pyvenv.cfg"
if (Test-Path $PyvenvCfg) {
    (Get-Content $PyvenvCfg) -replace "^home = .*", "home = ..\python" | Set-Content $PyvenvCfg
}

# 10. Smoke test
Write-Host "Smoke test..." -ForegroundColor Cyan
$SmokeTestPython = 'import sys; print("  Python", sys.version.split()[0], "OK")'
& $VenvPython -c $SmokeTestPython
$SmokeTestAcp = 'import acp_adapter; print("  acp_adapter import OK")'
& $VenvPython -c $SmokeTestAcp

Write-Host ""
Write-Host "Hermes bundle built at $VendorDir" -ForegroundColor Green
