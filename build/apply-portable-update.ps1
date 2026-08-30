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
$ResultPath = [System.IO.Path]::GetFullPath([string]$Plan.result_path)
$LogPath = [System.IO.Path]::GetFullPath([string]$Plan.log_path)
$ParentPid = [int]$Plan.parent_pid
$InstalledExecutable = Join-Path $InstallRoot $ExecutableName

$UpdateForm = $null
$UpdateLabel = $null
$UpdateProgress = $null

function Write-UpdateLog {
  param([string]$Message)
  try {
    $Directory = [System.IO.Path]::GetDirectoryName($LogPath)
    New-Item $Directory -ItemType Directory -Force | Out-Null
    $Line = "$(Get-Date -Format o) $Message"
    Add-Content -Path $LogPath -Value $Line -Encoding UTF8
  } catch {
    # Logging must never prevent the application from being restored.
  }
}

function Write-UpdateResult {
  param(
    [ValidateSet('success', 'failed')][string]$Status,
    [string]$Message
  )
  try {
    $Directory = [System.IO.Path]::GetDirectoryName($ResultPath)
    New-Item $Directory -ItemType Directory -Force | Out-Null
    $TemporaryPath = "$ResultPath.tmp"
    $Json = @{
      schema_version = 1
      status = $Status
      version = $ExpectedVersion
      message = $Message
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText(
      $TemporaryPath,
      $Json,
      (New-Object System.Text.UTF8Encoding($false))
    )
    Move-Item $TemporaryPath $ResultPath -Force
  } catch {
    Write-UpdateLog "could not persist update result: $($_.Exception.Message)"
  }
}

function Open-UpdateWindow {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing

    $script:UpdateForm = New-Object System.Windows.Forms.Form
    $script:UpdateForm.Text = 'PANGEA Desktop'
    $script:UpdateForm.ClientSize = New-Object System.Drawing.Size(480, 154)
    $script:UpdateForm.StartPosition = 'CenterScreen'
    $script:UpdateForm.FormBorderStyle = 'FixedDialog'
    $script:UpdateForm.MaximizeBox = $false
    $script:UpdateForm.MinimizeBox = $false
    $script:UpdateForm.ControlBox = $false
    $script:UpdateForm.BackColor = [System.Drawing.Color]::White
    $script:UpdateForm.TopMost = $true
    if (Test-Path $InstalledExecutable -PathType Leaf) {
      $script:UpdateForm.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($InstalledExecutable)
    }

    $Title = New-Object System.Windows.Forms.Label
    $Title.Text = "Updating PANGEA Desktop to $ExpectedVersion"
    $Title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 12, [System.Drawing.FontStyle]::Bold)
    $Title.AutoSize = $true
    $Title.Location = New-Object System.Drawing.Point(24, 22)

    $script:UpdateLabel = New-Object System.Windows.Forms.Label
    $script:UpdateLabel.Text = 'Closing the current version...'
    $script:UpdateLabel.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $script:UpdateLabel.ForeColor = [System.Drawing.Color]::FromArgb(88, 94, 102)
    $script:UpdateLabel.AutoSize = $true
    $script:UpdateLabel.Location = New-Object System.Drawing.Point(25, 62)

    $script:UpdateProgress = New-Object System.Windows.Forms.ProgressBar
    $script:UpdateProgress.Style = 'Continuous'
    $script:UpdateProgress.Minimum = 0
    $script:UpdateProgress.Maximum = 100
    $script:UpdateProgress.Value = 5
    $script:UpdateProgress.Size = New-Object System.Drawing.Size(430, 12)
    $script:UpdateProgress.Location = New-Object System.Drawing.Point(25, 103)

    $script:UpdateForm.Controls.Add($Title)
    $script:UpdateForm.Controls.Add($script:UpdateLabel)
    $script:UpdateForm.Controls.Add($script:UpdateProgress)
    $script:UpdateForm.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $script:UpdateForm.TopMost = $false
  } catch {
    Write-UpdateLog "update progress window unavailable: $($_.Exception.Message)"
  }
}

function Set-UpdateStage {
  param([string]$Message, [int]$Percent)
  if ($null -eq $script:UpdateForm -or $script:UpdateForm.IsDisposed) { return }
  $script:UpdateLabel.Text = $Message
  $script:UpdateProgress.Value = [Math]::Max(0, [Math]::Min(100, $Percent))
  [System.Windows.Forms.Application]::DoEvents()
}

function Close-UpdateWindow {
  if ($null -ne $script:UpdateForm -and -not $script:UpdateForm.IsDisposed) {
    $script:UpdateForm.Close()
    $script:UpdateForm.Dispose()
  }
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

$Leaf = [System.IO.Path]::GetFileName($InstallRoot.TrimEnd('\'))
$Nonce = [Guid]::NewGuid().ToString('N')
$CandidateRoot = Join-Path $InstallParent "$Leaf.update-$Nonce"
$BackupRoot = Join-Path $InstallParent "$Leaf.previous"
$FailedRoot = Join-Path $InstallParent "$Leaf.failed-$Nonce"
$OriginalMoved = $false
$Swapped = $false
$NewProcess = $null

Open-UpdateWindow

try {
  Write-UpdateLog "waiting for PANGEA Desktop process $ParentPid"
  Set-UpdateStage 'Closing the current version...' 12
  try { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction Stop } catch {
    if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
      throw 'PANGEA Desktop did not exit before the update timeout.'
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
  Set-UpdateStage 'Verifying the update package...' 18
  $ActualSha256 = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw 'The downloaded update package no longer matches the signed release.'
  }
  if (-not $ExecutableName.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The portable executable name is invalid.'
  }

  Set-UpdateStage 'Preparing the new version...' 42
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

  Set-UpdateStage 'Replacing application files...' 68
  if (Test-Path $BackupRoot) { Remove-Item $BackupRoot -Recurse -Force }
  Move-Item $InstallRoot $BackupRoot
  $OriginalMoved = $true
  Move-Item $CandidateRoot $InstallRoot
  $Swapped = $true

  $UpdatedExecutable = Join-Path $InstallRoot $ExecutableName
  Remove-Item $HealthMarker -Force -ErrorAction SilentlyContinue
  $HealthArgument = "--pangea-update-health=`"$HealthMarker`""
  Set-UpdateStage 'Starting the new version...' 82
  $NewProcess = Start-Process -FilePath $UpdatedExecutable `
    -ArgumentList $HealthArgument -PassThru
  Write-UpdateLog "started PANGEA Desktop $ExpectedVersion as process $($NewProcess.Id)"

  Set-UpdateStage 'Checking that the new version is ready...' 92
  $Deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $Deadline) {
    if (Test-Path $HealthMarker -PathType Leaf) {
      Write-UpdateLog "PANGEA Desktop $ExpectedVersion reported healthy"
      Write-UpdateResult 'success' 'The update completed successfully.'
      if (Test-Path $BackupRoot) {
        Remove-Item $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
      }
      Set-UpdateStage 'Update complete. PANGEA Desktop has restarted.' 100
      Start-Sleep -Milliseconds 700
      Close-UpdateWindow
      exit 0
    }
    if ($NewProcess.HasExited) { throw 'Updated PANGEA Desktop exited before reporting healthy.' }
    Start-Sleep -Milliseconds 500
    $NewProcess.Refresh()
    if ($null -ne $script:UpdateForm -and -not $script:UpdateForm.IsDisposed) {
      [System.Windows.Forms.Application]::DoEvents()
    }
  }
  throw 'Updated PANGEA Desktop did not report healthy before the rollback timeout.'
} catch {
  $FailureMessage = $_.Exception.Message
  Write-UpdateLog "update failed: $FailureMessage"
  Set-UpdateStage 'Update incomplete. Restoring the working version...' 35
  if ($NewProcess -and -not $NewProcess.HasExited) {
    Stop-Process -Id $NewProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  if ($Swapped) {
    if (Test-Path $InstallRoot) { Move-Item $InstallRoot $FailedRoot }
    if (Test-Path $BackupRoot) {
      Move-Item $BackupRoot $InstallRoot
      Write-UpdateLog 'previous PANGEA Desktop version restored'
    }
  } elseif ($OriginalMoved -and -not (Test-Path $InstallRoot) -and (Test-Path $BackupRoot)) {
    Move-Item $BackupRoot $InstallRoot
    Write-UpdateLog 'previous PANGEA Desktop directory restored'
  }
  if (Test-Path $CandidateRoot) {
    Remove-Item $CandidateRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $FailedRoot) {
    Remove-Item $FailedRoot -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-UpdateResult 'failed' $FailureMessage
  if (Test-Path $InstalledExecutable -PathType Leaf) {
    Start-Process -FilePath $InstalledExecutable | Out-Null
    Write-UpdateLog 'working PANGEA Desktop version restarted'
  }
  Start-Sleep -Milliseconds 500
  Close-UpdateWindow
  exit 1
}
