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
$ExpectedVersion='2.1.9'; $ExpectedBaseVersion='2.1.8'
$Quote={param($Value) "'"+$Value.Replace("'","''")+"'"}
$Shell="$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
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
      '[IO.File]::WriteAllText(' + (& $Quote ($script:Probe+'.pid')) + ',$child.Id);Start-Sleep -Seconds 120'
    $Encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Body))
    Microsoft.PowerShell.Management\Start-Process -FilePath $Shell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$Encoded) -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $RedirectStandardOutput -RedirectStandardError $RedirectStandardError -PassThru
  }
  $Rejected=$false
  try { Invoke-PortableIOWorker -Operation Preflight -Arguments @{} -TimeoutSeconds 5 | Out-Null } catch { $Rejected=$_.Exception.Message -like '*timed out*' }
  Remove-Item Function:\Start-Process
  if (-not $Rejected -or $script:UnsafeIOWorker -or -not [IO.File]::Exists("$script:Probe.pid")) { throw 'Timeout did not terminate and confirm the owned worker tree.' }
  $ChildId=[int][IO.File]::ReadAllText("$script:Probe.pid")
  if (Get-Process -Id $ChildId -ErrorAction SilentlyContinue) { throw 'The timed-out helper left a writer alive.' }
  $Length=(Get-Item -LiteralPath "$script:Probe.data").Length
  Start-Sleep -Milliseconds 300
  if ((Get-Item -LiteralPath "$script:Probe.data").Length -ne $Length) { throw 'The timed-out helper continued writing after control returned.' }
  Write-Output 'PASS: timeout kills the whole owned job and confirms no descendant can keep writing'

  # Abrupt supervisor death bypasses PowerShell finally blocks. The kernel
  # must still terminate the assigned worker when its last job handle closes.
  $CrashProbe=Join-Path $Root 'parent-death'
  $WriterBody='while($true){[IO.File]::AppendAllText(' + (& $Quote ($CrashProbe+'.data')) + ',"x");Start-Sleep -Milliseconds 40}'
  $WriterEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($WriterBody))
  $JobDefinition=($Definitions | Where-Object {$_.Name -eq 'Initialize-PortableWorkerJob'}).Extent.Text
  $HostBody=$JobDefinition + "`nInitialize-PortableWorkerJob;" + '$job=New-Object PangeaPortableWorkerJob;' +
    '$worker=Start-Process -FilePath ' + (& $Quote $Shell) + ' -ArgumentList @("-NoProfile","-NonInteractive","-EncodedCommand",' + (& $Quote $WriterEncoded) + ') -PassThru -WindowStyle Hidden;' +
    '$job.Attach($worker);[IO.File]::WriteAllText(' + (& $Quote ($CrashProbe+'.pid')) + ',$worker.Id);Start-Sleep -Seconds 2;[Environment]::Exit(99)'
  $HostEncoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($HostBody))
  $Supervisor=Start-Process -FilePath $Shell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$HostEncoded) -PassThru -WindowStyle Hidden
  try {
    if (-not $Supervisor.WaitForExit(20000)) { $Supervisor.Kill(); throw 'Parent-death fixture did not finish.' }
    $ChildId=[int][IO.File]::ReadAllText($CrashProbe+'.pid')
    $Deadline=[DateTime]::UtcNow.AddSeconds(5)
    while ((Get-Process -Id $ChildId -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $Deadline) { Start-Sleep -Milliseconds 50 }
    if (Get-Process -Id $ChildId -ErrorAction SilentlyContinue) { throw 'Job writer survived abrupt supervisor exit.' }
    if (-not [IO.File]::Exists($CrashProbe+'.data')) { throw 'Parent-death fixture never exercised an active writer.' }
  } finally { $Supervisor.Dispose() }
  Write-Output 'PASS: kill-on-job-close stops file writers after abrupt supervisor exit'
} finally {
  if (Test-Path Function:\Start-Process) { Remove-Item Function:\Start-Process }
  $script:PortableIOWorker=$true
  if ([IO.Directory]::Exists($Root)) { Remove-PortableDirectory $Root }
}
$global:LASTEXITCODE=0
