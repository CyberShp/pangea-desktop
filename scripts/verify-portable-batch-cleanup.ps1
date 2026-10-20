$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Updater = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'))
$Tokens=$null; $Errors=$null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
foreach ($Function in $Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]}, $true)) { Invoke-Expression $Function.Extent.Text }

# Exercise the real resolver, substituting only OS scan/stop/UI boundaries.
# No process is terminated; this suite also runs under PowerShell on Linux.
$OriginalSystemRoot = $env:SystemRoot
if (-not $env:SystemRoot) { $env:SystemRoot = [IO.Path]::GetTempPath() }
$Session = [Diagnostics.Process]::GetCurrentProcess().SessionId
function New-HolderFixture {
  param([int]$ProcessId)
  return [pscustomobject]@{Id=$ProcessId; Created=[long](1000+$ProcessId); Name='node'; Executable='fixture/node.exe'; Path='fixture/install/data'; Critical=$false; SameUser=$true; Session=$Session}
}
function Reset-BatchFixture {
  $script:OwnedUpdateProcesses=@()
  $script:ProtectedUpdateProcesses=@()
  $script:AutomaticUpdateCleanup=$false
  $script:ExplorerRestartAttempted=$false
  $script:PromptCount=0
  $script:ScanCalls=0; $script:StoppedIds=@(); $script:FixtureLogs=@()
  $script:Mode='stable'; $script:RecoveryStarted=$false; $script:FoldersClosed=$false
  $script:RegisteredCachePaths=@()
  $script:CacheVersion=[pscustomobject]@{ProductName='TortoiseGit'; OriginalFilename='TGitCache.exe'}
  $script:FixtureHolders=@(1..20 | ForEach-Object { New-HolderFixture $_ })
}
function Set-UpdateStage { param($Message, $Percent, $Stage) }
function Write-UpdateLog { param($Message) $script:FixtureLogs += [string]$Message }
function Initialize-HandleInspector { }
function Confirm-UpdateHolderBatchStop {
  param([object[]]$Holders, [bool]$IncludesExplorer=$false)
  $script:PromptCount++
  throw 'Directory lock cleanup must never request confirmation.'
}
function Get-UpdateLockHolders {
  param($Root, $TimeoutMilliseconds)
  $script:ScanCalls++
  if ($script:Mode -eq 'changed' -and $script:ScanCalls -gt 1) {
    $script:ProtectedUpdateProcesses=@(8)
    foreach ($Original in $script:FixtureHolders) {
      $Record=$Original | Select-Object *
      if ($Record.Id -eq 1) { continue } # released its lock
      switch ($Record.Id) {
        2 { $Record.Created++ } # PID reused
        3 { $Record.Executable='fixture/other-node.exe' }
        5 { $Record.SameUser=$false }
        6 { $Record.Session++ }
        7 { $Record.Critical=$true }
        9 { $Record.Name='unknown-program' }
      }
      $Record
    }
    New-HolderFixture 100 # arrived after the initial holder scan
    return
  }
  if ($script:Mode -eq 'ownership-changed' -and $script:ScanCalls -gt 1) { $script:OwnedUpdateProcesses=@() }
  foreach ($Record in $script:FixtureHolders) {
    if ($Record.Name -eq 'explorer' -and $script:FoldersClosed -and $script:Mode -ne 'explorer-held') { continue }
    $Record
  }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction, $OperationTimeoutSec)
  if ($script:Mode -eq 'changed' -and $script:ScanCalls -gt 1) { [pscustomobject]@{ProcessId=4} }
}
function Stop-UpdateHolder {
  param($Holder)
  if ($Holder -is [Array] -or $Holder.Id -is [Array]) { throw 'Termination received nested holder records.' }
  if ($Holder.Name -eq 'explorer' -and (-not $script:RecoveryStarted -or -not $script:FoldersClosed)) { throw 'Explorer termination must follow recovery setup and matching folder close.' }
  if ($script:Mode -eq 'stop-error' -and $Holder.Id -eq 1) { throw 'fixture process became inaccessible' }
  $script:StoppedIds += $Holder.Id
  if ($script:Mode -eq 'cache-recreated' -and $Holder.Id -eq 31) {
    $Replacement=$Holder | Select-Object *
    $Replacement.Id=32; $Replacement.Created++
    $script:FixtureHolders=@($Replacement)
  }
  return $true
}
function Get-RegisteredTortoiseGitCachePaths { $script:RegisteredCachePaths }
function Get-UpdateExecutableVersionInfo { param($Path) $script:CacheVersion }
function Start-ExplorerRecovery { $script:RecoveryStarted=$true }
function Close-InstallationExplorerWindows { param($Root) $script:FoldersClosed=$true }
function Assert-NoResolverError {
  if (@($script:FixtureLogs | Where-Object { $_ -like 'local lock resolution:*' }).Count) { throw ($script:FixtureLogs -join "`n") }
  if ($script:PromptCount) { throw 'Resolver requested confirmation.' }
}
try {
  $ResolverAst=$Ast.Find({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Resolve-UpdateDirectoryLocks'}, $true)
  if ($ResolverAst.Extent.Text -match 'ShowDialog|MessageBox|Confirm-UpdateHolder') { throw 'Directory lock resolver still contains a blocking confirmation dialog.' }
  Reset-BatchFixture
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -ne 20 -or $script:ScanCalls -ne 21) { throw '20 holders must be stopped automatically, with a fresh scan before every stop.' }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  Write-Output 'PASS: 20 actual holder identities are cleaned automatically and retry never requests confirmation'

  Reset-BatchFixture
  $RuntimeNames=@('node','python','pythonw','cmd','powershell','pwsh','WindowsTerminal','OpenConsole','opencode','nga','codeagent','codeagentcli','claude','uv','uvx')
  $script:FixtureHolders=@()
  for ($Index=0; $Index -lt $RuntimeNames.Count; $Index++) {
    $Holder=New-HolderFixture ($Index+1)
    $Holder.Name=$RuntimeNames[$Index]
    $Holder.Executable="fixture/$($Holder.Name).exe"
    if ((Get-UpdateHolderPolicy $Holder @() @() @()) -ne 'automatic') { throw "Known runtime $($Holder.Name) is not classified for automatic cleanup." }
    $script:FixtureHolders += $Holder
  }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -ne $RuntimeNames.Count) { throw 'Runtime or terminal wrappers were left waiting for manual cleanup.' }
  Write-Output 'PASS: Python, Node, shells, terminal hosts, Agent wrappers and uv runtimes release their installation handles automatically'

  Reset-BatchFixture
  $ProtectedNames=@('Code','notepad','notepad++','unknown-security-service')
  $script:FixtureHolders=@()
  for ($Index=0; $Index -lt $ProtectedNames.Count; $Index++) {
    $Holder=New-HolderFixture ($Index+1)
    $Holder.Name=$ProtectedNames[$Index]
    $Holder.Executable="fixture/$($Holder.Name).exe"
    if ((Get-UpdateHolderPolicy $Holder @() @() @()) -ne 'protected') { throw "Unapproved desktop application $($Holder.Name) is not protected." }
    $script:FixtureHolders += $Holder
  }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count) { throw 'Unknown applications or editors were terminated.' }
  Write-Output 'PASS: unknown applications and editors remain protected without opening a blocking modal'

  Reset-BatchFixture
  $Cache=New-HolderFixture 31
  $Cache.Name='TGitCache'; $Cache.Executable=[IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'TortoiseGit/bin/TGitCache.exe'))
  $script:RegisteredCachePaths=@($Cache.Executable)
  $script:FixtureHolders=@($Cache)
  if ((Get-UpdateHolderPolicy $Cache @() @() @()) -ne 'tortoisegit') { throw 'Registered TortoiseGit cache was not recognized.' }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (($script:StoppedIds -join ',') -ne '31') { throw 'Verified TortoiseGit cache holding the installation was not released.' }
  foreach ($Field in @('ProductName','OriginalFilename')) {
    $Saved=$script:CacheVersion.$Field; $script:CacheVersion.$Field='unrelated-program'
    if ((Get-UpdateHolderPolicy $Cache @() @() @()) -ne 'protected') { throw 'A mismatched TGitCache binary was authorized.' }
    $script:CacheVersion.$Field=$Saved
  }
  $script:RegisteredCachePaths=@()
  if ((Get-UpdateHolderPolicy $Cache @() @() @()) -ne 'protected') { throw 'An unregistered executable named TGitCache was authorized.' }
  $script:RegisteredCachePaths=@($Cache.Executable)
  foreach ($Field in @('Critical','SameUser','Session')) {
    $Other=$Cache | Select-Object *
    switch ($Field) { 'Critical' { $Other.Critical=$true }; 'SameUser' { $Other.SameUser=$false }; 'Session' { $Other.Session++ } }
    if ((Get-UpdateHolderPolicy $Other @() @() @()) -ne 'protected') { throw "TortoiseGit bypassed $Field protection." }
  }
  if ((Get-UpdateHolderPolicy $Cache @() @(31) @()) -ne 'protected' -or
      (Get-UpdateHolderPolicy $Cache @() @() @(31)) -ne 'protected') { throw 'TortoiseGit bypassed service/ancestor protection.' }
  Write-Output 'PASS: registered TortoiseGit cache is cleaned only with matching executable metadata and existing identity protections'

  $script:StoppedIds=@(); $script:Mode='cache-recreated'; $script:FixtureHolders=@($Cache)
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  if (($script:StoppedIds -join ',') -ne '31') { throw 'A replacement cache inherited its predecessor cleanup decision in the same pass.' }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  if (($script:StoppedIds -join ',') -ne '31,32') { throw 'A recreated cache was not independently verified on the next cleanup pass.' }
  Write-Output 'PASS: a recreated cache receives a fresh holder identity and policy check before a later cleanup pass stops it'

  Reset-BatchFixture
  $script:Mode='stop-error'
  $Result=Resolve-UpdateDirectoryLocks 'fixture/install'
  if (($script:StoppedIds -join ',') -ne ((2..20) -join ',') -or $Result.Detail -notlike '*PID 1*') { throw 'One inaccessible holder suppressed the other candidates or lost diagnostics.' }
  Write-Output 'PASS: one holder failure preserves its diagnostic and does not suppress the remaining cleanup batch'

  Reset-BatchFixture
  $Result=Resolve-UpdateDirectoryLocks 'fixture/install' -Deadline ([DateTime]::UtcNow.AddSeconds(-1))
  if ($script:ScanCalls -or $script:StoppedIds.Count -or $Result.Detail -notlike '*time limit*') { throw 'Expired cleanup budget still scanned or terminated a process.' }
  Write-Output 'PASS: an expired overall cleanup deadline stops further scanning and termination'

  Reset-BatchFixture
  $script:Mode='changed'
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (($script:StoppedIds -join ',') -ne ((10..20) -join ',')) { throw "Changed/released/protected/new holders reached termination: $($script:StoppedIds -join ',')" }
  Write-Output 'PASS: rescan excludes released, reused, executable-changed, service, user, session, critical, ancestor and unknown holders'
  Write-Output 'PASS: a newly appearing process cannot inherit another holder identity'

  Reset-BatchFixture
  $script:Mode='ownership-changed'
  $script:FixtureHolders=@(New-HolderFixture 1)
  $script:FixtureHolders[0].Name='PANGEA Desktop'
  $script:OwnedUpdateProcesses=@($script:FixtureHolders[0] | Select-Object Id,Created,Executable)
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count) { throw 'Lost ownership must not reuse automatic authorization.' }
  Write-Output 'PASS: fresh ownership policy must still authorize automatic termination'

  Reset-BatchFixture
  $Explorer=New-HolderFixture 21
  $Explorer.Name='explorer'; $Explorer.Executable=Join-Path $env:SystemRoot 'explorer.exe'
  $script:FixtureHolders += $Explorer
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (-not $script:RecoveryStarted -or -not $script:FoldersClosed -or 21 -in $script:StoppedIds) { throw 'Explorer must close matching folders automatically and avoid termination when the lock is released.' }
  Write-Output 'PASS: matching Explorer folders close automatically, preserving Explorer when that releases the lock'

  Reset-BatchFixture
  $script:FixtureHolders=@($Explorer)
  $script:AutomaticUpdateCleanup=$true
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -or -not $script:RecoveryStarted -or -not $script:FoldersClosed -or $script:StoppedIds.Count) { throw 'Existing automatic Explorer cleanup policy changed.' }
  Write-Output 'PASS: automatic Explorer policy still needs no extra confirmation'

  Reset-BatchFixture
  $script:Mode='explorer-held'
  $script:FixtureHolders=@($Explorer)
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (($script:StoppedIds -join ',') -ne '21') { throw 'Explorer retaining its directory handle must be stopped with recovery armed.' }
  $null=Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -ne 1) { throw 'Explorer restart was attempted repeatedly.' }
  Write-Output 'PASS: Explorer retaining a lock is terminated once after its independent recovery guard is armed'

  # Exercise the real rename loop with a missing destination parent as its
  # deterministic OS failure boundary. A fresh cleanup pass releases it.
  $RetryRoot=Join-Path ([IO.Path]::GetTempPath()) ('pangea-cleanup-retry-'+[guid]::NewGuid())
  $Source=Join-Path $RetryRoot 'installed'
  $script:RetryDestination=Join-Path $RetryRoot 'new-parent/old'
  New-Item -ItemType Directory -Path $Source -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Source 'run.json'), 'existing-run')
  $script:RetryPasses=0; $script:ReleaseOnPass=2
  function Write-InstallationProcesses { param($Root) }
  function Resolve-UpdateDirectoryLocks {
    param($Root, $Deadline)
    $script:RetryPasses++
    if ($script:RetryPasses -eq $script:ReleaseOnPass) { [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:RetryDestination)) | Out-Null }
    return [pscustomobject]@{Detail='受保护占用：TGitCache (PID 23192)'}
  }
  try {
    Move-UpdateDirectory $Source $script:RetryDestination -ResolveLocks -TimeoutSeconds 1 -CleanupTimeoutSeconds 2
    if ($script:RetryPasses -ne 2 -or [IO.File]::ReadAllText((Join-Path $script:RetryDestination 'run.json')) -ne 'existing-run') { throw 'A later cleanup pass did not complete the rename and preserve Run data.' }
    Write-Output 'PASS: a later independently verified cleanup pass can release a recreated holder and complete the rename'

    $Source=Join-Path $RetryRoot 'persistent'
    New-Item -ItemType Directory -Path $Source -Force | Out-Null
    $script:RetryDestination=Join-Path $RetryRoot 'still-missing/old'
    $script:RetryPasses=0; $script:ReleaseOnPass=99
    $Failure=''; $Timer=[Diagnostics.Stopwatch]::StartNew()
    try { Move-UpdateDirectory $Source $script:RetryDestination -ResolveLocks -TimeoutSeconds 1 -CleanupTimeoutSeconds 2 -MaxCleanupPasses 3 }
    catch { $Failure=$_.Exception.Message }
    if ($script:RetryPasses -ne 3 -or $Failure -notlike '*TGitCache (PID 23192)*' -or -not (Test-Path -LiteralPath $Source)) { throw 'Repeated cleanup exceeded its count, lost holder diagnostics, or changed the original installation.' }
    if ($Timer.Elapsed.TotalSeconds -gt 5) { throw 'Repeated cleanup exceeded its overall time budget.' }
    Write-Output 'PASS: persistent locks stop after three passes within the time budget, preserve the original, and name the blocking process'
  } finally { Remove-Item -LiteralPath $RetryRoot -Recurse -Force }
} finally { $env:SystemRoot=$OriginalSystemRoot }
$global:LASTEXITCODE=0
