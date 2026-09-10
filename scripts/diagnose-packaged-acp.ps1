[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppDirectory,
  [Parameter(Mandatory = $true)][string]$Workspace,
  [ValidateSet('pangea-nga', 'pangea-opencode', 'pangea-codeagent')][string]$Provider = 'pangea-opencode',
  [string]$DesktopUserData,
  [string]$OutputDirectory,
  [int]$TimeoutSeconds = 60
)
$ErrorActionPreference = 'Stop'
$AppDirectory = (Resolve-Path -LiteralPath $AppDirectory).Path
$Workspace = (Resolve-Path -LiteralPath $Workspace).Path
$Resources = Join-Path $AppDirectory 'resources'
$ProbeNode = Join-Path $Resources 'app/node_modules/node/bin/node.exe'
$ProbeScript = Join-Path $Resources 'app/scripts/diagnose-acp-initialization.mjs'
$ProbePython = Join-Path $Resources 'pangea-python/python.exe'
$ProbeRuntime = Join-Path $Resources 'pangea-runtime'
$PreviousConfig = $env:PANGEA_ACP_RUNTIME_CONFIG
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("pangea-acp-{0}-{1}-{2}" -f $Provider, (Get-Date -Format 'yyyyMMdd-HHmmss'), [guid]::NewGuid().ToString('N').Substring(0, 8))
}
Write-Host "ACP diagnostics: $OutputDirectory"
try {
  if ($DesktopUserData) {
    $ConfigPath = Join-Path $DesktopUserData 'harness/dsh-pangea-companion/acp-runtime-v1.json'
    if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) {
      $env:PANGEA_ACP_RUNTIME_CONFIG = Get-Content -LiteralPath $ConfigPath -Raw
    } else { throw "Desktop ACP command settings not found: $ConfigPath" }
  }
  & $ProbeNode $ProbeScript --provider $Provider --cwd $Workspace --python $ProbePython --runtime $ProbeRuntime --timeout-ms ($TimeoutSeconds * 1000) --output-dir $OutputDirectory
  $ProbeExit = $LASTEXITCODE
} finally { $env:PANGEA_ACP_RUNTIME_CONFIG = $PreviousConfig }
exit $ProbeExit
