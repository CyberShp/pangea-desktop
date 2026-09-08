$ErrorActionPreference = 'Stop'
# Parse only the helper; never execute the updater against a real installation.
$Updater = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
$Function = $Ast.Find({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $Node.Name -eq 'Copy-LocalSkills' }, $true)
if (-not $Function) { throw 'Migration helper missing' }
Invoke-Expression $Function.Extent.Text
$Root = Join-Path ([System.IO.Path]::GetTempPath()) ('pangea-skills-' + [guid]::NewGuid())
try {
  $Old = Join-Path $Root 'old'
  $Candidate = Join-Path $Root 'candidate'
  $Private = Join-Path $Old 'local-skills\coverage-query\scripts'
  New-Item -ItemType Directory -Path $Private -Force | Out-Null
  New-Item -ItemType Directory -Path $Candidate -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $Private 'coverage_query.py') -Value '# synthetic only'
  Copy-LocalSkills $Old $Candidate
  $Copied = Join-Path $Candidate 'local-skills\coverage-query\scripts\coverage_query.py'
  if (-not (Test-Path -LiteralPath $Copied)) { throw 'Full update lost private Skill' }
  if (-not (Test-Path -LiteralPath (Join-Path $Private 'coverage_query.py'))) { throw 'Rollback input was moved' }
  $Backup = Join-Path $Root 'backup'
  Move-Item -LiteralPath $Old -Destination $Backup
  Copy-LocalSkills $Backup $Candidate
  if ((Get-Content -LiteralPath $Copied -Raw).Trim() -ne '# synthetic only') { throw 'Patch update changed private Skill' }
  Remove-Item -LiteralPath $Candidate -Recurse -Force
  Move-Item -LiteralPath $Backup -Destination $Old
  if (-not (Test-Path -LiteralPath (Join-Path $Private 'coverage_query.py'))) { throw 'Rollback lost private Skill' }
  Write-Output 'PASS: full/patch candidate copy and rollback preserve synthetic private Skill'
} finally {
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
