$ErrorActionPreference = 'Stop'
$Updater = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Tokens = $null
$ParseErrors = $null
$Ast = [System.Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Function in $Ast.FindAll({ param($Node) $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $Function.Extent.Text
}
$Root = Join-Path ([System.IO.Path]::GetTempPath()) ('pangea-patch-apply-' + [guid]::NewGuid())
$Base = Join-Path $Root 'base [95]'
$Candidate = Join-Path $Root 'candidate [98]'
$ArchiveRoot = Join-Path $Root 'zip'
$LogPath = Join-Path $Root 'apply.log'
$script:UpdateForm = $null
$ExpectedBaseVersion = '1.0.0'
$ExpectedVersion = '1.0.1'
$Plan = @{ package_channel = 'stable' }
try {
  New-Item -ItemType Directory -Path $Base,$ArchiveRoot -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $Base '[Content_Types].xml'), 'unchanged bracket file')
  [System.IO.File]::WriteAllText((Join-Path $Base 'obsolete.txt'), 'removed in target')
  New-Item -ItemType Directory -Path (Join-Path $ArchiveRoot 'payload'),(Join-Path $ArchiveRoot 'target/resources/update') -Force | Out-Null
  [System.IO.File]::WriteAllText((Join-Path $ArchiveRoot 'payload/new [file].txt'), 'new payload')
  $Files = @(
    @{ path = '[Content_Types].xml'; size = (Get-Item -LiteralPath (Join-Path $Base '[Content_Types].xml')).Length; sha256 = (Get-FileHash -LiteralPath (Join-Path $Base '[Content_Types].xml')).Hash.ToLowerInvariant() },
    @{ path = 'new [file].txt'; size = (Get-Item -LiteralPath (Join-Path $ArchiveRoot 'payload/new [file].txt')).Length; sha256 = (Get-FileHash -LiteralPath (Join-Path $ArchiveRoot 'payload/new [file].txt')).Hash.ToLowerInvariant() }
  )
  @{ schema_version = 1; product = 'PANGEA Desktop'; from_version = $ExpectedBaseVersion; to_version = $ExpectedVersion; files = @($Files[1]) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ArchiveRoot 'pangea-patch-manifest.json')
  @{ version = $ExpectedVersion; channel = 'stable'; files = $Files } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json')
  'fixture-signature' | Set-Content -LiteralPath (Join-Path $ArchiveRoot 'target/resources/update/pangea-package-manifest.json.sig')
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = Join-Path $Root 'patch.zip'
  [System.IO.Compression.ZipFile]::CreateFromDirectory($ArchiveRoot, $Archive)
  Apply-VerifiedPatch $Archive $Base $Candidate
  foreach ($File in $Files) {
    if ((Get-FileHash -LiteralPath (Join-Path $Candidate $File.path)).Hash.ToLowerInvariant() -ne $File.sha256) { throw 'Reconstructed file mismatch' }
  }
  if (Test-Path -LiteralPath (Join-Path $Candidate 'obsolete.txt')) { throw 'Deleted file survived' }
  Write-Output 'PASS: bracket paths and patch reconstruction'
  New-Item -ItemType Directory -Path (Join-Path $Base 'launch-root/pangea-data/runs'),(Join-Path $Base 'local-skills/private') -Force | Out-Null
  'report' | Set-Content -LiteralPath (Join-Path $Base 'launch-root/pangea-data/runs/report.md')
  'skill' | Set-Content -LiteralPath (Join-Path $Base 'local-skills/private/SKILL.md')
  Copy-PortableUserData $Base $Candidate
  foreach ($Relative in @('launch-root/pangea-data/runs/report.md', 'local-skills/private/SKILL.md')) {
    if ((Get-FileHash -LiteralPath (Join-Path $Base $Relative)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Candidate $Relative)).Hash) { throw "Lost user data: $Relative" }
  }
  Write-Output 'PASS: user data copied and rollback source retained'
} finally {
  $ResolvedRoot = [System.IO.Path]::GetFullPath($Root)
  if (-not $ResolvedRoot.StartsWith([System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup root' }
  Remove-Item -LiteralPath $ResolvedRoot -Recurse -Force
}
