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
  PANGEA_RUNTIME_ROOT = $Agent; PANGEA_TEST_RUNTIME = $Agent
  PANGEA_REQUIRE_ACP_INIT_PROBE = '1'; PYTHONPATH = (Join-Path $Agent 'src')
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
  & $Python -X utf8 -c 'import pathlib,sys,pangea_agent; actual=pathlib.Path(pangea_agent.__file__).resolve(); expected=pathlib.Path(sys.argv[1]).resolve(); assert actual.is_relative_to(expected), (actual,expected); print(sys.executable); print(actual)' $Agent
  if ($LASTEXITCODE -ne 0) { throw 'Packaged Python cannot import the Agent.' }
  foreach ($Plugin in @('dsh-pangea-companion', 'dsh-pangea-asset-catalog')) {
    Push-Location -LiteralPath (Join-Path $App "node_modules/$Plugin")
    try {
      # The complete source suite also injects fake modules via PYTHONPATH.
      # Embedded Python deliberately ignores that path; exercise the real Agent here.
      if ($Plugin -eq 'dsh-pangea-companion') {
        & $Node --test 'tests/source-scope-engine.test.mjs' 'tests/test-tool-reference.test.mjs' 'tests/repository-local-integration.test.mjs' 'tests/source-first-acp.test.mjs' 'tests/semantic-runtime.test.mjs' 'tests/runtime-view.test.mjs'
      } else {
        & $Node --test 'tests/*.test.mjs'
      }
      if ($LASTEXITCODE -ne 0) { throw "Packaged Python/plugin integration failed: $Plugin" }
      if ($Plugin -eq 'dsh-pangea-companion') {
        & $Node --test 'tests/cordis-launch.integration.mjs'
        if ($LASTEXITCODE -ne 0) { throw 'Packaged Cordis integration failed.' }
      }
    } finally { Pop-Location }
  }
  $RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
  Push-Location -LiteralPath $RepoRoot
  try {
    & npx --no-install vitest run --reporter=verbose test/acp-probe.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Packaged ACP initialization probe failed.' }
  } finally { Pop-Location }
} finally {
  foreach ($Key in $Previous.Keys) { [Environment]::SetEnvironmentVariable($Key, $Previous[$Key], 'Process') }
}
