$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Vertice Workspace - Encerrando" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Localizar Node.js
$NodeCandidates = @(
  "$env:APPDATA\AionUi-Dev\aionui\runtime\node\node-v24*",
  "$env:APPDATA\AionUi\aionui\runtime\node\node-v24*",
  "$env:APPDATA\AionUi-Dev\aionui\runtime\node\node-v22*",
  "$env:APPDATA\AionUi\aionui\runtime\node\node-v22*"
)
foreach ($pattern in $NodeCandidates) {
  $dirs = Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  foreach ($d in $dirs) {
    if (Test-Path (Join-Path $d.FullName "node.exe")) {
      $env:PATH = "$($d.FullName);$env:PATH"
      break
    }
  }
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node scripts\vertice-ctl.mjs stop
} else {
  Write-Host "[AVISO] Node.js nao encontrado para encerrar o servidor via vertice-ctl." -ForegroundColor Yellow
}

# Encerrar apenas o aioncore.exe iniciado por este launcher (se existir .vertice\aioncore.pid)
$pidFile = Join-Path $RootDir ".vertice\aioncore.pid"
if (Test-Path $pidFile) {
  $rawPid = (Get-Content -Path $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
  $parsedPid = 0
  if ([int]::TryParse($rawPid, [ref]$parsedPid) -and $parsedPid -gt 0) {
    $proc = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -ieq 'aioncore') {
      Stop-Process -Id $parsedPid -Force -ErrorAction SilentlyContinue
      Write-Host "AionCore local encerrado (PID $parsedPid)." -ForegroundColor Green
    }
  }
  Remove-Item -Path $pidFile -Force -ErrorAction SilentlyContinue
}

exit 0
