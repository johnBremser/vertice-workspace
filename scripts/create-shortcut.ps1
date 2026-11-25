param(
  [switch]$Desktop,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()

$RootDir = Split-Path -Parent $PSScriptRoot
$IconPath = Join-Path $RootDir 'assets/vertice.ico'
$StartCmd = Join-Path $RootDir 'Iniciar Vertice.cmd'
$StopCmd = Join-Path $RootDir 'Parar Vertice.cmd'

if (-not (Test-Path $IconPath)) {
  throw "Icone nao encontrado: $IconPath. Rode 'python scripts/build-vertice-icon.py' primeiro."
}

$shell = New-Object -ComObject WScript.Shell

function New-VerticeShortcut {
  param(
    [string]$LinkPath,
    [string]$Target,
    [string]$Description
  )
  $link = $shell.CreateShortcut($LinkPath)
  $link.TargetPath = $Target
  $link.IconLocation = "$IconPath,0"
  $link.WorkingDirectory = $RootDir
  $link.Description = $Description
  $link.WindowStyle = 1
  $link.Save()
  if (-not $Quiet) {
    Write-Host "Atalho criado: $LinkPath" -ForegroundColor Green
  }
}

# Atalhos na raiz do projeto (sempre criados).
New-VerticeShortcut -LinkPath (Join-Path $RootDir 'Iniciar Vertice.lnk') -Target $StartCmd -Description 'Inicia o Vertice Workspace local (AionCore + interface web).'
New-VerticeShortcut -LinkPath (Join-Path $RootDir 'Parar Vertice.lnk') -Target $StopCmd -Description 'Encera o servidor do Vertice Workspace.'

# Area de trabalho (opcional): atualiza atalhos existentes que ja apontam para o
# .cmd do projeto e cria o atalho branded "Vertice Workspace".
if ($Desktop) {
  try {
    $desktopDir = [Environment]::GetFolderPath([Environment+SpecialFolder]::Desktop)
    $existing = Get-ChildItem -Path $desktopDir -Filter *.lnk -ErrorAction SilentlyContinue
    foreach ($file in $existing) {
      $candidate = $shell.CreateShortcut($file.FullName)
      if ($candidate.TargetPath -and ($candidate.TargetPath -like (Join-Path $RootDir '*'))) {
        $candidate.IconLocation = "$IconPath,0"
        $candidate.Save()
        if (-not $Quiet) {
          Write-Host "Icone atualizado: $($file.FullName)" -ForegroundColor Green
        }
      }
    }
    New-VerticeShortcut -LinkPath (Join-Path $desktopDir 'Vertice Workspace.lnk') -Target $StartCmd -Description 'Inicia o Vertice Workspace local (AionCore + interface web).'
  } catch {
    if (-not $Quiet) {
      Write-Host "Aviso: nao foi possivel criar o atalho na area de trabalho ($($_.Exception.Message))." -ForegroundColor Yellow
    }
  }
}

if (-not $Quiet) {
  Write-Host "Icone aplicado: $IconPath" -ForegroundColor Cyan
}
