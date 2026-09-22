$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Updater=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'))
$Tokens=$null; $Errors=$null
$Ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
$Definitions=@($Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true))
foreach ($Function in $Definitions) { Invoke-Expression $Function.Extent.Text }
$Session=[Diagnostics.Process]::GetCurrentProcess().SessionId
$Fake=[pscustomobject]@{Id=99999;Created=1;Name='explorer';Executable="$env:SystemRoot\explorer.exe";SameUser=$true;Critical=$false;Session=$Session}
if ((Get-UpdateHolderPolicy $Fake @() @() @($Fake.Id)) -ne 'explorer') { throw 'Current-user Explorer exception was not recognized.' }
$Fake.Session++
if ((Get-UpdateHolderPolicy $Fake @() @() @()) -ne 'protected') { throw 'Other-session Explorer must be protected.' }
$Fake.Session=$Session; $Fake.SameUser=$false
if ((Get-UpdateHolderPolicy $Fake @() @() @()) -ne 'protected') { throw 'Other-user Explorer must be protected.' }
$Fake.SameUser=$true; $Fake.Executable='C:\not-system\explorer.exe'
if ((Get-UpdateHolderPolicy $Fake @() @() @()) -ne 'protected') { throw 'An unrelated executable named explorer must be protected.' }
Write-Output 'PASS: Explorer exception is restricted to Windows executable, current user and session'
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-explorer-guard-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$LogPath=Join-Path $Root 'update.log'
# Exercise automatic Explorer handling without touching the runner's shell.
# The second scan reports that closing its folder window released the handle.
$script:AutomaticUpdateCleanup=$true
$script:OwnedUpdateProcesses=@()
$script:ProtectedUpdateProcesses=@($PID)
$script:ScanCalls=0; $script:RecoveryStarted=$false; $script:FoldersClosed=$false
$Fake.Executable=Join-Path $env:SystemRoot 'explorer.exe'
function Get-UpdateLockHolders { param($Root) $script:ScanCalls++; if ($script:ScanCalls -eq 1) { return @($Fake) }; return @() }
function Confirm-ExplorerRestart { throw 'Automatic cleanup must not ask for Explorer confirmation.' }
function Start-ExplorerRecovery { $script:RecoveryStarted=$true }
function Close-InstallationExplorerWindows { param($Root) $script:FoldersClosed=$true }
Resolve-UpdateDirectoryLocks $Root
if (-not $script:RecoveryStarted -or -not $script:FoldersClosed -or $script:ScanCalls -ne 2) { throw 'Automatic Explorer cleanup did not guard recovery and recheck handles.' }
Write-Output 'PASS: automatic Explorer cleanup starts recovery and rechecks handles without a confirmation dialog'
$WorkerPath=Join-Path $Root 'guard-fixture.ps1'
$WatchDefinition=($Definitions | Where-Object { $_.Name -eq 'Watch-ExplorerRecovery' }).Extent.Text
# Use the real watchdog in an independent process, substituting only the shell
# launch with a marker. Do not kill or restart the CI runner's desktop shell.
$Fixture='param([string]$WatchFile)' + "`n" + '$ErrorActionPreference="Stop"' + "`n" + $WatchDefinition + "`n" + 'function Restore-ExplorerShell { [IO.File]::WriteAllText("$WatchFile.fixture-restored", "restored") }' + "`n" + 'Watch-ExplorerRecovery $WatchFile'
[IO.File]::WriteAllText($WorkerPath,$Fixture)
$Supervisor=$null; $Guard=$null
try {
  foreach ($Mode in @('complete','crash','cancel','reused-pid')) {
    $Supervisor=Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 90') -WindowStyle Hidden -PassThru
    $null=$Supervisor.Handle
    $WatchFile=Join-Path $Root "$Mode.json"
    $Created=$Supervisor.StartTime.ToUniversalTime().ToFileTimeUtc()
    if ($Mode -eq 'reused-pid') { $Created++ }
    @{supervisor_pid=$Supervisor.Id;supervisor_created=$Created;session=$Session} | ConvertTo-Json | Set-Content -LiteralPath $WatchFile -Encoding UTF8
    if ($Mode -ne 'cancel') { [IO.File]::WriteAllText("$WatchFile.armed",'armed') }
    $Args='-NoProfile -ExecutionPolicy Bypass -File "' + $WorkerPath + '" -WatchFile "' + $WatchFile + '"'
    $Guard=Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $Args -WindowStyle Hidden -PassThru
    $null=$Guard.Handle
    $Deadline=(Get-Date).AddSeconds(10)
    while (-not (Test-Path -LiteralPath "$WatchFile.ready")) {
      if ((Get-Date) -gt $Deadline) { throw 'Recovery guard handshake failed.' }
      Start-Sleep -Milliseconds 100
    }
    if ($Mode -eq 'crash') { $Supervisor.Kill(); $Supervisor.WaitForExit() }
    elseif ($Mode -ne 'reused-pid') { [IO.File]::WriteAllText("$WatchFile.done",'done') }
    if (-not $Guard.WaitForExit(10000) -or $Guard.ExitCode -ne 0) { throw "Guard failed: $Mode" }
    $Recovered=Test-Path -LiteralPath "$WatchFile.fixture-restored"
    if ($Recovered -ne ($Mode -ne 'cancel')) { throw "Unexpected recovery: $Mode" }
    if ($Mode -eq 'reused-pid') { $Supervisor.Refresh(); if ($Supervisor.HasExited) { throw 'Watchdog interfered with reused PID.' } }
    Write-Output "PASS: independent recovery guard handles $Mode"
    $Guard.Dispose(); $Guard=$null
    $Supervisor.Refresh(); if (-not $Supervisor.HasExited) { $Supervisor.Kill(); $Supervisor.WaitForExit() }; $Supervisor.Dispose(); $Supervisor=$null
  }
} finally {
  foreach ($Process in @($Supervisor,$Guard)) { if ($Process) { $Process.Refresh(); if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() }; $Process.Dispose() } }
  Remove-PortableDirectory $Root
}
$global:LASTEXITCODE=0
