# PANGEA_UPDATE_MONITOR_PROTOCOL=1
[CmdletBinding()]
param([string]$PlanPath, [switch]$ScanLocks, [string]$ScanRoot, [string]$ScanOutput, [string]$WatchExplorer, [switch]$WatchUpdate, [switch]$RecoverOnly, [string]$IOWorker)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$UpdateForm = $null
$UpdateLabel = $null
$UpdateProgress = $null

function Initialize-PortableWorkerJob {
  if ('PangeaPortableWorkerJob' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public sealed class PangeaPortableWorkerJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public Limits Basic; public Io Counters; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long User, Kernel, PeriodUser, PeriodKernel; public uint Faults, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits data, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting data, uint length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr handle;
  public PangeaPortableWorkerJob() {
    handle=CreateJobObject(IntPtr.Zero,null);
    if(handle==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    var limits=new ExtendedLimits(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE, no breakaway
    if(!SetInformationJobObject(handle,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      int error=Marshal.GetLastWin32Error(); Dispose(); throw new Win32Exception(error);
    }
  }
  public void Attach(Process process) {
    if(!AssignProcessToJobObject(handle,process.Handle)) throw new Win32Exception(Marshal.GetLastWin32Error());
  }
  public bool StopAndWait(int milliseconds) {
    if(!TerminateJobObject(handle,1)) return false;
    var timer=Stopwatch.StartNew();
    do {
      Accounting state;
      if(!QueryInformationJobObject(handle,1,out state,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) return false;
      if(state.Active==0) return true;
      Thread.Sleep(50);
    } while(timer.ElapsedMilliseconds<milliseconds);
    return false;
  }
  public void Dispose() { if(handle!=IntPtr.Zero) { CloseHandle(handle); handle=IntPtr.Zero; } }
}
'@
}

function Invoke-PortableIOWorker {
  param([string]$Operation, [hashtable]$Arguments, [int]$TimeoutSeconds = 1800)
  # Workers cannot touch application files before the parent attaches their
  # entire process tree to a kill-on-close job. Parent death also ends robocopy.
  Initialize-PortableWorkerJob
  $Control = New-UpdateControlFile 'io'
  $Context = @{}
  foreach ($Name in @('PlanPath','Plan','LogPath','ExpectedVersion','ExpectedBaseVersion')) {
    $Variable = Get-Variable -Name $Name -ErrorAction SilentlyContinue
    if ($Variable) { $Context[$Name]=$Variable.Value }
  }
  $Config = @{ operation=$Operation; arguments=$Arguments; context=$Context }
  [IO.File]::WriteAllText($Control, ($Config | ConvertTo-Json -Depth 20), (New-Object Text.UTF8Encoding($false)))
  $Quote = { param($Value) "'" + $Value.Replace("'", "''") + "'" }
  $Command = '& ' + (& $Quote $script:UpdaterScriptPath) + ' -IOWorker ' + (& $Quote $Control)
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  $Job = New-Object PangeaPortableWorkerJob
  $Worker = $null; $Attached=$false; $Stopped=$false; [long]$ProgressSequence=0
  try {
    $Worker = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$Encoded) -WorkingDirectory ([IO.Path]::GetDirectoryName($Control)) -WindowStyle Hidden -RedirectStandardOutput "$Control.stdout" -RedirectStandardError "$Control.stderr" -PassThru
    $null=$Worker.Handle
    $Job.Attach($Worker); $Attached=$true
    Write-UpdateLog "IO worker started: operation=$Operation; pid=$($Worker.Id); limit=${TimeoutSeconds}s; control=$Control"
    [IO.File]::WriteAllText("$Control.go", 'attached')
    $Deadline=[DateTime]::UtcNow.AddSeconds([Math]::Max(1,$TimeoutSeconds))
    $LastReport=[DateTime]::UtcNow
    while (-not $Worker.WaitForExit(250)) {
      $ProgressSequence=Publish-PortableIOProgress -Control $Control -LastSequence $ProgressSequence
      if ([DateTime]::UtcNow -ge $Deadline) { throw "File operation timed out: $Operation (${TimeoutSeconds}s). Details: $Control.stderr" }
      if (([DateTime]::UtcNow-$LastReport).TotalSeconds -ge 15) {
        Write-UpdateLog "IO worker still running: operation=$Operation; pid=$($Worker.Id); remaining=$([int]($Deadline-[DateTime]::UtcNow).TotalSeconds)s"
        $LastReport=[DateTime]::UtcNow
      }
    }
    $ProgressSequence=Publish-PortableIOProgress -Control $Control -LastSequence $ProgressSequence
    # Even on success, confirm no helper descendant is left writing a path.
    $Stopped=$Job.StopAndWait(5000)
    if (-not $Stopped) { throw "IO worker descendants did not exit: $Operation" }
    if (-not [IO.File]::Exists("$Control.result")) { throw "IO worker failed: $Operation (exit $($Worker.ExitCode)). Details: $Control.stderr" }
    $Result=[IO.File]::ReadAllText("$Control.result",[Text.Encoding]::UTF8) | ConvertFrom-Json
    if (-not $Result.ok) { throw [string]$Result.error }
    if ($Worker.ExitCode -ne 0) { throw "IO worker failed: $Operation (exit $($Worker.ExitCode)). Details: $Control.stderr" }
    return $Result.value
  } finally {
    if ($Worker -and -not $Stopped) {
      if ($Attached) { $Stopped=$Job.StopAndWait(5000) } else {
        # The gate was never opened: this unassigned child cannot write files.
        try { if (-not $Worker.HasExited) { $Worker.Kill() }; $Stopped=$Worker.WaitForExit(5000) } catch { $Stopped=$false }
      }
      if (-not $Stopped) {
        $script:UnsafeIOWorker=$true
        Write-UpdateLog "UNSAFE IO worker exit unconfirmed: operation=$Operation; pid=$($Worker.Id). Directory changes and rollback must stop."
      }
    }
    if ($Worker) { $Worker.Dispose() }
    $Job.Dispose()
  }
}

function Publish-PortableIOProgress {
  param([string]$Control, [long]$LastSequence=0)
  # Only the supervising updater owns the monitor's progress identity. A short
  # lived IO worker reports stages through a separate private mailbox.
  try {
    if (-not [IO.File]::Exists("$Control.progress")) { return $LastSequence }
    $Progress=[IO.File]::ReadAllText("$Control.progress",[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Progress.schema_version -ne 1 -or [long]$Progress.sequence -le $LastSequence) { return $LastSequence }
    $Parameters=@{State='running';Stage=[string]$Progress.stage;Message=[string]$Progress.message;Percent=[int]$Progress.percent}
    if ($Progress.PSObject.Properties['files_completed']) { $Parameters.FilesCompleted=[int]$Progress.files_completed }
    if ($Progress.PSObject.Properties['files_total']) { $Parameters.FilesTotal=[int]$Progress.files_total }
    Write-UpdateProgress @Parameters
    return [long]$Progress.sequence
  } catch { return $LastSequence }
}

function Invoke-PortableIOWorkerEntry {
  param([string]$Control)
  $Config=[IO.File]::ReadAllText($Control,[Text.Encoding]::UTF8) | ConvertFrom-Json
  $Deadline=[DateTime]::UtcNow.AddSeconds(30)
  while (-not [IO.File]::Exists("$Control.go")) {
    if ([DateTime]::UtcNow -ge $Deadline) { throw 'IO worker was not attached to its supervisor; refusing file operations.' }
    Start-Sleep -Milliseconds 50
  }
  foreach ($Property in $Config.context.PSObject.Properties) { Set-Variable -Name $Property.Name -Value $Property.Value -Scope Script }
  $script:PortableIOWorker=$true
  $script:PortableIOControl=$Control
  $script:PortableIOProgressSequence=0
  $Arguments=@{}
  foreach ($Property in $Config.arguments.PSObject.Properties) { $Arguments[$Property.Name]=$Property.Value }
  try {
    $Value = switch ([string]$Config.operation) {
      'ValidatePackage' {
        if ([long]$Arguments.Size -le 0 -or (Get-Item -LiteralPath $Arguments.Path).Length -ne [long]$Arguments.Size) { throw 'The downloaded update package size no longer matches the signed release.' }
        if ([string]$Arguments.Sha256 -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $Arguments.Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$Arguments.Sha256) { throw 'The downloaded update package no longer matches the signed release.' }
      }
      'Preflight' { Assert-PortableUpdatePreflight @Arguments }
      'Patch' { Apply-VerifiedPatch @Arguments }
      'Extract' { Expand-VerifiedArchive @Arguments }
      'CopyUserData' { Copy-PortableUserData @Arguments }
      'VerifyUserData' { Assert-PortableUserDataUnchanged @Arguments }
      'RemoveDirectory' { Remove-PortableDirectory @Arguments }
      'SnapshotProfile' { New-UpdateProfileSnapshot @Arguments }
      'RestoreProfile' { Restore-UpdateProfileSnapshot @Arguments }
      default { throw "Unsupported IO worker operation: $($Config.operation)" }
    }
    $Result=@{ok=$true;value=$Value}
  } catch { $Result=@{ok=$false;error=$_.Exception.Message}; Write-UpdateLog "IO worker failed: $($Config.operation): $($_.Exception.Message)" }
  [IO.File]::WriteAllText("$Control.result",($Result | ConvertTo-Json -Depth 20),(New-Object Text.UTF8Encoding($false)))
}

function Test-PortableIOWorker {
  return (Get-Variable -Name PortableIOWorker -Scope Script -ErrorAction SilentlyContinue) -and $script:PortableIOWorker
}

function Get-PortableSpaceRequirement {
  param([long]$CandidateBytes, [long]$UserBytes, [long]$EntryCount, [long]$AllocationUnit = 65536)
  if ($CandidateBytes -lt 0 -or $UserBytes -lt 0 -or $EntryCount -lt 0 -or $AllocationUnit -le 0) { throw 'Invalid update space estimate.' }
  # Free space already excludes the installed version and imported archive.
  # Add the new full tree, a second copy of user data, allocation slack and a
  # reserve; the old tree is renamed, not copied to another volume.
  $Peak=[decimal]$CandidateBytes+[decimal]$UserBytes+([decimal]$EntryCount*$AllocationUnit)
  $Reserve=[Math]::Max([decimal](256MB),[Math]::Ceiling($Peak/[decimal]10))
  if ($Peak+$Reserve -gt [long]::MaxValue) { throw 'Update space estimate exceeds supported size.' }
  return [long]($Peak+$Reserve)
}

function Get-PortableProtectedInventory {
  param([string]$InstallRoot)
  Initialize-PortableFileIO
  $ManifestPath=Join-Path $InstallRoot 'resources\update\pangea-package-manifest.json'
  if (-not [PangeaPortableFileIO]::IsFile($ManifestPath)) { throw 'Cannot protect custom installation files: installed package manifest is missing. Keep the original directory and restore its package manifest before retrying.' }
  $Manifest=[IO.File]::ReadAllText($ManifestPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
  if (-not $Manifest.PSObject.Properties['files'] -or -not @($Manifest.files).Count) { throw 'Installed package manifest has no file inventory; custom files cannot be safely classified.' }
  $KnownFiles=@{}; $KnownDirectories=@{}
  $Paths=@($Manifest.files | ForEach-Object { [string]$_.path }) + @('resources/update/pangea-package-manifest.json','resources/update/pangea-package-manifest.json.sig')
  foreach ($Path in $Paths) {
    $Normalized=$Path.Replace('\','/').ToLowerInvariant()
    $null=[PangeaPortableFileIO]::Child($InstallRoot,$Normalized)
    $KnownFiles[$Normalized]=$true
    while ($Normalized.Contains('/')) { $Normalized=$Normalized.Substring(0,$Normalized.LastIndexOf('/')); $KnownDirectories[$Normalized]=$true }
  }
  $Entries=@([PangeaPortableTree]::Inventory($InstallRoot,$false))
  $Unknown=[Collections.Generic.List[string]]::new(); [long]$UnknownCount=0; [long]$UserBytes=0; [long]$UserCount=0
  foreach ($Entry in $Entries) {
    $Relative=$Entry.Path.Replace('\','/').ToLowerInvariant()
    $Top=$Relative.Split('/')[0]
    if ($Top -in @('local-skills','launch-root')) {
      if ($Relative -eq $Top -and $Entry.Kind -ne 'directory') { throw "User-data root must be a real directory, not a file or link: $($Entry.Path). Original data is retained." }
      $UserBytes += [long]$Entry.Length; $UserCount++; continue
    }
    if ($Entry.Kind -eq 'file' -and $KnownFiles.ContainsKey($Relative)) { continue }
    if ($Entry.Kind -eq 'directory' -and $KnownDirectories.ContainsKey($Relative)) { continue }
    # These are the only generated program files excluded by the package
    # builder. Keep this cache exemption; never migrate old program files.
    if (($Entry.Kind -eq 'directory' -and $Relative -match '(^|/)__pycache__$') -or
        ($Entry.Kind -eq 'file' -and $Relative -match '(^|/)__pycache__/[^/]+\.pyc$')) { continue }
    $UnknownCount++
    if ($Unknown.Count -lt 20) { $Unknown.Add([string]$Entry.Path) }
  }
  if ($UnknownCount) {
    # Rebuild only the target package and copy the two protected user roots.
    # Extras stay in the rollback tree until health succeeds, then are deleted
    # with that tree. Never delete from the live installation during preflight.
    Write-UpdateLog ('安装目录清单外条目不迁入新版，将在新版健康检查通过后随旧版本备份删除；数量：' + $UnknownCount + '；示例（最多20项）：' + ($Unknown -join '；'))
  }
  return [pscustomobject]@{UserBytes=$UserBytes;UserCount=$UserCount}
}

function Assert-PortableUpdatePreflight {
  param([string]$InstallRoot, [string]$PackagePath, [string]$PackageType)
  if (-not (Test-PortableIOWorker)) {
    return Invoke-PortableIOWorker -Operation Preflight -Arguments @{InstallRoot=$InstallRoot;PackagePath=$PackagePath;PackageType=$PackageType} -TimeoutSeconds 600
  }
  Initialize-PortableFileIO
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Inventory=Get-PortableProtectedInventory $InstallRoot
  [long]$UserBytes=$Inventory.UserBytes; [long]$UserCount=$Inventory.UserCount
  [long]$CandidateBytes=0; [long]$CandidateCount=0
  $Zip=[IO.Compression.ZipFile]::OpenRead($PackagePath)
  try {
    if ($PackageType -eq 'patch') {
      $Target=Read-ZipEntryText $Zip 'target/resources/update/pangea-package-manifest.json' | ConvertFrom-Json
      foreach ($File in $Target.files) {
        if ([long]$File.size -lt 0) { throw 'Invalid target file size.' }
        $CandidateBytes += [long]$File.size; $CandidateCount++
      }
      foreach ($Name in @('target/resources/update/pangea-package-manifest.json','target/resources/update/pangea-package-manifest.json.sig')) {
        $Entry=Get-ZipEntry $Zip $Name
        if (-not $Entry) { throw "Package metadata is missing: $Name" }
        $CandidateBytes += [long]$Entry.Length; $CandidateCount++
      }
    } elseif ($PackageType -eq 'full') {
      foreach ($Entry in $Zip.Entries) { $CandidateBytes += [long]$Entry.Length; $CandidateCount++ }
    } else { throw "Unsupported package type: $PackageType" }
  } finally { $Zip.Dispose() }
  $Parent=[IO.Path]::GetDirectoryName($InstallRoot)
  $Unit=[PangeaPortableTree]::AllocationUnit($Parent)
  # Count another allocation unit for possible parent directories per file.
  # Profile rollback retains both the original settings snapshot and the
  # attempted-version settings, each bounded to 256 MiB by its own helper.
  $Required=Get-PortableSpaceRequirement ($CandidateBytes+512MB) $UserBytes (($CandidateCount*2)+$UserCount) $Unit
  $Available=[PangeaPortableTree]::AvailableBytes($Parent)
  Write-UpdateLog "disk preflight: install=$InstallRoot; available=$Available; required=$Required; candidate=$CandidateBytes; user-data=$UserBytes; profile-rollback-budget=536870912; allocation=$Unit"
  if ($Available -lt $Required) {
    throw ("安装盘空间不足：需要额外 {0:N2} GiB（新版本、用户数据副本及余量），可用 {1:N2} GiB。原版本未替换。" -f ($Required/1GB),($Available/1GB))
  }
  return [pscustomobject]@{required_bytes=$Required;available_bytes=$Available;candidate_bytes=$CandidateBytes;user_bytes=$UserBytes}
}

function Stop-PortableOwnedWriters {
  param([string]$InstallRoot, [int]$TimeoutSeconds=60)
  if (-not $script:AutomaticUpdateCleanup -or -not @($script:OwnedUpdateProcesses).Count) { return }
  Initialize-HandleInspector
  $Deadline=[DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  # The handoff snapshot predates Desktop exit. Refresh descendants while
  # their captured parent identity is still provable, including writers whose
  # executable lives outside the installation and has no directory handle.
  $Rows=@(Get-CimInstance Win32_Process -OperationTimeoutSec (Get-UpdateServiceBudget $Deadline) -ErrorAction Stop)
  $Known=@{}
  foreach ($Owned in $script:OwnedUpdateProcesses) {
    $Fresh=[PangeaUpdateHandles]::Inspect([int]$Owned.Id)
    if ($Fresh -and $Fresh.Created -eq $Owned.Created -and $Fresh.Executable -ieq $Owned.Executable) { $Known[[int]$Fresh.Id]=$Fresh }
  }
  do {
    $Added=$false
    foreach ($Row in $Rows) {
      $ChildId=[int]$Row.ProcessId; $OwnerId=[int]$Row.ParentProcessId
      if ($Known.ContainsKey($ChildId) -or -not $Known.ContainsKey($OwnerId)) { continue }
      $Child=[PangeaUpdateHandles]::Inspect($ChildId)
      if (-not $Child -or $Child.Created -lt $Known[$OwnerId].Created) { continue }
      $Known[$ChildId]=$Child; $Added=$true
      $script:OwnedUpdateProcesses += [pscustomobject]@{Id=$Child.Id;Created=$Child.Created;Executable=$Child.Executable}
    }
  } while ($Added)
  $Stopped=@{}
  foreach ($Owned in $script:OwnedUpdateProcesses) {
    if ($Stopped.ContainsKey([int]$Owned.Id)) { continue }
    $Fresh=[PangeaUpdateHandles]::Inspect([int]$Owned.Id)
    if (-not $Fresh) {
      if (Get-Process -Id ([int]$Owned.Id) -ErrorAction SilentlyContinue) { throw "Cannot verify whether Desktop descendant PID $($Owned.Id) is still writing data; original data is retained." }
      continue
    }
    if ($Fresh.Created -ne $Owned.Created -or $Fresh.Executable -ine $Owned.Executable) { continue }
    $Services=@(Get-CimInstance Win32_Service -Filter "State='Running'" -OperationTimeoutSec (Get-UpdateServiceBudget $Deadline) -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
    $Policy=Get-UpdateHolderPolicy $Fresh $script:OwnedUpdateProcesses $Services $script:ProtectedUpdateProcesses
    if ($Policy -ne 'owned') { throw "Cannot quiesce protected Desktop descendant before data copy: $($Fresh.Name) (PID $($Fresh.Id)); policy=$Policy. Original data is retained." }
    if (($Deadline-[DateTime]::UtcNow).TotalSeconds -lt 5 -or -not (Stop-UpdateHolder $Fresh)) { throw "Could not stop verified Desktop writer before data copy: $($Fresh.Name) (PID $($Fresh.Id)). Original data is retained." }
    $Stopped[[int]$Fresh.Id]=$true
    Write-UpdateLog "stopped verified Desktop descendant before data copy: $($Fresh.Name); pid=$($Fresh.Id); executable=$($Fresh.Executable)"
  }
}

function Assert-PortableUserDataQuiescent {
  param([string]$PreviousRoot, [int]$TimeoutSeconds=60, [switch]$InspectOnly)
  $Deadline=[DateTime]::UtcNow.AddSeconds([Math]::Max(1,$TimeoutSeconds))
  foreach ($Name in @('local-skills','launch-root')) {
    $Root=Join-Path $PreviousRoot $Name
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { continue }
    # A FILE_SHARE_DELETE writer can survive a directory rename. Hash equality
    # alone is not sufficient: inspect user-data handles before copying and
    # again on both sides of the old-directory rename. Use the same verified
    # cleanup policy as rename, then require a fresh, empty inspection.
    $Holders=@(Get-UpdateLockHolders -Root $Root -TimeoutMilliseconds (Get-UpdateScanBudget $Deadline))
    if (-not $Holders.Count) { continue }
    if ($InspectOnly) {
      $Resolution=[pscustomobject]@{Detail='数据验证期间出现了新的占用，请关闭写入程序后重试。'}
      $Remaining=$Holders
    } else {
      Write-UpdateLog "user-data quiescence: $Name has $($Holders.Count) holders; resolving before copy/version switch"
      $Resolution=Resolve-UpdateDirectoryLocks -Root $Root -Deadline $Deadline
      $Remaining=@(Get-UpdateLockHolders -Root $Root -TimeoutMilliseconds (Get-UpdateScanBudget $Deadline))
    }
    if ($Remaining.Count) {
      $Names=@($Remaining | ForEach-Object { "$($_.Name) (PID $($_.Id))" }) -join '、'
      throw "用户数据目录仍被进程占用，复制或切换已停止：$Name；$Names。原数据及备份已保留。$($Resolution.Detail)"
    }
    Write-UpdateLog "user-data quiescence confirmed after cleanup: $Name"
  }
}

function Assert-PortableUserDataUnchanged {
  param([string]$PreviousRoot, [string]$CandidateRoot, $Snapshots=$null)
  if (-not (Test-PortableIOWorker)) {
    if (-not (Get-Variable -Name PortableUserDataSnapshot -Scope Script -ErrorAction SilentlyContinue)) { throw 'User-data verification snapshot is missing; refusing version switch.' }
    Assert-PortableUserDataQuiescent -PreviousRoot $PreviousRoot
    Invoke-PortableIOWorker -Operation VerifyUserData -Arguments @{PreviousRoot=$PreviousRoot;CandidateRoot=$CandidateRoot;Snapshots=$script:PortableUserDataSnapshot} | Out-Null
    Assert-PortableUserDataQuiescent -PreviousRoot $PreviousRoot -InspectOnly
    return
  }
  Initialize-PortableFileIO
  # Repeat inventory validation after copying and after the old-root rename.
  # Only the two protected roots are migrated; other extras retire with backup.
  if ([PangeaPortableFileIO]::IsFile((Join-Path $PreviousRoot 'resources\update\pangea-package-manifest.json'))) {
    Get-PortableProtectedInventory $PreviousRoot | Out-Null
  }
  foreach ($Name in @('local-skills','launch-root')) {
    $Source=Join-Path $PreviousRoot $Name
    $Target=Join-Path $CandidateRoot $Name
    $Expected=[string]$Snapshots.$Name
    $Actual=if (Test-Path -LiteralPath $Source -PathType Container) { [PangeaPortableTree]::Fingerprint($Source) } else { 'missing' }
    if ($Actual -ne $Expected) { throw "User directory changed after copy: $Name. Version switch stopped; original data is retained." }
    if ($Expected -ne 'missing' -and [PangeaPortableTree]::Fingerprint($Target) -ne $Expected) { throw "Candidate user directory changed after verification: $Name. Original data is retained." }
  }
}

function Copy-PortableUserData([string]$PreviousRoot, [string]$CandidateRoot) {
  if (-not (Test-PortableIOWorker)) {
    Assert-PortableUserDataQuiescent -PreviousRoot $PreviousRoot
    $script:PortableUserDataSnapshot = Invoke-PortableIOWorker -Operation CopyUserData -Arguments @{PreviousRoot=$PreviousRoot;CandidateRoot=$CandidateRoot}
    Assert-PortableUserDataQuiescent -PreviousRoot $PreviousRoot -InspectOnly
    return
  }
  Initialize-PortableFileIO
  if ([PangeaPortableFileIO]::IsFile((Join-Path $PreviousRoot 'resources\update\pangea-package-manifest.json'))) {
    Get-PortableProtectedInventory $PreviousRoot | Out-Null
  }
  $Snapshots=@{}
  # Keep the original intact until the new application reports healthy.
  foreach ($Name in @('local-skills', 'launch-root')) {
    $Source = Join-Path $PreviousRoot $Name
    if (Test-Path -LiteralPath $Source -PathType Container) {
      $Target = Join-Path $CandidateRoot $Name
      if (Test-Path -LiteralPath $Target) { Remove-PortableDirectory $Target }
      $CopyLog = "$LogPath.copy-$Name.log"
      Set-UpdateStage "正在保留用户数据：$Name（含工作区、任务和本地技能）…" 70 'user-data'
      Write-UpdateLog "copying user directory: $Name; details: $CopyLog"
      # PowerShell 5.1 Copy-Item can fail when the longer candidate path exceeds
      # MAX_PATH. Robocopy supports long paths and preserves links without
      # recursively expanding their targets (including repository link cycles).
      & "$env:SystemRoot\System32\robocopy.exe" $Source $Target /E /COPY:DAT /DCOPY:DAT /SL /SJ /R:1 /W:1 /NP /NFL /NDL "/UNILOG:$CopyLog" | Out-Null
      $CopyExit = $LASTEXITCODE
      if ($CopyExit -lt 0 -or $CopyExit -ge 8) {
        throw "User directory copy failed: $Name (robocopy exit $CopyExit). Original data is unchanged. Details: $CopyLog"
      }
      $Before=[PangeaPortableTree]::Fingerprint($Source)
      $Copied=[PangeaPortableTree]::Fingerprint($Target)
      $After=[PangeaPortableTree]::Fingerprint($Source)
      if ($Before -ne $After -or $After -ne $Copied) { throw "User directory changed during copy or verification failed: $Name. Stop applications writing this data and retry; original data is retained." }
      $Snapshots[$Name]=$After
      Write-UpdateLog "preserved user directory: $Name"
    } else { $Snapshots[$Name]='missing' }
  }
  return $Snapshots
}

function Remove-PortableDirectory {
  param([string]$Directory)
  if (-not (Test-PortableIOWorker)) { Invoke-PortableIOWorker -Operation RemoveDirectory -Arguments @{Directory=$Directory} -TimeoutSeconds 300 | Out-Null; return }
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

function Get-UpdateProfileFiles {
  # Only configuration touched by Desktop/Harness startup belongs to this
  # transaction. Sessions, credentials, reports, plugins and repositories do not.
  return @('package.json', 'cordis.patch.yml', 'cordis.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.npmrc', '.install-complete') | ForEach-Object { 'harness/profiles/web/' + $_ }
}

function Assert-UpdateProfilePath {
  param([string]$Path)
  $Full = [IO.Path]::GetFullPath($Path)
  $Cursor = $Full
  while ($Cursor) {
    $Attributes = $null
    try { $Attributes = [IO.File]::GetAttributes($Cursor) }
    catch [IO.FileNotFoundException] { }
    catch [IO.DirectoryNotFoundException] { }
    if ($null -ne $Attributes) {
      if (($Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Profile transaction refuses a linked path: $Cursor"
      }
    }
    $Next = [IO.Path]::GetDirectoryName($Cursor)
    if ($Next -eq $Cursor) { break }
    $Cursor = $Next
  }
  return $Full
}

function Test-UpdateProfileFile {
  param([string]$Path)
  # File.Exists hides access errors by returning false. A denied original must
  # never be recorded as absent and deleted by a later rollback.
  $Full = Assert-UpdateProfilePath $Path
  try { $Attributes = [IO.File]::GetAttributes($Full) }
  catch [IO.FileNotFoundException] { return $false }
  catch [IO.DirectoryNotFoundException] { return $false }
  if (($Attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw "Expected a profile file, found a directory: $Full" }
  return $true
}

function Get-UpdateProfileHash {
  param([byte[]]$Bytes)
  $Hash = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($Hash.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $Hash.Dispose() }
}

function Read-UpdateProfileBytes {
  param([string]$Path)
  $Full = Assert-UpdateProfilePath $Path
  if ([IO.Directory]::Exists($Full)) { throw "Expected a profile file, found a directory: $Full" }
  $Stream = [IO.File]::Open($Full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($Stream.Length -gt 64MB) { throw "Profile configuration exceeds the 64 MiB snapshot limit: $Full" }
    $Memory = New-Object IO.MemoryStream
    try {
      $Stream.CopyTo($Memory)
      if ($Memory.Length -gt 64MB) { throw "Profile configuration grew beyond its snapshot limit: $Full" }
      return ,$Memory.ToArray()
    } finally { $Memory.Dispose() }
  } finally { $Stream.Dispose() }
}

function Write-UpdateProfileBytes {
  param([string]$Path, [byte[]]$Bytes, [switch]$CreateOnly)
  $Full = Assert-UpdateProfilePath $Path
  if ([IO.Directory]::Exists($Full)) { throw "Expected a profile file, found a directory: $Full" }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Full)) | Out-Null
  $Temporary = Join-Path ([IO.Path]::GetDirectoryName($Full)) ('.profile-' + [guid]::NewGuid().ToString('N') + '.tmp')
  try {
    $Stream = [IO.File]::Open($Temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $Stream.Write($Bytes, 0, $Bytes.Length); $Stream.Flush($true) } finally { $Stream.Dispose() }
    Assert-UpdateProfilePath $Full | Out-Null
    if ((Test-UpdateProfileFile $Full) -and -not $CreateOnly) { [IO.File]::Replace($Temporary, $Full, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Full) }
  } finally {
    if ([IO.File]::Exists($Temporary)) { [IO.File]::Delete($Temporary) }
  }
}

function Assert-UpdateProfileQuiescent {
  param([string]$UserDataRoot)
  $ProfileRoot = Assert-UpdateProfilePath (Join-Path $UserDataRoot 'harness/profiles/web')
  # External Node/Python executables can keep writing this profile without
  # holding the application directory. Only captured and freshly verified
  # Desktop descendants may be stopped; all other holders block restoration.
  Stop-PortableOwnedWriters -InstallRoot $UserDataRoot -TimeoutSeconds 30
  if (-not [IO.Directory]::Exists($ProfileRoot)) { return }
  $Holders = @(Get-UpdateLockHolders -Root $ProfileRoot -TimeoutMilliseconds 15000)
  if ($Holders.Count) {
    $Details = @($Holders | ForEach-Object { "$($_.Name) (PID $($_.Id))" }) -join '、'
    throw "外部用户配置仍被进程占用，配置快照或恢复已停止，原文件已保留：$Details。请关闭这些进程后重试恢复。"
  }
}

function New-UpdateProfileSnapshot {
  param([string]$UserDataRoot, [string]$SnapshotRoot)
  if (-not (Test-PortableIOWorker)) {
    Assert-UpdateProfileQuiescent -UserDataRoot $UserDataRoot
    Invoke-PortableIOWorker -Operation SnapshotProfile -Arguments @{UserDataRoot=$UserDataRoot; SnapshotRoot=$SnapshotRoot} -TimeoutSeconds 180 | Out-Null
    return
  }
  $UserRoot = (Assert-UpdateProfilePath $UserDataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $Snapshot = Assert-UpdateProfilePath $SnapshotRoot
  if ([IO.Directory]::Exists($Snapshot) -or [IO.File]::Exists($Snapshot)) { throw "Profile snapshot already exists: $Snapshot" }
  [IO.Directory]::CreateDirectory($Snapshot) | Out-Null
  # .npmrc and user patch layers can contain private connection settings. Do
  # not inherit a broadly readable install-drive ACL for their backup copies.
  if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) {
    $Acl = Get-Acl -LiteralPath $Snapshot
    $Acl.SetAccessRuleProtection($true, $false)
    $Inheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    $CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $SystemUser = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    foreach ($Identity in @($CurrentUser, $SystemUser)) {
      $Rule = New-Object Security.AccessControl.FileSystemAccessRule($Identity, [Security.AccessControl.FileSystemRights]::FullControl, $Inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $Acl.AddAccessRule($Rule)
    }
    Set-Acl -LiteralPath $Snapshot -AclObject $Acl
  }
  $Entries = @(); $TotalBytes = [long]0
  foreach ($Relative in @(Get-UpdateProfileFiles)) {
    $Source = Assert-UpdateProfilePath (Join-Path $UserRoot $Relative)
    if ([IO.Directory]::Exists($Source)) { throw "Expected a profile file, found a directory: $Source" }
    $Exists = Test-UpdateProfileFile $Source
    $Size = [long]0; $Sha256 = $null
    if ($Exists) {
      $Bytes = Read-UpdateProfileBytes $Source
      $Size = $Bytes.LongLength; $TotalBytes += $Size
      if ($TotalBytes -gt 256MB) { throw 'Profile configuration exceeds the 256 MiB total snapshot limit.' }
      $Sha256 = Get-UpdateProfileHash $Bytes
      Write-UpdateProfileBytes (Join-Path (Join-Path $Snapshot 'original') $Relative) $Bytes -CreateOnly
    }
    $Entries += @{ path=$Relative; existed=$Exists; size=$Size; sha256=$Sha256 }
  }
  $Manifest = @{ schema_version=1; user_data_root=$UserRoot; files=$Entries; created_at=[DateTime]::UtcNow.ToString('o') }
  $Json = ConvertTo-Json -InputObject $Manifest -Depth 5
  Write-UpdateProfileBytes (Join-Path $Snapshot 'profile.json') ([Text.Encoding]::UTF8.GetBytes($Json)) -CreateOnly
  Write-UpdateLog "External profile configuration snapshot saved: $Snapshot"
}

function Restore-UpdateProfileSnapshot {
  param([string]$UserDataRoot, [string]$SnapshotRoot)
  if (-not (Test-PortableIOWorker)) {
    Assert-UpdateProfileQuiescent -UserDataRoot $UserDataRoot
    Invoke-PortableIOWorker -Operation RestoreProfile -Arguments @{UserDataRoot=$UserDataRoot; SnapshotRoot=$SnapshotRoot} -TimeoutSeconds 180 | Out-Null
    return
  }
  $UserRoot = (Assert-UpdateProfilePath $UserDataRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $Snapshot = Assert-UpdateProfilePath $SnapshotRoot
  $ManifestPath = Join-Path $Snapshot 'profile.json'
  $Manifest = [Text.Encoding]::UTF8.GetString((Read-UpdateProfileBytes $ManifestPath)) | ConvertFrom-Json
  if ($Manifest.schema_version -ne 1 -or [string]$Manifest.user_data_root -cne $UserRoot) { throw 'Profile snapshot identity does not match this user data directory.' }
  $Allowed = @(Get-UpdateProfileFiles)
  if (@($Manifest.files).Count -ne $Allowed.Count) { throw 'Profile snapshot has an incomplete file list.' }
  $Validated = @(); $Seen = @{}; $TotalBytes = [long]0
  # Validate every saved file before changing any live configuration.
  foreach ($Entry in @($Manifest.files)) {
    $Relative = [string]$Entry.path
    if ($Relative -cnotin $Allowed -or $Seen.ContainsKey($Relative)) { throw 'Profile snapshot contains an unexpected or duplicate path.' }
    if ($Entry.existed -isnot [bool]) { throw 'Profile snapshot has an invalid presence record.' }
    $Seen[$Relative] = $true
    $Target = Assert-UpdateProfilePath (Join-Path $UserRoot $Relative)
    if ([IO.Directory]::Exists($Target)) { throw "Expected a profile file, found a directory: $Target" }
    $Bytes = $null
    if ($Entry.existed) {
      if ([long]$Entry.size -lt 0 -or [long]$Entry.size -gt 64MB -or [string]$Entry.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'Profile snapshot has invalid file metadata.' }
      $Bytes = Read-UpdateProfileBytes (Join-Path (Join-Path $Snapshot 'original') $Relative)
      $TotalBytes += $Bytes.LongLength
      if ($TotalBytes -gt 256MB -or $Bytes.LongLength -ne [long]$Entry.size -or (Get-UpdateProfileHash $Bytes) -cne [string]$Entry.sha256) { throw "Profile snapshot integrity check failed: $Relative" }
    } elseif ([long]$Entry.size -ne 0 -or $null -ne $Entry.sha256) { throw 'Profile snapshot has invalid absent-file metadata.' }
    $Validated += [pscustomobject]@{ Relative=$Relative; Target=$Target; Existed=[bool]$Entry.existed; Bytes=$Bytes }
  }
  foreach ($File in $Validated) {
    Assert-UpdateProfilePath $File.Target | Out-Null
    # Preserve the failed version's first observed configuration before any
    # replacement/deletion. A repeated interrupted rollback keeps this copy.
    if (Test-UpdateProfileFile $File.Target) {
      $Attempted = Join-Path (Join-Path $Snapshot 'attempted') $File.Relative
      Assert-UpdateProfilePath $Attempted | Out-Null
      if (-not (Test-UpdateProfileFile $Attempted)) {
        Write-UpdateProfileBytes $Attempted (Read-UpdateProfileBytes $File.Target) -CreateOnly
      }
    }
    if ($File.Existed) { Write-UpdateProfileBytes $File.Target $File.Bytes }
    elseif (Test-UpdateProfileFile $File.Target) { [IO.File]::Delete($File.Target) }
  }
  # The new version may have altered node_modules. Restoring an old success
  # fingerprint must not claim that those packages still match the old graph.
  $InstallMarker = Assert-UpdateProfilePath (Join-Path $UserRoot 'harness/profiles/web/.install-complete')
  if (Test-UpdateProfileFile $InstallMarker) { [IO.File]::Delete($InstallMarker) }
  Write-UpdateLog "External profile configuration restored; failed-version configuration retained at $(Join-Path $Snapshot 'attempted')"
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

function Initialize-HandleInspector {
  if ('PangeaUpdateHandles' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Principal;
public class PangeaHolder {
  public int Id; public long Created; public string Name; public string Executable;
  public string Path; public bool Critical; public bool SameUser; public int Session;
}
public static class PangeaUpdateHandles {
  [StructLayout(LayoutKind.Sequential)] struct Entry {
    public IntPtr Object; public UIntPtr ProcessId; public UIntPtr Handle;
    public uint Access; public ushort Trace; public ushort Type; public uint Attributes; public uint Reserved;
  }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr data, int size, out int required);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int id);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr process, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr handle, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsProcessCritical(IntPtr handle, out bool critical);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  static bool SameUser(IntPtr process) {
    IntPtr token;
    if (!OpenProcessToken(process, 8, out token)) return false;
    try { using (var identity = new WindowsIdentity(token)) return identity.User == WindowsIdentity.GetCurrent().User; }
    finally { CloseHandle(token); }
  }
  static string Normalize(string path) {
    if (path.StartsWith(@"\\?\UNC\")) return @"\\" + path.Substring(8);
    return path.StartsWith(@"\\?\") ? path.Substring(4) : path;
  }
  public static PangeaHolder[] Scan(string root) {
    root = Path.GetFullPath(root).TrimEnd('\\');
    var found = new Dictionary<int,PangeaHolder>();
    IntPtr reference = CreateFile(root, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (reference == new IntPtr(-1)) throw new IOException("Cannot inspect directory handles: " + Marshal.GetLastWin32Error());
    IntPtr data = IntPtr.Zero;
    try {
      int size = 1048576, required, status;
      do {
        if (data != IntPtr.Zero) Marshal.FreeHGlobal(data);
        data = Marshal.AllocHGlobal(size);
        status = NtQuerySystemInformation(64, data, size, out required);
        if (status == unchecked((int)0xC0000004)) size = Math.Max(size * 2, required + 65536);
        if (size > 268435456) throw new IOException("Handle table exceeds inspection limit.");
      } while (status == unchecked((int)0xC0000004));
      if (status != 0) throw new IOException("Handle inspection unavailable: " + status);
      long count = Marshal.ReadIntPtr(data).ToInt64();
      int width = Marshal.SizeOf(typeof(Entry)), self = Process.GetCurrentProcess().Id;
      if (count < 0 || count > (size - IntPtr.Size * 2) / width) throw new IOException("Unsupported handle table layout.");
      ushort fileType = 0;
      for (long i=0; i<count; i++) {
        var e = (Entry)Marshal.PtrToStructure(IntPtr.Add(data, checked(IntPtr.Size*2 + (int)i*width)), typeof(Entry));
        if (e.ProcessId.ToUInt64() == (ulong)self && e.Handle.ToUInt64() == (ulong)reference.ToInt64()) { fileType=e.Type; break; }
      }
      if (fileType == 0) throw new IOException("File handle type unavailable.");
      for (long i=0; i<count; i++) {
        var e = (Entry)Marshal.PtrToStructure(IntPtr.Add(data, checked(IntPtr.Size*2 + (int)i*width)), typeof(Entry));
        if (e.Type != fileType || e.ProcessId.ToUInt64() > int.MaxValue) continue;
        int id = (int)e.ProcessId.ToUInt64();
        if (id <= 4 || id == self || found.ContainsKey(id)) continue;
        IntPtr process = OpenProcess(0x1040, false, id);
        if (process == IntPtr.Zero) continue;
        try {
          IntPtr handle;
          if (!DuplicateHandle(process, new IntPtr((long)e.Handle.ToUInt64()), GetCurrentProcess(), out handle, 0, false, 2)) continue;
          try {
            if (GetFileType(handle) != 1) continue;
            var path = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
            if (length == 0 || length >= path.Capacity) continue;
            string name = Normalize(path.ToString());
            if (!name.Equals(root,StringComparison.OrdinalIgnoreCase) && !name.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) continue;
            long created, exited, kernel, user;
            if (!GetProcessTimes(process,out created,out exited,out kernel,out user)) continue;
            bool critical;
            if (!IsProcessCritical(process,out critical)) critical = true;
            try {
              using (var p = Process.GetProcessById(id)) {
                if (p.StartTime.ToUniversalTime().ToFileTimeUtc() != created) continue;
                found[id] = new PangeaHolder {Id=id, Created=created, Name=p.ProcessName,
                  Executable=p.MainModule.FileName, Path=name, Critical=critical,
                  SameUser=SameUser(process), Session=p.SessionId};
              }
            } catch { }
          } finally { CloseHandle(handle); }
        } finally { CloseHandle(process); }
      }
      return new List<PangeaHolder>(found.Values).ToArray();
    } finally { if (data != IntPtr.Zero) Marshal.FreeHGlobal(data); CloseHandle(reference); }
  }
  // Hold a process handle throughout: a recycled PID must never target a new process.
  public static PangeaHolder Inspect(int id) {
    IntPtr handle=OpenProcess(0x1000,false,id);
    if(handle==IntPtr.Zero) return null;
    try {
      long created,exited,kernel,user; bool critical;
      if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) return null;
      if(!IsProcessCritical(handle,out critical)) critical=true;
      using(var process=Process.GetProcessById(id)) {
        if(process.StartTime.ToUniversalTime().ToFileTimeUtc()!=created) return null;
        return new PangeaHolder {Id=id,Created=created,Name=process.ProcessName,Executable=process.MainModule.FileName,
          Path="",Critical=critical,SameUser=SameUser(handle),Session=process.SessionId};
      }
    } catch { return null; } finally {CloseHandle(handle);}
  }
  public static bool Stop(int id, long expectedCreated) {
    IntPtr handle = OpenProcess(0x101001, false, id);
    if (handle == IntPtr.Zero) return false;
    try {
      long created, exited, kernel, user; bool critical;
      if (!GetProcessTimes(handle,out created,out exited,out kernel,out user) || created != expectedCreated ||
          !SameUser(handle) || !IsProcessCritical(handle,out critical) || critical) return false;
      using (var p = Process.GetProcessById(id)) {
        if (p.SessionId != Process.GetCurrentProcess().SessionId) return false;
        // Console runtimes have no main window. Do not spend two seconds on
        // every headless holder waiting for a close request that was not sent.
        if (p.CloseMainWindow() && WaitForSingleObject(handle,2000) == 0) return true;
      }
      if (WaitForSingleObject(handle,0) == 0) return true;
      if (!TerminateProcess(handle,1)) return false;
      return WaitForSingleObject(handle,3000) == 0;
    } finally { CloseHandle(handle); }
  }
}
'@
}

function Wait-UpdateDesktopExit {
  param([int]$DesktopPid, $Identity, [int]$TimeoutSeconds = 15)
  if ($DesktopPid -le 0) { return }
  try { Wait-Process -Id $DesktopPid -Timeout $TimeoutSeconds -ErrorAction Stop } catch {
    if (-not (Get-Process -Id $DesktopPid -ErrorAction SilentlyContinue)) { return }
    if (-not $Identity -or $Identity.Id -ne $DesktopPid) { throw 'Desktop did not exit and its original process identity could not be verified.' }
    Initialize-HandleInspector
    $Stopped = [PangeaUpdateHandles]::Stop($Identity.Id, $Identity.Created)
    Write-UpdateLog "Desktop exit timeout: pid=$DesktopPid; stopped=$Stopped"
    if (-not $Stopped) { throw 'The verified Desktop process could not be stopped; installation is unchanged.' }
  }
}

function Get-OwnedUpdateProcesses {
  param([int]$DesktopPid, [string]$DesktopExecutable)
  if ($DesktopPid -le 0) { return @() }
  $Parent = Get-Process -Id $DesktopPid -ErrorAction Stop
  if ($Parent.Path -ine $DesktopExecutable) { return @() }
  $Rows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $Known = @{}; $Known[$DesktopPid] = $Parent.StartTime.ToUniversalTime().ToFileTimeUtc()
  $Owned = @()
  do {
    $Added = $false
    foreach ($Row in $Rows) {
      $ChildId = [int]$Row.ProcessId; $ParentId = [int]$Row.ParentProcessId
      if ($Known.ContainsKey($ChildId) -or -not $Known.ContainsKey($ParentId)) { continue }
      try {
        $Child = Get-Process -Id $ChildId -ErrorAction Stop
        $Created = $Child.StartTime.ToUniversalTime().ToFileTimeUtc()
        if ($Created -lt $Known[$ParentId]) { continue }
        $Known[$ChildId] = $Created; $Added = $true
        $Owned += [pscustomobject]@{ Id=$ChildId; Created=$Created; Executable=$Child.Path }
      } catch { }
    }
  } while ($Added)
  return $Owned
}

function New-UpdateControlFile {
  param([string]$Prefix)
  $Directory = [IO.Path]::GetDirectoryName($PlanPath)
  for ($Number = 1; $Number -le 9999; $Number++) {
    $Path = Join-Path $Directory "$Prefix-$Number.json"
    try {
      $Stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      $Stream.Dispose()
      return $Path
    } catch [IO.IOException] {
      if (-not [IO.File]::Exists($Path) -and -not [IO.Directory]::Exists($Path)) { throw }
    }
  }
  throw "No unused update control file is available: $Prefix"
}

function Get-UpdateLockHolders {
  param([string]$Root, [int]$TimeoutMilliseconds = 15000)
  # A remote filesystem handle query can block inside Windows. Isolate the scan
  # and bound its lifetime; only this diagnostic child may be killed on timeout.
  $Output = New-UpdateControlFile 'handles'
  $Quote = { param($Value) "'" + $Value.Replace("'", "''") + "'" }
  $Command = '& ' + (& $Quote $script:UpdaterScriptPath) + ' -ScanLocks -ScanRoot ' + (& $Quote $Root) + ' -ScanOutput ' + (& $Quote $Output)
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  $Worker = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$Encoded) -WorkingDirectory ([IO.Path]::GetDirectoryName($PlanPath)) -WindowStyle Hidden -PassThru
  try {
    $null = $Worker.Handle
    if (-not $Worker.WaitForExit([Math]::Max(1, $TimeoutMilliseconds))) { $Worker.Kill(); throw 'Local handle inspection timed out; no occupying processes were stopped.' }
    if ($Worker.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw 'Local handle inspection unavailable; no occupying processes were stopped.' }
    # Windows PowerShell 5.1 emits a top-level JSON array as one pipeline
    # object. Wrapping that pipeline in @() nests the holders: member access
    # then returns arrays, and a multi-item Critical array evaluates to true.
    # Assign first and emit each record explicitly on both PowerShell editions.
    $ParsedHolders = Get-Content -LiteralPath $Output -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($Holder in $ParsedHolders) { $Holder }
  } finally { $Worker.Dispose(); Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue }
}

function Get-RegisteredTortoiseGitCachePaths {
  # TortoiseGit's installer records its exact cache executable in HKLM. Read
  # both views so a 32-bit shell cannot miss a 64-bit installation (or vice versa).
  foreach ($View in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
    $Base = $null; $Key = $null
    try {
      $Base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $View)
      $Key = $Base.OpenSubKey('Software\TortoiseGit')
      if ($Key) {
        $Path = [string]$Key.GetValue('CachePath', '')
        if ($Path) { [IO.Path]::GetFullPath($Path) }
      }
    } catch { } finally {
      if ($Key) { $Key.Dispose() }
      if ($Base) { $Base.Dispose() }
    }
  }
}

function Get-UpdateExecutableVersionInfo {
  param([string]$Path)
  return [Diagnostics.FileVersionInfo]::GetVersionInfo($Path)
}

function Test-TortoiseGitCacheExecutable {
  param([string]$Executable)
  try {
    if ([string]::IsNullOrWhiteSpace($Executable)) { return $false }
    $Path = [IO.Path]::GetFullPath($Executable)
    if ([IO.Path]::GetFileName($Path) -ine 'TGitCache.exe') { return $false }
    if (-not @((Get-RegisteredTortoiseGitCachePaths) | Where-Object { $_ -ieq $Path }).Count) { return $false }
    $Version = Get-UpdateExecutableVersionInfo $Path
    return $Version.ProductName -ieq 'TortoiseGit' -and $Version.OriginalFilename -ieq 'TGitCache.exe'
  } catch { return $false }
}

function Get-UpdateHolderPolicy {
  param($Holder, $Owned, [int[]]$ServiceIds, [int[]]$ProtectedIds)
  if ($Holder.Critical -or -not $Holder.SameUser -or $Holder.Session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
      $Holder.Id -in $ServiceIds) { return 'protected' }
  if ($Holder.Name -ieq 'explorer' -and $Holder.Executable -ieq (Join-Path $env:SystemRoot 'explorer.exe')) { return 'explorer' }
  if ($Holder.Id -in $ProtectedIds) { return 'protected' }
  # Only the installed TortoiseGit cache may release repository-watcher locks.
  # A name match alone must never authorize stopping an unrelated program.
  if ($Holder.Name -ieq 'TGitCache') {
    if (Test-TortoiseGitCacheExecutable ([string]$Holder.Executable)) { return 'tortoisegit' }
    return 'protected'
  }
  # Exact descendant identity, not a short executable-name allowlist: Electron
  # helpers and shell wrappers can also retain this installation's handles.
  if (@($Owned | Where-Object { $_.Id -eq $Holder.Id -and $_.Created -eq $Holder.Created -and $_.Executable -ieq $Holder.Executable }).Count) { return 'owned' }
  # This policy is applied only to verified holders of this installation.
  # Include Agent launchers and terminal hosts so their remaining handles do
  # not require a separate user action after the runtime has been stopped.
  $RuntimeNames = @('node','python','pythonw','opencode','nga','codeagent','codeagentcli','claude','uv','uvx',
    'powershell','pwsh','cmd','WindowsTerminal','OpenConsole')
  if ($Holder.Name -in $RuntimeNames) { return 'automatic' }
  return 'protected'
}

function Get-UpdateHolderIdentityKey {
  param([string]$Root, $Holder)
  # Match this observed process at this directory, never a name or PID alone.
  return ('{0}|{1}|{2}|{3}' -f $Root.TrimEnd('\').ToLowerInvariant(), $Holder.Id, $Holder.Created, ([string]$Holder.Executable).ToLowerInvariant())
}

function Stop-UpdateHolder {
  param($Holder)
  return [PangeaUpdateHandles]::Stop([int]$Holder.Id, [long]$Holder.Created)
}

function Close-InstallationExplorerWindows {
  param([string]$Root)
  $Shell = $null
  try {
    $Shell = New-Object -ComObject Shell.Application
    foreach ($Window in @($Shell.Windows())) {
      try {
        if ([IO.Path]::GetFileName([string]$Window.FullName) -ine 'explorer.exe') { continue }
        $Uri = [Uri]([string]$Window.LocationURL)
        if (-not $Uri.IsFile) { continue }
        $Folder = $Uri.LocalPath.TrimEnd('\')
        if ($Folder -ieq $Root.TrimEnd('\') -or $Folder.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $Window.Quit() }
      } catch { }
    }
  } finally { if ($Shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($Shell) } }
}

function Restore-ExplorerShell {
  # Shell detection is session-local. An automatically restarted shell wins;
  # a remaining folder-only Explorer process is not proof that the shell exists.
  if (-not ('PangeaExplorerShell' -as [type])) {
    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PangeaExplorerShell { [DllImport("user32.dll")] public static extern IntPtr GetShellWindow(); }'
  }
  if ([PangeaExplorerShell]::GetShellWindow() -eq [IntPtr]::Zero) {
    Start-Process -FilePath "$env:SystemRoot\explorer.exe" -WorkingDirectory $env:SystemRoot | Out-Null
  }
}

function Watch-ExplorerRecovery {
  param([string]$WatchFile)
  $Watch = Get-Content -LiteralPath $WatchFile -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([int]$Watch.session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) { throw 'Explorer recovery session mismatch.' }
  $Supervisor = $null
  try {
    try {
      $Supervisor = Get-Process -Id ([int]$Watch.supervisor_pid) -ErrorAction Stop
      $null = $Supervisor.Handle
      if ($Supervisor.StartTime.ToUniversalTime().ToFileTimeUtc() -ne [long]$Watch.supervisor_created) { $Supervisor.Dispose(); $Supervisor=$null }
    } catch { $Supervisor=$null }
    [IO.File]::WriteAllText("$WatchFile.ready", 'ready')
    while ($Supervisor -and -not $Supervisor.HasExited -and -not (Test-Path -LiteralPath "$WatchFile.done")) {
      Start-Sleep -Milliseconds 300
      $Supervisor.Refresh()
    }
    if (Test-Path -LiteralPath "$WatchFile.armed") { Restore-ExplorerShell }
    [IO.File]::WriteAllText("$WatchFile.restored", 'checked')
  } finally { if ($Supervisor) { $Supervisor.Dispose() } }
}

function Start-ExplorerRecovery {
  param([int]$TimeoutMilliseconds = 15000)
  $WatchFile = New-UpdateControlFile 'explorer'
  $Self = Get-Process -Id $PID
  $Watch = @{ supervisor_pid=$PID; supervisor_created=$Self.StartTime.ToUniversalTime().ToFileTimeUtc(); session=$Self.SessionId }
  [IO.File]::WriteAllText($WatchFile, ($Watch | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
  $Quote = { param($Value) "'" + $Value.Replace("'", "''") + "'" }
  $Command = '& ' + (& $Quote $script:UpdaterScriptPath) + ' -WatchExplorer ' + (& $Quote $WatchFile)
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  # Start-Process supplies a separate console lifetime; the guard survives a
  # crashed updater. Do not terminate Explorer until the guard acknowledges.
  $Guard = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$Encoded) -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
  try {
    $Deadline=[DateTime]::UtcNow.AddMilliseconds([Math]::Max(1, $TimeoutMilliseconds))
    while (-not (Test-Path -LiteralPath "$WatchFile.ready")) {
      if ($Guard.HasExited -or [DateTime]::UtcNow -ge $Deadline) { throw 'Explorer recovery guard did not start; Explorer will not be terminated.' }
      Start-Sleep -Milliseconds 100
      $Guard.Refresh()
    }
    $script:ExplorerWatchFile=$WatchFile
    [IO.File]::WriteAllText("$WatchFile.armed", 'armed')
  } catch {
    [IO.File]::WriteAllText("$WatchFile.done", 'cancelled')
    throw
  } finally { $Guard.Dispose() }
}

function Complete-ExplorerRecovery {
  if (Get-Variable -Name ExplorerWatchFile -Scope Script -ErrorAction SilentlyContinue) {
    [IO.File]::WriteAllText("$script:ExplorerWatchFile.done", 'complete')
  }
}

function Get-UpdateScanBudget {
  param([DateTime]$Deadline)
  $Remaining = [Math]::Floor(($Deadline - [DateTime]::UtcNow).TotalMilliseconds)
  if ($Remaining -le 0) { throw 'Directory lock cleanup time limit reached.' }
  return [int][Math]::Min([double]15000, $Remaining)
}

function Get-UpdateServiceBudget {
  param([DateTime]$Deadline)
  $Milliseconds = Get-UpdateScanBudget $Deadline
  # CIM uses whole seconds; do not start a query with less than one second left.
  if ($Milliseconds -lt 1000) { throw 'Directory lock cleanup time limit reached.' }
  return [int][Math]::Min(5, [Math]::Floor($Milliseconds / 1000))
}

function Resolve-UpdateDirectoryLocks {
  param([string]$Root, [DateTime]$Deadline = [DateTime]::MaxValue)
  Set-UpdateStage '正在检查并自动释放安装目录占用…' 76 'directory-locks'
  $Details = [Collections.Generic.List[string]]::new()
  try {
    $Holders = @(Get-UpdateLockHolders $Root -TimeoutMilliseconds (Get-UpdateScanBudget $Deadline))
    $ServiceIds = @(Get-CimInstance Win32_Service -Filter "State='Running'" -OperationTimeoutSec (Get-UpdateServiceBudget $Deadline) -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
    Initialize-HandleInspector
    $ManualHolders = @()
    $Candidates = @()
    $Seen = @{}
    foreach ($Holder in $Holders) {
      $Policy = Get-UpdateHolderPolicy $Holder $script:OwnedUpdateProcesses $ServiceIds $script:ProtectedUpdateProcesses
      Write-UpdateLog "directory handle: $($Holder.Name) pid=$($Holder.Id); policy=$Policy; executable=$($Holder.Executable)"
      if ($Policy -eq 'protected') {
        $ManualHolders += "$($Holder.Name) (PID $($Holder.Id))"
        $Details.Add("受保护占用：$($Holder.Name) (PID $($Holder.Id))")
        continue
      }
      if ($Policy -eq 'explorer' -and (Get-Variable -Name ExplorerRestartAttempted -Scope Script -ErrorAction SilentlyContinue) -and $script:ExplorerRestartAttempted) {
        Write-UpdateLog 'Explorer was already handled once; it will not be repeatedly terminated.'
        $Details.Add("Explorer 仍占用目录 (PID $($Holder.Id))；本次升级已处理过一次")
        continue
      }
      $Key = Get-UpdateHolderIdentityKey $Root $Holder
      if ($Seen.ContainsKey($Key)) { continue }
      $Seen[$Key] = $true
      $Candidates += [pscustomobject]@{ Holder=$Holder; Policy=$Policy; Key=$Key }
    }
    $Index = 0
    foreach ($Candidate in $Candidates) {
      if ([DateTime]::UtcNow -ge $Deadline) { $Details.Add('目录占用清理已达到总时间上限'); break }
      $Index++
      Set-UpdateStage "正在自动释放目录占用：$Index / $($Candidates.Count)，$($Candidate.Holder.Name) (PID $($Candidate.Holder.Id))…" 76 'directory-locks'
      try {
        if ($Candidate.Policy -eq 'explorer') {
          if ((Get-Variable -Name ExplorerRestartAttempted -Scope Script -ErrorAction SilentlyContinue) -and $script:ExplorerRestartAttempted) { continue }
          $script:ExplorerRestartAttempted=$true
          Start-ExplorerRecovery -TimeoutMilliseconds (Get-UpdateScanBudget $Deadline)
          Close-InstallationExplorerWindows $Root
          Start-Sleep -Milliseconds 500
        }
        # Re-scan before every termination. Automatic cleanup must still match
        # PID, creation time, executable, directory AND fresh policy.
        $StillHolding = @(Get-UpdateLockHolders $Root -TimeoutMilliseconds (Get-UpdateScanBudget $Deadline) | Where-Object { (Get-UpdateHolderIdentityKey $Root $_) -eq $Candidate.Key })
        if (-not $StillHolding.Count) {
          Write-UpdateLog "directory holder released or identity changed; skipping pid=$($Candidate.Holder.Id)"
          continue
        }
        $Fresh = $StillHolding[0]
        $FreshServices = @(Get-CimInstance Win32_Service -Filter "State='Running'" -OperationTimeoutSec (Get-UpdateServiceBudget $Deadline) -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
        $FreshPolicy = Get-UpdateHolderPolicy $Fresh $script:OwnedUpdateProcesses $FreshServices $script:ProtectedUpdateProcesses
        if ($FreshPolicy -ne $Candidate.Policy) {
          Write-UpdateLog "directory holder policy changed; skipping pid=$($Fresh.Id); policy=$FreshPolicy"
          $Details.Add("占用身份或保护策略已变化：$($Fresh.Name) (PID $($Fresh.Id))")
          continue
        }
        # Stop uses at most two seconds for a close request plus three for exit.
        if (($Deadline - [DateTime]::UtcNow).TotalMilliseconds -lt 5000) { $Details.Add('目录占用清理已达到总时间上限'); break }
        $Stopped = Stop-UpdateHolder $Fresh
        Write-UpdateLog "release directory handle: $($Fresh.Name) pid=$($Fresh.Id); stopped=$Stopped"
        if (-not $Stopped) { $Details.Add("未能释放占用：$($Fresh.Name) (PID $($Fresh.Id))") }
      } catch {
        # One inaccessible holder must not suppress cleanup of other proven
        # holders. It remains protected and its failure appears in the result.
        $Message = "处理 $($Candidate.Holder.Name) (PID $($Candidate.Holder.Id)) 失败：$($_.Exception.Message)"
        $Details.Add($Message)
        Write-UpdateLog "local lock resolution: $Message"
      }
    }
    if ($ManualHolders.Count) {
      # Never block the rename timeout on an unattended modal dialog.
      Write-UpdateLog ('protected directory holders remain: ' + ($ManualHolders -join '; '))
      Set-UpdateStage ('自动清理已完成，仍有受保护的目录占用：' + ($ManualHolders -join '、') + '；正在重试版本切换…') 76 'directory-locks'
    }
    if (-not $Holders.Count) {
      Write-UpdateLog 'No inspectable directory holders found; permissions or protected/inaccessible processes may prevent rename.'
      $Details.Add('未发现可读取的目录占用；仍可能是目录权限或不可读取的进程占用')
    }
  } catch {
    Write-UpdateLog "local lock resolution: $($_.Exception.Message)"
    $Details.Add("目录占用检查失败：$($_.Exception.Message)")
  }
  return [pscustomobject]@{ Detail = ($Details -join '；') }
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
  param([string]$Source, [string]$Destination, [int]$TimeoutSeconds = 30, [switch]$ResolveLocks,
    [int]$MaxCleanupPasses = 3, [int]$CleanupTimeoutSeconds = 60)
  Write-UpdateLog "renaming directory: $Source -> $Destination"
  $Started = [DateTime]::UtcNow
  $Deadline = $Started.AddSeconds([Math]::Max(0, $TimeoutSeconds))
  $OverallDeadline = $Deadline
  if ($ResolveLocks) { $OverallDeadline = $Deadline.AddSeconds([Math]::Max(0, $CleanupTimeoutSeconds)) }
  $Attempt = 0
  $CleanupPasses = 0
  $NextCleanup = $Started
  $LockDetail = ''
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
        Set-UpdateStage '正在等待安装目录占用释放，请查看日志中的占用进程信息…' 76 'directory-locks'
        Write-UpdateLog "directory rename blocked; waiting for handles to close: $Reason"
        Write-InstallationProcesses $Source
      }
      if ($ResolveLocks -and $CleanupPasses -lt $MaxCleanupPasses -and
          [DateTime]::UtcNow -ge $NextCleanup -and [DateTime]::UtcNow -lt $OverallDeadline) {
        $CleanupPasses++
        Write-UpdateLog "directory lock cleanup pass $CleanupPasses / $MaxCleanupPasses"
        $Resolution = Resolve-UpdateDirectoryLocks $Source -Deadline $OverallDeadline
        $LockDetail = $Resolution.Detail
        # Recreated cache processes must be independently scanned and classified
        # on a later pass; no new PID inherits a previous termination decision.
        $NextCleanup = [DateTime]::UtcNow.AddMilliseconds(500)
        $Deadline = [DateTime]::UtcNow.AddSeconds([Math]::Max(0, $TimeoutSeconds))
        if ($Deadline -gt $OverallDeadline) { $Deadline = $OverallDeadline }
        continue
      }
      if ([DateTime]::UtcNow -ge $Deadline) {
        $Diagnostic = if ($LockDetail) { " 最近检查：$LockDetail。" } else { '' }
        throw "Cannot rename installation directory '$Source' to '$Destination'.$Diagnostic 已执行 $CleanupPasses 次目录占用清理。请查看本机升级日志中的进程和权限检查结果。Details: $Reason"
      }
      $Attempt++
      Start-Sleep -Milliseconds 500
    }
  }
}

function Write-AtomicUpdateJson {
  param([string]$Path, $Value)
  $Directory = [IO.Path]::GetDirectoryName($Path)
  New-Item $Directory -ItemType Directory -Force | Out-Null
  # Writes are synchronous within each process; PID separates worker/monitor.
  $Temporary = "$Path.$PID.tmp"
  try {
    [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Path) }
  } finally { if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue } }
}

function Write-UpdateResult {
  param([ValidateSet('success', 'failed')][string]$Status, [string]$Message, [string]$Rollback = '')
  if (Test-PortableIOWorker) { return }
  try {
    $Result = @{ schema_version=1; status=$Status; version=$ExpectedVersion; message=$Message; log_path=$LogPath }
    if ($Rollback) { $Result.rollback=$Rollback }
    if ((Get-Variable -Name PlanPath -ErrorAction SilentlyContinue) -and $PlanPath) { $Result.plan_path=$PlanPath }
    if ((Get-Variable -Name UpdateProgressData -Scope Script -ErrorAction SilentlyContinue) -and $script:UpdateProgressData) {
      $Result.worker_pid=$script:UpdateProgressData.worker_pid
      $Result.worker_started_at=$script:UpdateProgressData.worker_started_at
    }
    Write-AtomicUpdateJson $ResultPath $Result
  } catch { Write-UpdateLog "could not persist update result: $($_.Exception.Message)" }
}

function Read-UpdateProgress {
  param([string]$Path)
  try {
    $Value = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Value.schema_version -ne 1 -or $Value.state -notin @('running','success','failed')) { return $null }
    return $Value
  } catch { return $null }
}

function Write-UpdateProgress {
  param([ValidateSet('running','success','failed')][string]$State = 'running', [string]$Stage = 'prepare',
    [string]$Message, [int]$Percent = 0, [string]$Rollback = '', [int]$FilesCompleted = -1, [int]$FilesTotal = -1)
  if (Test-PortableIOWorker) {
    if (Get-Variable -Name PortableIOControl -Scope Script -ErrorAction SilentlyContinue) {
      try {
        $script:PortableIOProgressSequence++
        $Progress=@{schema_version=1;sequence=$script:PortableIOProgressSequence;stage=$Stage;message=$Message;percent=$Percent}
        if ($FilesCompleted -ge 0) { $Progress.files_completed=$FilesCompleted }
        if ($FilesTotal -ge 0) { $Progress.files_total=$FilesTotal }
        Write-AtomicUpdateJson "$script:PortableIOControl.progress" $Progress
      } catch { Write-UpdateLog "could not persist IO progress: $($_.Exception.Message)" }
    }
    return
  }
  # Also used by AST-based component tests that do not execute script globals.
  if (-not (Get-Variable -Name PlanPath -ErrorAction SilentlyContinue) -or -not $PlanPath) { return }
  try {
    $Now = [DateTime]::UtcNow.ToString('o')
    if (-not (Get-Variable -Name UpdateProgressData -Scope Script -ErrorAction SilentlyContinue) -or -not $script:UpdateProgressData) {
      $Self = Get-Process -Id $PID -ErrorAction Stop
      $script:UpdateProgressData = @{ schema_version=1; state='running'; stage=''; message=''; percent=0;
        started_at=$Now; stage_started_at=$Now; updated_at=$Now; worker_pid=$PID;
        worker_started_at=$Self.StartTime.ToUniversalTime().ToString('o'); log_path=$LogPath; version=$ExpectedVersion }
    }
    $Data = $script:UpdateProgressData
    if ($Data.stage -ne $Stage) {
      $Data.stage_started_at=$Now
      $Data.Remove('files_completed'); $Data.Remove('files_total')
    }
    $Data.state=$State; $Data.stage=$Stage; $Data.message=$Message
    $Data.percent=[Math]::Max(0,[Math]::Min(100,$Percent)); $Data.updated_at=$Now
    if ($Rollback) { $Data.rollback=$Rollback }
    if ($FilesCompleted -ge 0) { $Data.files_completed=$FilesCompleted }
    if ($FilesTotal -ge 0) { $Data.files_total=$FilesTotal }
    Write-AtomicUpdateJson "$PlanPath.progress.json" $Data
  } catch { Write-UpdateLog "could not persist update progress: $($_.Exception.Message)" }
}

function Set-UpdateStage {
  param([string]$Message, [int]$Percent, [string]$Stage = 'prepare', [int]$FilesCompleted = -1, [int]$FilesTotal = -1)
  Write-UpdateLog "$Percent% $Message"
  Write-UpdateProgress -State running -Stage $Stage -Message $Message -Percent $Percent -FilesCompleted $FilesCompleted -FilesTotal $FilesTotal
}

function Test-UpdateWorkerIdentity {
  param($Progress)
  $Worker = $null
  try {
    $Worker = Get-Process -Id ([int]$Progress.worker_pid) -ErrorAction Stop
    return -not $Worker.HasExited -and $Worker.StartTime.ToUniversalTime().Ticks -eq ([DateTime]$Progress.worker_started_at).ToUniversalTime().Ticks
  } catch { return $false }
  finally { if ($Worker) { $Worker.Dispose() } }
}

function Set-InterruptedUpdateFailure {
  param($Progress)
  # The monitor only writes after the original process identity has gone.
  if ($Progress.state -ne 'running' -or (Test-UpdateWorkerIdentity $Progress)) { return $Progress }
  # The last timer read can predate the worker's terminal write. Once the
  # worker has exited, read again before declaring interruption.
  $Latest=Read-UpdateProgress "$PlanPath.progress.json"
  if ($Latest) {
    if ($Latest.state -ne 'running') { return $Latest }
    if ($Latest.worker_pid -ne $Progress.worker_pid -or $Latest.worker_started_at -ne $Progress.worker_started_at) { return $Latest }
    $Progress=$Latest
  }
  $Data=@{}; foreach ($Property in $Progress.PSObject.Properties) { $Data[$Property.Name]=$Property.Value }
  # If only the final progress write failed, preserve a matching persisted
  # result. A previous attempt's result must never be mistaken for this one.
  try {
    $Result=[IO.File]::ReadAllText($ResultPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
    if ($Result.schema_version -eq 1 -and $Result.status -in @('success','failed') -and
        $Result.plan_path -eq $PlanPath -and $Result.worker_pid -eq $Progress.worker_pid -and
        $Result.worker_started_at -eq $Progress.worker_started_at) {
      $Data.state=$Result.status; $Data.message=$Result.message; $Data.stage='complete'
      $Data.updated_at=[DateTime]::UtcNow.ToString('o'); $Data.stage_started_at=$Data.updated_at
      if ($Result.status -eq 'success') { $Data.percent=100 }
      if ($Result.PSObject.Properties['rollback']) { $Data.rollback=$Result.rollback }
      try { Write-AtomicUpdateJson "$PlanPath.progress.json" $Data } catch { Write-UpdateLog $_.Exception.Message }
      return [pscustomobject]$Data
    }
  } catch { }
  $Data.state='failed'; $Data.stage='interrupted'; $Data.updated_at=[DateTime]::UtcNow.ToString('o')
  $Data.stage_started_at=$Data.updated_at; $Data.rollback='unknown'
  $Data.message='升级进程异常退出，无法确认版本切换或回滚是否完成。请打开升级日志核实；不要删除原版本备份目录。'
  Write-UpdateLog $Data.message
  Write-UpdateResult 'failed' $Data.message 'unknown'
  try { Write-AtomicUpdateJson "$PlanPath.progress.json" $Data } catch { Write-UpdateLog "could not persist interrupted progress: $($_.Exception.Message)" }
  return [pscustomobject]$Data
}

function Get-UpdateLogTail {
  param([string]$Path, [int]$MaximumBytes = 16384)
  $Stream=$null
  try {
    $Stream=New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    $Count=[int][Math]::Min($MaximumBytes,$Stream.Length)
    $null=$Stream.Seek(-$Count,[IO.SeekOrigin]::End)
    $Bytes=New-Object byte[] $Count
    $Read=$Stream.Read($Bytes,0,$Count)
    return [Text.Encoding]::UTF8.GetString($Bytes,0,$Read)
  } catch { return '暂无日志，等待升级进程写入…' }
  finally { if ($Stream) { $Stream.Dispose() } }
}

function Initialize-UpdateWindowApi {
  if ('PangeaUpdateWindow' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PangeaUpdateWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
}
'@
}

function Watch-UpdateWindow {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Initialize-UpdateWindowApi
    [Windows.Forms.Application]::EnableVisualStyles()
    $script:MonitorTerminal=$false
    $script:MonitorProgress=Read-UpdateProgress "$PlanPath.progress.json"
    if (-not $script:MonitorProgress) { throw '升级状态文件无法读取，未启动升级。' }
    $script:MonitorLastLogRead=[DateTime]::MinValue
    $script:UpdateForm=New-Object Windows.Forms.Form
    $script:UpdateForm.Text='PANGEA Desktop · 升级进度'
    $script:UpdateForm.ClientSize=New-Object Drawing.Size(760,570)
    $script:UpdateForm.StartPosition='CenterScreen'
    $script:UpdateForm.FormBorderStyle='FixedDialog'
    $script:UpdateForm.MaximizeBox=$false; $script:UpdateForm.MinimizeBox=$true
    $script:UpdateForm.Font=New-Object Drawing.Font('Microsoft YaHei UI',9)
    $script:UpdateForm.BackColor=[Drawing.Color]::White
    try { if (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf) { $script:UpdateForm.Icon=[Drawing.Icon]::ExtractAssociatedIcon($InstalledExecutable) } } catch { }
    $script:UpdateTitle=New-Object Windows.Forms.Label
    $script:UpdateTitle.Text="正在升级至 $ExpectedVersion"
    $script:UpdateTitle.Font=New-Object Drawing.Font('Microsoft YaHei UI',14,[Drawing.FontStyle]::Bold)
    $script:UpdateTitle.SetBounds(24,20,712,34)
    $script:UpdateLabel=New-Object Windows.Forms.Label
    $script:UpdateLabel.Name='UpdateMessage'; $script:UpdateLabel.SetBounds(24,64,712,74)
    $script:UpdateProgress=New-Object Windows.Forms.ProgressBar
    $script:UpdateProgress.SetBounds(24,144,712,16)
    $script:UpdateProgress.Style='Continuous'
    $Hint=New-Object Windows.Forms.Label
    $Hint.Text='阶段进度用于说明当前步骤，不代表剩余时间。'; $Hint.SetBounds(24,167,712,23)
    $script:UpdateElapsed=New-Object Windows.Forms.Label
    $script:UpdateElapsed.Name='UpdateElapsed'; $script:UpdateElapsed.SetBounds(24,198,712,24)
    $script:UpdateRecent=New-Object Windows.Forms.Label
    $script:UpdateRecent.Name='UpdateRecent'; $script:UpdateRecent.SetBounds(24,228,712,45)
    $script:UpdateRecovery=New-Object Windows.Forms.Label
    $script:UpdateRecovery.Name='UpdateRecovery'; $script:UpdateRecovery.SetBounds(24,278,712,37)
    $script:UpdateLogBox=New-Object Windows.Forms.TextBox
    $script:UpdateLogBox.Name='UpdateLog'; $script:UpdateLogBox.SetBounds(24,322,712,168)
    $script:UpdateLogBox.Multiline=$true; $script:UpdateLogBox.ReadOnly=$true
    $script:UpdateLogBox.ScrollBars='Both'; $script:UpdateLogBox.WordWrap=$false
    $script:UpdateLogBox.Font=New-Object Drawing.Font('Consolas',9)
    $OpenLog=New-Object Windows.Forms.Button
    $OpenLog.Text='打开日志'; $OpenLog.SetBounds(24,510,106,32)
    $OpenLog.Add_Click({ try { if (Test-Path -LiteralPath $LogPath) { Start-Process -FilePath 'notepad.exe' -ArgumentList ('"'+$LogPath+'"') | Out-Null } } catch { $script:UpdateRecovery.Text=$_.Exception.Message } })
    $OpenFolder=New-Object Windows.Forms.Button
    $OpenFolder.Text='打开日志目录'; $OpenFolder.SetBounds(140,510,126,32)
    $OpenFolder.Add_Click({ try { Start-Process -FilePath 'explorer.exe' -ArgumentList ('"'+[IO.Path]::GetDirectoryName($LogPath)+'"') | Out-Null } catch { $script:UpdateRecovery.Text=$_.Exception.Message } })
    $CopyError=New-Object Windows.Forms.Button
    $CopyError.Text='复制诊断信息'; $CopyError.SetBounds(276,510,126,32)
    $CopyError.Add_Click({ try { [Windows.Forms.Clipboard]::SetText(($script:MonitorProgress | ConvertTo-Json -Depth 8)+"`r`n"+$script:UpdateLogBox.Text) } catch { $script:UpdateRecovery.Text=$_.Exception.Message } })
    $script:UpdateCloseButton=New-Object Windows.Forms.Button
    $script:UpdateCloseButton.Text='升级中，可最小化'; $script:UpdateCloseButton.Enabled=$false
    $script:UpdateCloseButton.SetBounds(566,510,170,32)
    $script:UpdateCloseButton.Add_Click({ $script:UpdateForm.Close() })
    foreach ($Control in @($script:UpdateTitle,$script:UpdateLabel,$script:UpdateProgress,$Hint,$script:UpdateElapsed,$script:UpdateRecent,$script:UpdateRecovery,$script:UpdateLogBox,$OpenLog,$OpenFolder,$CopyError,$script:UpdateCloseButton)) { $script:UpdateForm.Controls.Add($Control) }
    $script:UpdateForm.Add_FormClosing({ param($Sender,$EventArgs) if (-not $script:MonitorTerminal) { $EventArgs.Cancel=$true; $script:UpdateRecovery.Text='升级仍在进行，可最小化窗口；结束后可以关闭。' } })
    $script:UpdateTimer=New-Object Windows.Forms.Timer
    $script:UpdateTimer.Interval=1000
    $script:UpdateTimer.Add_Tick({ Update-MonitorWindow })
    $script:UpdateForm.Add_Shown({
      try {
        if (-not $script:UpdateForm.Visible -or -not $script:UpdateForm.IsHandleCreated) { throw '升级窗口未显示。' }
        # The hidden console's STARTUPINFO can hide the first native ShowWindow
        # even when WinForms reports Visible=true. Explicitly show the HWND and
        # verify the operating system state before acknowledging the handoff.
        $WindowHandle=$script:UpdateForm.Handle
        [PangeaUpdateWindow]::ShowWindow($WindowHandle,5) | Out-Null
        if (-not [PangeaUpdateWindow]::IsWindowVisible($WindowHandle)) {
          [PangeaUpdateWindow]::ShowWindow($WindowHandle,5) | Out-Null
        }
        if (-not [PangeaUpdateWindow]::IsWindowVisible($WindowHandle)) { throw 'Windows 未能显示升级窗口，已取消交接。' }
        Update-MonitorWindow
        Write-AtomicUpdateJson "$PlanPath.ui-ready" @{ schema_version=1; monitor_pid=$PID; visible=$true; window_handle=$WindowHandle.ToInt64() }
        $script:UpdateTimer.Start()
      } catch {
        [IO.File]::WriteAllText("$PlanPath.ui-error",$_.Exception.Message,(New-Object Text.UTF8Encoding($false)))
        $script:MonitorTerminal=$true; $script:UpdateForm.Close()
      }
    })
    # A dedicated STA process owns the real message loop, independent of file IO.
    [Windows.Forms.Application]::Run($script:UpdateForm)
  } catch {
    $Reason=$_.Exception.Message
    try { [IO.File]::WriteAllText("$PlanPath.ui-error",$Reason,(New-Object Text.UTF8Encoding($false))) } catch { }
    throw
  } finally {
    if (Get-Variable -Name UpdateTimer -Scope Script -ErrorAction SilentlyContinue) { $script:UpdateTimer.Stop(); $script:UpdateTimer.Dispose() }
    if ($script:UpdateForm) { $script:UpdateForm.Dispose() }
  }
}

function Update-MonitorWindow {
  try {
    $Latest=Read-UpdateProgress "$PlanPath.progress.json"
    if ($Latest) { $script:MonitorProgress=$Latest }
    $Progress=$script:MonitorProgress
    if ($Progress.state -eq 'running' -and -not (Test-UpdateWorkerIdentity $Progress)) {
      $Progress=Set-InterruptedUpdateFailure $Progress; $script:MonitorProgress=$Progress
    }
    $script:MonitorTerminal=$Progress.state -in @('success','failed')
    $script:UpdateLabel.Text=$Progress.message
    $script:UpdateProgress.Value=[Math]::Max(0,[Math]::Min(100,[int]$Progress.percent))
    $Now=[DateTime]::UtcNow
    $End=if ($script:MonitorTerminal) { ([DateTime]$Progress.updated_at).ToUniversalTime() } else { $Now }
    $Elapsed=$End-([DateTime]$Progress.started_at).ToUniversalTime()
    $StageElapsed=$End-([DateTime]$Progress.stage_started_at).ToUniversalTime()
    $script:UpdateElapsed.Text=('阶段进度 {0}%　总已用 {1:00}:{2:00}:{3:00}　本阶段 {4:00}:{5:00}:{6:00}' -f $Progress.percent,[Math]::Floor($Elapsed.TotalHours),$Elapsed.Minutes,$Elapsed.Seconds,[Math]::Floor($StageElapsed.TotalHours),$StageElapsed.Minutes,$StageElapsed.Seconds)
    $Ago=[Math]::Max(0,[int]($Now-([DateTime]$Progress.updated_at).ToUniversalTime()).TotalSeconds)
    $script:UpdateRecent.Text=if ($script:MonitorTerminal) { '升级流程已结束，此窗口将保留，便于查看结果和日志。' } elseif ($Ago -ge 30) { "最近进展：${Ago} 秒前。大文件校验、复制或目录占用处理可能耗时较长，暂无新进展不代表程序卡死。" } else { "最近进展：${Ago} 秒前。窗口可最小化，升级将继续进行。" }
    if ($script:MonitorTerminal) {
      $script:UpdateCloseButton.Enabled=$true; $script:UpdateCloseButton.Text='关闭'
      $script:UpdateForm.Text=if ($Progress.state -eq 'success') { 'PANGEA Desktop · 升级完成' } else { 'PANGEA Desktop · 升级失败' }
      $script:UpdateTitle.Text=if ($Progress.state -eq 'success') { "升级完成 · $ExpectedVersion" } else { "升级失败 · $ExpectedVersion" }
      $Rollback=if ($Progress.PSObject.Properties['rollback']) { [string]$Progress.rollback } else { '' }
      $script:UpdateRecovery.Text=switch ($Rollback) {
        'restored' { '已恢复原版本文件；旧版启动结果请查看上方信息与日志。' }
        'not_needed' { '安装目录尚未切换，原版本文件保持完整。' }
        'failed' { '自动回滚未完成，请保留备份目录并查看日志中的恢复位置。' }
        'unknown' { '升级进程意外结束，回滚状态未知，请查看日志。' }
        default { '新版已通过启动健康检查。' }
      }
    }
    if (($Now-$script:MonitorLastLogRead).TotalSeconds -ge 2) {
      $Tail=Get-UpdateLogTail $LogPath
      if ($script:UpdateLogBox.Text -ne $Tail) { $script:UpdateLogBox.Text=$Tail; $script:UpdateLogBox.SelectionStart=$script:UpdateLogBox.Text.Length; $script:UpdateLogBox.ScrollToCaret() }
      $script:MonitorLastLogRead=$Now
    }
  } catch { $script:UpdateRecovery.Text="状态刷新遇到问题，将继续重试：$($_.Exception.Message)" }
}

function Open-UpdateWindow {
  Set-UpdateStage '正在启动独立升级窗口…' 2 'prepare'
  $Quote={ param($Value) "'"+$Value.Replace("'","''")+"'" }
  $Command='& '+(& $Quote $script:UpdaterScriptPath)+' -WatchUpdate -PlanPath '+(& $Quote $PlanPath)
  $Encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  $script:UpdateMonitor=Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-EncodedCommand',$Encoded) -WorkingDirectory ([IO.Path]::GetDirectoryName($PlanPath)) -WindowStyle Hidden -PassThru
  $Deadline=(Get-Date).AddSeconds(20)
  while ($true) {
    if (Test-Path -LiteralPath "$PlanPath.ui-error") { throw ('升级窗口启动失败：'+[IO.File]::ReadAllText("$PlanPath.ui-error")) }
    if ($script:UpdateMonitor.HasExited) { throw '升级窗口进程已退出，当前版本将保持运行。' }
    if (Test-Path -LiteralPath "$PlanPath.ui-ready") {
      $Ready=[IO.File]::ReadAllText("$PlanPath.ui-ready") | ConvertFrom-Json
      if ($Ready.visible -eq $true -and [int]$Ready.monitor_pid -eq $script:UpdateMonitor.Id) { return }
      throw '升级窗口就绪状态无效，当前版本将保持运行。'
    }
    if ((Get-Date) -ge $Deadline) { throw '升级窗口在 20 秒内未能显示，已取消升级。' }
    Start-Sleep -Milliseconds 100; $script:UpdateMonitor.Refresh()
  }
}

function Wait-UpdateHandoff {
  if (-not $Plan.PSObject.Properties['handoff_required'] -or $Plan.handoff_required -ne $true) { return }
  $Deadline=(Get-Date).AddSeconds(20)
  while ($true) {
    if (Test-Path -LiteralPath "$PlanPath.cancel") { throw '升级交接已取消，当前版本保持运行。' }
    if (Test-Path -LiteralPath "$PlanPath.continue") { return }
    if ((Get-Date) -ge $Deadline) { throw '未收到主窗口的升级交接确认，已取消升级，当前版本保持运行。' }
    Start-Sleep -Milliseconds 100
  }
}

function Initialize-PortableDesktopLauncher {
  if ('PangeaPortableDesktopLauncher' -as [type]) { return }
  # PS 5.1 Start-Process expands wildcard characters in WorkingDirectory and
  # resolves redirect paths more than once, so escaping [] is not sufficient.
  # Inherit native log-file handles: no pipe reader must survive this updater.
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PangeaPortableDesktopLauncher {
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES {
    public int Length; public IntPtr Descriptor; public int InheritHandle;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct STARTUPINFO {
    public int Size; public string Reserved; public string Desktop; public string Title;
    public uint X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
    public ushort ShowWindow, ReservedSize; public IntPtr ReservedData;
    public IntPtr StdInput, StdOutput, StdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr Process, Thread; public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    ref SECURITY_ATTRIBUTES security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine,
    IntPtr processSecurity, IntPtr threadSecurity, bool inheritHandles, uint flags,
    IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", ExactSpelling=true, SetLastError=true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", ExactSpelling=true)]
  static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", ExactSpelling=true)]
  static extern bool CloseHandle(IntPtr handle);

  static SafeFileHandle OpenLog(string path, bool input) {
    var security = new SECURITY_ATTRIBUTES();
    security.Length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    security.InheritHandle = 1;
    // Direct file handles preserve literal brackets, spaces and Unicode.
    var handle = CreateFileW(path, input ? 0x80000000u : 0x40000000u, 3,
      ref security, input ? 3u : 2u, 0x80, IntPtr.Zero);
    if (handle.IsInvalid) {
      int error = Marshal.GetLastWin32Error();
      handle.Dispose();
      throw new Win32Exception(error, "Cannot open Desktop startup stream: " + path);
    }
    return handle;
  }

  public static Process Start(string executable, string arguments, string directory,
    string stdout, string stderr) {
    using (var input = OpenLog("NUL", true))
    using (var output = OpenLog(stdout, false))
    using (var error = OpenLog(stderr, false)) {
      var startup = new STARTUPINFO();
      startup.Size = Marshal.SizeOf(typeof(STARTUPINFO));
      startup.Flags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
      startup.ShowWindow = 1; // SW_SHOWNORMAL
      startup.StdInput = input.DangerousGetHandle();
      startup.StdOutput = output.DangerousGetHandle();
      startup.StdError = error.DangerousGetHandle();
      PROCESS_INFORMATION created;
      var commandLine = new StringBuilder("\"" + executable + "\" " + arguments);
      // Suspend until Process owns a handle, retaining even an immediate exit's
      // status. Null environment inherits the caller's sanitized environment.
      if (!CreateProcessW(executable, commandLine, IntPtr.Zero, IntPtr.Zero, true,
        0x14, IntPtr.Zero, directory, ref startup, out created))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot start Desktop: " + executable);
      Process process = null;
      try {
        process = Process.GetProcessById((int)created.ProcessId);
        IntPtr retainedHandle = process.Handle;
        if (ResumeThread(created.Thread) == UInt32.MaxValue)
          throw new Win32Exception(Marshal.GetLastWin32Error(), "Cannot resume Desktop startup.");
        return process;
      } catch {
        // Never strand an invisible suspended process after a launch error.
        TerminateProcess(created.Process, 1);
        if (process != null) process.Dispose();
        throw;
      } finally {
        CloseHandle(created.Thread);
        CloseHandle(created.Process);
      }
    }
  }
}
'@
}

function Start-PortableDesktop {
  param([string]$Executable, [string]$Marker, [string]$LaunchLog)
  Initialize-PortableDesktopLauncher
  Remove-Item -LiteralPath $Marker -Force -ErrorAction SilentlyContinue
  $Arguments = "--pangea-update-health=`"$Marker`" --enable-logging=file --log-file=`"$LaunchLog`""
  $SavedEnvironment = @{}
  try {
    # GUI relaunch must not inherit Node-only launch/debug flags. Preserve the
    # user's profile/runtime configuration and restore our own environment.
    foreach ($Name in @('ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH')) {
      $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
      [Environment]::SetEnvironmentVariable($Name, $null, 'Process')
    }
    $Desktop = [PangeaPortableDesktopLauncher]::Start($Executable, $Arguments,
      [IO.Path]::GetDirectoryName($Executable), "$LaunchLog.stdout", "$LaunchLog.stderr")
    Write-UpdateLog "Desktop launch: pid=$($Desktop.Id); executable=$Executable; working-directory=$([IO.Path]::GetDirectoryName($Executable)); health=$Marker; log=$LaunchLog; stdout=$LaunchLog.stdout; stderr=$LaunchLog.stderr"
    # Retain the handle now so PS 5.1 can report an early exit code reliably.
    try { $null = $Desktop.Handle } catch { Write-UpdateLog "Desktop handle unavailable after launch: pid=$($Desktop.Id); $($_.Exception.Message)" }
    return $Desktop
  } finally {
    foreach ($Name in $SavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], 'Process') }
  }
}

function Wait-PortableDesktopHealthy {
  param($Process, [string]$Marker, [string]$Version, [int]$TimeoutSeconds = 300,
    [string]$Stage = 'health-check', [int]$Percent = 92)
  $Deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $LastProgress = [DateTime]::MinValue
  $Description = if ($Stage -eq 'rollback-health') { '原版本工作台' } else { '新版本工作台' }
  $HealthDetail = '尚未收到工作台就绪确认'
  while ([DateTime]::UtcNow -lt $Deadline) {
    $Process.Refresh()
    if ($Process.HasExited) {
      $Message = "$Description 启动进程已退出，PID $($Process.Id)，退出码 $($Process.ExitCode)。请查看启动日志；退出码 0 也可能是已有实例占用。"
      Write-UpdateLog $Message
      throw $Message
    }
    if (Test-Path -LiteralPath $Marker -PathType Leaf) {
      try {
        $Health = [IO.File]::ReadAllText($Marker, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if ($Health.schema_version -eq 1 -and [int]$Health.pid -eq $Process.Id -and
            (-not $Version -or [string]$Health.version -eq $Version) -and
            ([DateTime]$Health.healthy_at).ToUniversalTime() -ge $Process.StartTime.ToUniversalTime().AddSeconds(-2)) {
          $Process.Refresh()
          if (-not $Process.HasExited) {
            Write-UpdateLog "$Description 已确认就绪：PID $($Process.Id)，版本 $($Health.version)"
            return $true
          }
        }
        $HealthDetail = '就绪标记的 PID、版本或时间与本次启动不符'
      } catch { $HealthDetail = '工作台就绪标记尚未完整写入或格式无效' }
    }
    if (([DateTime]::UtcNow - $LastProgress).TotalSeconds -ge 5) {
      $Remaining = [Math]::Max(0, [int]($Deadline - [DateTime]::UtcNow).TotalSeconds)
      Set-UpdateStage "正在等待$Description 就绪，PID $($Process.Id)，剩余 $Remaining 秒；$HealthDetail…" $Percent $Stage
      $LastProgress = [DateTime]::UtcNow
    }
    Start-Sleep -Milliseconds 250
  }
  throw "$Description 进程已启动，但 $TimeoutSeconds 秒内未确认工作台就绪（PID $($Process.Id)；$HealthDetail）。进程尚在运行，请查看启动日志。"
}

function Initialize-PortableFileIO {
  if ('PangeaPortableFileIO' -as [type]) { return }
  # PS 5.1 providers and .NET Framework path-based FileStream constructors can
  # still apply MAX_PATH, even when Windows long paths are enabled. Use Unicode
  # Win32 calls with extended paths, then wrap the native handle for streaming.
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class PangeaPortableFileIO {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern uint GetFullPathNameW(string path, uint size, StringBuilder buffer, IntPtr part);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool CopyFileW(string source, string target, bool failIfExists);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);

  static IOException Error(string operation, string path, int code) {
    return new IOException(operation + " failed (Win32 " + code + ", path length " + path.Length + "): " + path,
      new Win32Exception(code));
  }
  static string FullPath(string path) {
    if (String.IsNullOrWhiteSpace(path)) throw new IOException("Empty update path.");
    path = path.Replace('/', '\\');
    if (path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) path = @"\\" + path.Substring(8);
    else if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) path = path.Substring(4);
    if (path.StartsWith(@"\\.\", StringComparison.Ordinal)) throw new IOException("Device update path is not allowed.");
    string native;
    if (path.StartsWith(@"\\", StringComparison.Ordinal)) native = @"\\?\UNC\" + path.Substring(2);
    else if (path.Length >= 3 && Char.IsLetter(path[0]) && path[1] == ':' && path[2] == '\\') native = @"\\?\" + path;
    else throw new IOException("Update path must be absolute: " + path);
    // GetFullPathNameW also needs the extended prefix on non-opted-in hosts.
    var buffer = new StringBuilder(32768);
    uint length = GetFullPathNameW(native, (uint)buffer.Capacity, buffer, IntPtr.Zero);
    if (length == 0) throw Error("Resolve path", path, Marshal.GetLastWin32Error());
    if (length >= buffer.Capacity) throw new PathTooLongException("Update path exceeds the Windows extended path limit.");
    string result = buffer.ToString();
    return result.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase) ? @"\\" + result.Substring(8) : result.Substring(4);
  }
  static string Extended(string path) {
    string full = FullPath(path);
    return full.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + full.Substring(2) : @"\\?\" + full;
  }
  public static string Child(string root, string relative) {
    if (String.IsNullOrEmpty(relative)) throw new IOException("Unsafe empty package path.");
    relative = relative.Replace('/', '\\');
    foreach (string part in relative.Split('\\')) {
      if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".") || part.EndsWith(" ") ||
          part.IndexOfAny(new char[] { ':', '\0', '<', '>', '"', '|', '?', '*' }) >= 0)
        throw new IOException("Unsafe package path: " + relative);
    }
    // Validate components before concatenation: no provider expansion, drive
    // paths, traversal, alternate streams or normalization outside this root.
    return FullPath(root).TrimEnd('\\') + "\\" + relative;
  }
  static string Parent(string full) {
    int index = full.LastIndexOf('\\');
    if (index < 0) throw new IOException("Update path has no parent: " + full);
    return full.Substring(0, index);
  }
  static void EnsureExtendedDirectory(string path) {
    uint attributes = GetFileAttributesW(path);
    if (attributes != UInt32.MaxValue) {
      if ((attributes & 16) == 0) throw new IOException("Update directory is a file: " + path);
      return;
    }
    int code = Marshal.GetLastWin32Error();
    if (code != 2 && code != 3) throw Error("Inspect directory", path, code);
    // Do not recurse above a drive root or UNC share when either is unavailable.
    int rootEnd = path.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)
      ? path.IndexOf('\\', path.IndexOf('\\', 8) + 1) : 6;
    if (rootEnd < 0 || path.Length <= rootEnd + 1) throw Error("Find volume or share", path, code);
    string parent = Parent(path);
    if (parent.EndsWith(":")) parent += "\\";
    EnsureExtendedDirectory(parent);
    if (!CreateDirectoryW(path, IntPtr.Zero)) {
      code = Marshal.GetLastWin32Error();
      attributes = GetFileAttributesW(path);
      if (code != 183 || attributes == UInt32.MaxValue || (attributes & 16) == 0)
        throw Error("Create directory", path, code);
    }
  }
  public static void EnsureDirectory(string path) { EnsureExtendedDirectory(Extended(path)); }
  public static string CreateWorkspace(string parent) {
    // Reserve a short, readable name atomically. Never reuse an old backup or
    // another updater's directory, including one left behind after a crash.
    for (int number = 1; number <= 9999; number++) {
      string path = Child(parent, "p-up-" + number);
      if (CreateDirectoryW(Extended(path), IntPtr.Zero)) return path;
      int code = Marshal.GetLastWin32Error();
      if (code != 183 && code != 80) throw Error("Reserve update directory", path, code);
    }
    throw new IOException("No unused portable update directory is available.");
  }
  public static bool IsFile(string path) {
    string full = Extended(path);
    uint attributes = GetFileAttributesW(full);
    if (attributes != UInt32.MaxValue) return (attributes & 16) == 0;
    int code = Marshal.GetLastWin32Error();
    if (code == 2 || code == 3) return false;
    throw Error("Inspect file", path, code);
  }
  public static void Copy(string source, string target) {
    string destination = Extended(target);
    EnsureExtendedDirectory(Parent(destination));
    if (!CopyFileW(Extended(source), destination, false)) throw Error("Copy file", target, Marshal.GetLastWin32Error());
  }
  public static FileStream Open(string path, bool write) {
    string full = Extended(path);
    if (write) EnsureExtendedDirectory(Parent(full));
    SafeFileHandle handle = CreateFileW(full, write ? 0x40000000u : 0x80000000u,
      write ? 0u : 1u, IntPtr.Zero, write ? 2u : 3u, 0x08000000u, IntPtr.Zero);
    if (handle.IsInvalid) {
      int code = Marshal.GetLastWin32Error(); handle.Dispose();
      throw Error(write ? "Create file" : "Read file", path, code);
    }
    try { return new FileStream(handle, write ? FileAccess.Write : FileAccess.Read, 65536, false); }
    catch { handle.Dispose(); throw; }
  }
  public static void Verify(string path, long size, string hash, string relative) {
    using (FileStream input = Open(path, false)) {
      if (input.Length != size) throw new IOException("Patched file size mismatch: " + relative);
      using (SHA256 sha = SHA256.Create()) {
        string actual = BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
        if (!String.Equals(actual, hash, StringComparison.Ordinal)) throw new IOException("Patched file hash mismatch: " + relative);
      }
    }
  }
}
public sealed class PangeaPortableEntry {
  public string Path, Kind, Hash; public long Length;
}
public static class PangeaPortableTree {
  [StructLayout(LayoutKind.Sequential)] struct FileTime { public uint Low, High; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct FindData {
    public uint Attributes; public FileTime Created, Accessed, Written;
    public uint SizeHigh, SizeLow, Reserved0, Reserved1;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=14)] public string Alternate;
  }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern IntPtr FindFirstFileW(string pattern,out FindData data);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool FindNextFileW(IntPtr handle,out FindData data);
  [DllImport("kernel32.dll")] static extern bool FindClose(IntPtr handle);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern uint GetFileAttributesW(string path);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint mode,uint flags,IntPtr template);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle handle,uint code,IntPtr input,uint inputLength,byte[] output,uint outputLength,out uint returned,IntPtr overlap);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool GetDiskFreeSpaceExW(string directory,out ulong available,out ulong total,out ulong free);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)] static extern bool GetDiskFreeSpaceW(string root,out uint sectors,out uint bytes,out uint free,out uint total);
  static string Native(string path) {
    return path.StartsWith(@"\\?\",StringComparison.Ordinal) ? path : path.StartsWith(@"\\",StringComparison.Ordinal) ? @"\\?\UNC\"+path.Substring(2) : @"\\?\"+path;
  }
  static IOException Error(string action,string path) { return new IOException(action+": "+path,new Win32Exception(Marshal.GetLastWin32Error())); }
  static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-","").ToLowerInvariant(); }
  public static long AvailableBytes(string directory) {
    ulong available,total,free;
    if(!GetDiskFreeSpaceExW(Native(directory),out available,out total,out free)) throw Error("Cannot inspect available installation space",directory);
    return available>long.MaxValue ? long.MaxValue : (long)available;
  }
  public static long AllocationUnit(string directory) {
    uint sectors,bytes,free,total;
    if(!GetDiskFreeSpaceW(System.IO.Path.GetPathRoot(directory),out sectors,out bytes,out free,out total)) throw Error("Cannot inspect installation allocation unit",directory);
    return Math.Max(65536L,checked((long)sectors*bytes));
  }
  static string LinkHash(string path) {
    using(var handle=CreateFileW(Native(path),0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
      if(handle.IsInvalid) throw Error("Cannot inspect user-data link",path);
      byte[] buffer=new byte[16384]; uint length;
      if(!DeviceIoControl(handle,0x000900A8,IntPtr.Zero,0,buffer,(uint)buffer.Length,out length,IntPtr.Zero)) throw Error("Cannot read user-data link",path);
      using(var sha=SHA256.Create()) return Hex(sha.ComputeHash(buffer,0,(int)length));
    }
  }
  static void Walk(string root,string relative,bool hashes,System.Collections.Generic.List<PangeaPortableEntry> entries,int depth) {
    if(depth>1024 || entries.Count>1000000) throw new IOException("Installation inventory exceeds safe traversal limits; original data is retained.");
    string directory=relative.Length==0 ? root : PangeaPortableFileIO.Child(root,relative);
    FindData data; IntPtr search=FindFirstFileW(Native(directory.TrimEnd('\\')+"\\*"),out data);
    if(search==new IntPtr(-1)) {
      if(Marshal.GetLastWin32Error()==2) return;
      throw Error("Cannot enumerate installation data",directory);
    }
    try {
      do {
        if(data.Name=="." || data.Name=="..") continue;
        string child=relative.Length==0 ? data.Name : relative+"/"+data.Name;
        string path=PangeaPortableFileIO.Child(root,child);
        bool link=(data.Attributes&0x400)!=0, folder=(data.Attributes&16)!=0;
        var entry=new PangeaPortableEntry {Path=child,Kind=link ? (folder ? "link-directory" : "link-file") : (folder ? "directory" : "file"),Length=folder ? 0 : checked(((long)data.SizeHigh<<32)+data.SizeLow),Hash=""};
        if(link) { entry.Length=0; if(hashes) entry.Hash=LinkHash(path); }
        else if(!folder && hashes) {
          using(var stream=PangeaPortableFileIO.Open(path,false)) {
            entry.Length=stream.Length;
            using(var sha=SHA256.Create()) entry.Hash=Hex(sha.ComputeHash(stream));
          }
        }
        entries.Add(entry);
        if(folder && !link) Walk(root,child,hashes,entries,depth+1);
      } while(FindNextFileW(search,out data));
      if(Marshal.GetLastWin32Error()!=18) throw Error("Cannot finish installation inventory",directory);
    } finally { FindClose(search); }
  }
  public static PangeaPortableEntry[] Inventory(string root,bool hashes) {
    uint attributes=GetFileAttributesW(Native(root));
    if(attributes==UInt32.MaxValue) throw Error("Cannot inspect installation data",root);
    if((attributes&16)==0 || (attributes&0x400)!=0) throw new IOException("Data root must be a real directory, not a link: "+root);
    var entries=new System.Collections.Generic.List<PangeaPortableEntry>();
    Walk(root,"",hashes,entries,0);
    entries.Sort(delegate(PangeaPortableEntry a,PangeaPortableEntry b) {return StringComparer.OrdinalIgnoreCase.Compare(a.Path,b.Path);});
    return entries.ToArray();
  }
  public static string Fingerprint(string root) {
    using(var sha=SHA256.Create()) {
      foreach(var entry in Inventory(root,true)) {
        byte[] data=Encoding.UTF8.GetBytes(entry.Kind+"\0"+entry.Path+"\0"+entry.Length+"\0"+entry.Hash+"\n");
        sha.TransformBlock(data,0,data.Length,data,0);
      }
      sha.TransformFinalBlock(new byte[0],0,0); return Hex(sha.Hash);
    }
  }
}
'@
}

function Expand-VerifiedArchive {
  param([string]$Archive, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Initialize-PortableFileIO
  [PangeaPortableFileIO]::EnsureDirectory($Destination)
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $Total=@($Zip.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }).Count
    $Completed=0; $LastProgress=[DateTime]::UtcNow
    foreach ($Entry in $Zip.Entries) {
      $Relative = $Entry.FullName.TrimEnd([char[]]@('/', '\'))
      $Target = [PangeaPortableFileIO]::Child($Destination, $Relative)
      if ([string]::IsNullOrEmpty($Entry.Name)) {
        [PangeaPortableFileIO]::EnsureDirectory($Target)
        continue
      }
      Write-ZipEntryFile $Entry $Target
      $Completed++
      if (($Completed % 100 -eq 0) -or $Completed -eq $Total -or ([DateTime]::UtcNow-$LastProgress).TotalSeconds -ge 2) {
        Set-UpdateStage "正在解压新版本：$Completed / $Total 个文件" (42+[int](24*$Completed/[Math]::Max(1,$Total))) 'extract' $Completed $Total
        $LastProgress=[DateTime]::UtcNow
      }
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
  Write-ZipEntryFile $Entry $Destination
}

function Write-ZipEntryFile {
  param($Entry, [string]$Destination)
  Initialize-PortableFileIO
  $ZipInput = $Entry.Open()
  try {
    $Output = [PangeaPortableFileIO]::Open($Destination, $true)
    try { $ZipInput.CopyTo($Output) } finally { $Output.Dispose() }
  } finally { $ZipInput.Dispose() }
}

function Apply-VerifiedPatch {
  param([string]$Archive, [string]$BaseRoot, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  Initialize-PortableFileIO
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

    [PangeaPortableFileIO]::EnsureDirectory($Destination)
    $Completed = 0; $LastProgress=[DateTime]::UtcNow
    foreach ($File in $TargetManifest.files) {
      $Relative = [string]$File.path
      $TargetPath = [PangeaPortableFileIO]::Child($Destination, $Relative)
      $Key = $Relative.ToLowerInvariant()
      if ($Payload.ContainsKey($Key)) {
        Extract-ZipEntry $Zip ("payload/" + $Relative) $TargetPath
      } else {
        $BasePath = [PangeaPortableFileIO]::Child($BaseRoot, $Relative)
        if (-not [PangeaPortableFileIO]::IsFile($BasePath)) { throw "Base package is missing unchanged file: $Relative" }
        [PangeaPortableFileIO]::Copy($BasePath, $TargetPath)
      }
      [PangeaPortableFileIO]::Verify($TargetPath, [long]$File.size, [string]$File.sha256, $Relative)
      $Completed++
      if ($Completed % 100 -eq 0 -or $Completed -eq $TargetManifest.files.Count -or ([DateTime]::UtcNow-$LastProgress).TotalSeconds -ge 2) {
        Set-UpdateStage "正在重建并校验补丁：$Completed / $($TargetManifest.files.Count) 个文件" (42 + [int](24 * $Completed / $TargetManifest.files.Count)) 'rebuild' $Completed $TargetManifest.files.Count
        $LastProgress=[DateTime]::UtcNow
      }
    }
    Extract-ZipEntry $Zip 'target/resources/update/pangea-package-manifest.json' (Join-Path $Destination 'resources\update\pangea-package-manifest.json')
    Extract-ZipEntry $Zip 'target/resources/update/pangea-package-manifest.json.sig' (Join-Path $Destination 'resources\update\pangea-package-manifest.json.sig')
  } finally { $Zip.Dispose() }
}

function Initialize-PortableTransactionPaths {
  if ('PangeaTransactionPaths' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class PangeaTransactionPaths {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);
  public static string Parent(string path) {
    if (Path.DirectorySeparatorChar != '\\') return Path.GetFullPath(path);
    using (var handle=CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Cannot canonicalize installation parent");
      var result=new StringBuilder(32768);
      uint length=GetFinalPathNameByHandleW(handle, result, (uint)result.Capacity, 0);
      if (length==0 || length>=result.Capacity) throw new IOException("Cannot canonicalize installation parent");
      string value=result.ToString();
      if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) return @"\\"+value.Substring(8);
      return value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase) ? value.Substring(4) : value;
    }
  }
}
'@
}

function Assert-PortableTransactionPath {
  param([string]$Path)
  # Recovery never follows links in a mutable transaction path or its parents.
  $Cursor = [IO.Path]::GetFullPath($Path)
  while ($Cursor) {
    $Item=$null
    try { $Item=Get-Item -LiteralPath $Cursor -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { }
    if ($Item) {
      if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Recovery refuses a linked path: $Cursor"
      }
    }
    $Parent = [IO.Path]::GetDirectoryName($Cursor)
    if (-not $Parent -or $Parent -eq $Cursor) { break }
    $Cursor = $Parent
  }
}

function Get-PortableTransactionContext {
  param([string]$Root)
  Initialize-PortableTransactionPaths
  $Full = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $Parent = [IO.Path]::GetDirectoryName($Full)
  if (-not $Parent -or -not [IO.Directory]::Exists($Parent)) { throw 'The installation must have an existing non-root parent directory.' }
  $Parent = [PangeaTransactionPaths]::Parent($Parent)
  $Canonical = Join-Path $Parent ([IO.Path]::GetFileName($Full))
  Assert-PortableTransactionPath $Canonical
  $Hasher = [Security.Cryptography.SHA256]::Create()
  try { $Key = ([BitConverter]::ToString($Hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical.ToLowerInvariant())))).Replace('-', '').ToLowerInvariant() }
  finally { $Hasher.Dispose() }
  $Prefix = Join-Path $Parent ".pangea-update-$Key"
  return [pscustomobject]@{ InstallRoot=$Canonical; Parent=$Parent; Journal="$Prefix.json"; LockPath="$Prefix.lock" }
}

function Enter-PortableUpdateLock {
  param($Context)
  Assert-PortableTransactionPath $Context.LockPath
  try {
    # A persistent file is intentional: deleting it after release could let two
    # different file objects protect the same install. Process death releases it.
    return [IO.File]::Open($Context.LockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch { throw "另一个升级或恢复进程正在使用此安装目录，或互斥文件不可写：$($Context.InstallRoot)。$($_.Exception.Message)" }
}

function Get-PortableTransactionOwner {
  if ([IO.Path]::DirectorySeparatorChar -eq '\') { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
  return [Environment]::UserName
}

function Get-PortableTransactionWorkerIdentity {
  $Process=[Diagnostics.Process]::GetCurrentProcess()
  try { return [pscustomobject]@{ pid=$Process.Id; started_at=$Process.StartTime.ToUniversalTime().ToString('o') } }
  finally { $Process.Dispose() }
}

function Write-PortableTransactionJson {
  param([string]$Path, $Value)
  Assert-PortableTransactionPath $Path
  $Temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  $Stream = $null
  try {
    $Stream = New-Object IO.FileStream($Temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::WriteThrough)
    $Bytes = [Text.Encoding]::UTF8.GetBytes(($Value | ConvertTo-Json -Depth 12))
    $Stream.Write($Bytes, 0, $Bytes.Length)
    $Stream.Flush($true); $Stream.Dispose(); $Stream=$null
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Path) }
  } finally {
    if ($Stream) { $Stream.Dispose() }
    if ([IO.File]::Exists($Temporary)) { [IO.File]::Delete($Temporary) }
  }
}

function Get-PortableRootIdentity {
  param([string]$Root)
  Assert-PortableTransactionPath $Root
  $Relative = 'resources/pangea-manifest.json'
  $Path = Join-Path $Root $Relative
  Assert-PortableTransactionPath $Path
  if (-not [IO.File]::Exists($Path)) { throw "Installation identity is missing: $Path" }
  $Manifest = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  if ([string]$Manifest.product.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "Invalid installation version: $Path" }
  return [pscustomobject]@{ relative_path=$Relative; version=[string]$Manifest.product.version; sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
}

function Test-PortableRootIdentity {
  param([string]$Root, $Identity)
  if (-not $Identity -or -not [IO.Directory]::Exists($Root)) { return $false }
  if ([string]$Identity.relative_path -ne 'resources/pangea-manifest.json' -or [string]$Identity.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid transaction installation identity.' }
  $Actual = Get-PortableRootIdentity $Root
  return $Actual.version -eq [string]$Identity.version -and $Actual.sha256 -eq [string]$Identity.sha256
}

function Assert-PortableUpgradeSourceVersion {
  param([string]$Root, [string]$PackageKind, [string]$ExpectedBase)
  # Keep in sync with build/portable-update-policy.json; the signed helper is a
  # standalone file and cannot trust a separate policy file supplied at runtime.
  $MinimumSourceVersion = '2.1.5'
  $Identity = Get-PortableRootIdentity $Root
  if ($Identity.version -notmatch '^(\d+\.\d+\.\d+)(?:-[0-9A-Za-z.-]+)?$' -or [version]$Matches[1] -lt [version]$MinimumSourceVersion) {
    throw "当前版本 $($Identity.version) 低于最低可升级版本 $MinimumSourceVersion。请使用完整安装包迁移。"
  }
  if ($PackageKind -eq 'patch' -and ($ExpectedBase -ne $Identity.version)) { throw "Installed version $($Identity.version) does not match patch base $ExpectedBase." }
  return $Identity
}

function Get-PortableStartupHealthTimeout {
  param($UpdatePlan)
  if (-not $UpdatePlan.PSObject.Properties['startup_health_timeout_seconds']) { return 300 }
  $Value=[string]$UpdatePlan.startup_health_timeout_seconds
  if ($Value -notmatch '^\d{2,3}$' -or [int]$Value -lt 30 -or [int]$Value -gt 600) { throw 'startup_health_timeout_seconds must be an integer from 30 through 600.' }
  return [int]$Value
}

function New-PortableUpdateTransaction {
  param($Context, [string]$Workspace, $BaseIdentity, [string]$TargetVersion, [string]$OriginalPlan, [string]$UserDataRoot)
  $WorkerIdentity=Get-PortableTransactionWorkerIdentity
  $Transaction = [pscustomobject]@{
    schema_version=1; id=[guid]::NewGuid().ToString('N'); owner=(Get-PortableTransactionOwner)
    install_root=$Context.InstallRoot; workspace=[IO.Path]::GetFullPath($Workspace)
    plan_path=[IO.Path]::GetFullPath($OriginalPlan); user_data_root=[IO.Path]::GetFullPath($UserDataRoot)
    base_version=$BaseIdentity.version; target_version=$TargetVersion; base_identity=$BaseIdentity; target_identity=$null
    state='preparing'; profile_snapshot_ready=$false; new_version_started=$false
    worker_pid=$WorkerIdentity.pid; worker_started_at=$WorkerIdentity.started_at
    updated_at=[DateTime]::UtcNow.ToString('o')
  }
  Assert-PortableTransactionPath $Workspace
  if ([IO.Path]::GetDirectoryName($Transaction.workspace) -ine $Context.Parent -or [IO.Path]::GetFileName($Transaction.workspace) -notmatch '^p-up-[1-9][0-9]*$') { throw 'Unsafe transaction workspace.' }
  Write-PortableTransactionJson (Join-Path $Workspace '.pangea-update-owner.json') @{ schema_version=1; id=$Transaction.id; install_root=$Context.InstallRoot; owner=$Transaction.owner }
  Write-PortableTransactionJson $Context.Journal $Transaction
  return $Transaction
}

function Set-PortableTransactionState {
  param($Context, $Transaction, [string]$State)
  $Transaction.state=$State; $Transaction.updated_at=[DateTime]::UtcNow.ToString('o')
  Write-PortableTransactionJson $Context.Journal $Transaction
}

function Read-PortableUpdateTransaction {
  param($Context, [string]$UserDataRoot)
  Assert-PortableTransactionPath $Context.Journal
  if (-not [IO.File]::Exists($Context.Journal)) { return $null }
  $Transaction = [IO.File]::ReadAllText($Context.Journal) | ConvertFrom-Json
  if ($Transaction.schema_version -ne 1 -or $Transaction.id -notmatch '^[a-f0-9]{32}$' -or
      [string]$Transaction.owner -ne (Get-PortableTransactionOwner) -or
      [string]$Transaction.install_root -ine $Context.InstallRoot -or
      [IO.Path]::GetFullPath([string]$Transaction.user_data_root) -ine [IO.Path]::GetFullPath($UserDataRoot) -or
      $Transaction.profile_snapshot_ready -isnot [bool] -or $Transaction.new_version_started -isnot [bool] -or
      $Transaction.state -notin @('preparing','candidate_ready','original_move_pending','original_moved','activate_pending','activated','rollback_pending','rollback_displaced','restored','committed')) { throw 'The interrupted update transaction has invalid identity or state; no files were moved.' }
  $UpdatesPrefix=(Join-Path ([IO.Path]::GetFullPath($UserDataRoot)) 'updates') + [IO.Path]::DirectorySeparatorChar
  if (-not [IO.Path]::GetFullPath([string]$Transaction.plan_path).StartsWith($UpdatesPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The interrupted update plan is outside this user profile.' }
  if ($Transaction.base_identity.version -ne $Transaction.base_version -or ($Transaction.target_identity -and $Transaction.target_identity.version -ne $Transaction.target_version)) { throw 'The transaction version identities do not match.' }
  # Completed transactions no longer depend on disposable recovery files.
  # Confirm the installed version before accepting a terminal journal; never
  # recreate an ownership receipt or mutate an unowned workspace.
  if ($Transaction.state -in @('restored','committed')) {
    $Identity=if ($Transaction.state -eq 'committed') { $Transaction.target_identity } else { $Transaction.base_identity }
    if (-not (Test-PortableRootIdentity $Context.InstallRoot $Identity)) { throw 'Completed update installation identity is missing or changed; no files were moved.' }
    return $Transaction
  }
  $Workspace = [IO.Path]::GetFullPath([string]$Transaction.workspace)
  if ([IO.Path]::GetDirectoryName($Workspace) -ine $Context.Parent -or [IO.Path]::GetFileName($Workspace) -notmatch '^p-up-[1-9][0-9]*$') { throw 'The interrupted update workspace is outside its reserved location.' }
  foreach ($Path in @($Workspace, (Join-Path $Workspace 'old'), (Join-Path $Workspace 'new'), (Join-Path $Workspace 'failed'), (Join-Path $Workspace 'profile'))) { Assert-PortableTransactionPath $Path }
  $OwnerPath = Join-Path $Workspace '.pangea-update-owner.json'
  Assert-PortableTransactionPath $OwnerPath
  if (-not [IO.File]::Exists($OwnerPath)) { throw "中断升级的工作区归属记录缺失，无法自动恢复。状态：$($Transaction.state)；事务：$($Context.Journal)；归属记录：$OwnerPath。所有版本目录保持不变。" }
  $Owner = [IO.File]::ReadAllText($OwnerPath) | ConvertFrom-Json
  if ($Owner.schema_version -ne 1 -or $Owner.id -ne $Transaction.id -or $Owner.install_root -ine $Context.InstallRoot -or $Owner.owner -ne $Transaction.owner) { throw 'The interrupted update workspace does not belong to this transaction.' }
  return $Transaction
}

function Restore-PortableUpdateTransaction {
  param($Context, $Transaction, [string]$UserDataRoot)
  # Re-read durable intent before any mutation. Never trust only in-memory flags.
  $Current = Read-PortableUpdateTransaction $Context $UserDataRoot
  if (-not $Current -or $Current.id -ne $Transaction.id) { throw 'The transaction changed before recovery.' }
  $Transaction=$Current
  $Root=$Context.InstallRoot; $Old=Join-Path $Transaction.workspace 'old'; $Failed=Join-Path $Transaction.workspace 'failed'
  if ($Transaction.state -eq 'committed') {
    if (-not (Test-PortableRootIdentity $Root $Transaction.target_identity)) { throw 'Committed installation identity is missing or changed; automatic rollback is forbidden.' }
    return $Transaction
  }
  if ($Transaction.state -eq 'restored') {
    if (-not (Test-PortableRootIdentity $Root $Transaction.base_identity)) { throw 'Restored installation identity has changed; no recovery actions were repeated.' }
    # A completed rollback is a terminal transaction. The user may have edited
    # configuration since then; never replay its profile snapshot again.
    return $Transaction
  }
  if ([IO.Directory]::Exists($Old)) {
    if (-not (Test-PortableRootIdentity $Old $Transaction.base_identity)) { throw 'Original backup identity does not match; all directories have been preserved.' }
    if ([IO.Directory]::Exists($Root)) {
      if (-not (Test-PortableRootIdentity $Root $Transaction.target_identity)) { throw 'An unexpected installation occupies the target path; recovery will not overwrite it.' }
      if (Test-Path -LiteralPath $Failed) { throw 'The recovery preservation directory already exists; no data will be overwritten.' }
      Set-PortableTransactionState $Context $Transaction 'rollback_pending'
      Move-UpdateDirectory $Root $Failed -ResolveLocks
      Set-PortableTransactionState $Context $Transaction 'rollback_displaced'
    } elseif (Test-Path -LiteralPath $Root) { throw 'A file occupies the installation path; recovery will not replace it.' }
    Set-PortableTransactionState $Context $Transaction 'rollback_displaced'
    Move-UpdateDirectory $Old $Root -ResolveLocks
  }
  if (-not (Test-PortableRootIdentity $Root $Transaction.base_identity)) { throw "Original installation could not be confirmed. Preserve the transaction workspace: $($Transaction.workspace)" }
  if ($Transaction.profile_snapshot_ready -eq $true -and $Transaction.new_version_started -eq $true) {
    Restore-UpdateProfileSnapshot -UserDataRoot $UserDataRoot -SnapshotRoot (Join-Path $Transaction.workspace 'profile') | Out-Null
  }
  # Retain candidate/failed/profile directories for diagnosis and user edits.
  # A future attempt reserves another p-up-N; recovery never recursively deletes.
  Set-PortableTransactionState $Context $Transaction 'restored'
  return $Transaction
}

$script:UpdaterScriptPath = $PSCommandPath
if ($IOWorker) { Invoke-PortableIOWorkerEntry $IOWorker; exit 0 }
if ($WatchExplorer) { Watch-ExplorerRecovery $WatchExplorer; exit 0 }
if ($ScanLocks) {
  Initialize-HandleInspector
  $Holders = @([PangeaUpdateHandles]::Scan($ScanRoot))
  [IO.File]::WriteAllText($ScanOutput, (ConvertTo-Json -InputObject $Holders -Depth 4), (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if (-not $PlanPath) { throw 'PlanPath is required.' }
try {
  $Plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Plan.schema_version -notin @(1, 2)) { throw 'Unsupported portable update plan.' }
  $InstallRoot = [IO.Path]::GetFullPath([string]$Plan.install_root)
  $InstallParent = [IO.Path]::GetDirectoryName($InstallRoot)
  $PackagePath = [IO.Path]::GetFullPath([string]$Plan.package_path)
  $ExecutableName = [string]$Plan.executable_name
  $ExpectedVersion = [string]$Plan.expected_version
  $PackageType = if ($Plan.PSObject.Properties['package_type'] -and $Plan.package_type) { [string]$Plan.package_type } else { 'full' }
  $ExpectedBaseVersion = if ($Plan.PSObject.Properties['expected_base_version'] -and $Plan.expected_base_version) { [string]$Plan.expected_base_version } else { '' }
  $ExpectedSize = [long]$Plan.expected_size
  $ExpectedSha256 = [string]$Plan.expected_sha256
  $HealthMarker = [IO.Path]::GetFullPath([string]$Plan.health_marker)
  $ResultPath = [IO.Path]::GetFullPath([string]$Plan.result_path)
  $LogPath = [IO.Path]::GetFullPath([string]$Plan.log_path)
  $ParentPid = [int]$Plan.parent_pid
  $StartupHealthTimeoutSeconds=Get-PortableStartupHealthTimeout $Plan
  if ([IO.Path]::GetFileName($ExecutableName) -ne $ExecutableName -or -not $ExecutableName.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { throw 'The portable executable name is invalid.' }
  $UpdatesRoot = [IO.Path]::GetDirectoryName($ResultPath)
  $UserDataRoot = [IO.Path]::GetDirectoryName($UpdatesRoot)
  if ([IO.Path]::GetFileName($UpdatesRoot) -ine 'updates' -or -not [IO.Path]::GetFullPath($PlanPath).StartsWith($UpdatesRoot.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The update plan must belong to the profile updates directory.' }
  $TransactionContext = Get-PortableTransactionContext $InstallRoot
  $InstallRoot=$TransactionContext.InstallRoot; $InstallParent=$TransactionContext.Parent
  $InstalledExecutable = Join-Path $InstallRoot $ExecutableName
} catch {
  $ErrorFile=if ($WatchUpdate) { "$PlanPath.ui-error" } else { "$PlanPath.startup-error" }
  try { [IO.File]::WriteAllText($ErrorFile,$_.Exception.Message,(New-Object Text.UTF8Encoding($false))) } catch { }
  throw
}
if ($WatchUpdate) { Watch-UpdateWindow; exit 0 }

$UpdateWorkspace = $null
$CandidateRoot = $null; $BackupRoot = $null; $FailedRoot = $null
$Transaction = $null; $InstallLock = $null; $RecoveryBlocked = $false; $RecoveryCompletionState = ''; $NewProcess = $null
$script:UnsafeIOWorker = $false
$script:OwnedUpdateProcesses = @()
$script:AutomaticUpdateCleanup = $Plan.PSObject.Properties['allow_owned_process_cleanup'] -and $Plan.allow_owned_process_cleanup -eq $true
$DesktopIdentity = $null
$script:ProtectedUpdateProcesses = @($PID, $ParentPid)

# The installed Desktop remains open until the independent window is visible
# and process ownership has been captured. Never acknowledge a hidden updater.
try {
  $InstallLock = Enter-PortableUpdateLock $TransactionContext
  Open-UpdateWindow
  $script:ProtectedUpdateProcesses += $script:UpdateMonitor.Id
  Set-UpdateStage '升级窗口已就绪，正在记录进程信息；当前主窗口暂时保持打开…' 5 'prepare'
  try {
    $ProcessRows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $AncestorId = $PID
    for ($Depth=0; $Depth -lt 32; $Depth++) {
      $Row = $ProcessRows | Where-Object { [int]$_.ProcessId -eq $AncestorId } | Select-Object -First 1
      if (-not $Row -or [int]$Row.ParentProcessId -le 0) { break }
      $AncestorId = [int]$Row.ParentProcessId
      if ($AncestorId -in $script:ProtectedUpdateProcesses) { break }
      $script:ProtectedUpdateProcesses += $AncestorId
    }
    if ($script:AutomaticUpdateCleanup) {
      $Desktop = Get-Process -Id $ParentPid -ErrorAction Stop
      if ($Desktop.Path -ine $InstalledExecutable) { throw 'Desktop executable identity does not match update plan.' }
      $DesktopIdentity = [pscustomobject]@{ Id=$Desktop.Id; Created=$Desktop.StartTime.ToUniversalTime().ToFileTimeUtc() }
      $script:OwnedUpdateProcesses = @(Get-OwnedUpdateProcesses $ParentPid $InstalledExecutable)
      foreach ($Instance in @(Get-Process | Where-Object { try { $_.Id -ne $ParentPid -and $_.Path -ieq $InstalledExecutable } catch { $false } })) {
        $script:OwnedUpdateProcesses += [pscustomobject]@{ Id=$Instance.Id; Created=$Instance.StartTime.ToUniversalTime().ToFileTimeUtc(); Executable=$Instance.Path }
        $script:OwnedUpdateProcesses += @(Get-OwnedUpdateProcesses $Instance.Id $InstalledExecutable)
      }
      $script:OwnedUpdateProcesses = @($script:OwnedUpdateProcesses | Where-Object { $_.Id -notin $script:ProtectedUpdateProcesses })
    }
  } catch {
    $script:AutomaticUpdateCleanup=$false; $script:OwnedUpdateProcesses=@()
    Write-UpdateLog "Process ownership snapshot unavailable; descendant cleanup disabled: $($_.Exception.Message)"
  }
  if (Test-Path -LiteralPath "$PlanPath.cancel") { throw '升级启动已取消，当前版本保持运行。' }
  $script:UpdateMonitor.Refresh()
  if ($script:UpdateMonitor.HasExited -or (Test-Path -LiteralPath "$PlanPath.ui-error")) { throw '升级窗口已关闭或启动失败，已取消升级。' }
  Write-AtomicUpdateJson "$PlanPath.ready" @{ schema_version=1; ui_ready=$true; worker_pid=$PID; monitor_pid=$script:UpdateMonitor.Id }
  Wait-UpdateHandoff
} catch {
  $StartupMessage=$_.Exception.Message
  Write-UpdateLog "updater startup cancelled: $StartupMessage"
  try { [IO.File]::WriteAllText("$PlanPath.startup-error",$StartupMessage,(New-Object Text.UTF8Encoding($false))) } catch { }
  Write-UpdateResult 'failed' $StartupMessage 'not_needed'
  Write-UpdateProgress -State failed -Stage 'startup' -Message $StartupMessage -Percent 0 -Rollback 'not_needed'
  if ($InstallLock) { $InstallLock.Dispose() }
  exit 1
}

try {
  Write-UpdateLog "waiting for PANGEA Desktop process $ParentPid"
  Set-UpdateStage '正在等待当前版本退出…' 12 'desktop-exit'
  Wait-UpdateDesktopExit $ParentPid $DesktopIdentity
  Stop-PortableOwnedWriters -InstallRoot $InstallRoot
  # Recover first: the install path may be temporarily absent between renames.
  # A new package is never applied in the same invocation as crash recovery.
  $RecoveryBlocked=$true
  $PriorTransaction = Read-PortableUpdateTransaction $TransactionContext $UserDataRoot
  if ($RecoverOnly -or ($PriorTransaction -and $PriorTransaction.state -notin @('restored','committed'))) {
    if (-not $PriorTransaction) { throw '没有找到可恢复的升级事务；安装文件未改动。' }
    $Transaction=$PriorTransaction
    Set-UpdateStage '正在检查中断的升级并恢复原版本…' 25 'recover-interrupted'
    $Transaction = Restore-PortableUpdateTransaction $TransactionContext $Transaction $UserDataRoot
    $RecoveryCompletionState=$Transaction.state
    $ExpectedVersion = if ($Transaction.state -eq 'committed') { $Transaction.target_version } else { $Transaction.base_version }
    $RecoveryLog = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) 'recovered-start.log'
    $RecoveryProcess = Start-PortableDesktop $InstalledExecutable "$PlanPath.recovered-healthy.json" $RecoveryLog
    try { Wait-PortableDesktopHealthy $RecoveryProcess "$PlanPath.recovered-healthy.json" $ExpectedVersion -TimeoutSeconds $StartupHealthTimeoutSeconds -Stage 'rollback-health' -Percent 36 | Out-Null }
    finally { $RecoveryProcess.Dispose() }
    $RecoveryMessage="中断升级已处理，版本 $ExpectedVersion 已启动并确认就绪。候选文件和配置快照已保留；如需升级，请重新发起。"
    Write-UpdateResult 'success' $RecoveryMessage $Transaction.state
    Write-UpdateProgress -State success -Stage 'complete' -Message $RecoveryMessage -Percent 100 -Rollback $Transaction.state
    exit 0
  }
  $RecoveryBlocked=$false
  if ([string]::IsNullOrWhiteSpace($InstallParent) -or $InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot)) { throw 'The portable application directory is unsafe to replace.' }
  $BaseIdentity = Assert-PortableUpgradeSourceVersion -Root $InstallRoot -PackageKind $PackageType -ExpectedBase $ExpectedBaseVersion
  Set-UpdateStage '正在校验升级包的大小与 SHA256…' 18 'verify-package'
  Invoke-PortableIOWorker -Operation ValidatePackage -Arguments @{ Path=$PackagePath; Size=$ExpectedSize; Sha256=$ExpectedSha256 } | Out-Null

  Initialize-PortableFileIO
  Assert-PortableUpdatePreflight -InstallRoot $InstallRoot -PackagePath $PackagePath -PackageType $PackageType | Out-Null
  $UpdateWorkspace = [PangeaPortableFileIO]::CreateWorkspace($InstallParent)
  $CandidateRoot = Join-Path $UpdateWorkspace 'new'
  $BackupRoot = Join-Path $UpdateWorkspace 'old'
  $FailedRoot = Join-Path $UpdateWorkspace 'failed'
  $Transaction = New-PortableUpdateTransaction $TransactionContext $UpdateWorkspace $BaseIdentity $ExpectedVersion $PlanPath $UserDataRoot
  Write-UpdateLog "update directories: new=$CandidateRoot; backup=$BackupRoot"

  if ($PackageType -eq 'patch') {
    Set-UpdateStage '正在根据补丁重建新版本，并逐文件校验…' 42 'rebuild'
    if ([string]::IsNullOrWhiteSpace($ExpectedBaseVersion)) { throw 'Patch base version is missing.' }
    $BaseManifestPath = Join-Path $InstallRoot 'resources\update\pangea-package-manifest.json'
    if (-not (Test-Path -LiteralPath $BaseManifestPath -PathType Leaf)) { throw 'Installed package manifest is missing.' }
    $BaseManifest = Get-Content -LiteralPath $BaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$BaseManifest.version -ne $ExpectedBaseVersion) { throw "Installed version $($BaseManifest.version) does not match patch base $ExpectedBaseVersion." }
    Invoke-PortableIOWorker -Operation Patch -Arguments @{ Archive=$PackagePath; BaseRoot=$InstallRoot; Destination=$CandidateRoot } | Out-Null
  } elseif ($PackageType -eq 'full') {
    Set-UpdateStage '正在解压新版本文件…' 42 'extract'
    Invoke-PortableIOWorker -Operation Extract -Arguments @{ Archive=$PackagePath; Destination=$CandidateRoot } | Out-Null
  } else { throw "Unsupported package type: $PackageType" }
  $CandidateExecutable = Join-Path $CandidateRoot $ExecutableName
  $CandidateManifest = Join-Path $CandidateRoot 'resources\pangea-manifest.json'
  if (-not (Test-Path -LiteralPath $CandidateExecutable -PathType Leaf)) { throw "Updated executable is missing: $ExecutableName" }
  if (-not (Test-Path -LiteralPath $CandidateManifest -PathType Leaf)) { throw 'Updated component manifest is missing.' }
  $Manifest = Get-Content -LiteralPath $CandidateManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$Manifest.product.version -ne $ExpectedVersion) { throw "Updated product version does not match $ExpectedVersion." }
  $Transaction.target_identity=Get-PortableRootIdentity $CandidateRoot
  Set-PortableTransactionState $TransactionContext $Transaction 'candidate_ready'

  Set-UpdateStage '正在保留用户工作区、任务和本地技能…' 70 'user-data'
  Stop-PortableOwnedWriters -InstallRoot $InstallRoot
  Copy-PortableUserData $InstallRoot $CandidateRoot
  New-UpdateProfileSnapshot -UserDataRoot $UserDataRoot -SnapshotRoot (Join-Path $UpdateWorkspace 'profile') | Out-Null
  $Transaction.profile_snapshot_ready=$true
  Set-PortableTransactionState $TransactionContext $Transaction 'candidate_ready'
  Assert-PortableUserDataUnchanged -PreviousRoot $InstallRoot -CandidateRoot $CandidateRoot
  Set-UpdateStage '正在切换版本，保留原版本备份…' 76 'switch-version'
  Set-PortableTransactionState $TransactionContext $Transaction 'original_move_pending'
  Move-UpdateDirectory $InstallRoot $BackupRoot -ResolveLocks
  Set-PortableTransactionState $TransactionContext $Transaction 'original_moved'
  Assert-PortableUserDataUnchanged -PreviousRoot $BackupRoot -CandidateRoot $CandidateRoot
  Set-UpdateStage '原版本已备份，正在启用新版本…' 78 'switch-version'
  Set-PortableTransactionState $TransactionContext $Transaction 'activate_pending'
  Move-UpdateDirectory $CandidateRoot $InstallRoot -ResolveLocks
  Set-PortableTransactionState $TransactionContext $Transaction 'activated'

  $UpdatedExecutable = Join-Path $InstallRoot $ExecutableName
  $LaunchLog = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) 'desktop-start.log'
  Set-UpdateStage '正在启动新版本…' 82 'start-version'
  $Transaction.new_version_started=$true
  Set-PortableTransactionState $TransactionContext $Transaction 'activated'
  $NewProcess = Start-PortableDesktop $UpdatedExecutable $HealthMarker $LaunchLog
  Wait-PortableDesktopHealthy $NewProcess $HealthMarker $ExpectedVersion -TimeoutSeconds $StartupHealthTimeoutSeconds | Out-Null
  Set-PortableTransactionState $TransactionContext $Transaction 'committed'
  Set-UpdateStage '新版健康检查通过，正在恢复资源管理器并清理备份…' 97 'cleanup'
  $SuccessMessage='升级完成，新版本已通过健康检查并重新启动。'
  try { Complete-ExplorerRecovery } catch { $SuccessMessage+=" 资源管理器恢复提示：$($_.Exception.Message)"; Write-UpdateLog $SuccessMessage }
  if (Test-Path -LiteralPath $BackupRoot) {
    try { Remove-PortableDirectory $BackupRoot } catch { $SuccessMessage+=" 旧版本备份暂未清理：$BackupRoot"; Write-UpdateLog $_.Exception.Message }
  }
  # Retain the ownership receipt and profile snapshot. A committed transaction
  # never rolls back because later cleanup or result persistence failed.
  Write-UpdateResult 'success' $SuccessMessage
  Write-UpdateProgress -State success -Stage 'complete' -Message $SuccessMessage -Percent 100
  exit 0
} catch {
  $FailureMessage = $_.Exception.Message
  Write-UpdateLog "update failed: $FailureMessage"
  Write-UpdateLog "failed operation: $($_.InvocationInfo.PositionMessage)"
  if ($script:UnsafeIOWorker -or $RecoveryBlocked) {
    $ReportedRollback=if ($RecoveryCompletionState) { $RecoveryCompletionState } else { 'unknown' }
    $FailureMessage=if ($RecoveryCompletionState) { "版本目录已确认（$RecoveryCompletionState），但工作台启动未确认；仍在启动的进程会保留。$FailureMessage" } else { "升级或恢复未完成，目录及事务已保留；请查看日志后恢复，当前不会继续切换或启动其他版本。$FailureMessage" }
    Write-UpdateResult 'failed' $FailureMessage $ReportedRollback
    Write-UpdateProgress -State failed -Stage 'interrupted' -Message $FailureMessage -Percent 35 -Rollback $ReportedRollback
    exit 1
  }
  if ($Transaction) {
    try { $DurableTransaction=Read-PortableUpdateTransaction $TransactionContext $UserDataRoot }
    catch {
      $FailureMessage+=" 无法安全读取事务，所有版本目录已保留：$($_.Exception.Message)"
      Write-UpdateResult 'failed' $FailureMessage 'unknown'
      Write-UpdateProgress -State failed -Stage 'interrupted' -Message $FailureMessage -Percent 35 -Rollback 'unknown'
      exit 1
    }
    if ($DurableTransaction -and $DurableTransaction.state -eq 'committed') {
      $CommittedMessage="新版本已通过健康检查并提交；后续清理未完成，保留当前版本。$FailureMessage"
      Write-UpdateResult 'success' $CommittedMessage
      Write-UpdateProgress -State success -Stage 'complete' -Message $CommittedMessage -Percent 100
      exit 0
    }
  }
  Set-UpdateStage '升级失败，正在检查并恢复原版本，请勿关闭计算机…' 35 'rollback'
  if ($NewProcess) {
    try {
      $NewProcess.Refresh()
      if (-not $NewProcess.HasExited) {
        # Capture this attempted version's descendants before stopping its main
        # process. Any remaining runtime holders can then be identity-checked
        # by the same lock resolver during rollback, not guessed from a PID.
        try { $script:OwnedUpdateProcesses += @(Get-OwnedUpdateProcesses $NewProcess.Id $UpdatedExecutable) }
        catch { Write-UpdateLog "Could not snapshot new-version children: $($_.Exception.Message)" }
        $NewIdentity = [pscustomobject]@{ Id=$NewProcess.Id; Created=$NewProcess.StartTime.ToUniversalTime().ToFileTimeUtc(); Executable=$UpdatedExecutable }
        $script:OwnedUpdateProcesses += $NewIdentity
        Initialize-HandleInspector
        $Stopped = [PangeaUpdateHandles]::Stop($NewIdentity.Id, $NewIdentity.Created)
        Write-UpdateLog "new-version process stopped before rollback: pid=$($NewIdentity.Id); stopped=$Stopped"
      }
    } catch { Write-UpdateLog "Could not stop new-version process: $($_.Exception.Message)" }
  }
  $Restored = $false
  $Rollback=if ($Transaction) { 'failed' } else { 'not_needed' }
  try {
    Stop-PortableOwnedWriters -InstallRoot $InstallRoot
    if ($Transaction) {
      $Transaction=Restore-PortableUpdateTransaction $TransactionContext $Transaction $UserDataRoot
      $Restored=$true; $Rollback='restored'
      Write-UpdateLog 'previous PANGEA Desktop directory and profile restored'
    } else { $Restored=Test-Path -LiteralPath $InstallRoot -PathType Container }
    if (-not $Restored) { throw "Original installation retained at '$BackupRoot'; automatic restoration could not be confirmed." }
  } catch {
    $FailureMessage+=" 回滚未完成：$($_.Exception.Message)。原版本备份：'$BackupRoot'。"
    Write-UpdateLog $FailureMessage
  }
  if ($Restored) {
    # Failed attempts may contain new user edits. Preserve them and the profile
    # snapshot even after rollback; do not silently discard diagnostic material.
    if (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf) {
      $RecoveryProcess = $null
      $RecoveryLog = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) 'rollback-start.log'
      $RecoveryMarker = "$PlanPath.rollback-healthy.json"
      try {
        $PreviousVersion = $ExpectedBaseVersion
        $PreviousManifestPath = Join-Path $InstallRoot 'resources\pangea-manifest.json'
        if (Test-Path -LiteralPath $PreviousManifestPath -PathType Leaf) {
          try {
            $RecordedVersion = [string]((Get-Content -LiteralPath $PreviousManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json).product.version)
            if (-not [string]::IsNullOrWhiteSpace($RecordedVersion)) { $PreviousVersion = $RecordedVersion }
          }
          catch { Write-UpdateLog "Could not read restored version metadata: $($_.Exception.Message)" }
        }
        # Publish the failure before the restored Desktop loads its update status.
        Write-UpdateResult 'failed' ("$FailureMessage 原版本文件已保留，正在确认工作台恢复启动。") $Rollback
        Set-UpdateStage '原版本文件已保留，正在重新启动工作台…' 36 'rollback-start'
        $RecoveryProcess = Start-PortableDesktop $InstalledExecutable $RecoveryMarker $RecoveryLog
        Wait-PortableDesktopHealthy $RecoveryProcess $RecoveryMarker $PreviousVersion -TimeoutSeconds $StartupHealthTimeoutSeconds -Stage 'rollback-health' -Percent 36 | Out-Null
        $FailureMessage+=' 原版本文件已保留，工作台已重新启动并确认就绪。'
      } catch {
        $FailureMessage+=" 原版本文件已保留，但工作台恢复启动未确认：$($_.Exception.Message) 启动日志：$RecoveryLog（另见 .stdout / .stderr）。"
        Write-UpdateLog $FailureMessage
      } finally {
        # Never kill a restored Desktop that is still starting after the timeout.
        if ($RecoveryProcess) { $RecoveryProcess.Dispose() }
      }
    } else { $FailureMessage+=' 未找到可启动的原版本程序，请查看日志。' }
  }
  try { Complete-ExplorerRecovery } catch { $FailureMessage+=" 资源管理器恢复失败：$($_.Exception.Message)"; Write-UpdateLog $FailureMessage }
  $FailureMessage="升级失败。$FailureMessage"
  Write-UpdateResult 'failed' $FailureMessage $Rollback
  Write-UpdateProgress -State failed -Stage 'failed' -Message $FailureMessage -Percent 35 -Rollback $Rollback
  exit 1
} finally {
  # Best effort only: failures here must not erase the true terminal outcome.
  try { Complete-ExplorerRecovery } catch { Write-UpdateLog "Explorer recovery final check: $($_.Exception.Message)" }
  if ($InstallLock) { $InstallLock.Dispose() }
}
