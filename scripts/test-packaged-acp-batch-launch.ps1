[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = (Resolve-Path $AppRoot).Path
$PackagedNode = Join-Path $AppRoot 'node_modules\node\bin\node.exe'
$Fixture = Join-Path $ProjectRoot 'scripts\fixtures\acp-batch-agent.mjs'
$TestScript = Join-Path $ProjectRoot 'scripts\verify-packaged-acp-batch-launch.mjs'
$TemporaryRoot = Join-Path $env:RUNNER_TEMP "PANGEA ACP 中文 空格 $([Guid]::NewGuid().ToString('N'))"

if (-not (Test-Path $PackagedNode -PathType Leaf)) { throw "Packaged Node.js runtime was not found: $PackagedNode" }
if (-not (Test-Path $Fixture -PathType Leaf)) { throw "ACP fixture was not found: $Fixture" }

try {
  New-Item $TemporaryRoot -ItemType Directory -Force | Out-Null
  $CoreShim = Join-Path $TemporaryRoot 'agent-core.cmd'
  @"
@ECHO OFF
"$PackagedNode" "$Fixture" %*
"@ | Set-Content $CoreShim -Encoding ASCII

  $Shims = @(
    (Join-Path $TemporaryRoot 'nga.cmd'),
    (Join-Path $TemporaryRoot 'codeagent.bat'),
    (Join-Path $TemporaryRoot 'opencode.cmd')
  )
  foreach ($Shim in $Shims) {
    @'
@ECHO OFF
CALL "%~dp0agent-core.cmd" %*
'@ | Set-Content $Shim -Encoding ASCII
  }

  $PreviousAppRoot = $env:PANGEA_TEST_APP_ROOT
  try {
    $env:PANGEA_TEST_APP_ROOT = $AppRoot
    & $PackagedNode $TestScript @Shims | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Packaged ACP batch launch test exited with code $LASTEXITCODE" }
  } finally {
    $env:PANGEA_TEST_APP_ROOT = $PreviousAppRoot
  }
} finally {
  Remove-Item $TemporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
