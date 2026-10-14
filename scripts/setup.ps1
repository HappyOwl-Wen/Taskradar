<#
.SYNOPSIS
    One-time setup of TaskRadar on Windows. No administrator rights required.

.DESCRIPTION
    1. Finds Python 3.12+ and creates backend\.venv with the backend installed in it.
    2. Installs the frontend dependencies (npm ci) and builds the web UI into the backend.
    3. Creates / migrates the local database (%LOCALAPPDATA%\TaskRadar by default).
    4. Reports whether the OCR engine (Tesseract) is available. It is NOT downloaded here;
       run scripts\install-tesseract.ps1 for that (separate, explicit step).

    Nothing outside the project folder and %LOCALAPPDATA%\TaskRadar is modified. The Windows
    autostart entry is never created by this script.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipFrontend,
    [switch]$Dev  # also install the backend's test / lint tools
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"
$Venv = Join-Path $Backend ".venv"
$VenvPython = Join-Path $Venv "Scripts\python.exe"

function Write-Step([string]$Text) { Write-Host ""; Write-Host "==> $Text" -ForegroundColor Cyan }
function Fail([string]$Text) { Write-Host ""; Write-Host "ERROR: $Text" -ForegroundColor Red; exit 1 }

function Find-Python {
    $candidates = @()
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in @("3.13", "3.12", "3.14")) { $candidates += , @("py", "-$v") }
    }
    if (Get-Command python -ErrorAction SilentlyContinue) { $candidates += , @("python") }
    foreach ($c in $candidates) {
        try {
            $exe = $c[0]
            $extra = @($c | Select-Object -Skip 1)
            $out = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)" 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
            $parts = "$($out[0])".Split(".")
            if ([int]$parts[0] -eq 3 -and [int]$parts[1] -ge 12) { return "$($out[1])".Trim() }
        } catch { continue }
    }
    return $null
}

Write-Step "Checking Python (3.12 or newer)"
if (Test-Path $VenvPython) {
    Write-Host "Using existing virtual environment: $Venv"
} else {
    $python = Find-Python
    if (-not $python) {
        Fail "Python 3.12+ was not found. Install it from https://www.python.org/downloads/windows/ (tick 'Add python.exe to PATH') and run this script again."
    }
    Write-Host "Found $python"
    Write-Step "Creating virtual environment in backend\.venv"
    & $python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Fail "Creating the virtual environment failed." }
}

Write-Step "Installing the backend"
& $VenvPython -m pip install --disable-pip-version-check --quiet --upgrade pip
if ($LASTEXITCODE -ne 0) { Fail "Upgrading pip failed." }
$target = if ($Dev) { "$Backend[dev]" } else { $Backend }
& $VenvPython -m pip install --disable-pip-version-check --quiet -e $target
if ($LASTEXITCODE -ne 0) { Fail "Installing the backend failed (see the pip output above)." }

if (-not $SkipFrontend) {
    Write-Step "Building the web interface"
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "Node.js was not found. Install the LTS version from https://nodejs.org/ (or run with -SkipFrontend if the UI is already built)."
    }
    $nodeVersion = (& node --version).TrimStart("v").Split(".")
    if ([int]$nodeVersion[0] -lt 20) { Fail "Node.js 20 or newer is required (found $(& node --version))." }
    Push-Location $Frontend
    try {
        & npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { Fail "npm ci failed." }
        & npm run build
        if ($LASTEXITCODE -ne 0) { Fail "Building the frontend failed." }
    } finally {
        Pop-Location
    }
}

Write-Step "Preparing the local database"
& $VenvPython -m taskradar migrate
if ($LASTEXITCODE -ne 0) { Fail "Database migration failed." }

Write-Step "Checking the OCR engine"
$ocr = & $VenvPython -c "from taskradar.config import load_config; from taskradar.parsing.ocr import TesseractEngine; c = load_config(); print('yes' if TesseractEngine(c.tesseract_cmd, tools_dir=c.tools_dir).available() else 'no')"
if ("$ocr".Trim() -eq "yes") {
    Write-Host "Tesseract found - scanned PDFs and screenshots can be read."
} else {
    Write-Host "Tesseract was not found. Text PDFs work, but scans and screenshots need OCR." -ForegroundColor Yellow
    Write-Host "Install it (about 50 MB, no admin rights) with:" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\install-tesseract.ps1" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setup complete. Start TaskRadar with TaskRadar.cmd (or scripts\start.ps1)." -ForegroundColor Green
Write-Host "It runs only on this computer at http://127.0.0.1:8000"
