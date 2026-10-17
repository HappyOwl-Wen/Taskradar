<#
.SYNOPSIS
    Build TaskRadar.exe: TaskRadar as one program that runs without Python or Node.js.

.DESCRIPTION
    1. Builds the web UI (frontend -> backend\src\taskradar\static).
    2. Packages backend, web UI, database migrations and the synthetic demo files with PyInstaller
       (installed into backend\.venv if it is missing).
    3. Puts Install-OCR.cmd, the OCR installer script and a short read-me next to the program and zips it.

    Result (default): dist\TaskRadar\TaskRadar.exe with its _internal folder, and
    dist\TaskRadar-<version>-windows-x64.zip. With -OneFile: dist\onefile\TaskRadar.exe, a single file that
    unpacks itself into the temp folder on every start (slower start).

    Nothing personal is packed: data stays in %LOCALAPPDATA%\TaskRadar, secrets in the Windows Credential
    Manager. The program is not code-signed, so Windows SmartScreen may ask before the first start.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1
    powershell -ExecutionPolicy Bypass -File scripts\build-exe.ps1 -OneFile
#>
[CmdletBinding()]
param(
    [switch]$OneFile,
    [switch]$SkipWebBuild
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

& $Python -c "import PyInstaller" 2>$null
if ($LASTEXITCODE) {
    Invoke-Step "Installing PyInstaller into backend\.venv" { & $Python -m pip install --quiet "pyinstaller>=6.11" }
}

$Dist = Join-Path $Root $(if ($OneFile) { "dist\onefile" } else { "dist" })
$env:TASKRADAR_ONEFILE = $(if ($OneFile) { "1" } else { "0" })
try {
    Invoke-Step "Packaging with PyInstaller" {
        & $Python -m PyInstaller --noconfirm --clean --log-level WARN `
            --distpath $Dist --workpath (Join-Path $Root "build\pyinstaller") (Join-Path $Root "packaging\taskradar.spec")
    }
} finally { Remove-Item Env:\TASKRADAR_ONEFILE -ErrorAction SilentlyContinue }

# Next to the program: the optional OCR installer and the read-me.
$Target = $(if ($OneFile) { $Dist } else { Join-Path $Dist "TaskRadar" })
Copy-Item (Join-Path $Root "packaging\Install-OCR.cmd") $Target -Force
Copy-Item (Join-Path $Root "scripts\install-tesseract.ps1") $Target -Force
$Version = (& $Python -c "import taskradar; print(taskradar.__version__)").Trim()
$Readme = (Get-Content (Join-Path $Root "packaging\README.txt") -Raw -Encoding UTF8).Replace("{version}", $Version)
if ($OneFile) {
    $Readme = $Readme.Replace("{keep-together-zh}", "").Replace("{keep-together-en}", "")
} else {
    $Readme = $Readme.Replace("{keep-together-zh}", "  请让整个文件夹保持在一起：TaskRadar.exe 需要旁边的 _internal 文件夹。`n")
    $Readme = $Readme.Replace("{keep-together-en}", "Keep the folder together (TaskRadar.exe needs its _internal folder). ")
}
Set-Content (Join-Path $Target "README.txt") $Readme -Encoding UTF8

$Exe = Join-Path $Target "TaskRadar.exe"
$SizeMB = [math]::Round(((Get-ChildItem $Target -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 1)
Write-Host ""
Write-Host "Built $Exe ($SizeMB MB in $Target)" -ForegroundColor Green

if (-not $OneFile) {
    $Zip = Join-Path $Dist "TaskRadar-$Version-windows-x64.zip"
    if (Test-Path $Zip) { Remove-Item $Zip -Force }
    Invoke-Step "Zipping" { Compress-Archive -Path $Target -DestinationPath $Zip -CompressionLevel Optimal }
    Write-Host "Zipped to $Zip ($([math]::Round((Get-Item $Zip).Length / 1MB, 1)) MB)" -ForegroundColor Green
}
