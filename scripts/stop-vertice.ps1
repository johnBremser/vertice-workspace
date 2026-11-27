$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

function Get-NormalizedArgPath([string]$PathValue) {
  if ([string]::IsNullOrWhiteSpace($PathValue)) { return "" }
  try {
    return [System.IO.Path]::GetFullPath($PathValue.Trim()).TrimEnd('\', '/')
  } catch {
    return $PathValue.Trim().TrimEnd('\', '/')
  }
}

function Get-CommandLineOptionValue([string]$CommandLine, [string]$OptionName) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $null }
  $escaped = [regex]::Escape($OptionName)
  $pattern = "(?:^|\s)${escaped}(?:\s+|=)(?:""([^""]+)""|'([^']+)'|(\S+))(?=\s|$)"
  $m = [regex]::Match($CommandLine, $pattern)
  if (-not $m.Success) { return $null }
  if ($m.Groups[1].Success) { return $m.Groups[1].Value }
  if ($m.Groups[2].Success) { return $m.Groups[2].Value }
  if ($m.Groups[3].Success) { return $m.Groups[3].Value }
  return $null
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Vertice Workspace - Encerrando" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# Localizar Node.js compativel na sessao sem alterar ambiente global
$NodeCompatScript = Join-Path $RootDir "scripts\node-compat.mjs"
$CandidateExes = [System.Collections.Generic.List[string]]::new()
foreach ($pattern in @(
  "$env:APPDATA\AionUi-Dev\aionui\runtime\node\node-v24*",
  "$env:APPDATA\AionUi\aionui\runtime\node\node-v24*",
  "$env:APPDATA\AionUi-Dev\aionui\runtime\node\node-v22*",
  "$env:APPDATA\AionUi\aionui\runtime\node\node-v22*",
  "$env:APPDATA\AionUi-Dev\aionui\runtime\node\node-v26*",
  "$env:APPDATA\AionUi\aionui\runtime\node\node-v26*"
)) {
  $dirs = Get-ChildItem -Path $pattern -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending
  foreach ($d in $dirs) {
    $exe = Join-Path $d.FullName "node.exe"
    if (Test-Path $exe) { $CandidateExes.Add($exe) }
  }
}
$pathNode = Get-Command node -ErrorAction SilentlyContinue
if ($pathNode -and $pathNode.Source) {
  $CandidateExes.Add($pathNode.Source)
}
foreach ($exe in ($CandidateExes | Select-Object -Unique)) {
  try {
    $ver = (& $exe -v 2>$null).Trim()
    if (-not $ver) { continue }
    & $exe $NodeCompatScript --is-supported $ver 2>$null
    if ($LASTEXITCODE -eq 0) {
      $nodeDir = Split-Path -Parent $exe
      $env:PATH = "$nodeDir;$env:PATH"
      break
    }
  } catch {}
}

$exitCode = 0

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node scripts\vertice-ctl.mjs stop
  if ($LASTEXITCODE -ne 0) {
    $exitCode = $LASTEXITCODE
  }
} else {
  Write-Host "[AVISO] Node.js nao encontrado para encerrar o servidor via vertice-ctl." -ForegroundColor Yellow
}

# Remover eventual arquivo legado .vertice\aioncore.pid sem encerrar nenhum processo por ele
$legacyPidFile = Join-Path $RootDir ".vertice\aioncore.pid"
if (Test-Path $legacyPidFile) {
  Remove-Item -Path $legacyPidFile -Force -ErrorAction SilentlyContinue
}

# Encerrar EXCLUSIVAMENTE o aioncore.exe iniciado por este launcher,
# comprovando PID + ExecutablePath + argumento exato --data-dir + --port + StartTimeUtc
$metaFile = Join-Path $RootDir ".vertice\aioncore-instance.json"
if (Test-Path $metaFile) {
  $shouldRemoveMeta = $false
  try {
    $meta = Get-Content -Path $metaFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $targetPid = [int]$meta.pid
    $expectedExe = Get-NormalizedArgPath ([string]$meta.executablePath)
    $expectedDataDir = Get-NormalizedArgPath ([string]$meta.dataDir)
    $expectedPort = [int]$meta.port
    $expectedStartUtc = [DateTime]::Parse([string]$meta.startTimeUtc).ToUniversalTime()

    if ($targetPid -le 0 -or -not $expectedExe -or -not $expectedDataDir) {
      Write-Host "[AVISO] Registro .vertice\aioncore-instance.json incompleto; nenhum processo AionCore foi encerrado." -ForegroundColor Yellow
      $shouldRemoveMeta = $true
    } else {
      $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
      $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $targetPid" -ErrorAction SilentlyContinue

      if (-not $proc -or -not $cim) {
        Write-Host "AionCore rastreado (PID $targetPid) ja estava encerrado." -ForegroundColor Gray
        $shouldRemoveMeta = $true
      } else {
        $actualExe = Get-NormalizedArgPath ([string]$cim.ExecutablePath)
        $actualCmd = [string]$cim.CommandLine
        $actualDataDirRaw = Get-CommandLineOptionValue $actualCmd "--data-dir"
        $actualDataDir = Get-NormalizedArgPath $actualDataDirRaw
        $actualPortRaw = Get-CommandLineOptionValue $actualCmd "--port"
        $actualStartUtc = $proc.StartTime.ToUniversalTime()
        $startDriftSeconds = [Math]::Abs(($actualStartUtc - $expectedStartUtc).TotalSeconds)

        $matchesName = ($proc.ProcessName -ieq 'aioncore')
        $matchesExe = ($actualExe -ieq $expectedExe)
        $matchesDataDir = ($actualDataDir -ne "" -and $actualDataDir -ieq $expectedDataDir)
        $matchesPort = ($actualPortRaw -eq "$expectedPort")
        $matchesStart = ($startDriftSeconds -le 2.0)

        if ($matchesName -and $matchesExe -and $matchesDataDir -and $matchesPort -and $matchesStart) {
          try {
            Stop-Process -Id $targetPid -Force -ErrorAction Stop
            Write-Host "AionCore local verificado e encerrado com seguranca (PID $targetPid)." -ForegroundColor Green
            $shouldRemoveMeta = $true
          } catch {
            Write-Host "[ERRO] Falha ao encerrar o AionCore local (PID $targetPid): $($_.Exception.Message). Registro preservado em .vertice\aioncore-instance.json." -ForegroundColor Red
            $shouldRemoveMeta = $false
            $exitCode = 1
          }
        } else {
          Write-Host "[AVISO] PID $targetPid nao corresponde a instancia do AionCore iniciada pelo Vertice (possivel reutilizacao de PID ou outra instancia). Processo preservado sem alteracao." -ForegroundColor Yellow
          $shouldRemoveMeta = $true
        }
      }
    }
  } catch {
    Write-Host "[AVISO] Registro .vertice\aioncore-instance.json invalido ou ilegivel; nenhum processo AionCore foi encerrado." -ForegroundColor Yellow
    $shouldRemoveMeta = $true
  }

  if ($shouldRemoveMeta) {
    Remove-Item -Path $metaFile -Force -ErrorAction SilentlyContinue
  }
}

exit $exitCode
