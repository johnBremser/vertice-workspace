@echo off
setlocal
chcp 65001 >nul 2>&1
title Vertice Workspace - Instalacao

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERRO] A instalacao foi interrompida ^(codigo %EXIT_CODE%^).
)
pause
exit /b %EXIT_CODE%
