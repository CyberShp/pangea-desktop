[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackageDirectory,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [ValidateSet('false', 'true')][string]$GitLongpathsDefault = 'false'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:OS -ne 'Windows_NT') { throw 'Packaged compatibility acceptance requires native Windows.' }
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PackageRoot = (Resolve-Path $PackageDirectory).Path
$Components = Get-Content (Join-Path $ProjectRoot 'pangea.components.json') -Raw | ConvertFrom-Json
$Manifest = Get-Content (Join-Path $PackageRoot 'resources/pangea-manifest.json') -Raw | ConvertFrom-Json
if ($Manifest.components.dsh_pangea.commit -cne $Components.dshPangea.commit) {
  throw 'Packaged companion differs from the component lock; refusing stale-package acceptance.'
}
$AppRoot = Join-Path $PackageRoot 'resources/app'
$Node = Join-Path $AppRoot 'node_modules/node/bin/node.exe'
$Companion = Join-Path $AppRoot 'node_modules/dsh-pangea-companion'
if (-not (Test-Path $Node -PathType Leaf)) { throw "Packaged Node is missing: $Node" }
& $Node (Join-Path $PSScriptRoot 'verify-fault-injection-compat.mjs') `
  --companion $Companion --require-windows --report $ReportPath --git-longpaths-default $GitLongpathsDefault
if ($LASTEXITCODE -ne 0) { throw "Packaged fault injection compatibility failed: $LASTEXITCODE" }
