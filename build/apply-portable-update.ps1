# PANGEA_UPDATE_MONITOR_PROTOCOL=1
[CmdletBinding()]
param([string]$PlanPath, [switch]$ScanLocks, [string]$ScanRoot, [string]$ScanOutput, [string]$WatchExplorer, [switch]$WatchUpdate)

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
    # Windows PowerShell 5.1 emits a top-level JSON array as one pipeline
    # object. Wrapping that pipeline in @() nests the holders: member access
    # then returns arrays, and a multi-item Critical array evaluates to true.
    # Assign first and emit each record explicitly on both PowerShell editions.
    $ParsedHolders = Get-Content -LiteralPath $Output -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($Holder in $ParsedHolders) { $Holder }
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

function Get-UpdateHolderIdentityKey {
  param([string]$Root, $Holder)
  # Consent belongs to this observed process at this directory, never a name
  # or PID alone. Cache both Yes and No for this updater invocation only.
  return ('{0}|{1}|{2}|{3}' -f $Root.TrimEnd('\').ToLowerInvariant(), $Holder.Id, $Holder.Created, ([string]$Holder.Executable).ToLowerInvariant())
}

function Confirm-UpdateHolderBatchStop {
  param([object[]]$Holders, [bool]$IncludesExplorer = $false)
  if (-not $Holders.Count) { return $false }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $Dialog = New-Object Windows.Forms.Form
  try {
    $Dialog.Text = 'PANGEA 升级 - 确认释放目录占用'
    $Dialog.ClientSize = New-Object Drawing.Size(900, 490)
    $Dialog.MinimumSize = New-Object Drawing.Size(700, 420)
    $Dialog.StartPosition = 'CenterScreen'
    $Dialog.ShowInTaskbar = $true
    $Dialog.MaximizeBox = $false
    $Dialog.MinimizeBox = $false
    $Dialog.TopMost = $true
    $Dialog.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)
    $Summary = New-Object Windows.Forms.Label
    $Summary.Location = New-Object Drawing.Point(16, 12)
    $Summary.Size = New-Object Drawing.Size(868, 76)
    $Summary.Anchor = 'Top, Left, Right'
    $Summary.Text = "以下 $($Holders.Count) 个进程正在占用安装目录。请先保存相关工作，再一次性确认结束清单中的进程。`r`n结束进程可能中断其任务或丢失未保存的内容；进程信息仅在本机使用。"
    if ($IncludesExplorer) { $Summary.Text += "`r`n清单包含资源管理器：请先完成文件复制/移动；桌面和任务栏可能短暂消失，随后自动恢复。" }
    $List = New-Object Windows.Forms.ListView
    $List.Location = New-Object Drawing.Point(16, 92)
    $List.Size = New-Object Drawing.Size(868, 328)
    $List.Anchor = 'Top, Bottom, Left, Right'
    $List.View = 'Details'
    $List.FullRowSelect = $true
    $List.GridLines = $true
    $List.MultiSelect = $false
    $List.HideSelection = $false
    [void]$List.Columns.Add('进程', 155)
    [void]$List.Columns.Add('PID', 75)
    [void]$List.Columns.Add('程序路径', 390)
    [void]$List.Columns.Add('占用路径', 420)
    foreach ($Holder in $Holders) {
      $Item = New-Object Windows.Forms.ListViewItem([string]$Holder.Name)
      [void]$Item.SubItems.Add([string]$Holder.Id)
      [void]$Item.SubItems.Add([string]$Holder.Executable)
      [void]$Item.SubItems.Add([string]$Holder.Path)
      [void]$List.Items.Add($Item)
    }
    $Accept = New-Object Windows.Forms.Button
    $Accept.Text = '结束以上全部进程并继续'
    $Accept.Location = New-Object Drawing.Point(516, 438)
    $Accept.Size = New-Object Drawing.Size(220, 36)
    $Accept.Anchor = 'Bottom, Right'
    $Accept.DialogResult = [Windows.Forms.DialogResult]::Yes
    $Cancel = New-Object Windows.Forms.Button
    $Cancel.Text = '暂不结束'
    $Cancel.Location = New-Object Drawing.Point(748, 438)
    $Cancel.Size = New-Object Drawing.Size(136, 36)
    $Cancel.Anchor = 'Bottom, Right'
    $Cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
    $Dialog.Controls.AddRange(@($Summary, $List, $Accept, $Cancel))
    $Dialog.AcceptButton = $Cancel
    $Dialog.CancelButton = $Cancel
    $Dialog.ActiveControl = $Cancel
    return $Dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::Yes
  } finally { $Dialog.Dispose() }
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
  Set-UpdateStage '正在检查目录占用；需要确认时将一次性列出进程，请先保存相关工作…' 76 'directory-locks'
  try {
    $Holders = @(Get-UpdateLockHolders $Root)
    $ServiceIds = @(Get-CimInstance Win32_Service -Filter "State='Running'" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
    Initialize-HandleInspector
    if (-not (Get-Variable -Name UpdateHolderDecisions -Scope Script -ErrorAction SilentlyContinue)) { $script:UpdateHolderDecisions = @{} }
    $Automatic = (Get-Variable -Name AutomaticUpdateCleanup -Scope Script -ErrorAction SilentlyContinue) -and $script:AutomaticUpdateCleanup
    $ManualHolders = @()
    $Candidates = @()
    $Pending = @()
    $Seen = @{}
    foreach ($Holder in $Holders) {
      $Policy = Get-UpdateHolderPolicy $Holder $script:OwnedUpdateProcesses $ServiceIds $script:ProtectedUpdateProcesses
      Write-UpdateLog "directory handle: $($Holder.Name) pid=$($Holder.Id); policy=$Policy"
      if ($Policy -eq 'protected') { $ManualHolders += "$($Holder.Name) (PID $($Holder.Id))"; continue }
      if ($Policy -eq 'explorer' -and (Get-Variable -Name ExplorerRestartAttempted -Scope Script -ErrorAction SilentlyContinue) -and $script:ExplorerRestartAttempted) {
        Write-UpdateLog 'Explorer was already handled once; it will not be repeatedly terminated.'
        continue
      }
      $Key = Get-UpdateHolderIdentityKey $Root $Holder
      if ($Seen.ContainsKey($Key)) { continue }
      $Seen[$Key] = $true
      $NeedsConsent = $Policy -eq 'confirm' -or ($Policy -eq 'explorer' -and -not $Automatic)
      $Candidate = [pscustomobject]@{ Holder=$Holder; Policy=$Policy; Key=$Key; NeedsConsent=$NeedsConsent }
      $Candidates += $Candidate
      if ($NeedsConsent -and -not $script:UpdateHolderDecisions.ContainsKey($Key)) { $Pending += $Candidate }
    }
    # One scrollable, reviewable list replaces one modal dialog per PID. A new
    # holder or reused PID is never covered by an earlier identity's decision.
    if ($Pending.Count) {
      $Confirmed = Confirm-UpdateHolderBatchStop -Holders @($Pending | ForEach-Object { $_.Holder }) -IncludesExplorer (@($Pending | Where-Object { $_.Policy -eq 'explorer' }).Count -gt 0)
      foreach ($Candidate in $Pending) {
        $script:UpdateHolderDecisions[$Candidate.Key] = [bool]$Confirmed
        Write-UpdateLog "directory cleanup consent: pid=$($Candidate.Holder.Id); approved=$Confirmed"
      }
    }
    foreach ($Candidate in $Candidates) {
      if ($Candidate.NeedsConsent -and -not $script:UpdateHolderDecisions[$Candidate.Key]) { continue }
      if ($Candidate.Policy -eq 'explorer') {
        if ((Get-Variable -Name ExplorerRestartAttempted -Scope Script -ErrorAction SilentlyContinue) -and $script:ExplorerRestartAttempted) { continue }
        $script:ExplorerRestartAttempted=$true
        Start-ExplorerRecovery
        Close-InstallationExplorerWindows $Root
        Start-Sleep -Milliseconds 500
      }
      # Re-scan before every termination. Consent and automatic ownership must
      # still match PID, creation time, executable, directory AND fresh policy.
      $StillHolding = @(Get-UpdateLockHolders $Root | Where-Object { (Get-UpdateHolderIdentityKey $Root $_) -eq $Candidate.Key })
      if (-not $StillHolding.Count) { continue }
      $Fresh = $StillHolding[0]
      $FreshServices = @(Get-CimInstance Win32_Service -Filter "State='Running'" -ErrorAction Stop | ForEach-Object { [int]$_.ProcessId })
      $FreshPolicy = Get-UpdateHolderPolicy $Fresh $script:OwnedUpdateProcesses $FreshServices $script:ProtectedUpdateProcesses
      if ($FreshPolicy -ne $Candidate.Policy) {
        Write-UpdateLog "directory holder policy changed; skipping pid=$($Fresh.Id); policy=$FreshPolicy"
        continue
      }
      $Stopped = Stop-UpdateHolder $Fresh
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
        Set-UpdateStage '正在等待安装目录占用释放，请查看日志中的占用进程信息…' 76 'directory-locks'
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
    }
  }
}

function Write-AtomicUpdateJson {
  param([string]$Path, $Value)
  $Directory = [IO.Path]::GetDirectoryName($Path)
  New-Item $Directory -ItemType Directory -Force | Out-Null
  $Temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($Temporary, ($Value | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
    if ([IO.File]::Exists($Path)) { [IO.File]::Replace($Temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($Temporary, $Path) }
  } finally { if (Test-Path -LiteralPath $Temporary) { Remove-Item -LiteralPath $Temporary -Force -ErrorAction SilentlyContinue } }
}

function Write-UpdateResult {
  param([ValidateSet('success', 'failed')][string]$Status, [string]$Message, [string]$Rollback = '')
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

function Expand-VerifiedArchive {
  param([string]$Archive, [string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item $Destination -ItemType Directory -Force | Out-Null
  $DestinationPrefix = [System.IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
  $Zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $Total=@($Zip.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) }).Count
    $Completed=0; $LastProgress=[DateTime]::UtcNow
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
    $Completed = 0; $LastProgress=[DateTime]::UtcNow
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
      if ($Completed % 100 -eq 0 -or $Completed -eq $TargetManifest.files.Count -or ([DateTime]::UtcNow-$LastProgress).TotalSeconds -ge 2) {
        Set-UpdateStage "正在重建并校验补丁：$Completed / $($TargetManifest.files.Count) 个文件" (42 + [int](24 * $Completed / $TargetManifest.files.Count)) 'rebuild' $Completed $TargetManifest.files.Count
        $LastProgress=[DateTime]::UtcNow
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
  $InstalledExecutable = Join-Path $InstallRoot $ExecutableName
} catch {
  $ErrorFile=if ($WatchUpdate) { "$PlanPath.ui-error" } else { "$PlanPath.startup-error" }
  try { [IO.File]::WriteAllText($ErrorFile,$_.Exception.Message,(New-Object Text.UTF8Encoding($false))) } catch { }
  throw
}
if ($WatchUpdate) { Watch-UpdateWindow; exit 0 }

$Leaf = [IO.Path]::GetFileName($InstallRoot.TrimEnd('\'))
$Nonce = [Guid]::NewGuid().ToString('N')
$CandidateRoot = Join-Path $InstallParent "$Leaf.update-$Nonce"
$BackupRoot = Join-Path $InstallParent "$Leaf.previous-$Nonce"
$FailedRoot = Join-Path $InstallParent "$Leaf.failed-$Nonce"
$OriginalMoved = $false; $Swapped = $false; $NewProcess = $null
$script:OwnedUpdateProcesses = @()
$script:AutomaticUpdateCleanup = $Plan.PSObject.Properties['allow_owned_process_cleanup'] -and $Plan.allow_owned_process_cleanup -eq $true
$DesktopIdentity = $null
$script:ProtectedUpdateProcesses = @($PID, $ParentPid)

# The installed Desktop remains open until the independent window is visible
# and process ownership has been captured. Never acknowledge a hidden updater.
try {
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
    Write-UpdateLog "Process ownership snapshot unavailable; automatic cleanup disabled: $($_.Exception.Message)"
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
  exit 1
}

try {
  Write-UpdateLog "waiting for PANGEA Desktop process $ParentPid"
  Set-UpdateStage '正在等待当前版本退出…' 12 'desktop-exit'
  Wait-UpdateDesktopExit $ParentPid $DesktopIdentity
  if ([string]::IsNullOrWhiteSpace($InstallParent) -or $InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot)) { throw 'The portable application directory is unsafe to replace.' }
  Set-UpdateStage '正在校验升级包的大小与 SHA256…' 18 'verify-package'
  if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw 'The downloaded update package is missing.' }
  if ($ExpectedSize -le 0 -or (Get-Item -LiteralPath $PackagePath).Length -ne $ExpectedSize) { throw 'The downloaded update package size no longer matches the signed release.' }
  if ($ExpectedSha256 -notmatch '^[0-9a-f]{64}$') { throw 'The expected update hash is invalid.' }
  $ActualSha256 = (Get-FileHash -LiteralPath $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256) { throw 'The downloaded update package no longer matches the signed release.' }
  if (-not $ExecutableName.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) { throw 'The portable executable name is invalid.' }

  if ($PackageType -eq 'patch') {
    Set-UpdateStage '正在根据补丁重建新版本，并逐文件校验…' 42 'rebuild'
    if ([string]::IsNullOrWhiteSpace($ExpectedBaseVersion)) { throw 'Patch base version is missing.' }
    $BaseManifestPath = Join-Path $InstallRoot 'resources\update\pangea-package-manifest.json'
    if (-not (Test-Path -LiteralPath $BaseManifestPath -PathType Leaf)) { throw 'Installed package manifest is missing.' }
    $BaseManifest = Get-Content -LiteralPath $BaseManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$BaseManifest.version -ne $ExpectedBaseVersion) { throw "Installed version $($BaseManifest.version) does not match patch base $ExpectedBaseVersion." }
    Apply-VerifiedPatch $PackagePath $InstallRoot $CandidateRoot
  } elseif ($PackageType -eq 'full') {
    Set-UpdateStage '正在解压新版本文件…' 42 'extract'
    Expand-VerifiedArchive $PackagePath $CandidateRoot
  } else { throw "Unsupported package type: $PackageType" }
  $CandidateExecutable = Join-Path $CandidateRoot $ExecutableName
  $CandidateManifest = Join-Path $CandidateRoot 'resources\pangea-manifest.json'
  if (-not (Test-Path -LiteralPath $CandidateExecutable -PathType Leaf)) { throw "Updated executable is missing: $ExecutableName" }
  if (-not (Test-Path -LiteralPath $CandidateManifest -PathType Leaf)) { throw 'Updated component manifest is missing.' }
  $Manifest = Get-Content -LiteralPath $CandidateManifest -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$Manifest.product.version -ne $ExpectedVersion) { throw "Updated product version does not match $ExpectedVersion." }

  Set-UpdateStage '正在保留用户工作区、任务和本地技能…' 70 'user-data'
  Copy-PortableUserData $InstallRoot $CandidateRoot
  Set-UpdateStage '正在切换版本，保留原版本备份…' 76 'switch-version'
  Move-UpdateDirectory $InstallRoot $BackupRoot -ResolveLocks
  $OriginalMoved = $true
  Set-UpdateStage '原版本已备份，正在启用新版本…' 78 'switch-version'
  Move-UpdateDirectory $CandidateRoot $InstallRoot -ResolveLocks
  $Swapped = $true

  $UpdatedExecutable = Join-Path $InstallRoot $ExecutableName
  Remove-Item -LiteralPath $HealthMarker -Force -ErrorAction SilentlyContinue
  $HealthArgument = "--pangea-update-health=`"$HealthMarker`""
  Set-UpdateStage '正在启动新版本…' 82 'start-version'
  $NewProcess = Start-Process -FilePath $UpdatedExecutable -ArgumentList $HealthArgument -PassThru
  Write-UpdateLog "started PANGEA Desktop $ExpectedVersion as process $($NewProcess.Id)"
  Set-UpdateStage '正在等待新版本健康检查，最长等待 150 秒…' 92 'health-check'
  $Deadline = (Get-Date).AddSeconds(150)
  $LastHealthProgress=[DateTime]::UtcNow
  while ((Get-Date) -lt $Deadline) {
    if (Test-Path -LiteralPath $HealthMarker -PathType Leaf) {
      Write-UpdateLog "PANGEA Desktop $ExpectedVersion reported healthy"
      Set-UpdateStage '新版健康检查通过，正在恢复资源管理器并清理备份…' 97 'cleanup'
      $SuccessMessage='升级完成，新版本已通过健康检查并重新启动。'
      try { Complete-ExplorerRecovery } catch { $SuccessMessage+=" 资源管理器恢复提示：$($_.Exception.Message)"; Write-UpdateLog $SuccessMessage }
      if (Test-Path -LiteralPath $BackupRoot) {
        try { Remove-PortableDirectory $BackupRoot } catch { $SuccessMessage+=" 旧版本备份暂未清理：$BackupRoot"; Write-UpdateLog $_.Exception.Message }
      }
      Write-UpdateResult 'success' $SuccessMessage
      Write-UpdateProgress -State success -Stage 'complete' -Message $SuccessMessage -Percent 100
      exit 0
    }
    if ($NewProcess.HasExited) { throw 'Updated PANGEA Desktop exited before reporting healthy.' }
    if (([DateTime]::UtcNow-$LastHealthProgress).TotalSeconds -ge 5) {
      $Remaining=[Math]::Max(0,[int]($Deadline-(Get-Date)).TotalSeconds)
      Set-UpdateStage "正在等待新版本健康检查，超时回滚倒计时 $Remaining 秒…" 92 'health-check'
      $LastHealthProgress=[DateTime]::UtcNow
    }
    Start-Sleep -Milliseconds 500
    $NewProcess.Refresh()
  }
  throw 'Updated PANGEA Desktop did not report healthy before the rollback timeout.'
} catch {
  $FailureMessage = $_.Exception.Message
  Write-UpdateLog "update failed: $FailureMessage"
  Write-UpdateLog "failed operation: $($_.InvocationInfo.PositionMessage)"
  Set-UpdateStage '升级失败，正在检查并恢复原版本，请勿关闭计算机…' 35 'rollback'
  if ($NewProcess -and -not $NewProcess.HasExited) {
    Stop-Process -Id $NewProcess.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  $Restored = -not $OriginalMoved
  $Rollback=if ($OriginalMoved) { 'failed' } else { 'not_needed' }
  try {
    if ($Swapped) {
      if (Test-Path -LiteralPath $InstallRoot) { Move-UpdateDirectory $InstallRoot $FailedRoot }
      if (Test-Path -LiteralPath $BackupRoot) {
        Move-UpdateDirectory $BackupRoot $InstallRoot
        $Restored=$true; $Rollback='restored'
        Write-UpdateLog 'previous PANGEA Desktop version restored'
      }
    } elseif ($OriginalMoved -and -not (Test-Path -LiteralPath $InstallRoot) -and (Test-Path -LiteralPath $BackupRoot)) {
      Move-UpdateDirectory $BackupRoot $InstallRoot
      $Restored=$true; $Rollback='restored'
      Write-UpdateLog 'previous PANGEA Desktop directory restored'
    }
    if (-not $Restored) { throw "Original installation retained at '$BackupRoot'; automatic restoration could not be confirmed." }
  } catch {
    $FailureMessage+=" 回滚未完成：$($_.Exception.Message)。原版本备份：'$BackupRoot'。"
    Write-UpdateLog $FailureMessage
  }
  if ($Restored) {
    foreach ($CleanupRoot in @($CandidateRoot,$FailedRoot)) {
      if (Test-Path -LiteralPath $CleanupRoot) { try { Remove-PortableDirectory $CleanupRoot } catch { Write-UpdateLog $_.Exception.Message } }
    }
    if (Test-Path -LiteralPath $InstalledExecutable -PathType Leaf) {
      try {
        Start-Process -FilePath $InstalledExecutable | Out-Null
        $FailureMessage+=' 原版本文件可用，已发出旧版启动请求。'
        Write-UpdateLog 'working PANGEA Desktop version restart requested'
      } catch { $FailureMessage+=" 原版本文件已保留，但启动失败：$($_.Exception.Message)"; Write-UpdateLog $FailureMessage }
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
}
