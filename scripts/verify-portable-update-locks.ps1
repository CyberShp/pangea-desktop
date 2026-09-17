$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Tokens = $null
$ParseErrors = $null
$Updater = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $Function.Extent.Text
}
$null = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'resume-portable-update.ps1'), [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-update-locks-' + [guid]::NewGuid())
$LogPath = Join-Path $Root 'apply.log'
$script:UpdateForm = $null
$LockType = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DirectoryLockFixture {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(string path, uint access, uint share,
    IntPtr security, uint mode, uint flags, IntPtr template);
  public static SafeFileHandle Open(string path) {
    var handle = CreateFile(path, 0, 3, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
    if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return handle;
  }
}
'@
Add-Type -TypeDefinition $LockType
$Job = $null
$Handle = $null
try {
  $Source = Join-Path $Root 'installed [1.0.3]'
  $Destination = Join-Path $Root 'backup [1.0.3]'
  New-Item -ItemType Directory -Path $Source -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $Source 'run.json'), '{"run_id":"existing-01"}')
  $ExpectedHash = (Get-FileHash -LiteralPath (Join-Path $Source 'run.json')).Hash
  $Handle = [DirectoryLockFixture]::Open($Source)
  $Rejected = $false
  try { Move-UpdateDirectory $Source $Destination -TimeoutSeconds 1 } catch {
    $Rejected = $_.Exception.Message -like '*Cannot rename installation directory*'
  }
  if (-not $Rejected -or (Test-Path -LiteralPath $Destination)) { throw 'A persistent lock must leave the installation in place.' }
  if ((Get-FileHash -LiteralPath (Join-Path $Source 'run.json')).Hash -ne $ExpectedHash) { throw 'Persistent lock changed user data.' }
  $Handle.Dispose(); $Handle = $null
  Write-Output 'PASS: persistent directory lock leaves installation and Run untouched'

  # Another process holds the directory while the updater begins the rename.
  $Ready = Join-Path $Root 'holder.ready'
  $Job = Start-Job -ArgumentList $LockType,$Source,$Ready -ScriptBlock {
    param($Type, $Directory, $Marker)
    Add-Type -TypeDefinition $Type
    $Held = [DirectoryLockFixture]::Open($Directory)
    try {
      [IO.File]::WriteAllText($Marker, 'ready')
      Start-Sleep -Seconds 2
    } finally { $Held.Dispose() }
  }
  $Deadline = (Get-Date).AddSeconds(15)
  while (-not (Test-Path -LiteralPath $Ready)) {
    if ((Get-Date) -ge $Deadline) { throw 'Lock fixture did not start.' }
    Start-Sleep -Milliseconds 50
  }
  Move-UpdateDirectory $Source $Destination -TimeoutSeconds 10
  $Job | Wait-Job -Timeout 10 | Receive-Job -ErrorAction Stop
  if ((Test-Path -LiteralPath $Source) -or (Get-FileHash -LiteralPath (Join-Path $Destination 'run.json')).Hash -ne $ExpectedHash) { throw 'Transient lock rename failed or changed data.' }
  Write-Output 'PASS: transient directory lock is retried until released'

  New-Item -ItemType Directory -Path $Source -Force | Out-Null
  $Rejected = $false
  try { Move-UpdateDirectory $Destination $Source -TimeoutSeconds 0 } catch {
    $Rejected = $_.Exception.Message -like '*destination already exists*'
  }
  if (-not $Rejected -or (Test-Path -LiteralPath (Join-Path $Source (Split-Path $Destination -Leaf)))) { throw 'Existing destination must not nest or overwrite the backup.' }
  Remove-Item -LiteralPath $Source
  Move-UpdateDirectory $Destination $Source -TimeoutSeconds 1
  if ((Get-FileHash -LiteralPath (Join-Path $Source 'run.json')).Hash -ne $ExpectedHash) { throw 'Rollback rename lost the Run.' }
  Write-Output 'PASS: rollback rename preserves data and rejects occupied destination'
} finally {
  if ($Handle) { $Handle.Dispose() }
  if ($Job) { $Job | Stop-Job; $Job | Remove-Job -Force }
  Remove-Item -LiteralPath $Root -Recurse -Force
}
