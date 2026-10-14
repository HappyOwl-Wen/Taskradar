<#
.SYNOPSIS
    Install the Tesseract OCR engine for TaskRadar into the current user's profile.

.DESCRIPTION
    Downloads the official UB Mannheim build of Tesseract 5.4.0 for Windows and the German and
    Simplified Chinese language models from the tesseract-ocr project, verifies every file
    against a pinned SHA-256 checksum, and unpacks them into
        %LOCALAPPDATA%\TaskRadar\tools\tesseract
    where TaskRadar finds them automatically.

    * No administrator rights, no installer is executed: the setup package is only unpacked
      with 7-Zip (https://www.7-zip.org/), which must be installed.
    * Nothing outside that folder is changed (no PATH or registry changes).
    * Files with a wrong checksum are deleted and the script stops.

    Downloads: ~48 MB installer + ~15 MB (deu) + ~44 MB (chi_sim).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install-tesseract.ps1
#>
[CmdletBinding()]
param(
    [switch]$Force,
    [string]$SevenZip = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"  # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$InstallerUrl = "https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe"
$InstallerSha256 = "c885fff6998e0608ba4bb8ab51436e1c6775c2bafc2559a19b423e18678b60c9"
$Models = [ordered]@{
    "deu"     = "896b3b4956503ab9daa10285db330881b2d74b70d889b79262cc534b9ec699a4"
    "chi_sim" = "fc05d89ab31d8b4e226910f16a8bcbf78e43bae3e2580bb5feefd052efdab363"
}
$ModelUrl = "https://github.com/tesseract-ocr/tessdata/raw/main/{0}.traineddata"

$Target = Join-Path $env:LOCALAPPDATA "TaskRadar\tools\tesseract"
$Exe = Join-Path $Target "tesseract.exe"

function Fail([string]$Text) { Write-Host "ERROR: $Text" -ForegroundColor Red; exit 1 }

function Get-Verified([string]$Url, [string]$Path, [string]$Sha256) {
    if (Test-Path $Path) {
        if ((Get-FileHash -Algorithm SHA256 $Path).Hash.ToLower() -eq $Sha256) { return }
        Remove-Item $Path -Force
    }
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 $Path).Hash.ToLower()
    if ($actual -ne $Sha256) {
        Remove-Item $Path -Force
        Fail "Checksum mismatch for $Url (expected $Sha256, got $actual). The file was deleted."
    }
}

if ((Test-Path $Exe) -and -not $Force) {
    Write-Host "Tesseract is already installed at $Target (use -Force to reinstall)."
} else {
    if (-not $SevenZip) {
        $cmd = Get-Command 7z -ErrorAction SilentlyContinue
        if ($cmd) { $SevenZip = $cmd.Source }
        foreach ($p in @("$env:ProgramFiles\7-Zip\7z.exe", "${env:ProgramFiles(x86)}\7-Zip\7z.exe")) {
            if (-not $SevenZip -and (Test-Path $p)) { $SevenZip = $p }
        }
    }
    if (-not $SevenZip -or -not (Test-Path $SevenZip)) {
        Fail "7-Zip was not found. Install it from https://www.7-zip.org/ (or pass -SevenZip <path to 7z.exe>), or install Tesseract with its official installer and set TASKRADAR_TESSERACT_CMD to tesseract.exe."
    }

    $work = Join-Path ([IO.Path]::GetTempPath()) ("taskradar-tesseract-" + [Guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $work | Out-Null
    try {
        $setup = Join-Path $work "tesseract-setup.exe"
        Get-Verified $InstallerUrl $setup $InstallerSha256
        $stage = Join-Path $work "unpacked"
        & $SevenZip x $setup "-o$stage" -y | Out-Null
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $stage "tesseract.exe"))) { Fail "Unpacking the Tesseract package failed." }
        $pluginDir = Join-Path $stage '$PLUGINSDIR'
        if (Test-Path $pluginDir) { Remove-Item $pluginDir -Recurse -Force }
        if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
        New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
        Move-Item $stage $Target
    } finally {
        if (Test-Path $work) { Remove-Item $work -Recurse -Force }
    }
}

$tessdata = Join-Path $Target "tessdata"
foreach ($lang in $Models.Keys) {
    Get-Verified ($ModelUrl -f $lang) (Join-Path $tessdata "$lang.traineddata") $Models[$lang]
}

$langs = & $Exe --list-langs 2>&1 | Select-Object -Skip 1
Write-Host ""
Write-Host "Tesseract installed: $Exe" -ForegroundColor Green
Write-Host "Languages: $($langs -join ', ')"
Write-Host "Restart TaskRadar so it picks up the OCR engine."
