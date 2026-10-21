[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [int]$TimeoutSeconds = 240
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
$Executable = Join-Path $PackageDirectory 'PANGEA Desktop Dev.exe'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Missing development application: $Executable" }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EvidenceRoot = Join-Path $ProjectRoot '.pangea-build'
$Profile = Join-Path ([IO.Path]::GetTempPath()) "pangea-uiux-$([Guid]::NewGuid().ToString('N'))"
$Marker = Join-Path $Profile 'updates\uiux-health.json'
$PreviousProfile = $env:PANGEA_USER_DATA_DIR
$Process = $null
try {
  New-Item -ItemType Directory -Path $Profile -Force | Out-Null
  $env:PANGEA_USER_DATA_DIR = $Profile
  $Process = Start-Process -FilePath $Executable -ArgumentList "--pangea-update-health=`"$Marker`"" -WorkingDirectory $PackageDirectory -PassThru
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not (Test-Path -LiteralPath $Marker -PathType Leaf)) {
    $Process.Refresh()
    if ($Process.HasExited) { throw "Development application exited before readiness: $($Process.ExitCode)" }
    if ([DateTime]::UtcNow -ge $Deadline) { throw "Development Harness did not reach readiness in $TimeoutSeconds seconds" }
    Start-Sleep -Seconds 1
  }
  $Health = Get-Content -LiteralPath $Marker -Raw | ConvertFrom-Json
  $Package = Get-Content -LiteralPath (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
  if ($Health.version -ne $Package.version) { throw "Unexpected running version: $($Health.version)" }
  @{ status = 'ready'; version = $Health.version; profile = 'isolated temporary profile'; desktop = (& git rev-parse HEAD).Trim() } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvidenceRoot 'uiux-smoke.json') -Encoding UTF8
} finally {
  $env:PANGEA_USER_DATA_DIR = $PreviousProfile
  if ($null -ne $Process -and -not $Process.HasExited) {
    & taskkill.exe /PID $Process.Id /T /F | Out-Null
  }
  $Logs = Join-Path $Profile 'logs'
  if (Test-Path -LiteralPath $Logs) { Copy-Item -LiteralPath $Logs -Destination (Join-Path $EvidenceRoot 'uiux-smoke-logs') -Recurse -Force }
  if (Test-Path -LiteralPath $Profile) { Remove-Item -LiteralPath $Profile -Recurse -Force -ErrorAction SilentlyContinue }
}
