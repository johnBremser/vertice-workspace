@echo off
setlocal
chcp 65001 >nul 2>&1
title Vertice Workspace - Encerramento

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-vertice.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  pause
)
exit /b %EXIT_CODE%
