$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$Tokens=$null; $Errors=$null
$Updater=Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'
$Ast=[Management.Automation.Language.Parser]::ParseFile($Updater,[ref]$Tokens,[ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
foreach ($Function in $Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]},$true)) { Invoke-Expression $Function.Extent.Text }
# Real persistent child/pipe protocol; only native scan and Windows Job are
# substituted. Native Windows coverage remains in handle-resolution.ps1.
$ServerBody=(Get-Command Invoke-UpdateHandleServer).Definition
$script:Starts=0
function Write-UpdateLog { param($Message) }
function Start-UpdateHandleServer {
  $script:Starts++
  $Stub=@'
function Initialize-HandleInspector {
  if ('PangeaUpdateHandles' -as [type]) { return }
  Add-Type @"
using System;
using System.Threading;
public static class PangeaUpdateHandles {
  public static object[] Scan(string root) {
    if(root == "timeout") Thread.Sleep(10000);
    if(root == "error") throw new Exception("fixture scan failure");
    return new object[] { new {Id=42, Created=123L, Path=root, Name="fixture", Critical=false, SameUser=true} };
  }
}
"@
}
'@
  $Code="[Console]::InputEncoding=[Text.Encoding]::ASCII`n" + $Stub + "`nfunction Invoke-UpdateHandleServer {`n"+$ServerBody+"`n}`nInvoke-UpdateHandleServer"
  $Info=New-Object Diagnostics.ProcessStartInfo
  $Info.FileName=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $Info.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Code))
  $Info.UseShellExecute=$false; $Info.CreateNoWindow=$true
  $Info.RedirectStandardInput=$true; $Info.RedirectStandardOutput=$true; $Info.RedirectStandardError=$true
  $Worker=New-Object Diagnostics.Process; $Worker.StartInfo=$Info
  if (-not $Worker.Start()) { throw 'fixture start failed' }
  # Reproduce the Framework pipe BOM/console-code-page mismatch on every OS.
  $Preamble=[byte[]]@(239,187,191)
  $Worker.StandardInput.BaseStream.Write($Preamble,0,$Preamble.Length)
  $Worker.StandardInput.BaseStream.Flush()
  $Job=[pscustomobject]@{Worker=$Worker}
  $Job | Add-Member -MemberType ScriptMethod -Name Dispose -Value { if (-not $this.Worker.HasExited) { $this.Worker.Kill(); $null=$this.Worker.WaitForExit(5000) } }
  $script:HandleServerState=[pscustomobject]@{Process=$Worker; Job=$Job; Errors=$Worker.StandardError.ReadToEndAsync(); Sequence=0}
}
try {
  $First=@(Get-UpdateLockHolders 'C:\测试 [1]\source')
  $WorkerId=$script:HandleServerState.Process.Id
  $Second=@(Get-UpdateLockHolders 'D:\other')
  if ($First.Count -ne 1 -or $First[0].Path -cne 'C:\测试 [1]\source' -or $Second[0].Path -cne 'D:\other') { throw 'Protocol corrupted path or returned stale result' }
  if ($script:Starts -ne 1 -or $script:HandleServerState.Process.Id -ne $WorkerId -or $script:HandleServerState.Sequence -ne 2) { throw 'Worker was not reused' }
  Write-Output 'PASS: real pipe requests reuse one compiled worker and preserve Unicode literal paths'
  $Failed=$false
  try { $null=Get-UpdateLockHolders 'timeout' -TimeoutMilliseconds 100 } catch { $Failed=$true }
  if (-not $Failed -or $script:HandleServerState) { throw 'Timeout must discard worker and pending response' }
  if (Get-Process -Id $WorkerId -ErrorAction SilentlyContinue) { throw 'Timed out worker remained alive' }
  Write-Output 'PASS: timeout terminates owned worker and invalidates pending response'
  $Recovered=@(Get-UpdateLockHolders 'C:\recovered')
  if ($script:Starts -ne 2 -or $Recovered[0].Path -cne 'C:\recovered') { throw 'Fresh worker did not recover after timeout' }
  $Failed=$false
  try { $null=Get-UpdateLockHolders 'error' } catch { $Failed=$_.Exception.Message -like '*fixture scan failure*' }
  if (-not $Failed -or $script:HandleServerState) { throw 'Scan failure must fail closed and discard worker' }
  Write-Output 'PASS: scan errors fail closed; next request uses a new worker'
} finally { Stop-UpdateHandleServer }
