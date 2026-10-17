@echo off
REM TaskRadar from source: opens the TaskRadar window (its local service starts and stops with the window).
REM "TaskRadar.cmd --browser" starts the browser version instead (http://127.0.0.1:8000; close this window to stop).
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
if /i "%~1"=="--browser" goto browser
start "" "backend\.venv\Scripts\pythonw.exe" -m taskradar desktop %*
exit /b 0

:browser
shift
title TaskRadar - close this window to stop
"backend\.venv\Scripts\python.exe" -m taskradar serve %1 %2 %3 %4 %5 %6 %7 %8 %9
if errorlevel 1 pause
