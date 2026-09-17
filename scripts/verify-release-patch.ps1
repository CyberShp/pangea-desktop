param(
  [Parameter(Mandatory = $true)][string]$BaseDirectory,
  [Parameter(Mandatory = $true)][string]$TargetDirectory,
  [Parameter(Mandatory = $true)][string]$PatchPath
)
$ErrorActionPreference = 'Stop'
# All input directories are disposable CI build directories, never a user installation.
$Base = (Resolve-Path -LiteralPath $BaseDirectory).Path
$Target = (Resolve-Path -LiteralPath $TargetDirectory).Path
$Archive = (Resolve-Path -LiteralPath $PatchPath).Path
$Candidate = "$Base.reconstructed"
$Backup = "$Base.before-patch"
if ((Test-Path -LiteralPath $Candidate) -or (Test-Path -LiteralPath $Backup)) { throw 'Patch verification directories already exist.' }
$BaseManifest = Get-Content -LiteralPath (Join-Path $Base 'resources/update/pangea-package-manifest.json') -Raw | ConvertFrom-Json
$TargetManifest = Get-Content -LiteralPath (Join-Path $Target 'resources/update/pangea-package-manifest.json') -Raw | ConvertFrom-Json
$ExpectedBaseVersion = $BaseManifest.version
$ExpectedVersion = $TargetManifest.version
$Plan = @{ package_channel = $TargetManifest.channel }
$LogPath = "$Base.patch-check.log"
$script:UpdateForm = $null
$Updater = Join-Path $PSScriptRoot '../build/apply-portable-update.ps1'
$Tokens = $null; $ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $Function.Extent.Text
}
$Data = Join-Path $Base 'launch-root/pangea-data'
$Node = Join-Path $Target 'resources/app/node_modules/node/bin/node.exe'
& $Node (Join-Path $PSScriptRoot 'verify-archify-upgrade.mjs') prepare $Target $Data
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare existing Run fixture.' }
$Skill = Join-Path $Base 'local-skills/patch-verification/SKILL.md'
New-Item -ItemType Directory -Path (Split-Path $Skill) -Force | Out-Null
[IO.File]::WriteAllText($Skill, '# Preserve user coverage skill')
$SkillHash = (Get-FileHash -LiteralPath $Skill).Hash
Apply-VerifiedPatch $Archive $Base $Candidate
# Compare to the independently built target, not only the manifest embedded in the patch.
foreach ($File in $TargetManifest.files) {
  $FilePath = Join-Path $Candidate $File.path
  if ((Get-Item -LiteralPath $FilePath).Length -ne $File.size -or (Get-FileHash -LiteralPath $FilePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $File.sha256) {
    throw "Patch target differs from full build: $($File.path)"
  }
}
Copy-PortableUserData $Base $Candidate
# Restore the same absolute installation path, matching the production updater.
Move-Item -LiteralPath $Base -Destination $Backup
try {
  Move-Item -LiteralPath $Candidate -Destination $Base
  if ((Get-FileHash -LiteralPath $Skill).Hash -ne $SkillHash) { throw 'User skill changed after patch.' }
  $PatchedNode = Join-Path $Base 'resources/app/node_modules/node/bin/node.exe'
  & $PatchedNode (Join-Path $PSScriptRoot 'verify-archify-upgrade.mjs') verify $Base $Data
  if ($LASTEXITCODE -ne 0) { throw 'Patched architecture verification failed.' }
  & (Join-Path $PSScriptRoot 'test-packaged-harness-startup.ps1') -PackageDirectory $Base -ExpectedVersion $ExpectedVersion
  if ($LASTEXITCODE -ne 0) { throw 'Patched Harness startup failed.' }
  Write-Output "PASS: real release patch $ExpectedBaseVersion -> $ExpectedVersion reconstructed and started; existing Run and local skill preserved."
} finally {
  # Keep verification evidence; this script never publishes or touches an installed application.
  if (Test-Path -LiteralPath $Base) { Move-Item -LiteralPath $Base -Destination $Candidate }
  Move-Item -LiteralPath $Backup -Destination $Base
}
