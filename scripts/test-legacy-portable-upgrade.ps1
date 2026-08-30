[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$LegacyCommit = 'b1f1b17994fcb5ea2f7056cde851ae0ab5286c9e'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PackagePath = (Resolve-Path $PackagePath).Path
$TemporaryRoot = Join-Path $env:RUNNER_TEMP "pangea-legacy-upgrade-$([Guid]::NewGuid().ToString('N'))"
$InstallRoot = Join-Path $TemporaryRoot 'PANGEA Desktop'
$LegacyHelper = Join-Path $TemporaryRoot 'apply-portable-update.ps1'
$PlanPath = Join-Path $TemporaryRoot 'update-plan.json'
$LogPath = Join-Path $TemporaryRoot 'apply-update.log'
$OriginalAppData = $env:APPDATA
$OriginalLocalAppData = $env:LOCALAPPDATA

try {
  New-Item $InstallRoot -ItemType Directory -Force | Out-Null
  Copy-Item (Join-Path $env:SystemRoot 'System32\cmd.exe') (Join-Path $InstallRoot 'PANGEA Desktop.exe')

  $LegacySource = & git -C $ProjectRoot show "$LegacyCommit`:build/apply-portable-update.ps1"
  if ($LASTEXITCODE -ne 0 -or -not $LegacySource) {
    throw "Could not load the legacy portable updater from $LegacyCommit."
  }
  Set-Content $LegacyHelper $LegacySource -Encoding UTF8

  $env:APPDATA = Join-Path $TemporaryRoot 'AppData\Roaming'
  $env:LOCALAPPDATA = Join-Path $TemporaryRoot 'AppData\Local'
  New-Item $env:APPDATA, $env:LOCALAPPDATA -ItemType Directory -Force | Out-Null
  $UpdateRoot = Join-Path $env:APPDATA 'pangea-desktop\updates'
  New-Item $UpdateRoot -ItemType Directory -Force | Out-Null
  $HealthMarker = Join-Path $UpdateRoot 'legacy-upgrade-healthy.json'

  $ParentProcess = Start-Process `
    -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
    -ArgumentList '/c', 'ping 127.0.0.1 -n 3 > nul' `
    -WindowStyle Hidden `
    -PassThru

  @{
    schema_version = 1
    parent_pid = $ParentProcess.Id
    package_path = $PackagePath
    install_root = $InstallRoot
    executable_name = 'PANGEA Desktop.exe'
    expected_version = $ExpectedVersion
    expected_size = (Get-Item $PackagePath).Length
    expected_sha256 = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    health_marker = $HealthMarker
    log_path = $LogPath
  } | ConvertTo-Json | Set-Content $PlanPath -Encoding UTF8

  & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') `
    -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File $LegacyHelper -PlanPath $PlanPath
  if ($LASTEXITCODE -ne 0) {
    if (Test-Path $LogPath) { Get-Content $LogPath | Out-Host }
    throw "The legacy updater exited with code $LASTEXITCODE."
  }

  if (-not (Test-Path $HealthMarker -PathType Leaf)) {
    throw 'The upgraded Desktop did not confirm PANGEA product-workspace readiness.'
  }
  $Health = Get-Content $HealthMarker -Raw | ConvertFrom-Json
  if ([string]$Health.version -ne $ExpectedVersion) {
    throw "The upgraded Desktop reported version $($Health.version) instead of $ExpectedVersion."
  }
  $Manifest = Get-Content (Join-Path $InstallRoot 'resources\pangea-manifest.json') -Raw | ConvertFrom-Json
  if ([string]$Manifest.product.version -ne $ExpectedVersion) {
    throw 'The installed component manifest does not match the requested version.'
  }
  if (-not (Test-Path (Join-Path $env:APPDATA 'pangea-desktop\launch-root\pangea-data') -PathType Container)) {
    throw 'First startup did not initialize the PANGEA data directory.'
  }

  Write-Host "Legacy portable upgrade reached PANGEA workspace readiness on $ExpectedVersion."
} catch {
  Write-Host 'Legacy upgrade diagnostics:'
  Get-ChildItem $TemporaryRoot -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- $($_.FullName.Substring($TemporaryRoot.Length + 1))"
    Get-Content $_.FullName -Tail 250 -ErrorAction SilentlyContinue | Out-Host
  }
  throw
} finally {
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($InstallRoot, [System.StringComparison]::OrdinalIgnoreCase) }
    catch { $false }
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  $env:APPDATA = $OriginalAppData
  $env:LOCALAPPDATA = $OriginalLocalAppData
  Start-Sleep -Milliseconds 500
  Remove-Item $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
