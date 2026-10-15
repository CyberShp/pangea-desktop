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
  $script:UpdateHolderDecisions=@{}
  $script:OwnedUpdateProcesses=@()
  $script:ProtectedUpdateProcesses=@()
  $script:AutomaticUpdateCleanup=$false
  $script:ExplorerRestartAttempted=$false
  $script:PromptCount=0; $script:PromptSizes=@(); $script:PromptIds=@(); $script:PromptHasExplorer=$false
  $script:ScanCalls=0; $script:StoppedIds=@(); $script:FixtureLogs=@()
  $script:Approved=$true; $script:Mode='stable'; $script:RecoveryStarted=$false; $script:FoldersClosed=$false
  $script:FixtureHolders=@(1..20 | ForEach-Object { New-HolderFixture $_ })
}
function Set-UpdateStage { param($Message, $Percent, $Stage) }
function Write-UpdateLog { param($Message) $script:FixtureLogs += [string]$Message }
function Initialize-HandleInspector { }
function Confirm-UpdateHolderBatchStop {
  param([object[]]$Holders, [bool]$IncludesExplorer=$false)
  $script:PromptCount++
  $script:PromptSizes += $Holders.Count
  $script:PromptIds += @($Holders | ForEach-Object { $_.Id })
  $script:PromptHasExplorer=$IncludesExplorer
  if (@($Holders | Where-Object { $_ -is [Array] -or $_.Id -is [Array] }).Count) { throw 'Batch contains nested holders.' }
  return $script:Approved
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
    New-HolderFixture 100 # arrived after the reviewed batch
    return
  }
  if ($script:Mode -eq 'ownership-changed' -and $script:ScanCalls -gt 1) { $script:OwnedUpdateProcesses=@() }
  foreach ($Record in $script:FixtureHolders) {
    if ($Record.Name -eq 'explorer' -and $script:FoldersClosed) { continue }
    $Record
  }
}
function Get-CimInstance {
  param($ClassName, $Filter, $ErrorAction)
  if ($script:Mode -eq 'changed' -and $script:ScanCalls -gt 1) { [pscustomobject]@{ProcessId=4} }
}
function Stop-UpdateHolder { param($Holder) $script:StoppedIds += $Holder.Id; return $true }
function Start-ExplorerRecovery { $script:RecoveryStarted=$true }
function Close-InstallationExplorerWindows { param($Root) $script:FoldersClosed=$true }
function Assert-NoResolverError {
  if (@($script:FixtureLogs | Where-Object { $_ -like 'local lock resolution:*' }).Count) { throw ($script:FixtureLogs -join "`n") }
}
try {
  Reset-BatchFixture
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 1 -or $script:PromptSizes[0] -ne 20 -or $script:StoppedIds.Count -ne 20 -or $script:ScanCalls -ne 21) { throw '20 holders must share one prompt, with a fresh scan before every stop.' }
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 1) { throw 'Accepted identities were prompted again on retry.' }
  Write-Output 'PASS: 20 holder identities share one confirmation and retry does not repeat it'

  Reset-BatchFixture
  $script:Approved=$false
  $script:OwnedUpdateProcesses=@($script:FixtureHolders[19] | Select-Object Id,Created,Executable)
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 1 -or $script:PromptSizes[0] -ne 19 -or $script:StoppedIds.Count -ne 2 -or @($script:StoppedIds | Where-Object { $_ -ne 20 }).Count) { throw 'Decline must preserve all external holders while keeping owned cleanup automatic.' }
  $script:FixtureHolders[0].Created++
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 2 -or $script:PromptSizes[1] -ne 1 -or $script:PromptIds[-1] -ne 1) { throw 'A reused PID needs its own new identity decision without re-prompting the unchanged holders.' }
  Write-Output 'PASS: decline is cached, owned processes stay automatic, and reused PID requires new consent'

  Reset-BatchFixture
  $script:Mode='changed'
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 1 -or ($script:StoppedIds -join ',') -ne ((10..20) -join ',')) { throw "Changed/released/protected/unreviewed holders reached termination: $($script:StoppedIds -join ',')" }
  Write-Output 'PASS: rescan excludes released, reused, executable-changed, service, user, session, critical, ancestor and unknown holders'
  Write-Output 'PASS: holders arriving after consent cannot inherit batch authorization'

  Reset-BatchFixture
  $script:Mode='ownership-changed'
  $script:FixtureHolders=@(New-HolderFixture 1)
  $script:OwnedUpdateProcesses=@($script:FixtureHolders[0] | Select-Object Id,Created,Executable)
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:StoppedIds.Count -or $script:PromptCount) { throw 'Lost ownership must not reuse automatic authorization.' }
  Write-Output 'PASS: fresh ownership policy must still authorize automatic termination'

  Reset-BatchFixture
  $Explorer=New-HolderFixture 21
  $Explorer.Name='explorer'; $Explorer.Executable=Join-Path $env:SystemRoot 'explorer.exe'
  $script:FixtureHolders += $Explorer
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -ne 1 -or $script:PromptSizes[0] -ne 21 -or -not $script:PromptHasExplorer -or -not $script:RecoveryStarted -or -not $script:FoldersClosed -or 21 -in $script:StoppedIds) { throw 'Manual Explorer must share the batch warning/consent and preserve guarded folder-close recovery.' }
  Write-Output 'PASS: manual Explorer shares the single batch prompt and keeps its recovery guard'

  Reset-BatchFixture
  $script:FixtureHolders=@($Explorer)
  $script:AutomaticUpdateCleanup=$true
  Resolve-UpdateDirectoryLocks 'fixture/install'
  Assert-NoResolverError
  if ($script:PromptCount -or -not $script:RecoveryStarted -or -not $script:FoldersClosed -or $script:StoppedIds.Count) { throw 'Existing automatic Explorer cleanup policy changed.' }
  Write-Output 'PASS: automatic Explorer policy still needs no extra confirmation'
} finally { $env:SystemRoot=$OriginalSystemRoot }
$global:LASTEXITCODE=0
