# Production supervisor/IO-worker/launch/health/rollback integration. The UI
# monitor is substituted because CI has no interactive desktop. The executable
# is a native health fixture, not Electron; signature admission has separate tests.
[CmdletBinding()]
param([int]$FileCount=0,[long]$UserBytes=0,[string]$ReportPath='.pangea-build/verification/portable-zero-copy-lifecycle.json')
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
$Source=Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-lifecycle-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Root)|Out-Null
$Utf8=New-Object Text.UTF8Encoding($true)
$Text=[IO.File]::ReadAllText($Source);$t=$null;$e=$null
$a=[Management.Automation.Language.Parser]::ParseInput($Text,[ref]$t,[ref]$e)
$Ui=@($a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-UpdateWindow'},$true))
if($e.Count -or $Ui.Count -ne 1){throw 'Cannot locate production UI boundary'}
$Replacement='function Open-UpdateWindow { $script:UpdateMonitor=[Diagnostics.Process]::GetCurrentProcess() }'
$Text=$Text.Remove($Ui[0].Extent.StartOffset,$Ui[0].Extent.EndOffset-$Ui[0].Extent.StartOffset).Insert($Ui[0].Extent.StartOffset,$Replacement)
$Helper=Join-Path $Root 'updater-fixture.ps1';[IO.File]::WriteAllText($Helper,$Text,$Utf8)
foreach($f in $a.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $f.Extent.Text}
$script:PortableIOWorker=$true;$script:UpdateForm=$null
$Exe=Join-Path $Root 'fixture.exe'
Add-Type -OutputAssembly $Exe -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Text.RegularExpressions;
public class DesktopFixture {
  public static int Main(string[] args) {
    string root=AppDomain.CurrentDomain.BaseDirectory;
    string text=File.ReadAllText(Path.Combine(root,"resources/pangea-manifest.json"));
    string version=Regex.Match(text,"[0-9]+\\.[0-9]+\\.[0-9]+").Value;
    if(version=="3.0.7") File.WriteAllText(Path.Combine(root,"launch-root/new-edit.txt"),"new version data");
    if(text.Contains("fail_start")) return 23;
    foreach(string arg in args) if(arg.StartsWith("--pangea-update-health=")) {
      string path=arg.Substring("--pangea-update-health=".Length);
      File.WriteAllText(path,"{\"schema_version\":1,\"pid\":"+Process.GetCurrentProcess().Id+",\"version\":\""+version+"\",\"healthy_at\":\""+DateTime.UtcNow.ToString("o")+"\"}");
    }
    Thread.Sleep(1200000);return 0;
  }
}
'@
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Checks=[Collections.Generic.List[string]]::new()
$Report=@{status='running';checks=$Checks;extra_package_files=$FileCount;user_payload_bytes=$UserBytes;supervisor_ms=@{};scope='Production main supervisor with UI monitor substitution; real native fixture executable and real worker processes, health and rollback. No Electron business acceptance.'}
function Json([string]$Path,$Value){[IO.File]::WriteAllText($Path,($Value|ConvertTo-Json -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))}
function Entry([string]$Base,[string]$Relative){$p=Join-Path $Base $Relative;return @{path=$Relative;size=(Get-Item -LiteralPath $p).Length;sha256=(Get-FileHash -LiteralPath $p).Hash.ToLowerInvariant()}}
try {
  $Modes=if($FileCount -gt 0){@('healthy')}else{@('healthy','failed-start')}
  foreach($Mode in $Modes) {
    $Case=Join-Path $Root $Mode;$Install=Join-Path $Case 'installed [native]';$ArchiveRoot=Join-Path $Case 'archive'
    $Updates=Join-Path $Case 'profile/updates';$Run=Join-Path $Updates 'one';$PlanPath=Join-Path $Run 'plan.json'
    foreach($Dir in @('resources/update','launch-root','local-skills')){[IO.Directory]::CreateDirectory((Join-Path $Install $Dir))|Out-Null}
    [IO.Directory]::CreateDirectory($Run)|Out-Null
    [IO.File]::Copy($Exe,(Join-Path $Install 'PANGEA Desktop.exe'))
    [IO.File]::WriteAllText((Join-Path $Install 'same.txt'),'same signed package bytes')
    [IO.File]::WriteAllText((Join-Path $Install 'launch-root/keep.txt'),'user data')
    [IO.File]::WriteAllText((Join-Path $Install 'local-skills/keep.txt'),'private skill')
    Json (Join-Path $Install 'resources/pangea-manifest.json') @{product=@{version='3.0.6'}}
    $Files=@((Entry $Install 'PANGEA Desktop.exe'),(Entry $Install 'same.txt'),(Entry $Install 'resources/pangea-manifest.json'))
    if($FileCount -gt 0) {
      $Inventory=[Collections.Generic.List[object]]::new();foreach($File in $Files){$Inventory.Add($File)}
      $Bytes=[Text.Encoding]::UTF8.GetBytes(('fixture'+('x'*505)));$Sha=[Security.Cryptography.SHA256]::Create();try{$Hash=([BitConverter]::ToString($Sha.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant()}finally{$Sha.Dispose()}
      for($i=0;$i -lt $FileCount;$i++){
        $Relative=('resources/fixture/d{0:000}/f{1:000000}.js' -f [int][Math]::Floor($i/1000),$i);$Path=Join-Path $Install $Relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))|Out-Null;[IO.File]::WriteAllBytes($Path,$Bytes)
        $Inventory.Add(@{path=$Relative;size=$Bytes.Length;sha256=$Hash})
      }
      $Files=$Inventory.ToArray()
    }
    if($UserBytes -gt 0) {
      $Stream=[IO.File]::Create((Join-Path $Install 'launch-root/repository.bin'))
      try{$Block=New-Object byte[] 1048576;$Block[0]=19;$Left=$UserBytes;while($Left -gt 0){$Count=[int][Math]::Min($Left,$Block.Length);$Stream.Write($Block,0,$Count);$Left-=$Count};$Stream.Flush($true)}finally{$Stream.Dispose()}
      $DataHash=(Get-FileHash -LiteralPath (Join-Path $Install 'launch-root/repository.bin')).Hash
    }
    Json (Join-Path $Install 'resources/update/pangea-package-manifest.json') @{version='3.0.6';channel='stable';files=$Files}
    [IO.File]::WriteAllText((Join-Path $Install 'resources/update/pangea-package-manifest.json.sig'),'fixture-signature')
    [IO.Directory]::CreateDirectory((Join-Path $ArchiveRoot 'payload/resources'))|Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $ArchiveRoot 'target/resources/update'))|Out-Null
    $Product=@{product=@{version='3.0.7'}};if($Mode -eq 'failed-start'){$Product.fail_start=$true}
    Json (Join-Path $ArchiveRoot 'payload/resources/pangea-manifest.json') $Product
    $Changed=Entry (Join-Path $ArchiveRoot 'payload') 'resources/pangea-manifest.json'
    Json (Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json') @{version='3.0.7';channel='stable';files=(@($Files|Where-Object {$_.path -ne 'resources/pangea-manifest.json'})+@($Changed))}
    [IO.File]::WriteAllText((Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json.sig'),'fixture-signature')
    Json (Join-Path $ArchiveRoot 'pangea-patch-manifest.json') @{schema_version=1;product='PANGEA Desktop';from_version='3.0.6';to_version='3.0.7';files=@($Changed)}
    $Archive=Join-Path $Run 'patch.zip';[IO.Compression.ZipFile]::CreateFromDirectory($ArchiveRoot,$Archive)
    $Plan=@{schema_version=2;install_root=$Install;package_path=$Archive;executable_name='PANGEA Desktop.exe';expected_version='3.0.7';expected_base_version='3.0.6';package_type='patch';package_channel='stable';expected_size=(Get-Item $Archive).Length;expected_sha256=(Get-FileHash $Archive).Hash.ToLowerInvariant();health_marker=(Join-Path $Run 'healthy.json');result_path=(Join-Path $Updates 'last-update-result.json');log_path=(Join-Path $Run 'update.log');parent_pid=0;startup_health_timeout_seconds=30;allow_owned_process_cleanup=$false}
    Json $PlanPath $Plan
    $Info=New-Object Diagnostics.ProcessStartInfo;$Info.FileName=Join-Path $PSHOME 'powershell.exe';$Info.Arguments='-NoProfile -ExecutionPolicy Bypass -File "'+$Helper+'" -PlanPath "'+$PlanPath+'"';$Info.UseShellExecute=$false;$Info.RedirectStandardError=$true
    $Timer=[Diagnostics.Stopwatch]::StartNew()
    $Process=[Diagnostics.Process]::Start($Info);$Errors=$Process.StandardError.ReadToEndAsync()
    try {
      if(-not $Process.WaitForExit(900000)){throw 'Lifecycle supervisor timed out'}
      $Timer.Stop();$Report.supervisor_ms[$Mode]=$Timer.ElapsedMilliseconds;Write-Output ('SUPERVISOR '+$Mode+'='+$Timer.ElapsedMilliseconds+'ms')
      if(-not [IO.File]::Exists($Plan.result_path)){throw ('No supervisor result: '+$Errors.Result)}
      $Result=[IO.File]::ReadAllText($Plan.result_path)|ConvertFrom-Json
      $ExpectedStatus=if($Mode -eq 'healthy'){'success'}else{'failed'};$ExpectedVersion=if($Mode -eq 'healthy'){'3.0.7'}else{'3.0.6'}
      if($Result.status -ne $ExpectedStatus -or ($Mode -eq 'failed-start' -and $Result.rollback -ne 'restored')){throw ($Result|ConvertTo-Json -Compress)}
      if((Get-PortableRootIdentity $Install).version -ne $ExpectedVersion){throw 'Supervisor selected wrong version'}
      foreach($Pair in @(@('launch-root/keep.txt','user data'),@('local-skills/keep.txt','private skill'),@('launch-root/new-edit.txt','new version data'))){if([IO.File]::ReadAllText((Join-Path $Install $Pair[0])) -ne $Pair[1]){throw 'Supervisor lost user bytes'}}
      $Health=if($Mode -eq 'healthy'){$Plan.health_marker}else{"$PlanPath.rollback-healthy.json"}
      if(-not [IO.File]::Exists($Health)){throw 'Expected healthy native process was not observed'}
      if($UserBytes -gt 0){Initialize-PortableFileIO;[PangeaPortableFileIO]::Verify((Join-Path $Install 'launch-root/repository.bin'),$UserBytes,$DataHash.ToLowerInvariant(),'repository.bin')}
      $Context=Get-PortableTransactionContext $Install;$Receipt=Read-PortableDataReceipt $Context
      if(-not $Receipt){throw 'Supervisor omitted durable data receipt'}
      $Message="main supervisor ${Mode}: real patch workers, native launch, health, program version and new user edits verified"
      $Checks.Add($Message);Write-Output "PASS: $Message"
    } finally {
      if(-not $Process.HasExited){$Process.Kill();$Process.WaitForExit(5000)|Out-Null};$Process.Dispose()
      foreach($Child in @(Get-Process | Where-Object {try{$_.Path -ieq (Join-Path $Install 'PANGEA Desktop.exe')}catch{$false}})){
        try{$null=$Child.Handle;$Child.Kill();if(-not $Child.WaitForExit(5000)){throw 'Native fixture did not exit'}}finally{$Child.Dispose()}
      }
      if([IO.File]::Exists($Plan.log_path)){Get-Content -LiteralPath $Plan.log_path|Write-Output}
    }
  }
  $Report.status='passed'
} catch {$Report.status='failed';$Report.error=$_.Exception.Message;throw}
finally {
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath)))|Out-Null
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath),($Report|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
  Remove-PortableDirectory $Root
}
$global:LASTEXITCODE=0
