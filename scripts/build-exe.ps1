<#
.SYNOPSIS
    Build the TaskRadar desktop app: TaskRadar.exe and its installer, running without Python or Node.js.

.DESCRIPTION
    1. Builds the web UI (frontend -> backend\src\taskradar\static).
    2. Packages backend, web UI, the window (pywebview on Microsoft Edge WebView2) and the database migrations with
       PyInstaller (installed into backend\.venv if it is missing) as a windowed program.
    3. Puts a short read-me next to the program and zips the folder (the portable version, which runs without
       installing).
    4. Builds the installer around that archive: dist\TaskRadar-Setup-<version>.exe installs TaskRadar for the
       current user (no administrator rights) with a Start menu entry, an optional desktop shortcut and an entry in
       Settings -> Apps to uninstall it again.

    Result: dist\TaskRadar-Setup-<version>.exe, dist\TaskRadar-<version>-windows-x64.zip and the folder
    dist\TaskRadar. With -OneFile: only dist\onefile\TaskRadar.exe, a single file that unpacks itself into the temp
    folder on every start (slower start, no installer).

    Nothing personal is packed: data stays in %LOCALAPPDATA%\TaskRadar, secrets in the Windows Credential
    Manager. The programs are not code-signed, so Windows SmartScreen may ask before the first start.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1 -OneFile
#>
[CmdletBinding()]
param(
    [switch]$OneFile,
    [switch]$SkipWebBuild,
    [switch]$SkipInstaller
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root "backend\.venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    Write-Host "The development setup is missing. Run Setup.cmd first." -ForegroundColor Yellow
    exit 1
}

function Invoke-Step([string]$Title, [scriptblock]$Action) {
    Write-Host "==> $Title" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE) { throw "$Title failed (exit code $LASTEXITCODE)" }
}

if (-not $SkipWebBuild) {
    Push-Location (Join-Path $Root "frontend")
    try {
        if (-not (Test-Path "node_modules")) { Invoke-Step "Installing web UI packages" { npm ci } }
        Invoke-Step "Building the web UI" { npm run build }
    } finally { Pop-Location }
}

& $Python -c "import PyInstaller, webview" 2>$null
if ($LASTEXITCODE) {
    Invoke-Step "Installing PyInstaller and pywebview into backend\.venv" {
        & $Python -m pip install --quiet "pyinstaller>=6.11" "pywebview>=6.1"
    }
}

$Dist = Join-Path $Root $(if ($OneFile) { "dist\onefile" } else { "dist" })
$Work = Join-Path $Root "build\pyinstaller"
$env:TASKRADAR_ONEFILE = $(if ($OneFile) { "1" } else { "0" })
try {
    Invoke-Step "Packaging TaskRadar.exe with PyInstaller" {
        & $Python -m PyInstaller --noconfirm --clean --log-level WARN `
            --distpath $Dist --workpath $Work (Join-Path $Root "packaging\taskradar.spec")
    }
} finally { Remove-Item Env:\TASKRADAR_ONEFILE -ErrorAction SilentlyContinue }

# Next to the program: the read-me.
$Target = $(if ($OneFile) { $Dist } else { Join-Path $Dist "TaskRadar" })
$Version = (& $Python -c "import taskradar; print(taskradar.__version__)").Trim()
$Readme = (Get-Content (Join-Path $Root "packaging\README.txt") -Raw -Encoding UTF8).Replace("{version}", $Version)
# Lines marked [folder] are about the folder build only.
$Readme = $(if ($OneFile) { $Readme -replace "(?m)^\[folder\].*\n", "" } else { $Readme -replace "(?m)^\[folder\]", "" })
Set-Content (Join-Path $Target "README.txt") $Readme -Encoding UTF8

$Exe = Join-Path $Target "TaskRadar.exe"
$SizeMB = [math]::Round(((Get-ChildItem $Target -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Built $Exe ($SizeMB MB in $Target)" -ForegroundColor Green
if ($OneFile) { exit 0 }

# The portable version, which is also what the installer unpacks.
$Zip = Join-Path $Dist "TaskRadar-$Version-windows-x64.zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Invoke-Step "Zipping the program folder" { Compress-Archive -Path $Target -DestinationPath $Zip -CompressionLevel Optimal }
Write-Host "Zipped to $Zip ($([math]::Round((Get-Item $Zip).Length / 1MB, 1)) MB)" -ForegroundColor Green
if ($SkipInstaller) { exit 0 }

$PayloadDir = Join-Path $Root "build\payload"
New-Item -ItemType Directory -Force $PayloadDir | Out-Null
Copy-Item $Zip (Join-Path $PayloadDir "TaskRadar.zip") -Force
$env:TASKRADAR_PAYLOAD = Join-Path $PayloadDir "TaskRadar.zip"
try {
    Invoke-Step "Building the installer" {
        & $Python -m PyInstaller --noconfirm --clean --log-level WARN `
            --distpath $Dist --workpath (Join-Path $Root "build\pyinstaller-setup") (Join-Path $Root "packaging\installer.spec")
    }
} finally { Remove-Item Env:\TASKRADAR_PAYLOAD -ErrorAction SilentlyContinue }
$Setup = Join-Path $Dist "TaskRadar-Setup-$Version.exe"
Write-Host "Built $Setup ($([math]::Round((Get-Item $Setup).Length / 1MB, 1)) MB)" -ForegroundColor Green
