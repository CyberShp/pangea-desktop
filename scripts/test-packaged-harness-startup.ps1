[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [int]$TimeoutSeconds = 300
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PackageDirectory = (Resolve-Path $PackageDirectory).Path
$ExecutablePath = Join-Path $PackageDirectory 'PANGEA Desktop.exe'
if (-not (Test-Path $ExecutablePath -PathType Leaf)) {
  throw "Packaged Desktop executable was not found at $ExecutablePath."
}

$TemporaryRoot = Join-Path $env:RUNNER_TEMP "pangea-packaged-smoke-$([Guid]::NewGuid().ToString('N'))"
$SmokeAppData = Join-Path $TemporaryRoot 'appdata'
$UserDataRoot = Join-Path $SmokeAppData 'pangea-desktop'
$ProfileRoot = Join-Path $UserDataRoot 'harness\profiles\web'
$HealthMarker = Join-Path $UserDataRoot 'updates\packaged-harness-healthy.json'
$OriginalAppData = $env:APPDATA
$OriginalLocalAppData = $env:LOCALAPPDATA
$DesktopProcess = $null

try {
  New-Item $ProfileRoot -ItemType Directory -Force | Out-Null
  New-Item (Split-Path -Parent $HealthMarker) -ItemType Directory -Force | Out-Null

  @{
    name = 'legacy-pangea-web'
    private = $true
    dependencies = @{
      'dsh-pangea' = '0.1.0'
      'dsh-pangea-companion' = '0.10.0'
      'dsh-pangea-asset-catalog' = '0.1.0'
    }
    dsh = @{
      profile = @{
        bundles = @(
          '@deepseek-ai/dsh-base'
          '@deepseek-ai/dsh-web-app'
          'dsh-pangea'
          'dsh-pangea-companion'
          'dsh-pangea-asset-catalog'
        )
      }
    }
  } | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $ProfileRoot 'package.json') -Encoding UTF8

  @'
# Legacy PANGEA rows must be removed before the installation-owned bundle loads.
- insert:
    - id: legacy-pangea-workbench
      name: dsh-pangea
    - id: legacy-pangea-companion
      name: dsh-pangea-companion
    - id: legacy-pangea-assets
      name: dsh-pangea-asset-catalog
'@ | Set-Content (Join-Path $ProfileRoot 'cordis.patch.yml') -Encoding UTF8

  $env:APPDATA = $SmokeAppData
  $env:LOCALAPPDATA = Join-Path $TemporaryRoot 'localappdata'
  New-Item $env:LOCALAPPDATA -ItemType Directory -Force | Out-Null

  $DesktopProcess = Start-Process `
    -FilePath $ExecutablePath `
    -ArgumentList @("--user-data-dir=$UserDataRoot", "--pangea-update-health=$HealthMarker") `
    -WorkingDirectory $PackageDirectory `
    -PassThru

  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not (Test-Path $HealthMarker -PathType Leaf)) {
    if ($DesktopProcess.HasExited) {
      throw "Packaged Desktop exited before Harness reached product-workspace readiness (exit $($DesktopProcess.ExitCode))."
    }
    if ([DateTime]::UtcNow -ge $Deadline) {
      throw "Packaged Harness did not reach product-workspace readiness within $TimeoutSeconds seconds."
    }
    Start-Sleep -Seconds 1
    $DesktopProcess.Refresh()
  }

  $Health = Get-Content $HealthMarker -Raw | ConvertFrom-Json
  if ([string]$Health.version -ne $ExpectedVersion) {
    throw "Packaged Desktop reported version $($Health.version) instead of $ExpectedVersion."
  }

  $ManifestPath = Join-Path $ProfileRoot 'package.json'
  $Manifest = Get-Content $ManifestPath -Raw | ConvertFrom-Json
  $Bundles = @($Manifest.dsh.profile.bundles)
  if ($Bundles -notcontains 'dsh-pangea-product') {
    throw 'The migrated profile did not activate dsh-pangea-product.'
  }
  foreach ($LegacyBundle in @('dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog')) {
    if ($Bundles -contains $LegacyBundle) {
      throw "The migrated profile still declares legacy bundle $LegacyBundle."
    }
    if ($null -ne $Manifest.dependencies.PSObject.Properties[$LegacyBundle]) {
      throw "The migrated profile still declares legacy dependency $LegacyBundle."
    }
  }
  $PatchText = Get-Content (Join-Path $ProfileRoot 'cordis.patch.yml') -Raw
  if ($PatchText -match 'name:\s+dsh-pangea(?:-companion|-asset-catalog)?(?:\s|$)') {
    throw 'The migrated profile still contains a direct legacy PANGEA insert.'
  }

  Write-Host "Packaged Harness migrated a legacy PANGEA profile and reached product-workspace readiness on $ExpectedVersion."
} catch {
  Write-Host 'Packaged Harness startup diagnostics:'
  Get-ChildItem $UserDataRoot -Recurse -File -Filter '*.log' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "--- user-data\$($_.FullName.Substring($UserDataRoot.Length + 1))"
    Get-Content $_.FullName -Tail 300 -ErrorAction SilentlyContinue | Out-Host
  }
  if (Test-Path (Join-Path $ProfileRoot 'package.json')) {
    Write-Host '--- migrated profile package.json'
    Get-Content (Join-Path $ProfileRoot 'package.json') -ErrorAction SilentlyContinue | Out-Host
  }
  if (Test-Path (Join-Path $ProfileRoot 'cordis.patch.yml')) {
    Write-Host '--- migrated profile cordis.patch.yml'
    Get-Content (Join-Path $ProfileRoot 'cordis.patch.yml') -ErrorAction SilentlyContinue | Out-Host
  }
  throw
} finally {
  $env:APPDATA = $OriginalAppData
  $env:LOCALAPPDATA = $OriginalLocalAppData
  Get-Process -ErrorAction SilentlyContinue | Where-Object {
    try { $_.Path -and $_.Path.StartsWith($PackageDirectory, [System.StringComparison]::OrdinalIgnoreCase) }
    catch { $false }
  } | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Remove-Item $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
