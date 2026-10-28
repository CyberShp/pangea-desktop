[CmdletBinding()]
param([string]$ChildRoot, [string]$CrashPoint)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Updater=Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Tokens=$null; $ParseErrors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$Tokens,[ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Definition in $Ast.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] },$true)) {
  Invoke-Expression $Definition.Extent.Text
}
# Only the OS rename boundary is replaced. All transaction persistence,
# validation, locking and recovery below is the production implementation.
function Move-UpdateDirectory { param([string]$Source,[string]$Destination,[switch]$ResolveLocks) [IO.Directory]::Move($Source,$Destination) }
if ([IO.Path]::DirectorySeparatorChar -ne '\') {
  # Linux test sandboxes can hide /proc start times. Production Windows uses the
  # actual process creation timestamp; this suite exercises persistence, not CIM.
  function Get-PortableTransactionWorkerIdentity { return [pscustomobject]@{ pid=$PID; started_at=[DateTime]::UtcNow.ToString('o') } }
}
function Write-FixtureVersion {
  param([string]$Root,[string]$Version,[string]$Content)
  [IO.Directory]::CreateDirectory((Join-Path $Root 'resources')) | Out-Null
  [IO.File]::WriteAllText((Join-Path $Root 'resources/pangea-manifest.json'),(@{product=@{version=$Version}} | ConvertTo-Json -Compress))
  [IO.File]::WriteAllText((Join-Path $Root 'user-work.txt'),$Content)
}
function New-Fixture {
  param([string]$Root)
  $Install=Join-Path $Root 'installed [中文]'; $Workspace=Join-Path $Root 'p-up-1'; $Data=Join-Path $Root 'profile'
  [IO.Directory]::CreateDirectory((Join-Path $Data 'updates/run-1')) | Out-Null
  [IO.Directory]::CreateDirectory($Workspace) | Out-Null
  Write-FixtureVersion $Install '2.1.8' 'original user work'
  Write-FixtureVersion (Join-Path $Workspace 'new') '2.1.9' 'candidate user work'
  return [pscustomobject]@{ Root=$Root; Install=$Install; Workspace=$Workspace; Data=$Data; Plan=(Join-Path $Data 'updates/run-1/plan.json') }
}
function Begin-FixtureTransaction {
  param($Fixture,$Context)
  $Transaction=New-PortableUpdateTransaction $Context $Fixture.Workspace (Get-PortableRootIdentity $Fixture.Install) '2.1.9' $Fixture.Plan $Fixture.Data
  $Transaction.target_identity=Get-PortableRootIdentity (Join-Path $Fixture.Workspace 'new')
  Set-PortableTransactionState $Context $Transaction 'candidate_ready'
  return $Transaction
}
if ($ChildRoot) {
  $Fixture=New-Fixture $ChildRoot
  $Context=Get-PortableTransactionContext $Fixture.Install
  $Lock=Enter-PortableUpdateLock $Context
  $Transaction=Begin-FixtureTransaction $Fixture $Context
  $Old=Join-Path $Fixture.Workspace 'old'; $New=Join-Path $Fixture.Workspace 'new'; $Failed=Join-Path $Fixture.Workspace 'failed'
  if ($CrashPoint -ne 'candidate_ready') {
    Set-PortableTransactionState $Context $Transaction 'original_move_pending'
    if ($CrashPoint -ne 'original_move_pending') {
      Move-UpdateDirectory $Fixture.Install $Old
      if ($CrashPoint -ne 'original_rename') {
        Set-PortableTransactionState $Context $Transaction 'original_moved'
        Set-PortableTransactionState $Context $Transaction 'activate_pending'
        if ($CrashPoint -ne 'activate_pending') {
          Move-UpdateDirectory $New $Fixture.Install
          if ($CrashPoint -ne 'activate_rename') {
            Set-PortableTransactionState $Context $Transaction 'activated'
            if ($CrashPoint -eq 'committed') { Set-PortableTransactionState $Context $Transaction 'committed' }
            if ($CrashPoint -in @('rollback_displace','rollback_restore')) {
              Set-PortableTransactionState $Context $Transaction 'rollback_pending'
              Move-UpdateDirectory $Fixture.Install $Failed
              if ($CrashPoint -eq 'rollback_restore') {
                Set-PortableTransactionState $Context $Transaction 'rollback_displaced'
                Move-UpdateDirectory $Old $Fixture.Install
              }
            }
          }
        }
      }
    }
  }
  [IO.File]::WriteAllText((Join-Path $ChildRoot 'crash-ready'),'ready')
  # The parent kills only this fixture process: no finally/catch recovery runs.
  while ($true) { Start-Sleep -Milliseconds 100 }
}

$TestRoot=Join-Path ([IO.Path]::GetTempPath()) ('pangea-transactions-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null
$Children=New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$LogPath=Join-Path $TestRoot 'test.log'
try {
  foreach ($Point in @('candidate_ready','original_move_pending','original_rename','activate_pending','activate_rename','activated','rollback_displace','rollback_restore','committed')) {
    $Case=Join-Path $TestRoot $Point
    [IO.Directory]::CreateDirectory($Case) | Out-Null
    $Start=New-Object Diagnostics.ProcessStartInfo
    $Start.FileName=Join-Path $PSHOME $(if ([IO.Path]::DirectorySeparatorChar -eq '\') { 'powershell.exe' } else { 'pwsh' })
    $Start.Arguments='-NoProfile -File "'+$PSCommandPath+'" -ChildRoot "'+$Case+'" -CrashPoint '+$Point
    $Start.UseShellExecute=$false; $Start.RedirectStandardError=$true
    $Process=[Diagnostics.Process]::Start($Start); $Children.Add($Process)
    $Deadline=[DateTime]::UtcNow.AddSeconds(20)
    while (-not [IO.File]::Exists((Join-Path $Case 'crash-ready'))) {
      if ($Process.HasExited) { throw "Fault fixture exited: $($Process.StandardError.ReadToEnd())" }
      if ([DateTime]::UtcNow -gt $Deadline) { throw "Fault fixture did not reach $Point" }
      Start-Sleep -Milliseconds 30
    }
    $Install=Join-Path $Case 'installed [中文]'; $Data=Join-Path $Case 'profile'; $Context=Get-PortableTransactionContext $Install
    $Rejected=$false
    try { $Unexpected=Enter-PortableUpdateLock $Context; $Unexpected.Dispose() } catch { $Rejected=$true }
    if (-not $Rejected) { throw 'Independent updater acquired the already-held installation lock.' }
    $Process.Kill(); $Process.WaitForExit()
    $Lock=Enter-PortableUpdateLock $Context
    try {
      $Transaction=Read-PortableUpdateTransaction $Context $Data
      $Recovered=Restore-PortableUpdateTransaction $Context $Transaction $Data
      $Expected=if ($Point -eq 'committed') { '2.1.9' } else { '2.1.8' }
      if ((Get-PortableRootIdentity $Install).version -ne $Expected) { throw "Wrong version recovered at $Point" }
      $Content=[IO.File]::ReadAllText((Join-Path $Install 'user-work.txt'))
      if ($Point -ne 'committed' -and $Content -ne 'original user work') { throw 'Original user data was changed.' }
      $Again=Restore-PortableUpdateTransaction $Context $Recovered $Data
      if ($Again.state -ne $Recovered.state) { throw 'Recovery was not idempotent.' }
      if ($Point -in @('activate_rename','activated','rollback_displace','rollback_restore') -and
          [IO.File]::ReadAllText((Join-Path $Case 'p-up-1/failed/user-work.txt')) -ne 'candidate user work') { throw 'Attempted-version user edits were discarded.' }
    } finally { $Lock.Dispose() }
    Write-Output "PASS: actual process termination at $Point; independent mutex, durable recovery and preserved data"
  }

  foreach ($Attack in @('missing-owner','outside-workspace','wrong-owner','changed-install','changed-backup','file-at-install','linked-workspace','linked-journal')) {
    $Fixture=New-Fixture (Join-Path $TestRoot $Attack); $Context=Get-PortableTransactionContext $Fixture.Install
    $Lock=Enter-PortableUpdateLock $Context
    try {
      $Transaction=Begin-FixtureTransaction $Fixture $Context
      $Outside=Join-Path $Fixture.Root 'unrelated'; [IO.Directory]::CreateDirectory($Outside) | Out-Null
      [IO.File]::WriteAllText((Join-Path $Outside 'precious.txt'),'untouched')
      switch ($Attack) {
        'missing-owner' { [IO.File]::Delete((Join-Path $Fixture.Workspace '.pangea-update-owner.json')) }
        'outside-workspace' { $Transaction.workspace=$Outside; Write-PortableTransactionJson $Context.Journal $Transaction }
        'wrong-owner' { $Transaction.owner='untrusted-user'; Write-PortableTransactionJson $Context.Journal $Transaction }
        'changed-install' { Write-FixtureVersion $Fixture.Install '9.9.9' 'unrelated installation' }
        'changed-backup' { Move-UpdateDirectory $Fixture.Install (Join-Path $Fixture.Workspace 'old'); Write-FixtureVersion (Join-Path $Fixture.Workspace 'old') '9.9.9' 'unrelated backup' }
        'file-at-install' { Move-UpdateDirectory $Fixture.Install (Join-Path $Fixture.Workspace 'old'); [IO.File]::WriteAllText($Fixture.Install,'unrelated file') }
        'linked-workspace' {
          [IO.Directory]::Move($Fixture.Workspace,(Join-Path $Fixture.Root 'saved-workspace'))
          try { New-Item -ItemType SymbolicLink -Path $Fixture.Workspace -Target $Outside -ErrorAction Stop | Out-Null }
          catch { Write-Output 'SKIP: creating symbolic links requires local permission'; continue }
        }
        'linked-journal' {
          [IO.File]::Move($Context.Journal,(Join-Path $Outside 'transaction.json'))
          try { New-Item -ItemType SymbolicLink -Path $Context.Journal -Target (Join-Path $Outside 'transaction.json') -ErrorAction Stop | Out-Null }
          catch { Write-Output 'SKIP: creating symbolic links requires local permission'; continue }
        }
      }
      $Rejected=$false
      try { Restore-PortableUpdateTransaction $Context $Transaction $Fixture.Data | Out-Null } catch { $Rejected=$true }
      if (-not $Rejected) { throw "Unsafe recovery was accepted: $Attack" }
      if ([IO.File]::ReadAllText((Join-Path $Outside 'precious.txt')) -ne 'untouched') { throw 'Recovery modified unrelated data.' }
      Write-Output "PASS: $Attack is rejected without overwriting unrelated data"
    } finally { $Lock.Dispose() }
  }

  foreach ($Terminal in @('committed','restored')) {
    foreach ($Cleanup in @('receipt','workspace')) {
      $Fixture=New-Fixture (Join-Path $TestRoot "$Terminal-missing-$Cleanup"); $Context=Get-PortableTransactionContext $Fixture.Install
      $Lock=Enter-PortableUpdateLock $Context
      try {
        $Transaction=Begin-FixtureTransaction $Fixture $Context
        if ($Terminal -eq 'committed') {
          Move-UpdateDirectory $Fixture.Install (Join-Path $Fixture.Workspace 'old')
          Move-UpdateDirectory (Join-Path $Fixture.Workspace 'new') $Fixture.Install
        }
        Set-PortableTransactionState $Context $Transaction $Terminal
        if ($Cleanup -eq 'receipt') { [IO.File]::Delete((Join-Path $Fixture.Workspace '.pangea-update-owner.json')) }
        else { Remove-Item -LiteralPath $Fixture.Workspace -Recurse -Force }
        $Recovered=Restore-PortableUpdateTransaction $Context $Transaction $Fixture.Data
        if ($Recovered.state -ne $Terminal) { throw 'Completed transaction changed after temporary-file cleanup.' }
        if ([IO.File]::Exists((Join-Path $Fixture.Workspace '.pangea-update-owner.json'))) { throw 'Recovery fabricated a missing ownership receipt.' }
        Write-FixtureVersion $Fixture.Install '9.9.9' 'unrelated installation'
        $Rejected=$false
        try { Read-PortableUpdateTransaction $Context $Fixture.Data | Out-Null } catch { $Rejected=$true }
        if (-not $Rejected) { throw 'Terminal journal accepted a changed installation.' }
        Write-Output "PASS: $Terminal tolerates missing $Cleanup but rejects a changed installation"
      } finally { $Lock.Dispose() }
    }
  }

  $Fixture=New-Fixture (Join-Path $TestRoot 'restored-user-edits'); $Context=Get-PortableTransactionContext $Fixture.Install
  $Lock=Enter-PortableUpdateLock $Context
  try {
    $Transaction=Begin-FixtureTransaction $Fixture $Context
    $Transaction.profile_snapshot_ready=$true; $Transaction.new_version_started=$true
    Set-PortableTransactionState $Context $Transaction 'restored'
    $UserConfig=Join-Path $Fixture.Data 'user-config.json'
    [IO.File]::WriteAllText($UserConfig,'user edits after completed rollback')
    function Restore-UpdateProfileSnapshot { throw 'A terminal rollback attempted to restore configuration again.' }
    Restore-PortableUpdateTransaction $Context $Transaction $Fixture.Data | Out-Null
    if ([IO.File]::ReadAllText($UserConfig) -ne 'user edits after completed rollback') { throw 'Repeated recovery overwrote later user edits.' }
    Write-Output 'PASS: terminal restored transaction does not replay profile migration or overwrite later user configuration'
  } finally { $Lock.Dispose() }

  $Policy=Get-Content -LiteralPath (Join-Path $PSScriptRoot '../build/portable-update-policy.json') -Raw | ConvertFrom-Json
  $Fixture=New-Fixture (Join-Path $TestRoot 'source-policy')
  foreach ($Version in @('2.1.7','2.1.7-test.17.abcdef','2.1.8','2.1.8-test.17.abcdef','2.1.9')) {
    Write-FixtureVersion $Fixture.Install $Version 'original work'
    $Accepted=$true
    try { Assert-PortableUpgradeSourceVersion $Fixture.Install 'patch' $Version | Out-Null } catch { $Accepted=$false }
    $Numeric=[version]($Version.Split('-')[0])
    if ($Accepted -ne ($Numeric -ge [version]$Policy.minimum_source_version)) { throw "Signed helper source policy differs from shared policy: $Version" }
  }
  $Rejected=$false
  try { Assert-PortableUpgradeSourceVersion $Fixture.Install 'patch' '2.1.8' | Out-Null } catch { $Rejected=$true }
  if (-not $Rejected) { throw 'Mismatched patch base was accepted.' }
  Write-Output 'PASS: stable/test source-version boundaries match shared policy and patch base is independently checked'
  if ((Get-PortableStartupHealthTimeout ([pscustomobject]@{})) -ne 300) { throw 'Legacy plans must use the 300-second health deadline.' }
  foreach ($Value in @(30,300,600)) {
    if ((Get-PortableStartupHealthTimeout ([pscustomobject]@{ startup_health_timeout_seconds=$Value })) -ne $Value) { throw 'A supported health deadline was changed.' }
  }
  foreach ($Value in @(0,29,601,-1,30.5,'invalid')) {
    $Rejected=$false
    try { Get-PortableStartupHealthTimeout ([pscustomobject]@{ startup_health_timeout_seconds=$Value }) | Out-Null } catch { $Rejected=$true }
    if (-not $Rejected) { throw "An invalid health deadline was accepted: $Value" }
  }
  Write-Output 'PASS: health deadline defaults to 300 seconds with explicit integer range 30 through 600'
} finally {
  foreach ($Process in $Children) { try { if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() } } finally { $Process.Dispose() } }
  if ([IO.Directory]::Exists($TestRoot)) { Remove-Item -LiteralPath $TestRoot -Recurse -Force }
}
$global:LASTEXITCODE=0
