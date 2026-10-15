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
  param($Root)
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
  param($ClassName, $Filter, $ErrorAction)
  if ($script:Mode -eq 'changed' -and $script:ScanCalls -gt 1) { [pscustomobject]@{ProcessId=4} }
}
function Stop-UpdateHolder {
  param($Holder)
  if ($Holder -is [Array] -or $Holder.Id -is [Array]) { throw 'Termination received nested holder records.' }
  if ($Holder.Name -eq 'explorer' -and (-not $script:RecoveryStarted -or -not $script:FoldersClosed)) { throw 'Explorer termination must follow recovery setup and matching folder close.' }
  $script:StoppedIds += $Holder.Id
  return $true
}
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
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -ne 20 -or $script:ScanCalls -ne 21) { throw '20 holders must be stopped automatically, with a fresh scan before every stop.' }
  Resolve-UpdateDirectoryLocks 'fixture/install'
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
  Resolve-UpdateDirectoryLocks 'fixture/install'
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
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count) { throw 'Unknown applications or editors were terminated.' }
  Write-Output 'PASS: unknown applications and editors remain protected without opening a blocking modal'

  Reset-BatchFixture
  $script:Mode='changed'
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (($script:StoppedIds -join ',') -ne ((10..20) -join ',')) { throw "Changed/released/protected/new holders reached termination: $($script:StoppedIds -join ',')" }
  Write-Output 'PASS: rescan excludes released, reused, executable-changed, service, user, session, critical, ancestor and unknown holders'
  Write-Output 'PASS: a newly appearing process cannot inherit another holder identity'

  Reset-BatchFixture
  $script:Mode='ownership-changed'
  $script:FixtureHolders=@(New-HolderFixture 1)
  $script:FixtureHolders[0].Name='PANGEA Desktop'
  $script:OwnedUpdateProcesses=@($script:FixtureHolders[0] | Select-Object Id,Created,Executable)
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count) { throw 'Lost ownership must not reuse automatic authorization.' }
  Write-Output 'PASS: fresh ownership policy must still authorize automatic termination'

  Reset-BatchFixture
  $Explorer=New-HolderFixture 21
  $Explorer.Name='explorer'; $Explorer.Executable=Join-Path $env:SystemRoot 'explorer.exe'
  $script:FixtureHolders += $Explorer
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (-not $script:RecoveryStarted -or -not $script:FoldersClosed -or 21 -in $script:StoppedIds) { throw 'Explorer must close matching folders automatically and avoid termination when the lock is released.' }
  Write-Output 'PASS: matching Explorer folders close automatically, preserving Explorer when that releases the lock'

  Reset-BatchFixture
  $script:FixtureHolders=@($Explorer)
  $script:AutomaticUpdateCleanup=$true
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -or -not $script:RecoveryStarted -or -not $script:FoldersClosed -or $script:StoppedIds.Count) { throw 'Existing automatic Explorer cleanup policy changed.' }
  Write-Output 'PASS: automatic Explorer policy still needs no extra confirmation'

  Reset-BatchFixture
  $script:Mode='explorer-held'
  $script:FixtureHolders=@($Explorer)
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if (($script:StoppedIds -join ',') -ne '21') { throw 'Explorer retaining its directory handle must be stopped with recovery armed.' }
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -ne 1) { throw 'Explorer restart was attempted repeatedly.' }
  Write-Output 'PASS: Explorer retaining a lock is terminated once after its independent recovery guard is armed'
} finally { $env:SystemRoot=$OriginalSystemRoot }
$global:LASTEXITCODE=0
