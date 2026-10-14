@echo off
REM TaskRadar one-time setup (no administrator rights needed). See scripts\setup.ps1.
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
pause
