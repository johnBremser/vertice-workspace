@echo off
setlocal
chcp 65001 >nul 2>&1
title Vertice Workspace - Inicializacao

cd /d "%~dp0"

set "PS_ARGS="
if /i "%~1"=="--no-open" set "PS_ARGS=-NoOpen"
if /i "%~1"=="-NoOpen" set "PS_ARGS=-NoOpen"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-vertice.ps1" %PS_ARGS%
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERRO] Nao foi possivel iniciar o Vertice Workspace ^(codigo %EXIT_CODE%^).
  pause
)
exit /b %EXIT_CODE%
