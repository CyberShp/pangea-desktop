[CmdletBinding()]
param([switch]$FunctionsOnly)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Updater = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'))
$Tokens = $null; $ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }

# Exercise real state functions on every platform. In particular, a monitor
# holding an older running snapshot must not overwrite a worker's final result.
$Names = @('Write-UpdateLog','Write-AtomicUpdateJson','Write-UpdateResult','Write-UpdateProgress','Read-UpdateProgress','Test-UpdateWorkerIdentity','Set-InterruptedUpdateFailure','Wait-UpdateHandoff')
foreach ($Definition in $Ast.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  if ($Definition.Name -in $Names) { Invoke-Expression $Definition.Extent.Text }
}
$StateRoot = Join-Path ([IO.Path]::GetTempPath()) ('pangea-progress-state-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
$PlanPath = Join-Path $StateRoot 'plan.json'
$LogPath = Join-Path $StateRoot 'update.log'
$ResultPath = Join-Path $StateRoot 'result.json'
$ExpectedVersion = '9.9.9'
try {
  Write-UpdateProgress -State running -Stage prepare -Message 'first-progress' -Percent 2
  $First = Read-UpdateProgress "$PlanPath.progress.json"
  if (-not $First -or $First.message -ne 'first-progress' -or -not (Test-UpdateWorkerIdentity $First)) {
    throw 'Initial progress was not persisted with a valid live worker identity.'
  }
  Write-UpdateProgress -State running -Stage apply -Message 'second-progress' -Percent 45 -FilesCompleted 15 -FilesTotal 100
  $Second = Read-UpdateProgress "$PlanPath.progress.json"
  if (-not $Second -or $Second.message -ne 'second-progress' -or $Second.percent -ne 45 -or $Second.files_completed -ne 15 -or $Second.files_total -ne 100 -or $Second.started_at -ne $First.started_at) {
    throw 'Progress could not atomically replace an existing status while preserving the run start time.'
  }
  if (-not (Test-UpdateWorkerIdentity $Second)) { throw 'Serializing progress lost the original worker creation time.' }
  Write-Output 'PASS: progress updates atomically replace previous status and preserve process identity'

  $Now = [DateTime]::UtcNow.ToString('o')
  $StaleRunning = [pscustomobject]@{
    schema_version=1; state='running'; stage='health_check'; message='old-running-snapshot'; percent=95
    started_at=$Now; stage_started_at=$Now; updated_at=$Now; worker_pid=[int]::MaxValue; worker_started_at=$Now
    log_path=$LogPath; version=$ExpectedVersion; rollback=''
  }
  foreach ($Terminal in @('success','failed')) {
    $Published=@{}; foreach ($Property in $StaleRunning.PSObject.Properties) { $Published[$Property.Name]=$Property.Value }
    $Published.state=$Terminal; $Published.stage=$Terminal; $Published.message="published-$Terminal"
    $Published.rollback=if ($Terminal -eq 'failed') { 'restored' } else { '' }
    Write-AtomicUpdateJson "$PlanPath.progress.json" $Published
    Write-UpdateResult $Terminal $Published.message $Published.rollback
    $Result = Set-InterruptedUpdateFailure $StaleRunning
    $Persisted = Read-UpdateProgress "$PlanPath.progress.json"
    $SavedResult = Get-Content -LiteralPath $ResultPath -Raw | ConvertFrom-Json
    if ($Result.state -ne $Terminal -or $Persisted.state -ne $Terminal -or $SavedResult.status -ne $Terminal -or $Persisted.message -ne $Published.message) {
      throw "A stale running snapshot overwrote the published $Terminal outcome."
    }
  }
  Write-Output 'PASS: stale running snapshots preserve a newly published terminal outcome'

  # A recycled PID must not be mistaken for the original worker identity.
  $Reused = [pscustomobject]@{ worker_pid=$PID; worker_started_at=[DateTime]::UtcNow.AddYears(-1).ToString('o') }
  if (Test-UpdateWorkerIdentity $Reused) { throw 'Reused PID was mistaken for the original update worker.' }
  $Self = Get-Process -Id $PID
  try {
    $Current = [pscustomobject]@{ worker_pid=$PID; worker_started_at=$Self.StartTime.ToUniversalTime().ToString('o') }
    if (-not (Test-UpdateWorkerIdentity $Current)) { throw 'A live update worker identity was rejected.' }
  } finally { $Self.Dispose() }
  Write-Output 'PASS: worker identity distinguishes the original process from a reused PID'

  $Plan = [pscustomobject]@{ handoff_required=$true }
  [IO.File]::WriteAllText("$PlanPath.cancel", 'cancel')
  [IO.File]::WriteAllText("$PlanPath.continue", 'continue')
  $Cancelled = $false
  try { Wait-UpdateHandoff } catch { $Cancelled = $true }
  if (-not $Cancelled) { throw 'A cancelled handoff accepted a simultaneous acknowledgement.' }
  Remove-Item -LiteralPath "$PlanPath.cancel"
  Wait-UpdateHandoff
  Remove-Item -LiteralPath "$PlanPath.continue"
  $Plan = [pscustomobject]@{ schema_version=1 }
  Wait-UpdateHandoff
  Write-Output 'PASS: worker prioritizes cancellation, accepts acknowledgement and supports legacy plans'
} finally { Remove-Item -LiteralPath $StateRoot -Recurse -Force }
if ($FunctionsOnly) { $global:LASTEXITCODE=0; return }

# Inspect real native windows owned by our monitor process, including their
# child captions. No installation, live Desktop process or user's profile is used.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class UpdateWindowFixture {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  public static uint Owner(IntPtr window) { uint owner; GetWindowThreadProcessId(window, out owner); return owner; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(
    IntPtr window, uint message, IntPtr wParam, StringBuilder lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW")] static extern IntPtr SendPing(
    IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  public static IntPtr Find(int process) {
    IntPtr found=IntPtr.Zero;
    EnumWindows(delegate(IntPtr window, IntPtr data) {
      uint owner; GetWindowThreadProcessId(window, out owner);
      if (owner == (uint)process && IsWindowVisible(window)) { found=window; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  static string Caption(IntPtr window) {
    var text=new StringBuilder(8192); IntPtr result;
    if (SendMessageTimeout(window, 0x000D, new IntPtr(text.Capacity), text, 2, 500, out result)==IntPtr.Zero) return "";
    return text.ToString();
  }
  public static string Text(IntPtr window) {
    var text=new List<string>(); text.Add(Caption(window));
    EnumChildWindows(window, delegate(IntPtr child, IntPtr data) { text.Add(Caption(child)); return true; }, IntPtr.Zero);
    return string.Join("\n", text.ToArray());
  }
  public static bool Responsive(IntPtr window) {
    IntPtr result; return SendPing(window, 0, IntPtr.Zero, IntPtr.Zero, 2, 1000, out result)!=IntPtr.Zero;
  }
  public static void Close(IntPtr window) { PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero); }
}
'@

$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-update-progress-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$PowerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Processes = New-Object System.Collections.ArrayList

function Wait-Fixture {
  param([scriptblock]$Condition, [string]$Description, [int]$Seconds = 15)
  $Deadline = (Get-Date).AddSeconds($Seconds)
  do {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $Deadline)
  throw "Timed out: $Description"
}
function Write-FixtureJson {
  param([string]$Path, $Value)
  Write-AtomicUpdateJson $Path $Value
}
function Read-FixtureJson {
  param([string]$Path)
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}
function New-ProgressFixture {
  param([string]$Name, [switch]$NoProgress)
  $Directory = Join-Path $Root $Name
  New-Item -ItemType Directory -Path $Directory -Force | Out-Null
  $Worker = Start-Process $PowerShell -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 180"' -WindowStyle Hidden -PassThru
  $null = $Worker.Handle
  $null = $Processes.Add($Worker)
  $PlanPath = Join-Path $Directory 'plan.json'
  $Plan = @{
    schema_version = 2; install_root = (Join-Path $Directory 'installed'); package_path = (Join-Path $Directory 'unused.zip')
    executable_name = 'PANGEA Desktop.exe'; expected_version = '9.9.9'; expected_base_version = '9.9.8'; package_type = 'patch'
    expected_size = 1; expected_sha256 = ('0' * 64); health_marker = (Join-Path $Directory 'healthy.json')
    result_path = (Join-Path $Directory 'result.json'); log_path = (Join-Path $Directory 'update.log'); parent_pid = 0
  }
  Write-FixtureJson $PlanPath $Plan
  New-Item -ItemType Directory -Path $Plan.install_root -Force | Out-Null
  Copy-Item -LiteralPath $PowerShell -Destination (Join-Path $Plan.install_root $Plan.executable_name)
  [IO.File]::WriteAllText($Plan.log_path, 'fixture-log-first-line')
  $Started = [DateTime]::UtcNow.ToString('o')
  $Progress = @{
    schema_version = 1; state = 'running'; stage = 'applying_patch'; message = 'fixture-long-patch-operation'; percent = 45
    started_at = $Started; stage_started_at = $Started; updated_at = $Started; worker_pid = $Worker.Id
    worker_started_at = $Worker.StartTime.ToUniversalTime().ToString('o'); log_path = $Plan.log_path; version = $Plan.expected_version
    rollback = ''; files_completed = 15; files_total = 100
  }
  if (-not $NoProgress) { Write-FixtureJson "$PlanPath.progress.json" $Progress }
  $Arguments = '-NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "' + $Updater + '" -WatchUpdate -PlanPath "' + $PlanPath + '"'
  $Monitor = Start-Process $PowerShell -ArgumentList $Arguments -WindowStyle Hidden -PassThru -RedirectStandardError (Join-Path $Directory 'monitor-error.log')
  $null = $Monitor.Handle
  $null = $Processes.Add($Monitor)
  return @{ PlanPath=$PlanPath; Plan=$Plan; Progress=$Progress; Worker=$Worker; Monitor=$Monitor }
}
function Wait-MonitorReady {
  param($Fixture)
  Wait-Fixture { (Test-Path -LiteralPath "$($Fixture.PlanPath).ui-ready") -or $Fixture.Monitor.HasExited } 'monitor visible-window handshake'
  if ($Fixture.Monitor.HasExited) { throw "Monitor exited before ready: $(Get-Content -LiteralPath (Join-Path (Split-Path $Fixture.PlanPath) 'monitor-error.log') -Raw)" }
  $Ready = Read-FixtureJson "$($Fixture.PlanPath).ui-ready"
  if (-not $Ready -or [int]$Ready.monitor_pid -ne $Fixture.Monitor.Id) { throw 'Visible-window handshake has an incorrect process identity.' }
  $Window = [IntPtr]([long]$Ready.window_handle)
  if ($Window -eq [IntPtr]::Zero -or [UpdateWindowFixture]::Owner($Window) -ne $Fixture.Monitor.Id -or -not [UpdateWindowFixture]::IsWindowVisible($Window)) {
    throw "Monitor announced ready without its own visible window. HWND=$Window owner=$([UpdateWindowFixture]::Owner($Window)) monitor=$($Fixture.Monitor.Id) visible=$([UpdateWindowFixture]::IsWindowVisible($Window)) enumerated=$([UpdateWindowFixture]::Find($Fixture.Monitor.Id))"
  }
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains($Fixture.Progress.message) } 'first stage rendered'
  return $Window
}
function Set-FixtureProgress {
  param($Fixture, [string]$State, [string]$Message, [string]$Rollback = '')
  $Fixture.Progress.state = $State
  $Fixture.Progress.stage = $State
  $Fixture.Progress.message = $Message
  $Fixture.Progress.rollback = $Rollback
  $Fixture.Progress.updated_at = [DateTime]::UtcNow.ToString('o')
  if ($State -eq 'success') { $Fixture.Progress.percent = 100 }
  Write-FixtureJson "$($Fixture.PlanPath).progress.json" $Fixture.Progress
}
function Close-FixtureMonitor {
  param($Fixture, [IntPtr]$Window)
  [UpdateWindowFixture]::Close($Window)
  if (-not $Fixture.Monitor.WaitForExit(5000)) { throw 'A terminal monitor did not close when the user closed its window.' }
}

try {
  $Live = New-ProgressFixture 'responsive'
  $Window = Wait-MonitorReady $Live
  Write-Output 'PASS: independent progress monitor announces ready only after a visible window exists'
  # Icon extraction must not make the UI itself a holder of the old install.
  $MovedInstall = "$($Live.Plan.install_root).previous"
  [IO.Directory]::Move($Live.Plan.install_root, $MovedInstall)
  [IO.Directory]::Move($MovedInstall, $Live.Plan.install_root)
  Write-Output 'PASS: real independent progress window does not hold the installation directory'
  $Before = [UpdateWindowFixture]::Text($Window)
  # The worker remains blocked at one stage and emits no new progress. The
  # monitor timer must still refresh elapsed time and dispatch window messages.
  Start-Sleep -Milliseconds 3200
  $After = [UpdateWindowFixture]::Text($Window)
  if ($Before -eq $After -or -not [UpdateWindowFixture]::Responsive($Window)) { throw 'Progress UI froze during a long worker operation.' }
  [IO.File]::AppendAllText($Live.Plan.log_path, "`r`nfixture-log-updated-during-long-operation")
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains('fixture-log-updated-during-long-operation') } 'live log tail refreshed'
  [UpdateWindowFixture]::Close($Window)
  Start-Sleep -Milliseconds 300
  if ($Live.Monitor.HasExited) { throw 'Running progress window could be closed before an outcome was available.' }
  $Live.Progress.message = 'fixture-next-stage-visible'
  Write-FixtureJson "$($Live.PlanPath).progress.json" $Live.Progress
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains('fixture-next-stage-visible') } 'new stage rendered'
  Write-Output 'PASS: elapsed time and stages refresh while the worker is busy'
  Set-FixtureProgress $Live 'failed' 'fixture-copy-failed-original-restored' 'restored'
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains('fixture-copy-failed-original-restored') } 'failed outcome rendered'
  Start-Sleep -Milliseconds 1500
  if ($Live.Monitor.HasExited -or -not [UpdateWindowFixture]::IsWindowVisible($Window)) { throw 'Failure outcome disappeared before acknowledgement.' }
  $Persisted = Read-FixtureJson "$($Live.PlanPath).progress.json"
  if ($Persisted.state -ne 'failed' -or $Persisted.rollback -ne 'restored') { throw 'Reported restoration outcome changed.' }
  Close-FixtureMonitor $Live $Window
  Write-Output 'PASS: failed outcome and restoration status remain available until acknowledged'

  $Crashed = New-ProgressFixture 'crashed-worker'
  $Window = Wait-MonitorReady $Crashed
  $Crashed.Worker.Kill(); $Crashed.Worker.WaitForExit()
  Wait-Fixture {
    $Progress = Read-FixtureJson "$($Crashed.PlanPath).progress.json"
    $Result = Read-FixtureJson $Crashed.Plan.result_path
    $Progress -and $Result -and $Progress.state -eq 'failed' -and $Result.status -eq 'failed'
  } 'worker crash persisted as failure'
  $Progress = Read-FixtureJson "$($Crashed.PlanPath).progress.json"
  if ($Progress.rollback -eq 'restored' -or $Progress.rollback -eq 'not_needed') { throw 'An interrupted worker must not claim verified restoration.' }
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains([string]$Progress.message) } 'worker crash rendered'
  if ($Crashed.Monitor.HasExited) { throw 'Crash outcome did not remain visible.' }
  Close-FixtureMonitor $Crashed $Window
  Write-Output 'PASS: unexpected worker exit persists a failed outcome without claiming restoration'

  $Success = New-ProgressFixture 'success'
  $Window = Wait-MonitorReady $Success
  Set-FixtureProgress $Success 'success' 'fixture-upgrade-successful'
  Wait-Fixture { [UpdateWindowFixture]::Text($Window).Contains('fixture-upgrade-successful') } 'successful outcome rendered'
  $Success.Worker.Kill(); $Success.Worker.WaitForExit()
  Start-Sleep -Milliseconds 1500
  $Progress = Read-FixtureJson "$($Success.PlanPath).progress.json"
  if ($Progress.state -ne 'success' -or $Success.Monitor.HasExited) { throw 'Worker exit overwrote or hid the successful outcome.' }
  Close-FixtureMonitor $Success $Window
  Write-Output 'PASS: successful outcome survives normal worker exit and stays reviewable'

  $Invalid = New-ProgressFixture 'monitor-startup-failure' -NoProgress
  if (-not $Invalid.Monitor.WaitForExit(15000)) { throw 'Monitor startup failure did not terminate.' }
  if (Test-Path -LiteralPath "$($Invalid.PlanPath).ui-ready") { throw 'Monitor startup failure incorrectly announced readiness.' }
  if (-not (Test-Path -LiteralPath "$($Invalid.PlanPath).ui-error")) { throw 'Monitor startup failure was not reported to its launcher.' }
  Write-Output 'PASS: monitor startup failure never announces a ready window'
} finally {
  foreach ($Process in $Processes) {
    try { $Process.Refresh(); if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() } } finally { $Process.Dispose() }
  }
  # Emit diagnostics before removing only this test's isolated temporary tree.
  foreach ($ErrorLog in @(Get-ChildItem -LiteralPath $Root -Filter '*error.log' -Recurse)) {
    if ($ErrorLog.Length -gt 0) { Write-Output "$($ErrorLog.FullName):"; Get-Content -LiteralPath $ErrorLog.FullName | Write-Output }
  }
  Remove-Item -LiteralPath $Root -Recurse -Force
}
$global:LASTEXITCODE = 0
