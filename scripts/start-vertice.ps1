param(
  [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Vertice Workspace - Iniciando" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Ler configuracao (vertice.config.json -> .env -> .env.local)
$VerticeHost = "127.0.0.1"
$VerticePort = "4173"
$CoreTarget = "http://127.0.0.1:25828"

$ConfigPath = Join-Path $RootDir "vertice.config.json"
if (Test-Path $ConfigPath) {
  try {
    $cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.host) { $VerticeHost = [string]$cfg.host }
    if ($cfg.port) { $VerticePort = [string]$cfg.port }
    if ($cfg.aioncoreProxyTarget) { $CoreTarget = [string]$cfg.aioncoreProxyTarget }
  } catch {}
}

foreach ($envFile in @(".env", ".env.local")) {
  $p = Join-Path $RootDir $envFile
  if (Test-Path $p) {
    foreach ($rawLine in (Get-Content -Path $p -Encoding UTF8)) {
      $line = $rawLine.Trim()
      if (-not $line -or $line.StartsWith('#')) { continue }
      $eq = $line.IndexOf('=')
      if ($eq -le 0) { continue }
      $k = $line.Substring(0, $eq).Trim()
      $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
      if ($k -eq 'VERTICE_HOST' -and $v) { $VerticeHost = $v }
      if ($k -eq 'VERTICE_PORT' -and $v) { $VerticePort = $v }
      if ($k -eq 'VITE_AIONCORE_PROXY_TARGET' -and $v) { $CoreTarget = $v }
    }
  }
}

# 2. Localizar Node.js compativel (^22.12.0 || ^24.0.0 || >=26.0.0) e garantir binarios npm globais no PATH da sessao
$NpmGlobalDir = Join-Path $env:APPDATA "npm"
if ((Test-Path $NpmGlobalDir) -and -not (($env:PATH -split ';') -contains $NpmGlobalDir)) {
  $env:PATH = "$NpmGlobalDir;$env:PATH"
}
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

$SelectedNodeExe = $null
$LastSeenVersion = $null
foreach ($exe in ($CandidateExes | Select-Object -Unique)) {
  try {
    $ver = (& $exe -v 2>$null).Trim()
    if (-not $ver) { continue }
    $LastSeenVersion = $ver
    & $exe $NodeCompatScript --is-supported $ver 2>$null
    if ($LASTEXITCODE -eq 0) {
      $SelectedNodeExe = $exe
      $nodeDir = Split-Path -Parent $exe
      $env:PATH = "$nodeDir;$env:PATH"
      break
    }
  } catch {}
}

if (-not $SelectedNodeExe) {
  if ($LastSeenVersion) {
    Write-Host "[ERRO] Node.js encontrado ($LastSeenVersion) esta fora da faixa suportada (^22.12.0 || ^24.0.0 || >=26.0.0)." -ForegroundColor Red
  } else {
    Write-Host "[ERRO] Node.js compativel (^22.12.0 || ^24.0.0 || >=26.0.0) nao encontrado." -ForegroundColor Red
  }
  Write-Host "       Execute install.cmd ou instale o Node.js 24 LTS em https://nodejs.org/." -ForegroundColor Yellow
  exit 1
}

# 3. Garantir dependencias e build
if (-not (Test-Path (Join-Path $RootDir "node_modules"))) {
  Write-Host "[INFO] Dependencias nao encontradas. Executando npm install..." -ForegroundColor Yellow
  & npm install
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

if (-not (Test-Path (Join-Path $RootDir "dist\index.html"))) {
  Write-Host "[INFO] Build nao encontrado. Gerando dist/..." -ForegroundColor Yellow
  & npm run build
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

# 4. Garantir AionCore local rodando (sem interferir se ja houver um ativo)
function Test-CoreHealth([string]$BaseUrl) {
  try {
    $resp = Invoke-WebRequest -Uri ($BaseUrl.TrimEnd('/') + "/health") -UseBasicParsing -TimeoutSec 2
    return ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 300)
  } catch {
    return $false
  }
}

if (Test-CoreHealth $CoreTarget) {
  Write-Host "[OK] AionCore ja esta ativo em $CoreTarget." -ForegroundColor Green
} else {
  $LocalAionCoreExe = Join-Path $RootDir ".vertice\bin\aioncore.exe"
  if (Test-Path $LocalAionCoreExe) {
    try {
      $uri = [System.Uri]$CoreTarget
      $coreHost = $uri.Host
      $corePort = $uri.Port
    } catch {
      $coreHost = "127.0.0.1"
      $corePort = 25828
    }
    $dataBase = Join-Path $env:LOCALAPPDATA "VerticeWorkspace"
    $dataDir = Join-Path $dataBase "core-data"
    $workDir = Join-Path $dataBase "core-work"
    $logDir = Join-Path $dataBase "core-logs"
    New-Item -ItemType Directory -Path $dataDir, $workDir, $logDir -Force | Out-Null

    Write-Host "[INFO] Iniciando AionCore local em http://${coreHost}:${corePort}..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath $LocalAionCoreExe -ArgumentList @(
      "--identity-mode", "webui",
      "--host", $coreHost,
      "--port", "$corePort",
      "--data-dir", $dataDir,
      "--work-dir", $workDir,
      "--log-dir", $logDir
    ) -WindowStyle Hidden -PassThru

    $metaFile = Join-Path $RootDir ".vertice\aioncore-instance.json"
    New-Item -ItemType Directory -Path (Split-Path -Parent $metaFile) -Force | Out-Null
    $instanceMeta = [ordered]@{
      pid = $proc.Id
      startTimeUtc = $proc.StartTime.ToUniversalTime().ToString("o")
      executablePath = [System.IO.Path]::GetFullPath($LocalAionCoreExe)
      dataDir = [System.IO.Path]::GetFullPath($dataDir)
      host = $coreHost
      port = [int]$corePort
    }
    $instanceMeta | ConvertTo-Json -Depth 3 | Set-Content -Path $metaFile -Encoding UTF8

    $ready = $false
    for ($i = 0; $i -lt 20; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-CoreHealth $CoreTarget) {
        $ready = $true
        break
      }
    }
    if ($ready) {
      Write-Host "[OK] AionCore iniciado (PID $($proc.Id))." -ForegroundColor Green
    } else {
      Write-Host "[AVISO] AionCore foi iniciado (PID $($proc.Id)), mas ainda nao respondeu em /health." -ForegroundColor Yellow
    }
  } else {
    Write-Host "[AVISO] AionCore nao esta respondendo em $CoreTarget e nao foi baixado localmente." -ForegroundColor Yellow
    Write-Host "        Execute install.cmd para baixar o aioncore.exe automaticamente." -ForegroundColor Yellow
  }
}

# 5. Iniciar servidor do Vertice Workspace
Write-Host ""
Write-Host "Iniciando / verificando o servidor do Vertice Workspace..." -ForegroundColor White
& node scripts\vertice-ctl.mjs start
if ($LASTEXITCODE -ne 0) {
  Write-Host ""
  Write-Host "[ERRO] Falha ao iniciar o servidor. Executando diagnostico (doctor)..." -ForegroundColor Red
  & node scripts\vertice-ctl.mjs doctor
  exit 1
}

$VerticeUrl = "http://${VerticeHost}:${VerticePort}"
Write-Host ""
if ($NoOpen) {
  Write-Host "Servidor pronto em $VerticeUrl (-NoOpen)." -ForegroundColor Green
} else {
  Write-Host "Abrindo $VerticeUrl no navegador..." -ForegroundColor Green
  Start-Process $VerticeUrl
  Start-Sleep -Seconds 2
}

exit 0
