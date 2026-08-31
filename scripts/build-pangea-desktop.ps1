[CmdletBinding()]
param(
  [string]$DshPangeaSource,
  [string]$PangeaAgentSource,
  [string]$UpdatePrivateKeyPath,
  [switch]$ResolveComponentBranches,
  [switch]$SkipTests,
  [switch]$SkipPackage
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$StageRoot = Join-Path $ProjectRoot '.pangea-build'
$SourceRoot = Join-Path $StageRoot 'sources'
$PluginRoot = Join-Path $StageRoot 'plugins'
$RuntimeRoot = Join-Path $StageRoot 'runtime'
$CacheRoot = Join-Path $StageRoot 'cache'
$UpdateRoot = Join-Path $StageRoot 'update'
$Components = Get-Content (Join-Path $ProjectRoot 'pangea.components.json') -Raw | ConvertFrom-Json

$UpdaterTokens = $null
$UpdaterErrors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $ProjectRoot 'build/apply-portable-update.ps1'),
  [ref]$UpdaterTokens,
  [ref]$UpdaterErrors
)
if ($UpdaterErrors.Count -gt 0) {
  throw "Portable updater script is invalid: $($UpdaterErrors[0].Message)"
}

function Invoke-Checked {
  param([string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory = $ProjectRoot)
  Push-Location $WorkingDirectory
  try {
    & $FilePath @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
      throw "$FilePath exited with code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
}

function Reset-StageDirectory {
  param([string]$Path)
  $ResolvedStage = [System.IO.Path]::GetFullPath($StageRoot)
  $ResolvedTarget = [System.IO.Path]::GetFullPath($Path)
  if (-not $ResolvedTarget.StartsWith($ResolvedStage, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to reset a path outside the PANGEA staging directory: $Path"
  }
  if (Test-Path $Path) { Remove-Item $Path -Recurse -Force }
  New-Item $Path -ItemType Directory -Force | Out-Null
}

function Get-ExactSource {
  param(
    [string]$Name,
    [string]$Repository,
    [string]$Commit,
    [string]$LocalSource
  )
  $Destination = Join-Path $SourceRoot $Name
  Reset-StageDirectory $Destination
  if ($LocalSource) {
    $Source = (Resolve-Path $LocalSource).Path
    Invoke-Checked 'git' @('clone', '--no-checkout', '--no-hardlinks', $Source, $Destination)
  } else {
    Invoke-Checked 'git' @('clone', '--no-checkout', $Repository, $Destination)
  }
  Invoke-Checked 'git' @('-C', $Destination, 'checkout', '--detach', $Commit)
  $Actual = (& git -C $Destination rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or $Actual -ne $Commit) {
    throw "$Name resolved to $Actual instead of locked commit $Commit"
  }
  return $Destination
}

function Resolve-BranchCommit {
  param(
    [string]$Name,
    [string]$Repository,
    [string]$Branch
  )
  if (-not $Branch) { throw "$Name does not declare a source branch." }
  $Output = @(& git ls-remote --exit-code --heads $Repository "refs/heads/$Branch")
  if ($LASTEXITCODE -ne 0 -or $Output.Count -ne 1) {
    throw "$Name branch could not be resolved: $Repository#$Branch"
  }
  $Commit = ($Output[0] -split '\s+')[0].ToLowerInvariant()
  if ($Commit -notmatch '^[0-9a-f]{40}$') {
    throw "$Name branch returned an invalid commit: $Commit"
  }
  return $Commit
}

function Get-VerifiedDownload {
  param([string]$Url, [string]$Sha256, [string]$Destination)
  if (Test-Path $Destination) {
    $Existing = (Get-FileHash $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Existing -eq $Sha256) { return }
    Remove-Item $Destination -Force
  }
  Invoke-WebRequest -Uri $Url -OutFile $Destination
  $Actual = (Get-FileHash $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Sha256) {
    Remove-Item $Destination -Force
    throw "Downloaded file hash mismatch for $Url. Expected $Sha256, got $Actual."
  }
}

if ($env:OS -ne 'Windows_NT' -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'PANGEA Desktop must be assembled on Windows x64.'
}

foreach ($Command in @('git', 'node', 'npm')) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    throw "$Command is required to build PANGEA Desktop."
  }
}
if (-not $SkipPackage -and -not $UpdatePrivateKeyPath) {
  throw 'UpdatePrivateKeyPath is required to create a verifiable portable ZIP.'
}

if ($ResolveComponentBranches) {
  Write-Host 'Resolving configured component branches...'
  $DesktopBaseCommit = Resolve-BranchCommit 'dsh-desktop' $Components.desktopBase.repository $Components.desktopBase.branch
  & git -C $ProjectRoot merge-base --is-ancestor $DesktopBaseCommit HEAD
  if ($LASTEXITCODE -ne 0) {
    throw "PANGEA Desktop does not contain dsh-desktop $($Components.desktopBase.branch) at $DesktopBaseCommit. Sync the product branch before releasing."
  }
  $Components.desktopBase.commit = $DesktopBaseCommit
  $Components.dshPangea.commit = Resolve-BranchCommit 'dsh-pangea' $Components.dshPangea.repository $Components.dshPangea.branch
  $Components.pangeaAgent.commit = Resolve-BranchCommit 'pangea-agent' $Components.pangeaAgent.repository $Components.pangeaAgent.branch
}

New-Item $StageRoot, $SourceRoot, $PluginRoot, $RuntimeRoot, $CacheRoot, $UpdateRoot -ItemType Directory -Force | Out-Null
$Components | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $StageRoot 'components.resolved.json') -Encoding UTF8

Write-Host 'Installing locked Desktop dependencies...'
Invoke-Checked 'npm' @('ci', '--legacy-peer-deps')

Write-Host 'Materializing locked PANGEA components...'
$DshPangea = Get-ExactSource 'dsh-pangea' $Components.dshPangea.repository $Components.dshPangea.commit $DshPangeaSource
$PangeaAgent = Get-ExactSource 'pangea-agent' $Components.pangeaAgent.repository $Components.pangeaAgent.commit $PangeaAgentSource
$LockedComposition = (Get-FileHash (Join-Path $DshPangea 'plugins/dsh-pangea/cordis.patch.yml') -Algorithm SHA256).Hash
$ProductComposition = (Get-FileHash (Join-Path $ProjectRoot 'packages/dsh-pangea-product/cordis.patch.yml') -Algorithm SHA256).Hash
if ($LockedComposition -ne $ProductComposition) {
  throw 'The product core bundle does not match the locked dsh-pangea composition patch.'
}

Reset-StageDirectory $PluginRoot
foreach ($Plugin in @('dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog')) {
  $Source = Join-Path $DshPangea "plugins/$Plugin"
  $Destination = Join-Path $PluginRoot $Plugin
  Copy-Item $Source $Destination -Recurse -Force
  Invoke-Checked 'node' @((Join-Path $Destination 'scripts/build-client.mjs'))
}

Write-Host 'Building the embedded PANGEA Python runtime...'
$PythonRoot = Join-Path $RuntimeRoot 'python'
$AgentRuntime = Join-Path $RuntimeRoot 'pangea-runtime'
Reset-StageDirectory $PythonRoot
Reset-StageDirectory $AgentRuntime

$PythonArchive = Join-Path $CacheRoot "python-$($Components.python.version)-embed-amd64.zip"
$PipWheel = Join-Path $CacheRoot "pip-$($Components.pip.version)-py3-none-any.whl"
Get-VerifiedDownload $Components.python.url $Components.python.sha256 $PythonArchive
Get-VerifiedDownload $Components.pip.url $Components.pip.sha256 $PipWheel
Expand-Archive -Path $PythonArchive -DestinationPath $PythonRoot -Force

$PathFile = Get-ChildItem $PythonRoot -Filter 'python*._pth' | Select-Object -First 1
if (-not $PathFile) { throw 'The embedded Python path configuration was not found.' }
$PathLines = Get-Content $PathFile.FullName
$PathLines = $PathLines | ForEach-Object { if ($_ -eq '#import site') { 'import site' } else { $_ } }
if ($PathLines -notcontains 'Lib\site-packages') { $PathLines += 'Lib\site-packages' }
if ($PathLines -notcontains '..\pangea-runtime\src') { $PathLines += '..\pangea-runtime\src' }
Set-Content $PathFile.FullName $PathLines -Encoding ASCII
New-Item (Join-Path $PythonRoot 'Lib/site-packages') -ItemType Directory -Force | Out-Null

foreach ($Directory in @('.agents', 'schemas', 'src')) {
  Copy-Item (Join-Path $PangeaAgent $Directory) (Join-Path $AgentRuntime $Directory) -Recurse -Force
}
Copy-Item (Join-Path $PangeaAgent 'pyproject.toml') $AgentRuntime -Force

$Python = Join-Path $PythonRoot 'python.exe'
$Requirements = Join-Path $ProjectRoot 'build/pangea-runtime-requirements.txt'
$SitePackages = Join-Path $PythonRoot 'Lib/site-packages'
$PipWheelLiteral = ConvertTo-Json $PipWheel -Compress
$PipBootstrap = "import sys; sys.path.insert(0, $PipWheelLiteral); from pip._internal.cli.main import main; raise SystemExit(main())"
Invoke-Checked $Python @(
  '-c', $PipBootstrap, 'install', '--disable-pip-version-check', '--no-compile',
  '--only-binary=:all:', '--target', $SitePackages, '-r', $Requirements
)

$SmokeData = Join-Path $StageRoot 'smoke-data'
Reset-StageDirectory $SmokeData
$PreviousPythonPath = $env:PYTHONPATH
try {
  $env:PYTHONPATH = Join-Path $AgentRuntime 'src'
  Invoke-Checked $Python @(
    '-m', 'pangea_agent.cli.main', 'system', 'capabilities', '--data-root', $SmokeData
  ) $AgentRuntime
} finally {
  $env:PYTHONPATH = $PreviousPythonPath
}

$DesktopCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
$Manifest = [ordered]@{
  schema_version = 1
  built_at = (Get-Date).ToUniversalTime().ToString('o')
  product = [ordered]@{ name = 'PANGEA Desktop'; version = (Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version }
  components = [ordered]@{
    desktop = [ordered]@{
      commit = $DesktopCommit
      upstream_branch = $Components.desktopBase.branch
      upstream_base = $Components.desktopBase.commit
    }
    dsh_pangea = [ordered]@{ branch = $Components.dshPangea.branch; commit = $Components.dshPangea.commit }
    pangea_agent = [ordered]@{ branch = $Components.pangeaAgent.branch; commit = $Components.pangeaAgent.commit }
    python = [ordered]@{ version = $Components.python.version; sha256 = $Components.python.sha256 }
  }
}
$Manifest | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $StageRoot 'manifest.json') -Encoding UTF8

Reset-StageDirectory $UpdateRoot
$UpdateArguments = @(
  (Join-Path $ProjectRoot 'scripts/prepare-portable-update.mjs'),
  '--output-dir', $UpdateRoot
)
if ($UpdatePrivateKeyPath) { $UpdateArguments += @('--private-key', $UpdatePrivateKeyPath) }
Invoke-Checked 'node' $UpdateArguments

if (-not $SkipTests) {
  Write-Host 'Running focused product checks...'
  foreach ($Plugin in @('dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog')) {
    Invoke-Checked 'npm' @('--prefix', (Join-Path $PluginRoot $Plugin), 'test')
  }
  Invoke-Checked 'npm' @('run', 'typecheck')
  Invoke-Checked 'npm' @(
    'test', '--', '--run',
    'test/product-workspace-bootstrap.test.ts',
    'test/launch-root.test.ts',
    'test/pangea-model-settings-entry.test.ts',
    'test/update-state.test.ts',
    'test/update-ui.test.ts',
    'test/finalize-windows-release.test.ts',
    'test/pangea-product.test.ts',
    'test/pangea-profile.test.ts',
    'test/safe-mode.test.ts',
    'test/runtime.test.ts'
  )
}

if (-not $SkipPackage) {
  Write-Host 'Packaging the Windows portable ZIP...'
  Invoke-Checked 'npm' @('run', 'package:dir')
  $PackageVersion = (Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
  $PackageName = "pangea-desktop-$PackageVersion-windows-x64-portable.zip"
  $PackagePath = Join-Path $ProjectRoot "dist/$PackageName"
  Invoke-Checked 'node' @(
    (Join-Path $ProjectRoot 'scripts/create-signed-portable-package.mjs'),
    '--app-dir', (Join-Path $ProjectRoot 'dist/win-unpacked'),
    '--private-key', $UpdatePrivateKeyPath,
    '--output', $PackagePath
  )
  if (-not (Test-Path $PackagePath -PathType Leaf)) {
    throw "Portable package was not created: $PackagePath"
  }
  $PackageHash = (Get-FileHash $PackagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content "$PackagePath.sha256" "$PackageHash  $PackageName" -Encoding ASCII
  Write-Host "Portable ZIP ready at $PackagePath"
}
