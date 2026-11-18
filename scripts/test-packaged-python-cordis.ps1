[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$PackageDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Packaged integration requires native Windows.' }
$PackageRoot = (Resolve-Path -LiteralPath $PackageDirectory).Path
$App = Join-Path $PackageRoot 'resources/app'
$Node = Join-Path $App 'node_modules/node/bin/node.exe'
$Python = Join-Path $PackageRoot 'resources/pangea-python/python.exe'
$Agent = Join-Path $PackageRoot 'resources/pangea-runtime'
$Companion = Join-Path $App 'node_modules/dsh-pangea-companion'
foreach ($Required in @($Node, $Python, (Join-Path $Agent 'src/pangea_agent/cli/main.py'))) {
  if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) { throw "Missing packaged runtime: $Required" }
}
$Values = @{
  PANGEA_PYTHON = $Python; PANGEA_TEST_PYTHON = $Python
  PANGEA_AGENT_ROOT = $Agent; PANGEA_INTEGRATION_RUNTIME = $Agent
  PANGEA_RUNTIME_ROOT = $Agent; PYTHONPATH = (Join-Path $Agent 'src')
  PANGEA_TEST_APP_ROOT = $App; PANGEA_TEST_COMPANION_ROOT = $Companion
  PANGEA_REQUIRE_DOM_TESTS = '1'; PYTHONUTF8 = '1'; GIT_LFS_SKIP_SMUDGE = '1'
}
$Previous = @{}
try {
  foreach ($Key in $Values.Keys) {
    $Previous[$Key] = [Environment]::GetEnvironmentVariable($Key, 'Process')
    [Environment]::SetEnvironmentVariable($Key, $Values[$Key], 'Process')
  }
  & $Node --version
  if ($LASTEXITCODE -ne 0) { throw 'Packaged Node failed.' }
  & $Python -X utf8 -c 'import sys,pangea_agent; print(sys.executable); print(pangea_agent.__file__)'
  if ($LASTEXITCODE -ne 0) { throw 'Packaged Python cannot import the Agent.' }
  foreach ($Plugin in @('dsh-pangea-companion', 'dsh-pangea-asset-catalog')) {
    Push-Location -LiteralPath (Join-Path $App "node_modules/$Plugin")
    try {
      & $Node --test 'tests/*.test.mjs'
      if ($LASTEXITCODE -ne 0) { throw "Packaged Python/plugin integration failed: $Plugin" }
      if ($Plugin -eq 'dsh-pangea-companion') {
        & $Node --test 'tests/cordis-launch.integration.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Cordis integration failed.' }
      }
    } finally { Pop-Location }
  }
} finally {
  foreach ($Key in $Previous.Keys) { [Environment]::SetEnvironmentVariable($Key, $Previous[$Key], 'Process') }
}
