[CmdletBinding()]
param([string]$ChildRoot,[string]$CrashPoint,[switch]$Benchmark,[string]$ReportPath)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Updater=Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'
$t=$null;$e=$null
$a=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $f.Extent.Text}
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Native Windows is required for zero-copy acceptance.'}
Initialize-PortableFileIO
$script:PortableIOWorker=$true
$script:UpdateForm=$null
function Set-UpdateStage { param($Message,$Percent,$Stage,$FilesCompleted,$FilesTotal) }
function Version([string]$Root,[string]$Number) {
  [IO.Directory]::CreateDirectory((Join-Path $Root 'resources'))|Out-Null
  [IO.File]::WriteAllText((Join-Path $Root 'resources/pangea-manifest.json'),(@{product=@{version=$Number}}|ConvertTo-Json -Compress))
}
function Fixture([string]$Root) {
  $Install=Join-Path $Root 'installed [test]'; $Workspace=Join-Path $Root 'p-up-1';$Profile=Join-Path $Root 'profile'
  [IO.Directory]::CreateDirectory((Join-Path $Profile 'updates/one'))|Out-Null
  Version $Install '2.1.25';Version (Join-Path $Workspace 'new') '2.1.26'
  foreach($Name in @('launch-root','local-skills')) {
    [IO.Directory]::CreateDirectory((Join-Path $Install $Name))|Out-Null
    [IO.File]::WriteAllText((Join-Path (Join-Path $Install $Name) 'keep.txt'),$Name)
  }
  $Context=Get-PortableTransactionContext $Install
  $Transaction=New-PortableUpdateTransaction $Context $Workspace (Get-PortableRootIdentity $Install) '2.1.26' (Join-Path $Profile 'updates/one/plan.json') $Profile
  $Transaction.target_identity=Get-PortableRootIdentity (Join-Path $Workspace 'new')
  Set-PortableTransactionState $Context $Transaction 'candidate_ready'
  return [pscustomobject]@{Install=$Install;Workspace=$Workspace;Profile=$Profile;Context=$Context;Transaction=$Transaction;Data=(Get-PortableDataContext $Context)}
}
function ReadyToKill([string]$Root) {
  [IO.File]::WriteAllText((Join-Path $Root 'ready'),'ready')
  while($true){Start-Sleep -Milliseconds 50}
}
if($ChildRoot) {
  $LogPath=Join-Path $ChildRoot 'child.log'
  $f=Fixture $ChildRoot
  $Lock=Enter-PortableUpdateLock $f.Context
  $receipt=Initialize-PortableDataMigration $f.Context
  if($CrashPoint -eq 'intent'){ReadyToKill $ChildRoot}
  if($CrashPoint -in @('first_move','temporary_link')) {
    [PangeaPortableFileIO]::EnsureDirectory($f.Data.Root)
    $target=Join-Path $f.Data.Root 'launch-root'
    [PangeaPortableFileIO]::MoveDirectory((Join-Path $f.Install 'launch-root'),$target)
    if($CrashPoint -eq 'temporary_link'){[PangeaPortableFileIO]::NewJunction((Join-Path $f.Install '.pangea-link-interrupted'),$target)}
    ReadyToKill $ChildRoot
  }
  Resume-PortableDataMigration $f.Context $f.Install
  if($CrashPoint -eq 'migrated'){ReadyToKill $ChildRoot}
  Mount-PortableData $f.Context (Join-Path $f.Workspace 'new')
  if($CrashPoint -eq 'mounted'){ReadyToKill $ChildRoot}
  Set-PortableTransactionState $f.Context $f.Transaction 'original_move_pending'
  [PangeaPortableFileIO]::MoveDirectory($f.Install,(Join-Path $f.Workspace 'old'))
  if($CrashPoint -eq 'original_rename'){ReadyToKill $ChildRoot}
  Set-PortableTransactionState $f.Context $f.Transaction 'activate_pending'
  [PangeaPortableFileIO]::MoveDirectory((Join-Path $f.Workspace 'new'),$f.Install)
  if($CrashPoint -eq 'activate_rename'){ReadyToKill $ChildRoot}
  Set-PortableTransactionState $f.Context $f.Transaction 'activated'
  [IO.File]::WriteAllText((Join-Path $f.Install 'launch-root/new-edit.txt'),'new-version edit')
  if($CrashPoint -eq 'committed'){Set-PortableTransactionState $f.Context $f.Transaction 'committed'}
  ReadyToKill $ChildRoot
}
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-zero-copy-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Root)|Out-Null
$LogPath=Join-Path $Root 'verify.log'
$Checks=[Collections.Generic.List[string]]::new()
$Results=@{schema_version=1;status='running';platform=[Environment]::OSVersion.ToString();powershell=$PSVersionTable.PSVersion.ToString();checks=$Checks}
function Pass([string]$Text){$Checks.Add($Text);Write-Output "PASS: $Text"}
try {
  foreach($Point in @('intent','first_move','temporary_link','migrated','mounted','original_rename','activate_rename','activated_write','committed')) {
    $Case=Join-Path $Root $Point;[IO.Directory]::CreateDirectory($Case)|Out-Null
    $Info=New-Object Diagnostics.ProcessStartInfo
    $Info.FileName=Join-Path $PSHOME 'powershell.exe'
    $Info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -ChildRoot "'+$Case+'" -CrashPoint '+$Point
    $Info.UseShellExecute=$false;$Info.RedirectStandardError=$true
    $Child=[Diagnostics.Process]::Start($Info);$Errors=$Child.StandardError.ReadToEndAsync()
    try {
      $Deadline=[DateTime]::UtcNow.AddSeconds(30)
      while(-not [IO.File]::Exists((Join-Path $Case 'ready'))){
        if($Child.HasExited){throw "Crash fixture exited: $($Errors.Result)"}
        if([DateTime]::UtcNow -ge $Deadline){throw 'Crash fixture timeout'}
        Start-Sleep -Milliseconds 50
      }
      $Child.Kill();if(-not $Child.WaitForExit(5000)){throw 'Fixture process did not exit'}
    } finally {if(-not $Child.HasExited){$Child.Kill();$Child.WaitForExit()};$Child.Dispose()}
    $Install=Join-Path $Case 'installed [test]';$Context=Get-PortableTransactionContext $Install;$Profile=Join-Path $Case 'profile'
    $Lock=Enter-PortableUpdateLock $Context
    try {
      $Tx=Read-PortableUpdateTransaction $Context $Profile
      $Tx=Restore-PortableUpdateTransaction $Context $Tx $Profile
      foreach($Name in @('launch-root','local-skills')) {
        if([IO.File]::ReadAllText((Join-Path (Join-Path $Install $Name) 'keep.txt')) -cne $Name){throw 'User data lost after crash recovery'}
      }
      if($Point -in @('activated_write','committed') -and [IO.File]::ReadAllText((Join-Path $Install 'launch-root/new-edit.txt')) -ne 'new-version edit'){throw 'Rollback discarded new user edits'}
      $Expected=if($Point -eq 'committed'){'2.1.26'}else{'2.1.25'}
      if((Get-PortableRootIdentity $Install).version -ne $Expected){throw 'Wrong program version after recovery'}
      $Data=Get-PortableDataContext $Context
      $Receipt=Read-PortableDataReceipt $Context
      foreach($Entry in $Receipt.entries){
        if([PangeaPortableFileIO]::DirectoryIdentity((Join-Path $Data.Root $Entry.name),$false) -ne $Entry.identity){throw 'Directory was copied or replaced instead of moved'}
      }
      # Idempotence and a later upgrade reuse the same externally owned data.
      Resume-PortableDataMigration $Context $Install
      $Second=Join-Path $Case 'second-version';Version $Second '2.1.27';Mount-PortableData $Context $Second
      Remove-PortableDirectory $Second
      if(-not [IO.File]::Exists((Join-Path $Data.Root 'launch-root/keep.txt'))){throw 'Candidate cleanup followed data junction'}
      Pass "real crash at $Point restores program and identical data directories; cleanup retains external data"
    } finally {$Lock.Dispose()}
  }
  # Both locations occupied is ambiguous: never overwrite the user's new path.
  $f=Fixture (Join-Path $Root 'conflict');$receipt=Initialize-PortableDataMigration $f.Context
  [PangeaPortableFileIO]::EnsureDirectory($f.Data.Root)
  [PangeaPortableFileIO]::MoveDirectory((Join-Path $f.Install 'launch-root'),(Join-Path $f.Data.Root 'launch-root'))
  [IO.Directory]::CreateDirectory((Join-Path $f.Install 'launch-root'))|Out-Null
  [IO.File]::WriteAllText((Join-Path $f.Install 'launch-root/concurrent.txt'),'keep conflict')
  $Rejected=$false;try{Resume-PortableDataMigration $f.Context $f.Install}catch{$Rejected=$true}
  if(-not $Rejected -or [IO.File]::ReadAllText((Join-Path $f.Install 'launch-root/concurrent.txt')) -ne 'keep conflict' -or -not [IO.File]::Exists((Join-Path $f.Data.Root 'launch-root/keep.txt'))){throw 'Migration overwrote a conflicting directory'}
  Pass 'conflicting source and target remain untouched for explicit recovery'
  # Hard-link reuse: verify first, reject overwrite and changed bytes.
  $Base=Join-Path $Root 'links/base';$New=Join-Path $Root 'links/new'
  [IO.Directory]::CreateDirectory($Base)|Out-Null;[IO.Directory]::CreateDirectory($New)|Out-Null
  $Source=Join-Path $Base 'same.txt';$Target=Join-Path $New 'same.txt';[IO.File]::WriteAllText($Source,'signed bytes')
  $Hash=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant();$Size=(Get-Item -LiteralPath $Source).Length
  if(-not [PangeaPortableFileIO]::ReuseVerified($Source,$Target,$Size,$Hash,'same.txt')){throw 'Same-volume NTFS file was not hard-linked'}
  foreach($Operation in @('open','copy','reuse')){
    $Rejected=$false
    try{switch($Operation){'open'{$Stream=[PangeaPortableFileIO]::Open($Target,$true);$Stream.Dispose()};'copy'{[PangeaPortableFileIO]::Copy($Source,$Target)};'reuse'{[PangeaPortableFileIO]::ReuseVerified($Source,$Target,$Size,$Hash,'same.txt')|Out-Null}}}catch{$Rejected=$true}
    if(-not $Rejected -or (Get-FileHash -LiteralPath $Source).Hash.ToLowerInvariant() -ne $Hash){throw 'Updater overwrote a linked baseline'}
  }
  $Rejected=$false;try{[PangeaPortableFileIO]::ReuseVerified($Source,(Join-Path $New 'bad.txt'),$Size,('0'*64),'bad.txt')|Out-Null}catch{$Rejected=$true}
  if(-not $Rejected -or [IO.File]::Exists((Join-Path $New 'bad.txt'))){throw 'Corrupt baseline linked before verification'}
  Remove-PortableDirectory $New
  if((Get-FileHash -LiteralPath $Source).Hash.ToLowerInvariant() -ne $Hash){throw 'Candidate cleanup damaged baseline'}
  Pass 'same-volume hard links verify bytes first; all updater overwrite paths reject shared targets'
  $Results.status='passed'
} catch {$Results.status='failed';$Results.error=$_.Exception.Message;throw}
finally {
  if($ReportPath){$Parent=Split-Path -Parent $ReportPath;if($Parent){[IO.Directory]::CreateDirectory($Parent)|Out-Null};[IO.File]::WriteAllText($ReportPath,($Results|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))}
  Stop-UpdateHandleServer
  Remove-PortableDirectory $Root
}
$global:LASTEXITCODE=0
