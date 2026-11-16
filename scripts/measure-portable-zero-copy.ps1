[CmdletBinding()]
param([int]$FileCount=100000,[long]$UserBytes=1073741824,[string]$ReportPath='.pangea-build/verification/portable-zero-copy-benchmark.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Native Windows is required.'}
$Updater=Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'
$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $f.Extent.Text}
# A controlled baseline: the identical production patch function, with only the
# unchanged-file strategy replaced by the previous copy-then-verify algorithm.
$Current=(Get-Command Apply-VerifiedPatch).Definition
$LinkLine='$CopyOnly=$false'
if(-not $Current.Contains($LinkLine)){throw 'Benchmark baseline transformation no longer matches production.'}
$Legacy=$Current.Replace($LinkLine,'$CopyOnly=$true')
Set-Item Function:Apply-CopyBaseline ([scriptblock]::Create($Legacy))
Initialize-PortableFileIO
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:PortableIOWorker=$true;$script:UpdateForm=$null;$script:UpdaterScriptPath=[IO.Path]::GetFullPath($Updater)
function Set-UpdateStage {param($Message,$Percent,$Stage,$FilesCompleted,$FilesTotal)}
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-benchmark-'+[guid]::NewGuid())
$Base=Join-Path $Root 'installed';$Workspace=Join-Path $Root 'p-up-1';$Candidate=Join-Path $Workspace 'new';$Copy=Join-Path $Root 'copy-baseline'
$LogPath=Join-Path $Root 'benchmark.log'
$ExpectedBaseVersion='2.1.25';$ExpectedVersion='2.1.26';$Plan=@{package_channel='stable'}
$Report=[ordered]@{status='running';file_count=$FileCount;user_bytes=$UserBytes;os=[Environment]::OSVersion.ToString();powershell=$PSVersionTable.PSVersion.ToString();scope='Native NTFS fixture: production patch reconstruction, legacy data copy+five fingerprints, data migration, switch, recovery. Signature admission and Electron startup are separate tests.';timings_ms=[ordered]@{};handle_scans=0}
Set-Item Function:Get-BenchmarkOriginalHolders ([scriptblock]::Create((Get-Command Get-UpdateLockHolders).Definition))
Set-Item Function:Start-BenchmarkOriginalServer ([scriptblock]::Create((Get-Command Start-UpdateHandleServer).Definition))
$Report.handle_worker_starts=0
function Get-UpdateLockHolders {param([string]$Root,[int]$TimeoutMilliseconds=15000);$Report.handle_scans++;Get-BenchmarkOriginalHolders $Root $TimeoutMilliseconds}
function Start-UpdateHandleServer {$Report.handle_worker_starts++;Start-BenchmarkOriginalServer}
function Save-Checkpoint {[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath)))|Out-Null;[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath),($Report|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))}
function Timed([string]$Name,[scriptblock]$Action){$sw=[Diagnostics.Stopwatch]::StartNew();& $Action;$sw.Stop();$Report.timings_ms[$Name]=$sw.ElapsedMilliseconds;Save-Checkpoint;Write-Output ('TIMING '+$Name+'='+$sw.ElapsedMilliseconds+'ms')}
try {
  [IO.Directory]::CreateDirectory($Base)|Out-Null
  $Files=New-Object 'Collections.Generic.List[object]'
  $Bytes=[Text.Encoding]::UTF8.GetBytes(('package fixture content '+('x'*480)))
  $Sha=[Security.Cryptography.SHA256]::Create();try{$Hash=([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$Sha.Dispose()}
  Timed 'seed_package' {
    for($i=0;$i -lt $FileCount;$i++){
      $Relative=('resources/fixture/d{0:000}/f{1:000000}.js' -f [int][Math]::Floor($i/1000),$i)
      $Path=Join-Path $Base $Relative
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))|Out-Null
      [IO.File]::WriteAllBytes($Path,$Bytes)
      $Files.Add(@{path=$Relative;size=$Bytes.Length;sha256=$Hash})
    }
  }
  foreach($Name in @('launch-root','local-skills')){[IO.Directory]::CreateDirectory((Join-Path $Base $Name))|Out-Null}
  Timed 'seed_user_data' {
    $Stream=[IO.File]::Create((Join-Path $Base 'launch-root/repository.bin'))
    try{$Block=New-Object byte[] 1048576;for($i=0;$i -lt $Block.Length;$i++){$Block[$i]=[byte]($i%251)};$Left=$UserBytes;while($Left -gt 0){$Count=[int][Math]::Min($Left,$Block.Length);$Stream.Write($Block,0,$Count);$Left-=$Count};$Stream.Flush($true)}finally{$Stream.Dispose()}
    [IO.File]::WriteAllText((Join-Path $Base 'local-skills/keep.txt'),'private skill')
  }
  $Before=(Get-FileHash -LiteralPath (Join-Path $Base 'launch-root/repository.bin')).Hash
  $ArchiveRoot=Join-Path $Root 'archive';[IO.Directory]::CreateDirectory((Join-Path $ArchiveRoot 'target/resources/update'))|Out-Null
  [IO.File]::WriteAllText((Join-Path $Base 'resources/pangea-manifest.json'),'{"product":{"version":"2.1.25"}}')
  [IO.Directory]::CreateDirectory((Join-Path $ArchiveRoot 'payload/resources'))|Out-Null
  $Payload=Join-Path $ArchiveRoot 'payload/resources/pangea-manifest.json'
  [IO.File]::WriteAllText($Payload,'{"product":{"version":"2.1.26"}}')
  $Changed=@{path='resources/pangea-manifest.json';size=(Get-Item $Payload).Length;sha256=(Get-FileHash $Payload).Hash.ToLowerInvariant()};$Files.Add($Changed)
  $Utf8=New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText((Join-Path $ArchiveRoot 'pangea-patch-manifest.json'),(@{schema_version=1;product='PANGEA Desktop';from_version=$ExpectedBaseVersion;to_version=$ExpectedVersion;files=@($Changed)}|ConvertTo-Json -Depth 6 -Compress),$Utf8)
  [IO.File]::WriteAllText((Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json'),(@{version=$ExpectedVersion;channel='stable';files=$Files.ToArray()}|ConvertTo-Json -Depth 6 -Compress),$Utf8)
  [IO.File]::WriteAllText((Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json.sig'),'fixture-signature',$Utf8)
  $Archive=Join-Path $Root 'patch.zip';[IO.Compression.ZipFile]::CreateFromDirectory($ArchiveRoot,$Archive)
  Timed 'copy_patch' {Apply-CopyBaseline $Archive $Base $Copy}
  Timed 'copy_user_data_and_five_fingerprints' {
    $Snapshot=Copy-PortableUserData $Base $Copy
    # The prior implementation's three fingerprints in Copy plus two pre-switch scans.
    foreach($Name in @('launch-root','local-skills')){
      if([PangeaPortableTree]::Fingerprint((Join-Path $Base $Name)) -ne $Snapshot[$Name]){throw 'Baseline source mismatch'}
      if([PangeaPortableTree]::Fingerprint((Join-Path $Copy $Name)) -ne $Snapshot[$Name]){throw 'Baseline candidate mismatch'}
    }
  }
  Timed 'copy_candidate_cleanup' {Remove-PortableDirectory $Copy}
  Timed 'hardlink_patch' {Apply-VerifiedPatch $Archive $Base $Candidate}
  $Profile=Join-Path $Root 'profile';[IO.Directory]::CreateDirectory((Join-Path $Profile 'updates/one'))|Out-Null
  $Context=Get-PortableTransactionContext $Base;$Lock=Enter-PortableUpdateLock $Context
  try {
    $Tx=New-PortableUpdateTransaction $Context $Workspace (Get-PortableRootIdentity $Base) $ExpectedVersion (Join-Path $Profile 'updates/one/plan.json') $Profile
    $Tx.target_identity=Get-PortableRootIdentity $Candidate;Set-PortableTransactionState $Context $Tx 'candidate_ready'
    Timed 'zero_copy_data' {Initialize-PortableDataMigration $Context|Out-Null;Resume-PortableDataMigration $Context $Base;Mount-PortableData $Context $Candidate}
    Timed 'switch' {
      Set-PortableTransactionState $Context $Tx 'original_move_pending'
      Move-UpdateDirectory $Base (Join-Path $Workspace 'old')
      Set-PortableTransactionState $Context $Tx 'original_moved'
      Set-PortableTransactionState $Context $Tx 'activate_pending'
      Move-UpdateDirectory $Candidate $Base
      Set-PortableTransactionState $Context $Tx 'activated'
    }
    [IO.File]::WriteAllText((Join-Path $Base 'launch-root/post-activation.txt'),'retained on rollback')
    Timed 'rollback' {Restore-PortableUpdateTransaction $Context $Tx $Profile|Out-Null}
    Write-Output 'VERIFY: restored program identity'
    if((Get-PortableRootIdentity $Base).version -ne $ExpectedBaseVersion){throw 'Rollback version mismatch'}
    Write-Output 'VERIFY: retained 1 GiB bytes through managed data junction'
    [PangeaPortableFileIO]::Verify((Join-Path $Base 'launch-root/repository.bin'),$UserBytes,$Before.ToLowerInvariant(),'repository.bin')
    Write-Output 'VERIFY: retained bytes confirmed'
    if([IO.File]::ReadAllText((Join-Path $Base 'launch-root/post-activation.txt')) -ne 'retained on rollback'){throw 'Rollback lost new edit'}
    $Receipt=Read-PortableDataReceipt $Context;$Data=Get-PortableDataContext $Context
    foreach($Entry in $Receipt.entries){if([PangeaPortableFileIO]::DirectoryIdentity((Join-Path $Data.Root $Entry.name),$false) -ne $Entry.identity){throw 'Data directory identity changed'}}
  } finally {$Lock.Dispose()}
  Write-Output 'VERIFY: migration receipt identities confirmed'
  $Report.copy_total_ms=$Report.timings_ms.copy_patch+$Report.timings_ms.copy_user_data_and_five_fingerprints
  $Report.zero_copy_total_ms=$Report.timings_ms.hardlink_patch+$Report.timings_ms.zero_copy_data+$Report.timings_ms.switch
  $Report.target_under_60_seconds=($Report.zero_copy_total_ms -lt 60000)
  # PS 5.1 Get-Content strings carry provider/drive metadata. Persist only
  # numeric counters, never recursively serialize those provider objects.
  $Report.patch_counts=@(foreach($Line in [IO.File]::ReadAllLines($LogPath)) {
    if($Line -match 'patch reconstruction: linked=(\d+); copied=(\d+); payload=(\d+)') {
      @{linked=[int]$Matches[1];copied=[int]$Matches[2];payload=[int]$Matches[3]}
    }
  })
  if(-not @($Report.patch_counts|Where-Object {$_.linked -eq $FileCount -and $_.copied -eq 0 -and $_.payload -eq 1}).Count){throw 'Native fixture did not hardlink every unchanged file'}
  $Report.status='passed'
} catch {$Report.status='failed';$Report.error=$_.Exception.Message;throw}
finally {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath)))|Out-Null
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath),($Report|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
  Write-Output ($Report|ConvertTo-Json -Depth 10)
  Stop-UpdateHandleServer
  if([IO.Directory]::Exists($Root)){Remove-PortableDirectory $Root}
}
$global:LASTEXITCODE=0
