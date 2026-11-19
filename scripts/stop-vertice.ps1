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

# Remover eventual arquivo legado .vertice\aioncore.pid sem encerrar nenhum processo por ele
$legacyPidFile = Join-Path $RootDir ".vertice\aioncore.pid"
if (Test-Path $legacyPidFile) {
  Remove-Item -Path $legacyPidFile -Force -ErrorAction SilentlyContinue
}

# Encerrar EXCLUSIVAMENTE o aioncore.exe iniciado por este launcher,
# comprovando PID + ExecutablePath + CommandLine (--data-dir/--port) + StartTimeUtc
$metaFile = Join-Path $RootDir ".vertice\aioncore-instance.json"
if (Test-Path $metaFile) {
  try {
    $meta = Get-Content -Path $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetPid = [int]$meta.pid
    $expectedExe = [string]$meta.executablePath
    $expectedDataDir = [string]$meta.dataDir
    $expectedPort = [int]$meta.port
    $expectedStartUtc = [DateTime]::Parse([string]$meta.startTimeUtc).ToUniversalTime()

    if ($targetPid -gt 0 -and $expectedExe -and $expectedDataDir) {
      $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue

      if (-not $proc -or -not $cim) {
        Write-Host "AionCore rastreado (PID $targetPid) ja estava encerrado." -ForegroundColor Gray
      } else {
        $actualExe = if ($cim.ExecutablePath) { [System.IO.Path]::GetFullPath([string]$cim.ExecutablePath) } else { "" }
        $actualCmd = [string]$cim.CommandLine
        $actualStartUtc = $proc.StartTime.ToUniversalTime()
        $startDriftSeconds = [Math]::Abs(($actualStartUtc - $expectedStartUtc).TotalSeconds)

        $matchesName = ($proc.ProcessName -ieq 'aioncore')
        $matchesExe = ($actualExe -ieq [System.IO.Path]::GetFullPath($expectedExe))
        $matchesDataDir = ($actualCmd.IndexOf($expectedDataDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        $matchesPort = ($actualCmd -match ("--port\s+" + [regex]::Escape("$expectedPort") + "(\s|$)"))
        $matchesStart = ($startDriftSeconds -le 2.0)

        if ($matchesName -and $matchesExe -and $matchesDataDir -and $matchesPort -and $matchesStart) {
          Stop-Process -Id $targetPid -Force -ErrorAction Stop
          Write-Host "AionCore local verificado e encerrado com seguranca (PID $targetPid)." -ForegroundColor Green
        } else {
          Write-Host "[AVISO] PID $targetPid nao corresponde a instancia do AionCore iniciada pelo Vertice (possivel reutilizacao de PID ou outra instancia). Processo preservado sem alteracao." -ForegroundColor Yellow
        }
      }
    }
  } catch {
    Write-Host "[AVISO] Registro .vertice\aioncore-instance.json invalido ou ilegivel; nenhum processo AionCore foi encerrado." -ForegroundColor Yellow
  } finally {
    Remove-Item -Path $metaFile -Force -ErrorAction SilentlyContinue
  }
}

exit 0
