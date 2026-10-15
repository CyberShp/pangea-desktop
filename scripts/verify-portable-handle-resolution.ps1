$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Updater = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'))
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
foreach ($Function in $Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) { Invoke-Expression $Function.Extent.Text }
$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-handles-' + [guid]::NewGuid())
$Installation=Join-Path $Root 'installation'
$Destination=Join-Path $Root 'renamed'
$Ready=Join-Path $Root 'holder.ready'
$LogPath=Join-Path $Root 'update.log'
$PlanPath=Join-Path $Root 'plan.json'
$script:UpdaterScriptPath=$Updater
$script:UpdateForm=$null
$script:OwnedUpdateProcesses=@()
$script:ProtectedUpdateProcesses=@($PID)
$script:AutomaticUpdateCleanup=$false
$script:ConfirmationCount=0
$HolderProcess=$null
$SecondHolderProcess=$null
$UnrelatedProcess=$null
function Confirm-UpdateHolderBatchStop {
  param([object[]]$Holders, [bool]$IncludesExplorer)
  $script:ConfirmationCount++
  throw 'Installation holder cleanup must never request confirmation.'
}

function Assert-ScalarHolderRecords {
  param([object[]]$Holders, [int[]]$ExpectedIds)
  if ($Holders.Count -ne $ExpectedIds.Count) {
    throw "Expected $($ExpectedIds.Count) scalar holder records, received $($Holders.Count). JSON arrays must be enumerated before returning from Get-UpdateLockHolders."
  }
  foreach ($Holder in $Holders) {
    if ($Holder -is [Array] -or $Holder.Id -is [Array] -or $Holder.Name -is [Array]) {
      throw 'Get-UpdateLockHolders returned a nested array instead of a single process record.'
    }
    if (($Holder.Id -isnot [int] -and $Holder.Id -isnot [long]) -or $Holder.Id -notin $ExpectedIds -or
        $Holder.Name -isnot [string] -or [string]::IsNullOrWhiteSpace($Holder.Name) -or
        $Holder.Critical -isnot [bool] -or $Holder.SameUser -isnot [bool]) {
      throw 'Holder PID, name and security flags must retain their scalar JSON types.'
    }
  }
  foreach ($ExpectedId in $ExpectedIds) {
    if (@($Holders | Where-Object { $_.Id -eq $ExpectedId }).Count -ne 1) {
      throw "Holder PID $ExpectedId was missing or duplicated."
    }
  }
}

New-Item -ItemType Directory -Path $Installation -Force | Out-Null
try {
  Initialize-HandleInspector
  $Holders=@(Get-UpdateLockHolders $Installation)
  Assert-ScalarHolderRecords $Holders @()
  Write-Output 'PASS: zero holders return an empty pipeline, not a nested empty JSON array'
  # This PowerShell executable is outside the installation, but its native CWD
  # holds the installation directory open, reproducing a terminal lock.
  $Code="[IO.File]::WriteAllText('$($Ready.Replace("'","''"))','ready'); Start-Sleep -Seconds 120"
  $Encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
  $HolderProcess=Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-EncodedCommand',$Encoded) -WorkingDirectory $Installation -WindowStyle Hidden -PassThru
  $Deadline=(Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath $Ready)) {
    if ((Get-Date) -ge $Deadline) { throw 'Holder did not start.' }
    Start-Sleep -Milliseconds 50
  }
  $Holders=@(Get-UpdateLockHolders $Installation)
  Assert-ScalarHolderRecords $Holders @($HolderProcess.Id)
  Write-Output 'PASS: one holder returns one scalar process record'

  # A single JSON result cannot catch PowerShell 5.1 treating a JSON array as
  # one pipeline item. Two real CWD holders must be returned and classified
  # individually; an aggregated Critical bool[] is truthy even when all false.
  $SecondReady=Join-Path $Root 'second-holder.ready'
  $Code="[IO.File]::WriteAllText('$($SecondReady.Replace("'","''"))','ready'); Start-Sleep -Seconds 120"
  $Encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
  $SecondHolderProcess=Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-EncodedCommand',$Encoded) -WorkingDirectory $Installation -WindowStyle Hidden -PassThru
  $Deadline=(Get-Date).AddSeconds(10)
  while (-not (Test-Path -LiteralPath $SecondReady)) {
    if ((Get-Date) -ge $Deadline) { throw 'Second holder did not start.' }
    Start-Sleep -Milliseconds 50
  }
  $Holders=@(Get-UpdateLockHolders $Installation)
  Assert-ScalarHolderRecords $Holders @($HolderProcess.Id, $SecondHolderProcess.Id)
  foreach ($Record in $Holders) {
    if ((Get-UpdateHolderPolicy $Record @() @() @($PID)) -ne 'automatic') {
      throw "External CWD holder $($Record.Id) must be individually classified for automatic cleanup."
    }
  }
  Write-Output 'PASS: multiple actual CWD holders retain scalar PID, name and security flags'
  $Holder=$Holders | Where-Object { $_.Id -eq $HolderProcess.Id } | Select-Object -First 1
  if (-not $Holder) { throw 'Directory holder outside installation was not detected.' }
  Write-Output 'PASS: actual directory handle finds external terminal by CWD'
  if ([PangeaUpdateHandles]::Stop($Holder.Id, ([long]$Holder.Created + 1))) { throw 'Stale creation time allowed termination.' }
  $HolderProcess.Refresh()
  if ($HolderProcess.HasExited) { throw 'PID reuse guard killed the process.' }
  Write-Output 'PASS: mismatched process creation time cannot terminate a PID'
  $Services=@(Get-CimInstance Win32_Service -Filter "State='Running'" | ForEach-Object { [int]$_.ProcessId })
  if ((Get-UpdateHolderPolicy $Holder @() $Services @($PID)) -ne 'automatic') { throw 'External terminal must be cleaned automatically.' }
  if ((Get-UpdateHolderPolicy $Holder @() @($Holder.Id) @($PID)) -ne 'protected') { throw 'Service process not protected.' }
  if ((Get-UpdateHolderPolicy $Holder @() @() @($Holder.Id)) -ne 'protected') { throw 'Updater ancestor not protected.' }
  $Fake=$Holder | Select-Object *; $Fake.Name='unknown-security-service'
  if ((Get-UpdateHolderPolicy $Fake @() @() @()) -ne 'protected') { throw 'Unknown process not protected.' }
  $Fake.Name='node'
  $Owned=@([pscustomobject]@{Id=$Fake.Id; Created=$Fake.Created; Executable=$Fake.Executable})
  if ((Get-UpdateHolderPolicy $Fake $Owned @() @()) -ne 'owned') { throw 'Owned runtime not recognized.' }
  $Fake.Name='PANGEA Desktop'
  if ((Get-UpdateHolderPolicy $Fake $Owned @() @()) -ne 'owned') { throw 'Owned Electron helper not recognized.' }
  $Fake.Name='node'
  $Owned[0].Created++
  if ((Get-UpdateHolderPolicy $Fake $Owned @() @()) -ne 'automatic') { throw 'Stale ownership must not classify a known runtime as owned.' }
  $Fake.Name='PANGEA Desktop'
  if ((Get-UpdateHolderPolicy $Fake $Owned @() @()) -ne 'protected') { throw 'Stale ownership authorized cleanup of an unknown application.' }
  Write-Output 'PASS: ownership, services, ancestors and unknown processes classified safely'
  # The user authorized automatic cleanup of actual installation holders.
  # Both processes are test-owned, but intentionally absent from the updater's
  # ownership snapshot so this exercises the external terminal policy.
  $NodePath=(Get-Command node.exe).Source
  $UnrelatedProcess=Start-Process $NodePath -ArgumentList @('-e','"setTimeout(()=>{},120000)"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Move-UpdateDirectory $Installation $Destination -TimeoutSeconds 1 -ResolveLocks
  $HolderProcess.Refresh()
  $SecondHolderProcess.Refresh()
  if (-not $HolderProcess.HasExited -or -not $SecondHolderProcess.HasExited -or -not (Test-Path -LiteralPath $Destination)) { throw 'Automatic holder cleanup did not release directory rename.' }
  if ($script:ConfirmationCount) { throw 'Actual holder cleanup requested user confirmation.' }
  $UnrelatedProcess.Refresh()
  if ($UnrelatedProcess.HasExited) { throw 'Runtime outside the installation holder set was terminated.' }
  Write-Output 'PASS: both actual external CWD holders exit automatically and directory rename succeeds without confirmation'
  Write-Output 'PASS: a Node runtime outside the installation remains alive during automatic cleanup'
  $HolderProcess.Dispose(); $HolderProcess=$null
  $SecondHolderProcess.Dispose(); $SecondHolderProcess=$null
  Move-UpdateDirectory $Destination $Installation
  $HolderProcess=Start-Process $NodePath -ArgumentList @('-e','"setTimeout(()=>{},120000)"') -WorkingDirectory $Installation -WindowStyle Hidden -PassThru
  $script:OwnedUpdateProcesses=@(Get-OwnedUpdateProcesses $PID ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName))
  if (-not @($script:OwnedUpdateProcesses | Where-Object { $_.Id -eq $HolderProcess.Id }).Count) { throw 'Live descendant ownership snapshot missed Node.' }
  Move-UpdateDirectory $Installation $Destination -TimeoutSeconds 1 -ResolveLocks
  $HolderProcess.Refresh()
  if (-not $HolderProcess.HasExited -or -not (Test-Path -LiteralPath $Destination)) { throw 'Owned runtime cleanup failed.' }
  if ($script:ConfirmationCount) { throw 'Owned runtime cleanup requested user confirmation.' }
  $UnrelatedProcess.Refresh()
  if ($UnrelatedProcess.HasExited) { throw 'Owned runtime without an installation handle was terminated.' }
  Write-Output 'PASS: live ownership snapshot automatically releases this Desktop runtime descendant'
  $HolderProcess.Dispose(); $HolderProcess=$null
  $HolderProcess=Start-Process $NodePath -ArgumentList @('-e','"setTimeout(()=>{},120000)"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  $Identity=[pscustomobject]@{Id=$HolderProcess.Id; Created=$HolderProcess.StartTime.ToUniversalTime().ToFileTimeUtc()}
  $Stale=[pscustomobject]@{Id=$Identity.Id; Created=([long]$Identity.Created + 1)}
  $Rejected=$false
  try { Wait-UpdateDesktopExit $HolderProcess.Id $Stale -TimeoutSeconds 1 } catch { $Rejected=$true }
  $HolderProcess.Refresh()
  if (-not $Rejected -or $HolderProcess.HasExited) { throw 'Desktop timeout bypassed original identity validation.' }
  Wait-UpdateDesktopExit $HolderProcess.Id $Identity -TimeoutSeconds 1
  $HolderProcess.Refresh()
  if (-not $HolderProcess.HasExited) { throw 'Desktop timeout did not force the exact process to exit.' }
  Write-Output 'PASS: Desktop exit timeout terminates only the original process identity'
} finally {
  if ($HolderProcess) { $HolderProcess.Refresh(); if (-not $HolderProcess.HasExited) { $HolderProcess.Kill(); $HolderProcess.WaitForExit() }; $HolderProcess.Dispose() }
  if ($SecondHolderProcess) { $SecondHolderProcess.Refresh(); if (-not $SecondHolderProcess.HasExited) { $SecondHolderProcess.Kill(); $SecondHolderProcess.WaitForExit() }; $SecondHolderProcess.Dispose() }
  if ($UnrelatedProcess) { $UnrelatedProcess.Refresh(); if (-not $UnrelatedProcess.HasExited) { $UnrelatedProcess.Kill(); $UnrelatedProcess.WaitForExit() }; $UnrelatedProcess.Dispose() }
  if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath | Write-Output }
  Remove-PortableDirectory $Root
}
$global:LASTEXITCODE=0
