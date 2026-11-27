param(
  [switch]$SkipAionCoreDownload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Vertice Workspace - Instalacao Automatica" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host ""

# 1. Ler vertice.config.json
$ConfigPath = Join-Path $RootDir "vertice.config.json"
$AionCoreVersion = "v0.2.2"
$VerticeHost = "127.0.0.1"
$VerticePort = 4173
if (Test-Path $ConfigPath) {
  try {
    $cfg = Get-Content -Path $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.aioncoreVersion) { $AionCoreVersion = [string]$cfg.aioncoreVersion }
    if ($cfg.host) { $VerticeHost = [string]$cfg.host }
    if ($cfg.port) { $VerticePort = [int]$cfg.port }
  } catch {
    Write-Host "[AVISO] Nao foi possivel ler vertice.config.json; usando padroes." -ForegroundColor Yellow
  }
}

# 2. Localizar Node.js compativel (^22.12.0 || ^24.0.0 || >=26.0.0) sem alterar PATH global
Write-Host "[1/4] Verificando Node.js..." -ForegroundColor White
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
    Write-Host "[ERRO] Node.js compativel (^22.12.0 || ^24.0.0 || >=26.0.0) nao encontrado neste computador." -ForegroundColor Red
  }
  Write-Host "       Instale o Node.js 24 LTS em: https://nodejs.org/" -ForegroundColor Yellow
  Write-Host "       Depois de instalar, execute install.cmd novamente." -ForegroundColor Yellow
  exit 1
}

$nodeVerRaw = (& $SelectedNodeExe -v).Trim()
Write-Host "       Node.js compativel encontrado: $nodeVerRaw ($SelectedNodeExe)" -ForegroundColor Green

# 3. Instalar dependencias e gerar build
Write-Host ""
if (Test-Path (Join-Path $RootDir "package-lock.json")) {
  Write-Host "[2/4] Instalando dependencias (npm ci)..." -ForegroundColor White
  & npm ci
} else {
  Write-Host "[2/4] Instalando dependencias (npm install)..." -ForegroundColor White
  & npm install
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERRO] Falha ao instalar dependencias." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "[3/4] Gerando build de producao (npm run build)..." -ForegroundColor White
& npm run build
if ($LASTEXITCODE -ne 0) {
  Write-Host "[ERRO] Falha no npm run build." -ForegroundColor Red
  exit 1
}

# 4. Verificar ou baixar AionCore
Write-Host ""
Write-Host "[4/4] Verificando AionCore ($AionCoreVersion)..." -ForegroundColor White

$BinDir = Join-Path $RootDir ".vertice\bin"
$LocalAionCoreExe = Join-Path $BinDir "aioncore.exe"

if (Test-Path $LocalAionCoreExe) {
  Write-Host "       AionCore ja instalado em: $LocalAionCoreExe" -ForegroundColor Green
} elseif ($SkipAionCoreDownload) {
  Write-Host "       Download do AionCore pulado (-SkipAionCoreDownload)." -ForegroundColor Yellow
} else {
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
  $assetName = "aioncore-$AionCoreVersion-$arch-pc-windows-msvc.zip"
  $baseUrl = "https://github.com/iOfficeAI/AionCore/releases/download/$AionCoreVersion"
  $zipUrl = "$baseUrl/$assetName"
  $checksumsUrl = "$baseUrl/aioncore-checksums.txt"

  New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
  $tempDir = Join-Path $env:TEMP ("vertice-aioncore-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    $zipPath = Join-Path $tempDir $assetName
    $checksumsPath = Join-Path $tempDir "aioncore-checksums.txt"

    Write-Host "       Baixando $assetName do GitHub oficial (iOfficeAI/AionCore)..." -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -Headers @{ "User-Agent" = "vertice-workspace-installer" }

    Write-Host "       Validando integridade SHA-256..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath -UseBasicParsing -Headers @{ "User-Agent" = "vertice-workspace-installer" }
    $expectedLine = Get-Content -Path $checksumsPath | Where-Object { $_ -match [regex]::Escape($assetName) } | Select-Object -First 1
    if (-not $expectedLine) {
      throw "Checksum para $assetName nao encontrado em aioncore-checksums.txt."
    }
    $expectedHash = ($expectedLine.Trim() -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedHash -ne $actualHash) {
      throw "Falha na verificacao SHA-256! Esperado: $expectedHash | Obtido: $actualHash"
    }
    Write-Host "       SHA-256 confirmado com sucesso." -ForegroundColor Green

    Write-Host "       Extraindo aioncore.exe para .vertice\bin\..." -ForegroundColor Cyan
    $extractDir = Join-Path $tempDir "extracted"
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

    $foundExe = Get-ChildItem -Path $extractDir -Filter "aioncore.exe" -Recurse | Select-Object -First 1
    if (-not $foundExe) {
      throw "aioncore.exe nao foi encontrado dentro de $assetName."
    }
    Copy-Item -Path $foundExe.FullName -Destination $LocalAionCoreExe -Force
    Write-Host "       AionCore instalado em: $LocalAionCoreExe" -ForegroundColor Green
  } finally {
    if (Test-Path $tempDir) {
      Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host ""
Write-Host "==================================================" -ForegroundColor Green
Write-Host "  Instalacao concluida com sucesso!" -ForegroundColor Green
Write-Host "  Para abrir o app: de 2 cliques em 'Iniciar Vertice.cmd'" -ForegroundColor Green
Write-Host "  Endereco local:   http://${VerticeHost}:${VerticePort}" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Green
exit 0
