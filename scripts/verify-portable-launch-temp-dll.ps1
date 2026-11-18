[CmdletBinding()]
param([string]$ReportPath='.pangea-build/verification/portable-launch-temp-dll.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Native Windows PowerShell 5.1 is required.' }
$Root=Join-Path ([IO.Path]::GetTempPath()) ('pangea-dll-observation-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($Root)|Out-Null
$Shell=Join-Path $PSHOME 'powershell.exe'
$Regression=Join-Path $PSScriptRoot 'verify-portable-rollback-start.ps1'
$Fixture=Join-Path $Root 'desktop-fixture.exe'
$Report=[ordered]@{status='running';powershell=$PSVersionTable.PSVersion.ToString();scope='Desktop launch and rollback-launch health regression in fresh PS 5.1 with isolated TEMP/TMP; fixture compiled before observation. Not a global updater/GUI/antivirus trace.';observations=@()}
function Observe([string]$Name,[string]$Arguments) {
  $Temp=Join-Path $Root $Name
  [IO.Directory]::CreateDirectory($Temp)|Out-Null
  $Watcher=New-Object IO.FileSystemWatcher
  $Watcher.Path=$Temp; $Watcher.Filter='*.dll'; $Watcher.IncludeSubdirectories=$true
  $Watcher.NotifyFilter=[IO.NotifyFilters]::FileName
  $Watcher.InternalBufferSize=65536
  $Ids=@(); $Process=$null
  try {
    foreach ($EventName in @('Created','Renamed','Error')) {
      $Id='pangea-dll-'+[guid]::NewGuid().ToString('N');$Ids+= $Id
      Register-ObjectEvent -InputObject $Watcher -EventName $EventName -SourceIdentifier $Id | Out-Null
    }
    $Watcher.EnableRaisingEvents=$true
    $Info=New-Object Diagnostics.ProcessStartInfo
    $Info.FileName=$Shell; $Info.Arguments=$Arguments; $Info.UseShellExecute=$false
    $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
    $Info.EnvironmentVariables['TEMP']=$Temp; $Info.EnvironmentVariables['TMP']=$Temp
    $Process=[Diagnostics.Process]::Start($Info)
    $Stdout=$Process.StandardOutput.ReadToEndAsync(); $Stderr=$Process.StandardError.ReadToEndAsync()
    if (-not $Process.WaitForExit(180000)) { throw "Observed child timed out: $Name" }
    Start-Sleep -Milliseconds 500
    $Events=@(foreach($Id in $Ids) { Get-Event -SourceIdentifier $Id -ErrorAction SilentlyContinue })
    $Errors=@($Events | Where-Object { $_.SourceEventArgs -is [IO.ErrorEventArgs] })
    $DllEvents=@($Events | Where-Object { $_.SourceEventArgs -is [IO.FileSystemEventArgs] } | ForEach-Object {
      @{type=$_.SourceEventArgs.ChangeType.ToString();path=$_.SourceEventArgs.FullPath.Substring($Temp.Length+1)}
    })
    $Record=@{name=$Name;pid=$Process.Id;exit_code=$Process.ExitCode;dll_events=$DllEvents;watcher_errors=@($Errors|ForEach-Object {$_.SourceEventArgs.GetException().Message});remaining_dlls=@(Get-ChildItem -LiteralPath $Temp -Filter '*.dll' -Recurse -File | ForEach-Object {$_.FullName.Substring($Temp.Length+1)});stdout=$Stdout.Result;stderr=$Stderr.Result}
    $Report.observations+= $Record
    Write-Host $Stdout.Result
    if ($Errors.Count) { throw 'DLL watcher overflow/error: observation is invalid.' }
    if ($Process.ExitCode -ne 0) { throw ("Observed child failed: "+$Stderr.Result) }
    return $Record
  } finally {
    $Watcher.EnableRaisingEvents=$false
    foreach ($Id in $Ids) {
      Unregister-Event -SourceIdentifier $Id -ErrorAction SilentlyContinue
      Get-Event -SourceIdentifier $Id -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
    }
    $Watcher.Dispose()
    if ($Process) { if(-not $Process.HasExited){$Process.Kill();$Process.WaitForExit()};$Process.Dispose() }
  }
}
try {
  & $Shell -NoProfile -ExecutionPolicy Bypass -File $Regression -CompileFixtureTo $Fixture
  if ($LASTEXITCODE -ne 0) { throw 'Could not precompile native launch fixture.' }
  $Control=Join-Path $Root 'control.ps1'
  [IO.File]::WriteAllText($Control,'$ErrorActionPreference="Stop"; Add-Type -TypeDefinition "public static class DllObservationControl { public static int Value=1; }"; $p=Join-Path $env:TEMP "transient-control.dll"; [IO.File]::WriteAllBytes($p,[byte[]](1,2,3)); [IO.File]::Delete($p)',(New-Object Text.UTF8Encoding($true)))
  $Positive=Observe 'compiler-control' ('-NoProfile -ExecutionPolicy Bypass -File "'+$Control+'"')
  if (-not @($Positive.dll_events | Where-Object {$_.path -eq 'transient-control.dll'}).Count) { throw 'Transient DLL positive control was missed.' }
  if (-not @($Positive.dll_events | Where-Object {$_.path -ne 'transient-control.dll'}).Count) { throw 'Actual Add-Type compiler DLL positive control was missed.' }
  $Launch=Observe 'desktop-launch' ('-NoProfile -ExecutionPolicy Bypass -File "'+$Regression+'" -PrecompiledFixture "'+$Fixture+'"')
  if ($Launch.dll_events.Count -ne 0 -or $Launch.remaining_dlls.Count -ne 0) { throw 'Desktop launch generated temporary DLLs.' }
  $Report.status='passed'
} catch { $Report.status='failed';$Report.error=$_.Exception.Message;throw }
finally {
  $Output=[IO.Path]::GetFullPath($ReportPath)
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output))|Out-Null
  [IO.File]::WriteAllText($Output,($Report|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath $Root -Recurse -Force
}
$global:LASTEXITCODE=0
