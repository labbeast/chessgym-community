@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Restore-ChessGym.ps1"
if errorlevel 1 pause
