<#
.SYNOPSIS
    Start the local TaskRadar server and open the dashboard.

.DESCRIPTION
    The server listens on 127.0.0.1 only. Stop it with Ctrl+C (or by closing the window).
    With -Background it runs without a console window; stop it from the Task Manager
    ("pythonw.exe") or by restarting Windows.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start.ps1
    powershell -ExecutionPolicy Bypass -File scripts\start.ps1 -Port 8010 -NoBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$NoBrowser,
    [switch]$Background,
    [string]$DataDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Scripts = Join-Path $Root "backend\.venv\Scripts"
$Python = Join-Path $Scripts "python.exe"

if (-not (Test-Path $Python)) {
    Write-Host "TaskRadar is not set up yet. Run:" -ForegroundColor Yellow
    Write-Host "    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1"
    exit 1
}

$arguments = @("-m", "taskradar", "serve")
if ($Port -gt 0) { $arguments += @("--port", "$Port") }
if ($NoBrowser) { $arguments += "--no-browser" }
if ($DataDir) { $arguments += @("--data-dir", $DataDir) }

if ($Background) {
    $pythonw = Join-Path $Scripts "pythonw.exe"
    Start-Process -FilePath $pythonw -ArgumentList $arguments -WorkingDirectory $Root -WindowStyle Hidden
    Write-Host "TaskRadar is starting in the background: http://127.0.0.1:$(if ($Port -gt 0) { $Port } else { 8000 })"
} else {
    Set-Location $Root
    & $Python @arguments
    exit $LASTEXITCODE
}
