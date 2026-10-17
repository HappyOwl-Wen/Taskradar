@echo off
REM Install the Tesseract OCR engine for TaskRadar (reading scans and screenshots).
REM Needs 7-Zip; no administrator rights. Installs into %LOCALAPPDATA%\TaskRadar\tools\tesseract.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-tesseract.ps1" %*
pause
