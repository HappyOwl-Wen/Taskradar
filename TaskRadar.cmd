@echo off
REM TaskRadar - start the local server (http://127.0.0.1:8000) and open the dashboard.
REM Close this window to stop TaskRadar.
setlocal
cd /d "%~dp0"
if not exist "backend\.venv\Scripts\python.exe" (
  echo TaskRadar is not set up yet.
  choice /c YN /m "Run the one-time setup now (installs Python and Node packages into this folder)"
  if errorlevel 2 exit /b 1
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1"
  if errorlevel 1 (
    echo Setup failed - see the messages above.
    pause
    exit /b 1
  )
)
title TaskRadar - close this window to stop
"backend\.venv\Scripts\python.exe" -m taskradar serve %*
if errorlevel 1 pause
