$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Updater = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'))
$Tokens=$null; $Errors=$null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$Errors)
if ($Errors.Count) { throw ($Errors | Out-String) }
foreach ($Function in $Ast.FindAll({param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst]}, $true)) { Invoke-Expression $Function.Extent.Text }
function Write-UpdateLog { param($Message) }
# Run the actual file operations directly. The separate IO suite verifies the
# Windows job/timeout boundary that wraps these operations in production.
$script:PortableIOWorker=$true
$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-profile-rollback-' + [guid]::NewGuid().ToString('N'))
$UserData = Join-Path $Root 'user'
$Profile = Join-Path $UserData 'harness/profiles/web'
$Snapshot = Join-Path $Root 'snapshot'
$Encoding = New-Object Text.UTF8Encoding($false)
function Put-Fixture { param($Path, $Value) [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null; [IO.File]::WriteAllText($Path, $Value, $Encoding) }
function Assert-Text { param($Path, $Expected) if ([IO.File]::ReadAllText($Path) -cne $Expected) { throw "Unexpected file content: $Path" } }
function Assert-Rejected { param([string]$Name, [scriptblock]$Action, [string]$Pattern) $Rejected=$false; try { & $Action } catch { if ($_.Exception.Message -notmatch $Pattern) { throw }; $Rejected=$true }; if (-not $Rejected) { throw "Expected rejection: $Name" }; Write-Output "PASS: $Name" }
function Read-Manifest { return ([IO.File]::ReadAllText((Join-Path $Snapshot 'profile.json')) | ConvertFrom-Json) }
function Save-Manifest { param($Manifest) [IO.File]::WriteAllText((Join-Path $Snapshot 'profile.json'), (ConvertTo-Json -InputObject $Manifest -Depth 6), $Encoding) }
try {
  Put-Fixture (Join-Path $Profile 'package.json') '{"dependencies":{"user-plugin":"1.0.0"}}'
  Put-Fixture (Join-Path $Profile 'cordis.patch.yml') 'custom-user-layer'
  Put-Fixture (Join-Path $Profile '.npmrc') 'registry=user-private-registry'
  Put-Fixture (Join-Path $Profile '.install-complete') 'old-fingerprint'
  Put-Fixture (Join-Path $Profile 'node_modules/user-plugin/index.js') 'user plugin must survive'
  Put-Fixture (Join-Path $UserData 'harness/credentials.json') 'credential must survive'
  Put-Fixture (Join-Path $UserData 'harness/sessions/session.json') 'session must survive'
  Put-Fixture (Join-Path $UserData 'launch-root/pangea-data/runs/report.md') 'report must survive'
  New-UpdateProfileSnapshot $UserData $Snapshot
  $OriginalManifest = [IO.File]::ReadAllText((Join-Path $Snapshot 'profile.json'))
  if (@((Read-Manifest).files).Count -ne 7) { throw 'Unexpected snapshot scope.' }
  if (Test-Path -LiteralPath (Join-Path $Snapshot 'original/harness/credentials.json')) { throw 'Credentials copied into configuration snapshot.' }
  Assert-Rejected 'existing snapshot cannot be silently replaced' { New-UpdateProfileSnapshot $UserData $Snapshot } 'already exists'
  Put-Fixture (Join-Path $Profile 'package.json') 'new-version manifest'
  Put-Fixture (Join-Path $Profile 'cordis.patch.yml') 'new-version layer'
  Put-Fixture (Join-Path $Profile 'pnpm-lock.yaml') 'newly-created lock'
  Put-Fixture (Join-Path $Profile '.install-complete') 'new-fingerprint'
  Restore-UpdateProfileSnapshot $UserData $Snapshot
  Assert-Text (Join-Path $Profile 'package.json') '{"dependencies":{"user-plugin":"1.0.0"}}'
  Assert-Text (Join-Path $Profile 'cordis.patch.yml') 'custom-user-layer'
  if (Test-Path -LiteralPath (Join-Path $Profile 'pnpm-lock.yaml')) { throw 'Originally missing config was not restored as missing.' }
  if (Test-Path -LiteralPath (Join-Path $Profile '.install-complete')) { throw 'Restored fingerprint falsely certifies the modified package tree.' }
  Assert-Text (Join-Path $Snapshot 'attempted/harness/profiles/web/package.json') 'new-version manifest'
  Assert-Text (Join-Path $Snapshot 'attempted/harness/profiles/web/pnpm-lock.yaml') 'newly-created lock'
  Assert-Text (Join-Path $Profile 'node_modules/user-plugin/index.js') 'user plugin must survive'
  Assert-Text (Join-Path $UserData 'harness/credentials.json') 'credential must survive'
  Assert-Text (Join-Path $UserData 'harness/sessions/session.json') 'session must survive'
  Assert-Text (Join-Path $UserData 'launch-root/pangea-data/runs/report.md') 'report must survive'
  Write-Output 'PASS: exact configuration rollback, missing files, failed-version copies, unrelated data preservation'
  Restore-UpdateProfileSnapshot $UserData $Snapshot
  Assert-Text (Join-Path $Snapshot 'attempted/harness/profiles/web/package.json') 'new-version manifest'
  Write-Output 'PASS: repeated rollback preserves the first failed-version configuration'

  Put-Fixture (Join-Path $Profile 'package.json') 'must remain on rejected restore'
  $SavedPatch = Join-Path $Snapshot 'original/harness/profiles/web/cordis.patch.yml'
  Put-Fixture $SavedPatch 'corrupted'
  Assert-Rejected 'all snapshot hashes validated before any live file changes' { Restore-UpdateProfileSnapshot $UserData $Snapshot } 'integrity check failed'
  Assert-Text (Join-Path $Profile 'package.json') 'must remain on rejected restore'
  Put-Fixture $SavedPatch 'custom-user-layer'
  $Manifest = Read-Manifest; $Manifest.files[0].path='../outside.txt'; Save-Manifest $Manifest
  Assert-Rejected 'path traversal in snapshot manifest is rejected' { Restore-UpdateProfileSnapshot $UserData $Snapshot } 'unexpected or duplicate path'
  [IO.File]::WriteAllText((Join-Path $Snapshot 'profile.json'), $OriginalManifest, $Encoding)
  $Manifest = Read-Manifest; $Manifest.files[1].path=$Manifest.files[0].path; Save-Manifest $Manifest
  Assert-Rejected 'duplicate snapshot path is rejected' { Restore-UpdateProfileSnapshot $UserData $Snapshot } 'unexpected or duplicate path'
  [IO.File]::WriteAllText((Join-Path $Snapshot 'profile.json'), $OriginalManifest, $Encoding)
  Assert-Rejected 'snapshot cannot restore into another user profile' { Restore-UpdateProfileSnapshot (Join-Path $Root 'other-user') $Snapshot } 'identity does not match'
  [IO.File]::Delete($SavedPatch)
  Assert-Rejected 'missing original snapshot bytes block restoration' { Restore-UpdateProfileSnapshot $UserData $Snapshot } 'Could not find|cannot find|not find'
  Put-Fixture $SavedPatch 'custom-user-layer'

  $LinkedUser = Join-Path $Root 'linked-user'
  $Linked = $false
  try { New-Item -ItemType SymbolicLink -Path $LinkedUser -Target $UserData -ErrorAction Stop | Out-Null; $Linked=$true } catch { Write-Output 'SKIP: symbolic-link fixture requires Windows link privilege.' }
  if ($Linked) {
    Assert-Rejected 'linked profile root cannot redirect snapshot operations' { New-UpdateProfileSnapshot $LinkedUser (Join-Path $Root 'linked-snapshot') } 'linked path'
    Remove-Item -LiteralPath $LinkedUser -Force
  }

  $LargeUser = Join-Path $Root 'large-user'
  $LargeConfig = Join-Path $LargeUser 'harness/profiles/web/package.json'
  Put-Fixture $LargeConfig ''
  $Stream = [IO.File]::OpenWrite($LargeConfig)
  try { $Stream.SetLength(64MB + 1) } finally { $Stream.Dispose() }
  Assert-Rejected 'oversized configuration fails before publishing a complete snapshot' { New-UpdateProfileSnapshot $LargeUser (Join-Path $Root 'large-snapshot') } 'snapshot limit'
  if (Test-Path -LiteralPath (Join-Path $Root 'large-snapshot/profile.json')) { throw 'Incomplete snapshot published as complete.' }

  # Interrupt halfway through restoration, then retry the same persisted
  # snapshot. Only the file-writing boundary is faulted; actual I/O is used.
  $OriginalWriter = (Get-Command Write-UpdateProfileBytes).ScriptBlock
  $script:FailProfileWrite = $true
  function Write-UpdateProfileBytes {
    param([string]$Path, [byte[]]$Bytes, [switch]$CreateOnly)
    if ($script:FailProfileWrite -and $Path -eq (Join-Path $Profile 'cordis.patch.yml')) {
      $script:FailProfileWrite=$false
      throw 'Injected interrupted profile restore'
    }
    & $OriginalWriter -Path $Path -Bytes $Bytes -CreateOnly:$CreateOnly
  }
  Assert-Rejected 'interruption during restoration remains retryable' { Restore-UpdateProfileSnapshot $UserData $Snapshot } 'Injected interrupted'
  Restore-UpdateProfileSnapshot $UserData $Snapshot
  Assert-Text (Join-Path $Profile 'package.json') '{"dependencies":{"user-plugin":"1.0.0"}}'
  Assert-Text (Join-Path $Profile 'cordis.patch.yml') 'custom-user-layer'
  Assert-Text (Join-Path $Snapshot 'attempted/harness/profiles/web/package.json') 'new-version manifest'
  Write-Output 'PASS: interrupted rollback resumes without losing original or failed-version configuration'

  # An external executable can write the profile without locking the install.
  # Verify this boundary independently of installation-directory lock cleanup.
  $script:Quiesced=$false
  $script:ProfileHolders=@([pscustomobject]@{Name='external-writer';Id=4321})
  function Stop-PortableOwnedWriters { param($InstallRoot,$TimeoutSeconds) $script:Quiesced=$true }
  function Get-UpdateLockHolders { param($Root,$TimeoutMilliseconds) if (-not $script:Quiesced) { throw 'Profile scanned before owned writers were stopped.' }; return $script:ProfileHolders }
  Assert-Rejected 'unknown external profile writer blocks snapshot and rollback' { Assert-UpdateProfileQuiescent $UserData } '4321'
  $script:ProfileHolders=@()
  Assert-UpdateProfileQuiescent $UserData
  Write-Output 'PASS: profile operations proceed only after known writers stop and remaining handles clear'
} finally {
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
