$ErrorActionPreference = 'Stop'
# Keep this script on Windows PowerShell 5.1: PowerShell 7 hides the original failure.
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw 'Run this regression with Windows PowerShell 5.1 (powershell.exe).'
}
$Updater = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Tokens = $null; $ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $Function.Extent.Text
}

# Fixture creation and assertions deliberately bypass all updater path helpers,
# PowerShell providers and .NET path-based file IO. Use independent Win32 handles.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class PortableLongPathFixture {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern bool CreateDirectoryW(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
  static extern uint GetFileAttributesW(string path);
  static string Native(string path) {
    if (path.Length < 3 || path[1] != ':' || path[2] != '\\') throw new ArgumentException("Fixture requires an absolute local path");
    return @"\\?\" + path;
  }
  public static void Directory(string path) {
    string current = path.Substring(0, 2);
    foreach (string part in path.Substring(3).Split('\\')) {
      if (part.Length == 0) continue;
      current += "\\" + part;
      if (!CreateDirectoryW(Native(current), IntPtr.Zero)) {
        int error = Marshal.GetLastWin32Error();
        if (error != 183) throw new Win32Exception(error, current);
      }
    }
  }
  static FileStream Open(string path, bool write) {
    SafeFileHandle handle = CreateFileW(Native(path), write ? 0x40000000u : 0x80000000u, 7, IntPtr.Zero, write ? 2u : 3u, 0x80, IntPtr.Zero);
    if (handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error, path); }
    try { return new FileStream(handle, write ? FileAccess.Write : FileAccess.Read); }
    catch { handle.Dispose(); throw; }
  }
  public static void Write(string path, byte[] bytes) {
    Directory(path.Substring(0, path.LastIndexOf('\\')));
    using (FileStream file = Open(path, true)) { file.Write(bytes, 0, bytes.Length); }
  }
  public static byte[] Read(string path) {
    using (FileStream file = Open(path, false))
    using (MemoryStream copy = new MemoryStream()) { file.CopyTo(copy); return copy.ToArray(); }
  }
  public static bool Exists(string path) { return GetFileAttributesW(Native(path)) != 0xffffffff; }
  public static bool IsDirectory(string path) { uint value=GetFileAttributesW(Native(path)); return value != 0xffffffff && (value & 16) != 0; }
  public static string Hash(byte[] bytes) {
    using (SHA256 hash = SHA256.Create()) { return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
  }
}
'@
# PS 5.1 resolves ZipArchiveMode before calling ZipFile; load its assembly explicitly.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Get-FixturePath {
  param([string]$Directory, [string]$Relative)
  return $Directory.TrimEnd('\') + '\' + $Relative.Replace('/', '\')
}
function Get-FixtureBytes {
  param([string]$Text)
  return ,([Text.Encoding]::UTF8.GetBytes($Text))
}
function New-FixtureRecord {
  param([string]$Relative, [byte[]]$Bytes)
  return @{ path=$Relative; size=$Bytes.Length; sha256=[PortableLongPathFixture]::Hash($Bytes) }
}
function Assert-FixtureBytes {
  param([string]$Path, [byte[]]$Expected)
  $Actual = [PortableLongPathFixture]::Read($Path)
  if ($Actual.Length -ne $Expected.Length -or [Convert]::ToBase64String($Actual) -ne [Convert]::ToBase64String($Expected)) {
    throw "File bytes differ: $Path"
  }
}
function Add-FixtureZipEntry {
  param($Zip, [string]$Name, [byte[]]$Bytes)
  $Entry = $Zip.CreateEntry($Name)
  $Stream = $Entry.Open()
  try { $Stream.Write($Bytes, 0, $Bytes.Length) } finally { $Stream.Dispose() }
}
function New-FixtureArchive {
  param([string]$Name, [hashtable]$Entries)
  $Path = Join-Path $Root ($Name + '.zip')
  $Zip = [IO.Compression.ZipFile]::Open($Path, [IO.Compression.ZipArchiveMode]::Create)
  try { foreach ($EntryName in $Entries.Keys) { Add-FixtureZipEntry $Zip $EntryName $Entries[$EntryName] } }
  finally { $Zip.Dispose() }
  return $Path
}
function New-FixturePatch {
  param([string]$Name, [object[]]$Files, [hashtable]$PayloadBytes)
  $Changed = @($Files | Where-Object { $PayloadBytes.ContainsKey([string]$_.path) })
  $Patch = @{ schema_version=1; product='PANGEA Desktop'; from_version=$ExpectedBaseVersion; to_version=$ExpectedVersion; files=$Changed }
  $Manifest = @{ version=$ExpectedVersion; channel='stable'; files=@($Files) }
  $Entries = @{
    'pangea-patch-manifest.json' = Get-FixtureBytes ($Patch | ConvertTo-Json -Depth 6 -Compress)
    'target/resources/update/pangea-package-manifest.json' = Get-FixtureBytes ($Manifest | ConvertTo-Json -Depth 6 -Compress)
    'target/resources/update/pangea-package-manifest.json.sig' = Get-FixtureBytes 'fixture-signature'
  }
  foreach ($Relative in $PayloadBytes.Keys) { $Entries['payload/' + $Relative] = $PayloadBytes[$Relative] }
  return New-FixtureArchive $Name $Entries
}
function Assert-FixtureRejected {
  param([string]$Name, [scriptblock]$Action, [string]$MessagePattern)
  $Failure = $null
  try { & $Action } catch { $Failure = $_.Exception.Message }
  if (-not $Failure) { throw "Unsafe operation was accepted: $Name" }
  if ($Failure -notmatch $MessagePattern) { throw "Unexpected rejection for ${Name}: $Failure" }
  Write-Output "PASS: $Name rejected ($Failure)"
}

$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-long-paths-' + [guid]::NewGuid().ToString('N'))
$InstallParent = Get-FixturePath $Root 'download/setup package [中文]'
while ($InstallParent.Length -lt 180) { $InstallParent += '\nested installation directory [验证]' }
$Base = Get-FixturePath $InstallParent 'pangea-desktop'
$Candidate = Get-FixturePath $InstallParent ('pangea-desktop.update-' + [guid]::NewGuid().ToString('N'))
$LogPath = Join-Path $Root 'apply.log'
$script:UpdateForm = $null
$ExpectedBaseVersion = '1.0.0'; $ExpectedVersion = '1.0.1'
$Plan = @{ package_channel='stable' }
# This is the exact nested dependency from the reported Copy-Item failure.
$DependencyDirectory = 'resources/app/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/resources/build/esnext/detectors/platform/node/machine-id'
$Unchanged = $DependencyDirectory + '/getMachineId-unsupported.js'
$Changed = $DependencyDirectory + '/changed [资源].js'
$Added = $DependencyDirectory + '/new [资源].js'
$UnchangedBytes = Get-FixtureBytes 'unchanged module export: 汉字 [literal]'
$ChangedBytes = Get-FixtureBytes 'changed module version 2'
$AddedBytes = Get-FixtureBytes 'added module version 2'
$OriginalChangedBytes = Get-FixtureBytes 'changed module version 1'
$Files = @(
  (New-FixtureRecord $Unchanged $UnchangedBytes),
  (New-FixtureRecord $Changed $ChangedBytes),
  (New-FixtureRecord $Added $AddedBytes)
)
try {
  [PortableLongPathFixture]::Directory($Root)
  $PlanPath = Join-Path $Root 'update-plan.json'
  $FirstControl = New-UpdateControlFile 'handles'
  [IO.File]::WriteAllText($FirstControl, 'retain previous diagnostics')
  $SecondControl = New-UpdateControlFile 'handles'
  if ([IO.Path]::GetFileName($FirstControl) -ne 'handles-1.json' -or
      [IO.Path]::GetFileName($SecondControl) -ne 'handles-2.json' -or
      [IO.File]::ReadAllText($FirstControl) -ne 'retain previous diagnostics') {
    throw 'Short control-file allocation reused or overwrote an existing file.'
  }
  Write-Output 'PASS: short control filenames preserve existing diagnostics'
  [PortableLongPathFixture]::Write((Get-FixturePath $Base $Unchanged), $UnchangedBytes)
  [PortableLongPathFixture]::Write((Get-FixturePath $Base $Changed), $OriginalChangedBytes)
  [PortableLongPathFixture]::Write((Get-FixturePath $Base 'obsolete.txt'), (Get-FixtureBytes 'removed file'))
  foreach ($Directory in @($Base, $Candidate)) {
    $Path = Get-FixturePath $Directory $Unchanged
    if ($Path.Length -le 350) { throw "Fixture must exceed 350 characters: $Path" }
    Write-Output "Long-path fixture: $($Path.Length) characters"
  }
  $Payload = @{}; $Payload[$Changed]=$ChangedBytes; $Payload[$Added]=$AddedBytes
  $Archive = New-FixturePatch 'valid' $Files $Payload
  Apply-VerifiedPatch $Archive $Base $Candidate
  Assert-FixtureBytes (Get-FixturePath $Candidate $Unchanged) $UnchangedBytes
  Assert-FixtureBytes (Get-FixturePath $Candidate $Changed) $ChangedBytes
  Assert-FixtureBytes (Get-FixturePath $Candidate $Added) $AddedBytes
  Assert-FixtureBytes (Get-FixturePath $Base $Changed) $OriginalChangedBytes
  Assert-FixtureBytes (Get-FixturePath $Candidate 'resources/update/pangea-package-manifest.json.sig') (Get-FixtureBytes 'fixture-signature')
  $ManifestBytes = [PortableLongPathFixture]::Read((Get-FixturePath $Candidate 'resources/update/pangea-package-manifest.json'))
  $Manifest = [Text.Encoding]::UTF8.GetString($ManifestBytes) | ConvertFrom-Json
  if ($Manifest.version -ne $ExpectedVersion -or $Manifest.files.Count -ne 3) { throw 'Target manifest was not extracted intact.' }
  if ([PortableLongPathFixture]::Exists((Get-FixturePath $Candidate 'obsolete.txt'))) { throw 'Deleted baseline file survived reconstruction.' }
  Write-Output 'PASS: >350-character baseline copy, changed/new payload, size/SHA validation and signed-manifest files'

  # Reproduce the threshold crossing separately: the installed file fits MAX_PATH
  # while a staging suffix alone pushes the identical relative path beyond it.
  $BoundaryBase = Get-FixturePath $Root 'short base'
  $BoundaryPrefix = 'resources/app/node_modules/[boundary]/'
  $PaddingLength = 221 - $BoundaryBase.Length - 1 - $BoundaryPrefix.Length - '.js'.Length
  if ($PaddingLength -lt 1) { throw 'Temporary root is too long for the 221-character boundary fixture.' }
  $BoundaryRelative = $BoundaryPrefix + ('x' * $PaddingLength) + '.js'
  $BoundaryTarget = $BoundaryBase + '-' + ('c' * 39)
  $BoundarySourcePath = Get-FixturePath $BoundaryBase $BoundaryRelative
  $BoundaryTargetPath = Get-FixturePath $BoundaryTarget $BoundaryRelative
  if ($BoundarySourcePath.Length -ne 221 -or $BoundaryTargetPath.Length -ne 261) { throw 'Invalid MAX_PATH boundary fixture.' }
  [PortableLongPathFixture]::Write($BoundarySourcePath, $UnchangedBytes)
  $BoundaryArchive = New-FixturePatch 'boundary-221-261' @((New-FixtureRecord $BoundaryRelative $UnchangedBytes)) @{}
  Apply-VerifiedPatch $BoundaryArchive $BoundaryBase $BoundaryTarget
  Assert-FixtureBytes $BoundaryTargetPath $UnchangedBytes
  Assert-FixtureBytes $BoundarySourcePath $UnchangedBytes
  Write-Output 'PASS: 221-character installed file reconstructs at 261-character destination'

  # Size and same-length hash corruption must both be rejected, for either source.
  foreach ($SourceKind in @('baseline', 'payload')) {
    foreach ($Corruption in @('size', 'hash')) {
      $Bytes = if ($SourceKind -eq 'baseline') { $UnchangedBytes } else { $ChangedBytes }
      $BadBytes = [byte[]]$Bytes.Clone()
      if ($Corruption -eq 'size') { $BadBytes = [byte[]]($BadBytes + [byte]1) }
      else { $BadBytes[0] = $BadBytes[0] -bxor 1 }
      $Label = $SourceKind + '-' + $Corruption
      $BadPayload = @{}; $BadPayload[$Changed]=$ChangedBytes; $BadPayload[$Added]=$AddedBytes
      if ($SourceKind -eq 'baseline') { [PortableLongPathFixture]::Write((Get-FixturePath $Base $Unchanged), $BadBytes) }
      else { $BadPayload[$Changed]=$BadBytes }
      $BadArchive = New-FixturePatch $Label $Files $BadPayload
      Assert-FixtureRejected $Label { Apply-VerifiedPatch $BadArchive $Base ($Candidate + '-' + $Label) } ('Patched file ' + $Corruption + ' mismatch')
      if ($SourceKind -eq 'baseline') {
        Assert-FixtureBytes (Get-FixturePath $Base $Unchanged) $BadBytes
        [PortableLongPathFixture]::Write((Get-FixturePath $Base $Unchanged), $UnchangedBytes)
      }
    }
  }
  $Missing = $DependencyDirectory + '/missing [baseline].js'
  $MissingArchive = New-FixturePatch 'missing-baseline' @((New-FixtureRecord $Missing $UnchangedBytes)) @{}
  Assert-FixtureRejected 'missing long baseline' { Apply-VerifiedPatch $MissingArchive $Base ($Candidate + '-missing') } 'Base package is missing unchanged file'

  $FullDestination = $Candidate + '-full'
  $EmptyDirectory = $DependencyDirectory + '/empty [目录]/'
  $FullEntries = @{}; $FullEntries[$Unchanged]=$UnchangedBytes; $FullEntries[$Changed]=$ChangedBytes; $FullEntries[$EmptyDirectory]=[byte[]]@()
  $FullArchive = New-FixtureArchive 'full' $FullEntries
  Expand-VerifiedArchive $FullArchive $FullDestination
  Assert-FixtureBytes (Get-FixturePath $FullDestination $Unchanged) $UnchangedBytes
  Assert-FixtureBytes (Get-FixturePath $FullDestination $Changed) $ChangedBytes
  if (-not [PortableLongPathFixture]::IsDirectory((Get-FixturePath $FullDestination $EmptyDirectory))) { throw 'Long empty ZIP directory missing.' }
  Write-Output 'PASS: full-package extraction preserves long files and empty directories'

  $ReservationParent = Get-FixturePath $Root 'workspace [预留]'
  $ExistingReservation = Get-FixturePath $ReservationParent 'p-up-1'
  $ReservationSentinel = Get-FixturePath $ExistingReservation 'sentinel.txt'
  $ReservationBytes = Get-FixtureBytes 'previous workspace: preserve me'
  [PortableLongPathFixture]::Write($ReservationSentinel, $ReservationBytes)
  $ReservedSecond = [PangeaPortableFileIO]::CreateWorkspace($ReservationParent)
  $ReservedThird = [PangeaPortableFileIO]::CreateWorkspace($ReservationParent)
  if ($ReservedSecond -ine (Get-FixturePath $ReservationParent 'p-up-2') -or $ReservedThird -ine (Get-FixturePath $ReservationParent 'p-up-3')) {
    throw 'Short workspace allocation reused an existing reservation or produced an unexpected name.'
  }
  if (-not [PortableLongPathFixture]::IsDirectory($ReservedSecond) -or -not [PortableLongPathFixture]::IsDirectory($ReservedThird)) {
    throw 'Short workspaces must be created at reservation time.'
  }
  Assert-FixtureBytes $ReservationSentinel $ReservationBytes
  Write-Output 'PASS: short workspaces reserve p-up-2 and p-up-3 without reusing p-up-1'

  $InstalledDirectory = Get-FixturePath $ReservationParent 'pangea-desktop'
  $NewDirectory = Get-FixturePath $ReservedSecond 'new'
  $OldDirectory = Get-FixturePath $ReservedSecond 'old'
  $FailedDirectory = Get-FixturePath $ReservedSecond 'failed'
  $MoveRelative = $Unchanged
  while ((Get-FixturePath $InstalledDirectory $MoveRelative).Length -le 350) { $MoveRelative = 'deep [目录]/' + $MoveRelative }
  [PortableLongPathFixture]::Write((Get-FixturePath $InstalledDirectory $MoveRelative), $UnchangedBytes)
  [PortableLongPathFixture]::Write((Get-FixturePath $NewDirectory $MoveRelative), $ChangedBytes)
  Move-UpdateDirectory $InstalledDirectory $OldDirectory -TimeoutSeconds 1
  Move-UpdateDirectory $NewDirectory $InstalledDirectory -TimeoutSeconds 1
  Assert-FixtureBytes (Get-FixturePath $InstalledDirectory $MoveRelative) $ChangedBytes
  Assert-FixtureBytes (Get-FixturePath $OldDirectory $MoveRelative) $UnchangedBytes
  if ([PortableLongPathFixture]::Exists($NewDirectory)) { throw 'Candidate directory survived its rename.' }
  Move-UpdateDirectory $InstalledDirectory $FailedDirectory -TimeoutSeconds 1
  Move-UpdateDirectory $OldDirectory $InstalledDirectory -TimeoutSeconds 1
  Assert-FixtureBytes (Get-FixturePath $InstalledDirectory $MoveRelative) $UnchangedBytes
  Assert-FixtureBytes (Get-FixturePath $FailedDirectory $MoveRelative) $ChangedBytes
  Assert-FixtureBytes $ReservationSentinel $ReservationBytes
  if ([PortableLongPathFixture]::Exists($OldDirectory)) { throw 'Backup directory survived rollback rename.' }
  Write-Output 'PASS: short new/old directories switch and roll back across parents, preserving long-path files'

  $Sentinel = Get-FixturePath $InstallParent 'escape.txt'
  $SentinelBytes = Get-FixtureBytes 'outside destination: do not overwrite'
  [PortableLongPathFixture]::Write($Sentinel, $SentinelBytes)
  $BadPaths = @('../escape.txt', '..\escape.txt', 'nested/../../escape.txt', $Sentinel)
  $Index = 0
  foreach ($BadPath in $BadPaths) {
    $Index++
    $BadEntries = @{}; $BadEntries[$BadPath]=Get-FixtureBytes 'escaped write'
    $EscapeArchive = New-FixtureArchive ('full-escape-' + $Index) $BadEntries
    Assert-FixtureRejected "full archive escape $Index" { Expand-VerifiedArchive $EscapeArchive ($Candidate + '-escape-' + $Index) } '(escape|relative|unsafe|invalid|absolute|rooted|traversal)'
    Assert-FixtureBytes $Sentinel $SentinelBytes
    $EscapePayload = @{}; $EscapePayload[$BadPath]=Get-FixtureBytes 'escaped write'
    $EscapeRecord = New-FixtureRecord $BadPath $EscapePayload[$BadPath]
    $EscapePatch = New-FixturePatch ('patch-escape-' + $Index) @($EscapeRecord) $EscapePayload
    Assert-FixtureRejected "patch manifest escape $Index" { Apply-VerifiedPatch $EscapePatch $Base ($Candidate + '-patch-escape-' + $Index) } '(escape|relative|unsafe|invalid|absolute|rooted|traversal)'
    Assert-FixtureBytes $Sentinel $SentinelBytes
  }
  Assert-FixtureBytes (Get-FixturePath $Base $Unchanged) $UnchangedBytes
  Assert-FixtureBytes (Get-FixturePath $Base $Changed) $OriginalChangedBytes
  Write-Output 'PASS: path escape rejection leaves outside sentinel and installed baseline intact'
} finally {
  # Node uses independent long-path IO and is already required by updater tests.
  # Never run cleanup on an unverified root or use the updater helper under test.
  $TempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not [IO.Path]::GetFullPath($Root).StartsWith($TempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup root' }
  & node -e 'require(''node:fs'').rmSync(process.argv[1], {recursive:true, force:true});' $Root
  if ($LASTEXITCODE -ne 0) { throw "Could not remove long-path regression fixture: $Root" }
}
$global:LASTEXITCODE = 0
