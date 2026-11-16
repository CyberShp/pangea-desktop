$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Updater=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'))
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
$Definitions=@($Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
foreach ($Function in $Definitions) { Invoke-Expression $Function.Extent.Text }
Initialize-PortableFileIO
Initialize-PortableWorkerJob
$Required=Get-PortableSpaceRequirement -CandidateBytes 1GB -UserBytes 2GB -EntryCount 0
if ($Required -ne [long]([decimal](3GB)+[Math]::Ceiling([decimal](3GB)/10))) { throw 'Space estimate must include the full candidate plus a second user-data copy and reserve.' }
if ((Get-PortableSpaceRequirement 0 0 100) -ne (256MB+100*65536)) { throw 'Allocation slack and minimum reserve are missing.' }
$Rejected=$false
try { Get-PortableSpaceRequirement ([long]::MaxValue) 1 0 | Out-Null } catch { $Rejected=$true }
if (-not $Rejected) { throw 'Overflowing space estimates must fail closed.' }
Write-Output 'PASS: space peak includes rebuilt program, user-data copy, allocation slack and reserve; overflow rejected'
$PolicyRoot=Join-Path ([IO.Path]::GetTempPath()) ('pangea-io-policy-' + [guid]::NewGuid())
$ScanDefinition=(Get-Command Get-UpdateLockHolders).ScriptBlock
$ResolverDefinition=(Get-Command Resolve-UpdateDirectoryLocks).ScriptBlock
try {
  [IO.Directory]::CreateDirectory((Join-Path $PolicyRoot 'launch-root')) | Out-Null
  $script:QuiescenceMode='releasable'; $script:QuiescenceResolved=$false; $script:QuiescenceResolveCalls=0
  function Get-UpdateLockHolders {
    param($Root,$TimeoutMilliseconds)
    if ($TimeoutMilliseconds -le 0 -or $TimeoutMilliseconds -gt 15000) { throw 'Handle scan lost its time budget.' }
    if ($script:QuiescenceMode -eq 'unavailable') { throw 'inspection unavailable' }
    if ($script:QuiescenceMode -eq 'releasable' -and $script:QuiescenceResolved) { return }
    return [pscustomobject]@{Id=471;Name='protected-editor'}
  }
  function Resolve-UpdateDirectoryLocks {
    param($Root,$Deadline)
    $script:QuiescenceResolveCalls++; $script:QuiescenceResolved=$true
    return [pscustomobject]@{Detail='fixture protection policy retained unknown holders'}
  }
  Assert-PortableUserDataQuiescent $PolicyRoot
  if ($script:QuiescenceResolveCalls -ne 1) { throw 'Pre-copy quiescence did not reuse the directory cleanup policy.' }
  Write-Output 'PASS: user-data cleanup reuses the existing policy and requires a fresh empty bounded scan'
  $script:QuiescenceMode='protected'
  $Rejected=$false
  try { Assert-PortableUserDataQuiescent $PolicyRoot } catch { $Rejected=$_.Exception.Message -like '*protected-editor (PID 471)*' }
  if (-not $Rejected) { throw 'Protected data holders must block copy/version switch.' }
  $Before=$script:QuiescenceResolveCalls
  $Rejected=$false
  try { Assert-PortableUserDataQuiescent $PolicyRoot -InspectOnly } catch { $Rejected=$_.Exception.Message -like '*PID 471*' }
  if (-not $Rejected -or $script:QuiescenceResolveCalls -ne $Before) { throw 'A writer detected after hashing must abort without another cleanup/change window.' }
  Write-Output 'PASS: protected holders and newly opened post-verification handles block switching'
  $script:QuiescenceMode='unavailable'; $Rejected=$false
  try { Assert-PortableUserDataQuiescent $PolicyRoot } catch { $Rejected=$_.Exception.Message -eq 'inspection unavailable' }
  if (-not $Rejected -or $script:QuiescenceResolveCalls -ne $Before) { throw 'Failed handle inspection must not be treated as quiescent.' }
  Write-Output 'PASS: unavailable handle inspection fails closed before copy'
} finally {
  Set-Item Function:\Get-UpdateLockHolders -Value $ScanDefinition
  Set-Item Function:\Resolve-UpdateDirectoryLocks -Value $ResolverDefinition
  if ([IO.Directory]::Exists($PolicyRoot)) { [IO.Directory]::Delete($PolicyRoot,$true) }
}
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  Write-Output 'SKIP: native filesystem and Job Object cases require Windows PowerShell 5.1'
  exit 0
}
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-io-' + [guid]::NewGuid())
$Source=Join-Path $Root 'installed'
$Candidate=Join-Path $Root 'new'
$ZipRoot=Join-Path $Root 'archive'
$PlanPath=Join-Path $Root 'plan.json'
$LogPath=Join-Path $Root 'apply.log'
$script:UpdaterScriptPath=$Updater
$script:UpdateForm=$null
$script:PortableIOWorker=$false
$script:UnsafeIOWorker=$false
$Plan=@{package_channel='stable'}
$ExpectedVersion='2.1.18'; $ExpectedBaseVersion='2.1.17'
$Quote={param($Value) "'"+$Value.Replace("'","''")+"'"}
$Shell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ProgressDefinition=(Get-Command Publish-PortableIOProgress).ScriptBlock
$script:TimeoutWriter=$null; $CrashWriter=$null; $Supervisor=$null
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
public static class PangeaWriterProbe {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  public static bool IsMember(Process process, object job) {
    // Inspect this exact production job, not the runner's enclosing job.
    var field=job.GetType().GetField("handle",BindingFlags.Instance|BindingFlags.NonPublic);
    if(field==null) throw new InvalidOperationException("Cannot inspect the owned worker job.");
    bool member;
    if(!IsProcessInJob(process.Handle,(IntPtr)field.GetValue(job),out member))
      throw new Win32Exception(Marshal.GetLastWin32Error());
    return member;
  }
}
'@
function Get-WriterProbe {
  param([string]$Prefix,$Job=$null)
  if (-not [IO.File]::Exists("$Prefix.pid")) { return $null }
  [int]$WriterId=0
  if (-not [int]::TryParse([IO.File]::ReadAllText("$Prefix.pid"),[ref]$WriterId)) { return $null }
  $ExpectedStart=[long][IO.File]::ReadAllText("$Prefix.started")
  try { $Process=[Diagnostics.Process]::GetProcessById($WriterId) } catch [ArgumentException] { return $null }
  try {
    # Retain the original kernel object before termination; a numeric PID is
    # neither a lifetime guarantee nor evidence that its process is running.
    $null=$Process.Handle
    $Started=$Process.StartTime.ToUniversalTime().Ticks
    if ($Started -ne $ExpectedStart) { $Process.Dispose(); return $null }
    $Member=if ($null -ne $Job) { [PangeaWriterProbe]::IsMember($Process,$Job) } else { $null }
    return [pscustomobject]@{Process=$Process;Id=$WriterId;Started=$Started;Member=$Member;Wrote=$false}
  } catch { $Process.Dispose(); throw }
}
function Update-WriterProbe {
  param($Probe,[string]$Prefix)
  if ($Probe -and [IO.File]::Exists("$Prefix.data") -and (Get-Item -LiteralPath "$Prefix.data").Length -gt 0) { $Probe.Wrote=$true }
}
function Get-WriterExitEvidence {
  param($Probe,[string]$Prefix)
  # Check immediately, before the observation window. It must not serve as
  # extra time for the production cleanup to finish.
  $Exited=$Probe -and $Probe.Process.WaitForExit(0)
  $Before=if ([IO.File]::Exists("$Prefix.data")) { (Get-Item -LiteralPath "$Prefix.data").Length } else { -1 }
  Start-Sleep -Milliseconds 300
  $After=if ([IO.File]::Exists("$Prefix.data")) { (Get-Item -LiteralPath "$Prefix.data").Length } else { -1 }
  $Identity='original process handle was not captured'
  if ($Probe) {
    $Current=Get-Process -Id $Probe.Id -ErrorAction SilentlyContinue
    try {
      $Identity=if (-not $Current) { 'PID no longer enumerated' }
        elseif ($Current.HasExited) { 'original PID still enumerated but exited' }
        elseif ($Current.StartTime.ToUniversalTime().Ticks -ne $Probe.Started) { 'PID reused by a different process' }
        else { 'original PID still enumerated' }
    } catch { $Identity='PID enumeration changed during diagnosis: '+$_.Exception.Message }
    finally { if ($Current) { $Current.Dispose() } }
  }
  return [pscustomobject]@{Exited=$Exited;Before=$Before;After=$After;Detail="handle-signaled-at-check=$Exited; bytes=$Before->$After; identity-after-observation=$Identity"}
}
function Stop-WriterProbe {
  param($Probe)
  if (-not $Probe) { return }
  try {
    if (-not $Probe.Process.WaitForExit(0)) {
      $Probe.Process.Kill()
      if (-not $Probe.Process.WaitForExit(5000)) { throw "Fixture writer did not stop: PID $($Probe.Id)" }
    }
  } finally { $Probe.Process.Dispose() }
}
try {
  New-Item -ItemType Directory -Path (Join-Path $Source 'resources/update'),(Join-Path $Source 'launch-root'),$ZipRoot -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Source 'app.exe'),'installed fixture')
  [IO.File]::WriteAllText((Join-Path $Source 'launch-root/report.txt'),'report before upgrade')
  @{files=@(@{path='app.exe';size=17})} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $Source 'resources/update/pangea-package-manifest.json')
  [IO.File]::WriteAllText((Join-Path $ZipRoot 'app.exe'),'candidate fixture')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive=Join-Path $Root 'package.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($ZipRoot,$Archive)
  $Estimate=Assert-PortableUpdatePreflight $Source $Archive full
  if ($Estimate.candidate_bytes -ne 17 -or $Estimate.user_bytes -ne 21) { throw 'Preflight did not measure the archive and existing user data.' }
  [IO.File]::WriteAllText((Join-Path $Source 'my-project.txt'),'custom root content')
  New-Item -ItemType Directory -Path (Join-Path $Source 'local-skills'),(Join-Path $Source 'obsolete'),(Join-Path $Source '__pycache__') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Source 'local-skills/custom.txt'),'skill')
  [IO.File]::WriteAllText((Join-Path $Source 'obsolete/old.dll'),'old binary')
  [IO.File]::WriteAllText((Join-Path $Source '__pycache__/fixture.pyc'),'cache')
  $Estimate=Assert-PortableUpdatePreflight $Source $Archive full
  if ($Estimate.user_bytes -ne 26) { throw 'Only protected user roots should count toward migration size.' }
  foreach ($Name in @('my-project.txt','obsolete/old.dll','__pycache__/fixture.pyc')) {
    if (-not [IO.File]::Exists((Join-Path $Source $Name))) { throw "Preflight deleted rollback content: $Name" }
  }
  Write-Output 'PASS: extras and Python cache do not block preflight; rollback source remains intact'


  $PatchRoot=Join-Path $Root 'oversized-patch'
  New-Item -ItemType Directory -Path (Join-Path $PatchRoot 'target/resources/update') -Force | Out-Null
  @{files=@(@{path='app.exe';size=1000000000000000})} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PatchRoot 'target/resources/update/pangea-package-manifest.json')
  [IO.File]::WriteAllText((Join-Path $PatchRoot 'target/resources/update/pangea-package-manifest.json.sig'),'fixture')
  $HugePatch=Join-Path $Root 'oversized.zip'
  [IO.Compression.ZipFile]::CreateFromDirectory($PatchRoot,$HugePatch)
  $Rejected=$false
  try { Assert-PortableUpdatePreflight $Source $HugePatch patch | Out-Null } catch { $Rejected=$_.Exception.Message -like '*空间不足*' }
  if (-not $Rejected) { throw 'A tiny patch rebuilding a huge candidate must fail space preflight.' }
  Write-Output 'PASS: patch disk budget uses full target size, not compressed patch size'

  Copy-PortableUserData $Source $Candidate
  $CopyProgress=Read-UpdateProgress "$PlanPath.progress.json"
  if (-not $CopyProgress -or $CopyProgress.worker_pid -ne $PID -or $CopyProgress.state -ne 'running' -or -not (Test-UpdateWorkerIdentity $CopyProgress)) { throw 'Completed copy worker replaced the live supervisor progress identity.' }
  Assert-PortableUserDataUnchanged $Source $Candidate
  foreach ($Name in @('my-project.txt','obsolete','__pycache__')) {
    if (Test-Path -LiteralPath (Join-Path $Candidate $Name)) { throw "Old extra migrated into candidate: $Name" }
  }
  if ([IO.File]::ReadAllText((Join-Path $Candidate 'local-skills/custom.txt')) -ne 'skill') { throw 'Local skills were not preserved.' }
  [IO.File]::WriteAllText((Join-Path $Source 'late-extra.txt'),'created during upgrade')
  Assert-PortableUserDataUnchanged $Source $Candidate
  if (-not [IO.File]::Exists((Join-Path $Source 'late-extra.txt'))) { throw 'Late extra must remain available for rollback.' }
  Write-Output 'PASS: protected roots migrate, old extras do not; late extras do not block switch'
  [IO.File]::WriteAllText((Join-Path $Source 'launch-root/report.txt'),'report changed after copy')
  $Rejected=$false
  try { Assert-PortableUserDataUnchanged $Source $Candidate } catch { $Rejected=$_.Exception.Message -like '*changed after copy*' }
  if (-not $Rejected -or [IO.File]::ReadAllText((Join-Path $Source 'launch-root/report.txt')) -ne 'report changed after copy') { throw 'Post-copy writes must abort without modifying the source.' }
  Write-Output 'PASS: worker-backed copy verifies content and rejects a later source write'

  # Substitute only the worker launch with a disposable writer fixture. The
  # production supervisor/job/timeout logic remains unchanged.
  $script:Probe=Join-Path $Root 'timeout-writer'
  function Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
    $Control=$RedirectStandardOutput.Substring(0,$RedirectStandardOutput.Length-7)
    $ChildBody='$ErrorActionPreference="Stop"; while($true){[IO.File]::AppendAllText(' + (& $Quote ($script:Probe+'.data')) + ',"x");Start-Sleep -Milliseconds 40}'
    $ChildEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ChildBody))
    $Body='while(-not [IO.File]::Exists(' + (& $Quote ($Control+'.go')) + ')){Start-Sleep -Milliseconds 20};' +
      '$child=Start-Process -FilePath ' + (& $Quote $Shell) + ' -ArgumentList @("-NoProfile","-NonInteractive","-EncodedCommand",' + (& $Quote $ChildEncoded) + ') -PassThru -WindowStyle Hidden;' +
      '[IO.File]::WriteAllText(' + (& $Quote ($script:Probe+'.started')) + ',$child.StartTime.ToUniversalTime().Ticks);' +
      '[IO.File]::WriteAllText(' + (& $Quote ($script:Probe+'.pid')) + ',$child.Id);Start-Sleep -Seconds 120'
    $Encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Body))
    Microsoft.PowerShell.Management\Start-Process -FilePath $Shell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$Encoded) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $RedirectStandardOutput -RedirectStandardError $RedirectStandardError -PassThru
  }
  function Publish-PortableIOProgress {
    param([string]$Control,[long]$LastSequence=0)
    if (-not $script:TimeoutWriter) {
      $OwnedJob=(Get-Variable -Name Job -Scope 1 -ErrorAction Stop).Value
      $script:TimeoutWriter=Get-WriterProbe -Prefix $script:Probe -Job $OwnedJob
    }
    Update-WriterProbe -Probe $script:TimeoutWriter -Prefix $script:Probe
    & $ProgressDefinition -Control $Control -LastSequence $LastSequence
  }
  $Rejected=$false
  $TimeoutError='none'
  try { Invoke-PortableIOWorker -Operation Preflight -Arguments @{} -TimeoutSeconds 5 | Out-Null }
  catch { $TimeoutError=$_.Exception.Message; $Rejected=$TimeoutError -like '*timed out*' }
  finally {
    Remove-Item Function:\Start-Process
    Set-Item Function:\Publish-PortableIOProgress -Value $ProgressDefinition
  }
  # Always collect write evidence, even when the exit/ownership assertion fails.
  $Evidence=Get-WriterExitEvidence -Probe $script:TimeoutWriter -Prefix $script:Probe
  if (-not $Rejected -or $script:UnsafeIOWorker -or -not $script:TimeoutWriter -or -not $script:TimeoutWriter.Wrote) {
    throw "Timeout fixture did not exercise and confirm an active writer: error=$TimeoutError; unsafe=$script:UnsafeIOWorker; $($Evidence.Detail)"
  }
  if (-not $script:TimeoutWriter.Member) { throw "Timeout fixture writer was outside the owned job before termination: PID $($script:TimeoutWriter.Id); $($Evidence.Detail)" }
  if (-not $Evidence.Exited -or $Evidence.Before -ne $Evidence.After) { throw "Timed-out writer was not quiescent when control returned: PID $($script:TimeoutWriter.Id); $($Evidence.Detail)" }
  Write-Output "INFO: timeout writer PID $($script:TimeoutWriter.Id); owned-job=$($script:TimeoutWriter.Member); $($Evidence.Detail)"
  Write-Output 'PASS: timeout kills the whole owned job and confirms no descendant can keep writing'

  # Abrupt supervisor death bypasses PowerShell finally blocks. The kernel
  # must still terminate the assigned worker when its last job handle closes.
  $CrashProbe=Join-Path $Root 'parent-death'
  $WriterBody='while($true){[IO.File]::AppendAllText(' + (& $Quote ($CrashProbe+'.data')) + ',"x");Start-Sleep -Milliseconds 40}'
  $WriterEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($WriterBody))
  $JobDefinition=($Definitions | Where-Object {$_.Name -eq 'Initialize-PortableWorkerJob'}).Extent.Text
  $HostBody=$JobDefinition + "`nInitialize-PortableWorkerJob;" + '$job=New-Object PangeaPortableWorkerJob;' +
    '$worker=Start-Process -FilePath ' + (& $Quote $Shell) + ' -ArgumentList @("-NoProfile","-NonInteractive","-EncodedCommand",' + (& $Quote $WriterEncoded) + ') -PassThru -WindowStyle Hidden;' +
    '$job.Attach($worker);[IO.File]::WriteAllText(' + (& $Quote ($CrashProbe+'.started')) + ',$worker.StartTime.ToUniversalTime().Ticks);' +
    '[IO.File]::WriteAllText(' + (& $Quote ($CrashProbe+'.pid')) + ',$worker.Id);' +
    '$deadline=[DateTime]::UtcNow.AddSeconds(30);while(-not [IO.File]::Exists(' + (& $Quote ($CrashProbe+'.release')) + ')){if([DateTime]::UtcNow -ge $deadline){throw "Writer capture handshake timed out."};Start-Sleep -Milliseconds 20};[Environment]::Exit(99)'
  $HostEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($HostBody))
  $Supervisor=Start-Process -FilePath $Shell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$HostEncoded) -PassThru -WindowStyle Hidden
  try {
    $null=$Supervisor.Handle
    $Deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
      if (-not $CrashWriter) { $CrashWriter=Get-WriterProbe -Prefix $CrashProbe }
      Update-WriterProbe -Probe $CrashWriter -Prefix $CrashProbe
      if ($CrashWriter -and $CrashWriter.Wrote) { break }
      if ($Supervisor.WaitForExit(20)) { throw 'Parent-death supervisor exited before its writer was captured.' }
    } while ([DateTime]::UtcNow -lt $Deadline)
    if (-not $CrashWriter -or -not $CrashWriter.Wrote) { throw 'Parent-death fixture never exercised an active writer.' }
    [IO.File]::WriteAllText($CrashProbe+'.release','captured active writer')
    if (-not $Supervisor.WaitForExit(20000) -or $Supervisor.ExitCode -ne 99) { throw 'Parent-death fixture did not finish with the expected abrupt exit.' }
    # Job-close termination is asynchronous; wait on the original object with
    # the existing five-second budget, rather than polling a reusable PID.
    $Stopped=$CrashWriter.Process.WaitForExit(5000)
    $Evidence=Get-WriterExitEvidence -Probe $CrashWriter -Prefix $CrashProbe
    if (-not $Stopped -or -not $Evidence.Exited -or $Evidence.Before -ne $Evidence.After) { throw "Job writer survived abrupt supervisor exit: PID $($CrashWriter.Id); $($Evidence.Detail)" }
    Write-Output "INFO: parent-death writer PID $($CrashWriter.Id); $($Evidence.Detail)"
  } finally {
    if (-not $Supervisor.WaitForExit(0)) { $Supervisor.Kill(); $null=$Supervisor.WaitForExit(5000) }
    $Supervisor.Dispose(); $Supervisor=$null
  }
  Write-Output 'PASS: kill-on-job-close stops file writers after abrupt supervisor exit'
} finally {
  Stop-UpdateHandleServer
  if (Test-Path Function:\Start-Process) { Remove-Item Function:\Start-Process }
  Set-Item Function:\Publish-PortableIOProgress -Value $ProgressDefinition
  try {
    # On a failed capture, only clean up a PID whose creation time still
    # matches the fixture record; never stop a process that reused the PID.
    if (-not $script:TimeoutWriter) { $script:TimeoutWriter=Get-WriterProbe -Prefix (Join-Path $Root 'timeout-writer') }
    Stop-WriterProbe $script:TimeoutWriter
  } finally {
    if (-not $CrashWriter) { $CrashWriter=Get-WriterProbe -Prefix (Join-Path $Root 'parent-death') }
    Stop-WriterProbe $CrashWriter
  }
  $script:PortableIOWorker=$true
  if ([IO.Directory]::Exists($Root)) { Remove-PortableDirectory $Root }
}
$global:LASTEXITCODE=0
