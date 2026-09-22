[CmdletBinding()]
param([string]$PlanPath, [switch]$ScanLocks, [string]$ScanRoot, [string]$ScanOutput, [string]$WatchExplorer)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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
  public static bool Stop(int id, long expectedCreated) {
    IntPtr handle = OpenProcess(0x101001, false, id);
    if (handle == IntPtr.Zero) return false;
    try {
      long created, exited, kernel, user; bool critical;
      if (!GetProcessTimes(handle,out created,out exited,out kernel,out user) || created != expectedCreated ||
          !SameUser(handle) || !IsProcessCritical(handle,out critical) || critical) return false;
      using (var p = Process.GetProcessById(id)) {
        if (p.SessionId != Process.GetCurrentProcess().SessionId) return false;
        p.CloseMainWindow();
      }
      if (WaitForSingleObject(handle,2000) == 0) return true;
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

function Get-UpdateLockHolders {
  param([string]$Root)
  # A remote filesystem handle query can block inside Windows. Isolate the scan
  # and bound its lifetime; only this diagnostic child may be killed on timeout.
  $Output = "$PlanPath.handles-$([guid]::NewGuid().ToString('N')).json"
  $Quote = { param($Value) "'" + $Value.Replace("'", "''") + "'" }
  $Command = '& ' + (& $Quote $script:UpdaterScriptPath) + ' -ScanLocks -ScanRoot ' + (& $Quote $Root) + ' -ScanOutput ' + (& $Quote $Output)
  $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Command))
  $Worker = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',$Encoded) -WorkingDirectory ([IO.Path]::GetDirectoryName($PlanPath)) -WindowStyle Hidden -PassThru
  try {
    $null = $Worker.Handle
    if (-not $Worker.WaitForExit(15000)) { $Worker.Kill(); throw 'Local handle inspection timed out; no occupying processes were stopped.' }
    if ($Worker.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $Output)) { throw 'Local handle inspection unavailable; no occupying processes were stopped.' }
    return @(Get-Content -LiteralPath $Output -Raw | ConvertFrom-Json)
  } finally { $Worker.Dispose(); Remove-Item -LiteralPath $Output -Force -ErrorAction SilentlyContinue }
}

function Get-UpdateHolderPolicy {
  param($Holder, $Owned, [int[]]$ServiceIds, [int[]]$ProtectedIds)
  if ($Holder.Critical -or -not $Holder.SameUser -or $Holder.Session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId -or
      $Holder.Id -in $ServiceIds) { return 'protected' }
  if ($Holder.Name -ieq 'explorer' -and $Holder.Executable -ieq (Join-Path $env:SystemRoot 'explorer.exe')) { return 'explorer' }
  if ($Holder.Id -in $ProtectedIds) { return 'protected' }
  # Exact descendant identity, not a short executable-name allowlist: Electron
  # helpers and shell wrappers can also retain this installation's handles.
  if (@($Owned | Where-Object { $_.Id -eq $Holder.Id -and $_.Created -eq $Holder.Created -and $_.Executable -ieq $Holder.Executable }).Count) { return 'owned' }
  $RuntimeNames = @('node','python','pythonw','opencode','nga','codeagent','claude')
  $IsRuntime = $Holder.Name -in $RuntimeNames
  # Unknown programs, other Desktop instances, Explorer and security software
  # are display-only. Only familiar user applications can be selected locally.
  if ($IsRuntime -or $Holder.Name -in @('Code','notepad','notepad++','powershell','pwsh','cmd','WindowsTerminal')) { return 'confirm' }
  return 'protected'
}

function Confirm-UpdateHolderStop {
  param($Holder)
  Add-Type -AssemblyName System.Windows.Forms
  $Message = "The installation directory is in use by:`n$($Holder.Name) (PID $($Holder.Id))`n$($Holder.Executable)`n`nSave your work first. Ending this process may interrupt its tasks.`nClose it now? This information stays on this computer."
  return [Windows.Forms.MessageBox]::Show($Message, 'PANGEA update - directory in use', 'YesNo', 'Warning', 'Button2') -eq 'Yes'
}

function Confirm-ExplorerRestart {
  Add-Type -AssemblyName System.Windows.Forms
  return [Windows.Forms.MessageBox]::Show('The update needs to restart Windows Explorer. The desktop and taskbar may disappear briefly. Finish all file copy/move operations and save your work first. Continue with the update?', 'PANGEA update - restart Explorer', 'YesNo', 'Warning', 'Button2') -eq 'Yes'
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
  $Watch = Get-Content -LiteralPath $WatchFile -Raw | ConvertFrom-Json
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
  $WatchFile = "$PlanPath.explorer-$([guid]::NewGuid().ToString('N')).json"
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
    $Deadline=(Get-Date).AddSeconds(15)
    while (-not (Test-Path -LiteralPath "$WatchFile.ready")) {
      if ($Guard.HasExited -or (Get-Date) -ge $Deadline) { throw 'Explorer recovery guard did not start; Explorer will not be terminated.' }
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

function Resolve-UpdateDirectoryLocks {
  param([string]$Root)
  try {
    $Holders = @(Get-UpdateLockHolders $Root)
    $ServiceIds = @(Get-CimInstance Win32_Service -Filter "State='Running'" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
    Initialize-HandleInspector
    $ManualHolders = @()
    foreach ($Holder in $Holders) {
      $Policy = Get-UpdateHolderPolicy $Holder $script:OwnedUpdateProcesses $ServiceIds $script:ProtectedUpdateProcesses
      Write-UpdateLog "directory handle: $($Holder.Name) pid=$($Holder.Id); policy=$Policy"
      if ($Policy -eq 'protected') { $ManualHolders += "$($Holder.Name) (PID $($Holder.Id))"; continue }
      if ($Policy -eq 'confirm' -and -not (Confirm-UpdateHolderStop $Holder)) { continue }
      if ($Policy -eq 'explorer') {
        if ((Get-Variable -Name ExplorerRestartAttempted -Scope Script -ErrorAction SilentlyContinue) -and $script:ExplorerRestartAttempted) {
          Write-UpdateLog 'Explorer was already handled once; it will not be repeatedly terminated.'
          continue
        }
        $Automatic = (Get-Variable -Name AutomaticUpdateCleanup -Scope Script -ErrorAction SilentlyContinue) -and $script:AutomaticUpdateCleanup
        if (-not $Automatic -and -not (Confirm-ExplorerRestart)) { continue }
        $script:ExplorerRestartAttempted=$true
        Start-ExplorerRecovery
        Close-InstallationExplorerWindows $Root
        Start-Sleep -Milliseconds 500
      }
      # Re-scan before termination: it must still hold this installation, and
      # both PID and creation time must still match the original observation.
      $StillHolding = @(Get-UpdateLockHolders $Root | Where-Object { $_.Id -eq $Holder.Id -and $_.Created -eq $Holder.Created })
      if (-not $StillHolding.Count) { continue }
      $Fresh = $StillHolding[0]
      $FreshServices = @(Get-CimInstance Win32_Service -Filter "State='Running'" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
      if ((Get-UpdateHolderPolicy $Fresh $script:OwnedUpdateProcesses $FreshServices $script:ProtectedUpdateProcesses) -eq 'protected') { continue }
      $Stopped = [PangeaUpdateHandles]::Stop([int]$Fresh.Id, [long]$Fresh.Created)
      Write-UpdateLog "release directory handle: $($Fresh.Name) pid=$($Fresh.Id); stopped=$Stopped"
    }
    if ($ManualHolders.Count) {
      Add-Type -AssemblyName System.Windows.Forms
      [Windows.Forms.MessageBox]::Show(("These processes hold the installation directory and will not be terminated by the updater:`n" + ($ManualHolders -join "`n") + "`n`nClose other Desktop instances or user applications normally. System, security and unknown processes require local investigation. No information is uploaded."), 'PANGEA update - manual action needed', 'OK', 'Information') | Out-Null
    }
    if (-not $Holders.Count) { Write-UpdateLog 'No inspectable directory holders found; permissions or protected/inaccessible processes may prevent rename.' }
  } catch { Write-UpdateLog "local lock resolution: $($_.Exception.Message)" }
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
  param([string]$Source, [string]$Destination, [int]$TimeoutSeconds = 30, [switch]$ResolveLocks)
  Write-UpdateLog "renaming directory: $Source -> $Destination"
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $Attempt = 0
  $ResolutionAttempted = $false
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
      if ($ResolveLocks -and -not $ResolutionAttempted) {
        $ResolutionAttempted = $true
        Resolve-UpdateDirectoryLocks $Source
        $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        continue
      }
      if ((Get-Date) -ge $Deadline) {
        throw "Cannot rename installation directory '$Source' to '$Destination'. Close applications and terminals using this directory, or check its permissions. See the local update log for handle detection and cleanup results. Details: $Reason"
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

$script:UpdaterScriptPath = $PSCommandPath
if ($WatchExplorer) { Watch-ExplorerRecovery $WatchExplorer; exit 0 }
if ($ScanLocks) {
  Initialize-HandleInspector
  $Holders = @([PangeaUpdateHandles]::Scan($ScanRoot))
  [IO.File]::WriteAllText($ScanOutput, (ConvertTo-Json -InputObject $Holders -Depth 4), (New-Object Text.UTF8Encoding($false)))
  exit 0
}
if (-not $PlanPath) { throw 'PlanPath is required.' }
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

$script:OwnedUpdateProcesses = @()
$script:AutomaticUpdateCleanup = $Plan.PSObject.Properties['allow_owned_process_cleanup'] -and $Plan.allow_owned_process_cleanup -eq $true
$DesktopIdentity = $null
$script:ProtectedUpdateProcesses = @($PID, $ParentPid)
try {
  # Protect the helper's ancestors, including the user's recovery terminal.
  $ProcessRows = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  $AncestorId = $PID
  for ($Depth=0; $Depth -lt 32; $Depth++) {
    $Row = $ProcessRows | Where-Object { [int]$_.ProcessId -eq $AncestorId } | Select-Object -First 1
    if (-not $Row -or [int]$Row.ParentProcessId -le 0) { break }
    $AncestorId = [int]$Row.ParentProcessId
    if ($AncestorId -in $script:ProtectedUpdateProcesses) { break }
    $script:ProtectedUpdateProcesses += $AncestorId
  }
  if ($Plan.PSObject.Properties['allow_owned_process_cleanup'] -and $Plan.allow_owned_process_cleanup -eq $true) {
    $Desktop = Get-Process -Id $ParentPid -ErrorAction Stop
    if ($Desktop.Path -ine $InstalledExecutable) { throw 'Desktop executable identity does not match update plan.' }
    $DesktopIdentity = [pscustomobject]@{ Id=$Desktop.Id; Created=$Desktop.StartTime.ToUniversalTime().ToFileTimeUtc() }
    $script:OwnedUpdateProcesses = @(Get-OwnedUpdateProcesses $ParentPid $InstalledExecutable)
    # Snapshot only other instances of this exact installed executable, never
    # all processes with the same name or another portable installation.
    foreach ($Instance in @(Get-Process | Where-Object { try { $_.Id -ne $ParentPid -and $_.Path -ieq $InstalledExecutable } catch { $false } })) {
      $script:OwnedUpdateProcesses += [pscustomobject]@{ Id=$Instance.Id; Created=$Instance.StartTime.ToUniversalTime().ToFileTimeUtc(); Executable=$Instance.Path }
      $script:OwnedUpdateProcesses += @(Get-OwnedUpdateProcesses $Instance.Id $InstalledExecutable)
    }
  }
} catch { Write-UpdateLog "Process ownership snapshot unavailable; automatic cleanup disabled: $($_.Exception.Message)" }

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
  Wait-UpdateDesktopExit $ParentPid $DesktopIdentity

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
  Move-UpdateDirectory $InstallRoot $BackupRoot -ResolveLocks
  $OriginalMoved = $true
  Move-UpdateDirectory $CandidateRoot $InstallRoot -ResolveLocks
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
      Complete-ExplorerRecovery
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
} finally {
  Complete-ExplorerRecovery
}
