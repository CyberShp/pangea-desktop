[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PlanPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Plan = Get-Content $PlanPath -Raw | ConvertFrom-Json
if ($Plan.schema_version -ne 1) { throw 'Unsupported portable update plan.' }

$InstallRoot = [System.IO.Path]::GetFullPath([string]$Plan.install_root)
$InstallParent = [System.IO.Path]::GetDirectoryName($InstallRoot)
$PackagePath = [System.IO.Path]::GetFullPath([string]$Plan.package_path)
$ExecutableName = [string]$Plan.executable_name
$ExpectedVersion = [string]$Plan.expected_version
$ExpectedSize = [long]$Plan.expected_size
$ExpectedSha256 = [string]$Plan.expected_sha256
$HealthMarker = [System.IO.Path]::GetFullPath([string]$Plan.health_marker)
$LogPath = [System.IO.Path]::GetFullPath([string]$Plan.log_path)
$ParentPid = [int]$Plan.parent_pid

function Write-UpdateLog {
  param([string]$Message)
  $Line = "$(Get-Date -Format o) $Message"
  Add-Content -Path $LogPath -Value $Line -Encoding UTF8
}

function Expand-VerifiedArchive {
  param([string]$Archive, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item $Destination -ItemType Directory -Force | Out-Null
  $DestinationPrefix = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($Entry in $Zip.Entries) {
      $Target = [System.IO.Path]::GetFullPath((Join-Path $Destination $Entry.FullName))
      if (-not $Target.StartsWith($DestinationPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive entry escapes the update directory: $($Entry.FullName)"
      }
      if ([string]::IsNullOrEmpty($Entry.Name)) {
        New-Item $Target -ItemType Directory -Force | Out-Null
        continue
      }
      $TargetParent = [System.IO.Path]::GetDirectoryName($Target)
      New-Item $TargetParent -ItemType Directory -Force | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($Entry, $Target, $true)
    }
  } finally {
    $Zip.Dispose()
  }
}

if ([string]::IsNullOrWhiteSpace($InstallParent) -or $InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot)) {
  throw 'The portable application directory is unsafe to replace.'
}
if (-not (Test-Path $PackagePath -PathType Leaf)) { throw 'The downloaded update package is missing.' }
if ($ExpectedSize -le 0 -or (Get-Item $PackagePath).Length -ne $ExpectedSize) {
  throw 'The downloaded update package size no longer matches the signed release.'
}
if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The expected update hash is invalid.' }
$ActualSha256 = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256) {
  throw 'The downloaded update package no longer matches the signed release.'
}
if (-not $ExecutableName.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'The portable executable name is invalid.'
}

$Leaf = [System.IO.Path]::GetFileName($InstallRoot.TrimEnd('\'))
$Nonce = [Guid]::NewGuid().ToString('N')
$CandidateRoot = Join-Path $InstallParent "$Leaf.update-$Nonce"
$BackupRoot = Join-Path $InstallParent "$Leaf.previous"
$FailedRoot = Join-Path $InstallParent "$Leaf.failed-$Nonce"
$OriginalMoved = $false
$Swapped = $false
$NewProcess = $null

try {
  Write-UpdateLog "waiting for PANGEA Desktop process $ParentPid"
  try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction Stop } catch {
    if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
      throw 'PANGEA Desktop did not exit before the update timeout.'
    }
  }

  Expand-VerifiedArchive $PackagePath $CandidateRoot
  $CandidateExecutable = Join-Path $CandidateRoot $ExecutableName
  $CandidateManifest = Join-Path $CandidateRoot 'resources\pangea-manifest.json'
  if (-not (Test-Path $CandidateExecutable -PathType Leaf)) {
    throw "Updated executable is missing: $ExecutableName"
  }
  if (-not (Test-Path $CandidateManifest -PathType Leaf)) {
    throw 'Updated component manifest is missing.'
  }
  $Manifest = Get-Content $CandidateManifest -Raw | ConvertFrom-Json
  if ([string]$Manifest.product.version -ne $ExpectedVersion) {
    throw "Updated product version does not match $ExpectedVersion."
  }

  if (Test-Path $BackupRoot) { Remove-Item $BackupRoot -Recurse -Force }
  Move-Item $InstallRoot $BackupRoot
  $OriginalMoved = $true
  Move-Item $CandidateRoot $InstallRoot
  $Swapped = $true

  $UpdatedExecutable = Join-Path $InstallRoot $ExecutableName
  Remove-Item $HealthMarker -Force -ErrorAction SilentlyContinue
  $HealthArgument = "--pangea-update-health=`"$HealthMarker`""
  $NewProcess = Start-Process -FilePath $UpdatedExecutable `
    -ArgumentList $HealthArgument -PassThru
  Write-UpdateLog "started PANGEA Desktop $ExpectedVersion as process $($NewProcess.Id)"

  $Deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $Deadline) {
    if (Test-Path $HealthMarker -PathType Leaf) {
      Write-UpdateLog "PANGEA Desktop $ExpectedVersion reported healthy; previous version kept at $BackupRoot"
      exit 0
    }
    if ($NewProcess.HasExited) { throw 'Updated PANGEA Desktop exited before reporting healthy.' }
    Start-Sleep -Milliseconds 500
    $NewProcess.Refresh()
  }
  throw 'Updated PANGEA Desktop did not report healthy before the rollback timeout.'
} catch {
  Write-UpdateLog "update failed: $($_.Exception.Message)"
  if ($NewProcess -and -not $NewProcess.HasExited) {
    Stop-Process -Id $NewProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  if ($Swapped) {
    if (Test-Path $InstallRoot) { Move-Item $InstallRoot $FailedRoot }
    if (Test-Path $BackupRoot) {
      Move-Item $BackupRoot $InstallRoot
      $RestoredExecutable = Join-Path $InstallRoot $ExecutableName
      Start-Process -FilePath $RestoredExecutable | Out-Null
      Write-UpdateLog 'previous PANGEA Desktop version restored and restarted'
    }
  } elseif ($OriginalMoved -and -not (Test-Path $InstallRoot) -and (Test-Path $BackupRoot)) {
    Move-Item $BackupRoot $InstallRoot
    Start-Process -FilePath (Join-Path $InstallRoot $ExecutableName) | Out-Null
    Write-UpdateLog 'previous PANGEA Desktop directory restored and restarted'
  }
  if (Test-Path $CandidateRoot) { Remove-Item $CandidateRoot -Recurse -Force }
  exit 1
}
