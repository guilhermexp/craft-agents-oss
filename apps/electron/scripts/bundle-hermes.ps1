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

# 5b. Patch ACP adapter for Craft streaming
$AcpServer = Join-Path $VendorDir "hermes-agent/acp_adapter/server.py"
if (Test-Path $AcpServer) {
    Write-Host "Patching Hermes ACP adapter streaming..." -ForegroundColor Cyan
    $PatchScript = @'
from pathlib import Path
import sys
path = Path(sys.argv[1])
text = path.read_text()
old_callbacks = """        agent = state.agent
        agent.tool_progress_callback = tool_progress_cb
        agent.thinking_callback = thinking_cb
        agent.step_callback = step_cb
        agent.message_callback = message_cb

        if approval_cb:
"""
new_callbacks = """        agent = state.agent
        agent.tool_progress_callback = tool_progress_cb
        # Hermes' AIAgent streams visible assistant text through
        # run_conversation(stream_callback=...).  The older `message_callback`
        # attribute is not read by run_agent.py, so setting only that makes ACP
        # turns finish with no assistant message.
        agent.reasoning_callback = thinking_cb
        agent.thinking_callback = thinking_cb
        agent.step_callback = step_cb

        streamed_text_parts: list[str] = []
        if message_cb:
            raw_message_cb = message_cb

            def tracked_message_cb(text: str) -> None:
                if isinstance(text, str) and text:
                    streamed_text_parts.append(text)
                raw_message_cb(text)

            message_cb = tracked_message_cb

        if approval_cb:
"""
old_run = """                result = agent.run_conversation(
                    user_message=user_text,
                    conversation_history=state.history,
                    task_id=session_id,
                )
"""
new_run = """                result = agent.run_conversation(
                    user_message=user_text,
                    conversation_history=state.history,
                    task_id=session_id,
                    stream_callback=message_cb,
                )
"""
old_final = """        final_response = result.get(\"final_response\", \"\")
        if final_response and conn:
            update = acp.update_agent_message_text(final_response)
            await conn.session_update(session_id, update)
"""
new_final = """        final_response = result.get(\"final_response\", \"\")
        if final_response and conn and not streamed_text_parts:
            update = acp.update_agent_message_text(final_response)
            await conn.session_update(session_id, update)
"""
for old, new in ((old_callbacks, new_callbacks), (old_run, new_run), (old_final, new_final)):
    if old in text:
        text = text.replace(old, new, 1)
    elif new not in text:
        raise SystemExit(f"Expected ACP adapter patch target not found in {path}")
path.write_text(text)
'@
    $TmpPatch = Join-Path $env:TEMP "craft-hermes-acp-patch.py"
    Set-Content -Path $TmpPatch -Value $PatchScript
    & $VenvPython $TmpPatch $AcpServer
    Remove-Item -Force $TmpPatch
    Write-Host "ACP adapter patched" -ForegroundColor Green
}

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
        & npm install --silent
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
& $VenvPython -c "import sys; print('  Python', sys.version.split()[0], 'OK')"
& $VenvPython -c "import acp_adapter; print('  acp_adapter import OK')"

Write-Host ""
Write-Host "Hermes bundle built at $VendorDir" -ForegroundColor Green
