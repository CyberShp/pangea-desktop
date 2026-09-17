$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Tokens = $null; $ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'), [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $Function.Extent.Text }
$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-user-data-' + [guid]::NewGuid())
$Source = Join-Path $Root 'installed'
$Candidate = Join-Path $Root ('installed.update-' + [guid]::NewGuid().ToString('N'))
$External = Join-Path $Root 'external-repository'
$LogPath = Join-Path $Root 'apply.log'
$script:UpdateForm = $null
$Held = $null
New-Item -ItemType Directory -Path $Root -Force | Out-Null
$Fixture = Join-Path $Root 'fixture.cjs'
@'
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [mode, source, candidate, external] = process.argv.slice(2);
const deep = path.join('launch-root', 'pangea-data', 'repositories', 'PANGEA-\u4ed3\u5e93', ...Array(10).fill('long-component-directory'), '[source].lua');
const files = [deep, 'launch-root/pangea-data/runs/existing-01/report.md', 'local-skills/private/SKILL.md', 'launch-root/.config'];
if (mode === 'create') {
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(source, file)), {recursive:true});
    fs.writeFileSync(path.join(source, file), `fixture ${file}`);
  }
  fs.mkdirSync(path.join(source, 'launch-root/empty'), {recursive:true});
  fs.mkdirSync(external, {recursive:true});
  fs.writeFileSync(path.join(external, 'sentinel.txt'), 'external must survive');
  fs.symlinkSync(external, path.join(source, 'launch-root/repository-link'), 'junction');
} else if (mode === 'verify') {
  assert.ok(path.join(candidate, deep).length > 300);
  for (const file of files) assert.equal(fs.readFileSync(path.join(candidate, file), 'utf8'), fs.readFileSync(path.join(source, file), 'utf8'));
  assert.ok(fs.statSync(path.join(candidate, 'launch-root/empty')).isDirectory());
  const link = path.join(candidate, 'launch-root/repository-link');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'junction must stay a link');
  assert.equal(fs.realpathSync(link), fs.realpathSync(external));
} else if (mode === 'cleanup') {
  assert.ok(!fs.existsSync(candidate));
  assert.equal(fs.readFileSync(path.join(external, 'sentinel.txt'), 'utf8'), 'external must survive');
  for (const file of files) assert.equal(fs.readFileSync(path.join(source, file), 'utf8'), `fixture ${file}`);
}
'@ | Set-Content -LiteralPath $Fixture -Encoding ASCII
try {
  & node $Fixture create $Source $Candidate $External
  if ($LASTEXITCODE -ne 0) { throw 'Could not create long-path repository fixture.' }
  Copy-PortableUserData $Source $Candidate
  & node $Fixture verify $Source $Candidate $External
  if ($LASTEXITCODE -ne 0) { throw 'User data copy mismatch.' }
  Write-Output 'PASS: long paths, Unicode, bracket names, empty directories, Run and skill preserved'
  Remove-PortableDirectory $Candidate
  & node $Fixture cleanup $Source $Candidate $External
  if ($LASTEXITCODE -ne 0) { throw 'Cleanup followed a junction or modified original data.' }
  Write-Output 'PASS: junction preserved and candidate cleanup leaves external repository intact'

  $LockedFile = Join-Path $Source 'launch-root\locked.txt'
  [IO.File]::WriteAllText($LockedFile, 'original locked data')
  $Held = [IO.File]::Open($LockedFile, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $Rejected = $false
  try { Copy-PortableUserData $Source $Candidate } catch {
    $Rejected = $_.Exception.Message -like '*User directory copy failed: launch-root*'
  }
  $Held.Dispose(); $Held = $null
  if (-not $Rejected -or [IO.File]::ReadAllText($LockedFile) -ne 'original locked data') { throw 'Copy errors must abort without changing original data.' }
  if (-not (Test-Path -LiteralPath "$LogPath.copy-launch-root.log")) { throw 'Copy failure diagnostics missing.' }
  Write-Output 'PASS: unreadable source aborts with copy log and original data retained'
} finally {
  if ($Held) { $Held.Dispose() }
  if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath | Write-Output }
  Remove-PortableDirectory $Root
}
# Robocopy success includes nonzero codes; do not leak one to the CI host.
$global:LASTEXITCODE = 0
