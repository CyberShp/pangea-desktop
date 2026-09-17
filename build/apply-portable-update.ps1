[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PlanPath)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
if ($Plan.schema_version -notin @(1, 2)) { throw 'Unsupported portable update plan.' }

$InstallRoot = [System.IO.Path]::GetFullPath([string]$Plan.install_root)
$InstallParent = [System.IO.Path]::GetDirectoryName($InstallRoot)
$PackagePath = [System.IO.Path]::GetFullPath([string]$Plan.package_path)
$ExecutableName = [string]$Plan.executable_name
$ExpectedVersion = [string]$Plan.expected_version
$PackageType = if ($Plan.package_type) { [string]$Plan.package_type } else { 'full' }
$ExpectedBaseVersion = if ($Plan.expected_base_version) { [string]$Plan.expected_base_version } else { '' }
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

function Copy-PortableUserData([string]$PreviousRoot, [string]$CandidateRoot) {
  # Keep the original intact until the new application reports healthy.
  foreach ($Name in @('local-skills', 'launch-root')) {
    $Source = Join-Path $PreviousRoot $Name
    if (Test-Path -LiteralPath $Source -PathType Container) {
      $Target = Join-Path $CandidateRoot $Name
      if (Test-Path -LiteralPath $Target) { Remove-PortableDirectory $Target }
      $CopyLog = "$LogPath.copy-$Name.log"
      Write-UpdateLog "copying user directory: $Name; details: $CopyLog"
      # PowerShell 5.1 Copy-Item can fail when the longer candidate path exceeds
      # MAX_PATH. Robocopy supports long paths and preserves links without
      # recursively expanding their targets (including repository link cycles).
      & "$env:SystemRoot\System32\robocopy.exe" $Source $Target /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:1 /W:1 /NP /NFL /NDL "/UNILOG:$CopyLog" | Out-Null
      $CopyExit = $LASTEXITCODE
      if ($CopyExit -lt 0 -or $CopyExit -ge 8) {
        throw "User directory copy failed: $Name (robocopy exit $CopyExit). Original data is unchanged. Details: $CopyLog"
      }
      Write-UpdateLog "preserved user directory: $Name"
    }
  }
}

function Remove-PortableDirectory {
  param([string]$Directory)
  # Windows rd supports extended paths and unlinks junctions instead of walking
  # their targets. Pass the path through the environment, not cmd interpolation.
  $FullPath = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  if ($FullPath -eq [IO.Path]::GetPathRoot($FullPath).TrimEnd('\')) { throw 'Refusing to remove a volume root.' }
  $ExtendedPath = if ($FullPath.StartsWith('\\')) { '\\?\UNC\' + $FullPath.Substring(2) } else { '\\?\' + $FullPath }
  $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
  $StartInfo.FileName = "$env:SystemRoot\System32\cmd.exe"
  $StartInfo.Arguments = '/d /v:off /c rd /s /q "%PANGEA_UPDATE_CLEANUP_PATH%"'
  $StartInfo.EnvironmentVariables['PANGEA_UPDATE_CLEANUP_PATH'] = $ExtendedPath
  $StartInfo.UseShellExecute = $false
  $StartInfo.CreateNoWindow = $true
  $Cleanup = [Diagnostics.Process]::Start($StartInfo)
  try {
    $Cleanup.WaitForExit()
    if ($Cleanup.ExitCode -ne 0) { throw "Could not remove temporary update directory: $Directory" }
  } finally { $Cleanup.Dispose() }
}

function Write-UpdateLog {
  param([string]$Message)
  try {
    $Directory = [System.IO.Path]::GetDirectoryName($LogPath)
    New-Item $Directory -ItemType Directory -Force | Out-Null
    $Line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath $LogPath -Value $Line -Encoding UTF8
  } catch {
    # Logging must never prevent the application from being restored.
  }
}

function Write-InstallationProcesses {
  param([string]$Root)
  # These are possible holders, not proof of a file lock. Never kill them.
  $Prefix = $Root.TrimEnd('\') + '\'
  Get-Process | ForEach-Object {
    try {
      if ($_.Path -and $_.Path.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
        Write-UpdateLog "running installation process: $($_.ProcessName) pid=$($_.Id)"
      }
    } catch { }
  }
}

function Move-UpdateDirectory {
  param([string]$Source, [string]$Destination, [int]$TimeoutSeconds = 30)
  Write-UpdateLog "renaming directory: $Source -> $Destination"
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $Attempt = 0
  while ($true) {
    # Directory.Move is a rename, never Move-Item's move-inside-existing-directory.
    if (Test-Path -LiteralPath $Destination) { throw "Rename destination already exists: $Destination" }
    try {
      [System.IO.Directory]::Move($Source, $Destination)
      return
    } catch {
      $Reason = $_.Exception.GetBaseException().Message
      if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw }
      if ($Attempt % 10 -eq 0) {
        Write-UpdateLog "directory rename blocked; waiting for handles to close: $Reason"
        Write-InstallationProcesses $Source
      }
      if ((Get-Date) -ge $Deadline) {
        throw "Cannot rename installation directory '$Source' to '$Destination'. Close applications and terminals using this directory, or check its permissions. No processes were terminated. Details: $Reason"
      }
      $Attempt++
      Start-Sleep -Milliseconds 500
      if ($null -ne $script:UpdateForm -and -not $script:UpdateForm.IsDisposed) {
        [System.Windows.Forms.Application]::DoEvents()
      }
    }
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
    Move-Item -LiteralPath $TemporaryPath $ResultPath -Force
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
    if (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf) {
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
  Write-UpdateLog "$Percent% $Message"
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

function Get-ZipEntry {
  param($Zip, [string]$Path)
  $Normalized = $Path.Replace('\', '/')
  foreach ($Entry in $Zip.Entries) {
    if ($Entry.FullName.Replace('\', '/') -ieq $Normalized) { return $Entry }
  }
  return $null
}

function Read-ZipEntryText {
  param($Zip, [string]$Path)
  $Entry = Get-ZipEntry $Zip $Path
  if ($null -eq $Entry) { throw "Patch entry is missing: $Path" }
  $Reader = [System.IO.StreamReader]::new($Entry.Open(), [System.Text.Encoding]::UTF8, $true)
  try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
}

function Extract-ZipEntry {
  param($Zip, [string]$Path, [string]$Destination)
  $Entry = Get-ZipEntry $Zip $Path
  if ($null -eq $Entry) { throw "Patch entry is missing: $Path" }
  $DestinationFull = [System.IO.Path]::GetFullPath($Destination)
  $Parent = [System.IO.Path]::GetDirectoryName($DestinationFull)
  New-Item $Parent -ItemType Directory -Force | Out-Null
  $ZipInput = $Entry.Open()
  try {
    $Output = [System.IO.File]::Open($DestinationFull, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    try { $ZipInput.CopyTo($Output) } finally { $Output.Dispose() }
  } finally { $ZipInput.Dispose() }
}

function Apply-VerifiedPatch {
  param([string]$Archive, [string]$BaseRoot, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $Patch = Read-ZipEntryText $Zip 'pangea-patch-manifest.json' | ConvertFrom-Json
    if ($Patch.schema_version -ne 1 -or [string]$Patch.product -ne 'PANGEA Desktop') { throw 'Patch manifest is invalid.' }
    if ([string]$Patch.from_version -ne $ExpectedBaseVersion -or [string]$Patch.to_version -ne $ExpectedVersion) {
      throw 'Patch versions do not match the requested update.'
    }
    $TargetManifestText = Read-ZipEntryText $Zip 'target/resources/update/pangea-package-manifest.json'
    $TargetManifest = $TargetManifestText | ConvertFrom-Json
    if ([string]$TargetManifest.version -ne $ExpectedVersion) { throw 'Patch target manifest version is invalid.' }
    if ([string]$TargetManifest.channel -ne [string]$Plan.package_channel) { throw 'Patch target manifest channel is invalid.' }

    Write-UpdateLog "indexing $($TargetManifest.files.Count) target files and $($Patch.files.Count) patch files"
    $TargetFiles = @{}
    foreach ($File in $TargetManifest.files) { $TargetFiles[([string]$File.path).ToLowerInvariant()] = $File }
    $Payload = @{}
    foreach ($File in $Patch.files) {
      $Payload[([string]$File.path).ToLowerInvariant()] = $File
      $Target = $TargetFiles[([string]$File.path).ToLowerInvariant()]
      if ($null -eq $Target -or [long]$Target.size -ne [long]$File.size -or ([string]$Target.sha256) -ne ([string]$File.sha256)) {
        throw "Patch file does not match target manifest: $($File.path)"
      }
      $Entry = Get-ZipEntry $Zip ("payload/" + [string]$File.path)
      if ($null -eq $Entry) { throw "Patch payload is missing: $($File.path)" }
    }

    New-Item $Destination -ItemType Directory -Force | Out-Null
    $Completed = 0
    foreach ($File in $TargetManifest.files) {
      $Relative = [string]$File.path
      $TargetPath = Join-Path $Destination ($Relative.Replace('/', '\'))
      $Key = $Relative.ToLowerInvariant()
      if ($Payload.ContainsKey($Key)) {
        Extract-ZipEntry $Zip ("payload/" + $Relative) $TargetPath
      } else {
        $BasePath = Join-Path $BaseRoot ($Relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $BasePath -PathType Leaf)) { throw "Base package is missing unchanged file: $Relative" }
        $Parent = [System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($TargetPath))
        New-Item $Parent -ItemType Directory -Force | Out-Null
        Copy-Item -LiteralPath $BasePath -Destination $TargetPath -Force
      }
      if ((Get-Item -LiteralPath $TargetPath).Length -ne [long]$File.size) { throw "Patched file size mismatch: $Relative" }
      if ((Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne ([string]$File.sha256)) { throw "Patched file hash mismatch: $Relative" }
      $Completed++
      if ($Completed % 500 -eq 0 -or $Completed -eq $TargetManifest.files.Count) {
        Set-UpdateStage "Verified $Completed / $($TargetManifest.files.Count) files" (42 + [int](24 * $Completed / $TargetManifest.files.Count))
      }
    }
    Extract-ZipEntry $Zip 'target/resources/update/pangea-package-manifest.json' (Join-Path $Destination 'resources\update\pangea-package-manifest.json')
    Extract-ZipEntry $Zip 'target/resources/update/pangea-package-manifest.json.sig' (Join-Path $Destination 'resources\update\pangea-package-manifest.json.sig')
  } finally { $Zip.Dispose() }
}

$Leaf = [System.IO.Path]::GetFileName($InstallRoot.TrimEnd('\'))
$Nonce = [Guid]::NewGuid().ToString('N')
$CandidateRoot = Join-Path $InstallParent "$Leaf.update-$Nonce"
$BackupRoot = Join-Path $InstallParent "$Leaf.previous-$Nonce"
$FailedRoot = Join-Path $InstallParent "$Leaf.failed-$Nonce"
$OriginalMoved = $false
$Swapped = $false
$NewProcess = $null

Open-UpdateWindow
[System.IO.File]::WriteAllText("$PlanPath.ready", 'ready')

try {
  Write-UpdateLog "waiting for PANGEA Desktop process $ParentPid"
  Set-UpdateStage 'Closing the current version...' 12
  try { if ($ParentPid -gt 0) { Wait-Process -Id $ParentPid -Timeout 120 -ErrorAction Stop } } catch {
    if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
      throw 'PANGEA Desktop did not exit before the update timeout.'
    }
  }

  if ([string]::IsNullOrWhiteSpace($InstallParent) -or $InstallRoot -eq [System.IO.Path]::GetPathRoot($InstallRoot)) {
    throw 'The portable application directory is unsafe to replace.'
  }
  if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw 'The downloaded update package is missing.' }
  if ($ExpectedSize -le 0 -or (Get-Item -LiteralPath $PackagePath).Length -ne $ExpectedSize) {
    throw 'The downloaded update package size no longer matches the signed release.'
  }
  if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The expected update hash is invalid.' }
  Set-UpdateStage 'Verifying the update package...' 18
  $ActualSha256 = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) {
    throw 'The downloaded update package no longer matches the signed release.'
  }
  if (-not $ExecutableName.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'The portable executable name is invalid.'
  }

  Set-UpdateStage 'Preparing the new version...' 42
  if ($PackageType -eq 'patch') {
    if ([string]::IsNullOrWhiteSpace($ExpectedBaseVersion)) { throw 'Patch base version is missing.' }
    $BaseManifestPath = Join-Path $InstallRoot 'resources\update\pangea-package-manifest.json'
    if (-not (Test-Path -LiteralPath $BaseManifestPath -PathType Leaf)) { throw 'Installed package manifest is missing.' }
    $BaseManifest = Get-Content -LiteralPath $BaseManifestPath -Raw | ConvertFrom-Json
    if ([string]$BaseManifest.version -ne $ExpectedBaseVersion) {
      throw "Installed version $($BaseManifest.version) does not match patch base $ExpectedBaseVersion."
    }
    # Build and verify beside the installed version; keep it intact on failure.
    Apply-VerifiedPatch $PackagePath $InstallRoot $CandidateRoot
  } elseif ($PackageType -eq 'full') {
    Expand-VerifiedArchive $PackagePath $CandidateRoot
  } else {
    throw "Unsupported package type: $PackageType"
  }
  $CandidateExecutable = Join-Path $CandidateRoot $ExecutableName
  $CandidateManifest = Join-Path $CandidateRoot 'resources\pangea-manifest.json'
  if (-not (Test-Path -LiteralPath $CandidateExecutable -PathType Leaf)) {
    throw "Updated executable is missing: $ExecutableName"
  }
  if (-not (Test-Path -LiteralPath $CandidateManifest -PathType Leaf)) {
    throw 'Updated component manifest is missing.'
  }
  $Manifest = Get-Content -LiteralPath $CandidateManifest -Raw | ConvertFrom-Json
  if ([string]$Manifest.product.version -ne $ExpectedVersion) {
    throw "Updated product version does not match $ExpectedVersion."
  }

  Copy-PortableUserData $InstallRoot $CandidateRoot

  Set-UpdateStage 'Replacing application files...' 68
  Move-UpdateDirectory $InstallRoot $BackupRoot
  $OriginalMoved = $true
  Move-UpdateDirectory $CandidateRoot $InstallRoot
  $Swapped = $true

  $UpdatedExecutable = Join-Path $InstallRoot $ExecutableName
  Remove-Item -LiteralPath $HealthMarker -Force -ErrorAction SilentlyContinue
  $HealthArgument = "--pangea-update-health=`"$HealthMarker`""
  Set-UpdateStage 'Starting the new version...' 82
  $NewProcess = Start-Process -FilePath $UpdatedExecutable `
    -ArgumentList $HealthArgument -PassThru
  Write-UpdateLog "started PANGEA Desktop $ExpectedVersion as process $($NewProcess.Id)"

  Set-UpdateStage 'Checking that the new version is ready...' 92
  $Deadline = (Get-Date).AddSeconds(150)
  while ((Get-Date) -lt $Deadline) {
    if (Test-Path -LiteralPath $HealthMarker -PathType Leaf) {
      Write-UpdateLog "PANGEA Desktop $ExpectedVersion reported healthy"
      Write-UpdateResult 'success' 'The update completed successfully.'
      if (Test-Path -LiteralPath $BackupRoot) {
        try { Remove-PortableDirectory $BackupRoot } catch { Write-UpdateLog $_.Exception.Message }
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
  Write-UpdateLog "failed operation: $($_.InvocationInfo.PositionMessage)"
  Set-UpdateStage 'Update incomplete. Restoring the working version...' 35
  if ($NewProcess -and -not $NewProcess.HasExited) {
    Stop-Process -Id $NewProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  $Restored = -not $OriginalMoved
  try {
   if ($Swapped) {
    if (Test-Path -LiteralPath $InstallRoot) { Move-UpdateDirectory $InstallRoot $FailedRoot }
    if (Test-Path -LiteralPath $BackupRoot) {
      Move-UpdateDirectory $BackupRoot $InstallRoot
      $Restored = $true
      Write-UpdateLog 'previous PANGEA Desktop version restored'
    }
   } elseif ($OriginalMoved -and -not (Test-Path -LiteralPath $InstallRoot) -and (Test-Path -LiteralPath $BackupRoot)) {
    Move-UpdateDirectory $BackupRoot $InstallRoot
    $Restored = $true
    Write-UpdateLog 'previous PANGEA Desktop directory restored'
   }
  } catch {
    $FailureMessage += " Rollback could not complete: $($_.Exception.Message). Original installation retained at '$BackupRoot'."
    Write-UpdateLog $FailureMessage
  }
  if ($Restored -and (Test-Path -LiteralPath $CandidateRoot)) {
    try { Remove-PortableDirectory $CandidateRoot } catch { Write-UpdateLog $_.Exception.Message }
  }
  if ($Restored -and (Test-Path -LiteralPath $FailedRoot)) {
    try { Remove-PortableDirectory $FailedRoot } catch { Write-UpdateLog $_.Exception.Message }
  }

  Write-UpdateResult 'failed' $FailureMessage
  if ($Restored -and (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf)) {
    Start-Process -FilePath $InstalledExecutable | Out-Null
    Write-UpdateLog 'working PANGEA Desktop version restarted'
  }
  Start-Sleep -Milliseconds 500
  Close-UpdateWindow
  exit 1
}
