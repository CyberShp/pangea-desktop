[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$TargetVersion = '1.0.4',
  [string]$PlanPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Recovery for a package already imported and signature-verified by Desktop.
# Never change the installed signed files or the package, and never kill a process.
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path.TrimEnd('\')
$Prefix = $InstallRoot + '\'
$UpdateRoot = Join-Path $env:APPDATA 'pangea-desktop\updates'
$Helper = Join-Path $PSScriptRoot 'apply-portable-update.ps1'
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) {
  $Helper = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
}
if (-not (Test-Path -LiteralPath $Helper -PathType Leaf)) { throw 'The recovery helper apply-portable-update.ps1 is missing.' }
if ([IO.Path]::GetFullPath($Helper).StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Place the recovery scripts outside the installation directory.'
}
$Running = @(Get-Process | ForEach-Object {
  try {
    if ($_.Path -and $_.Path.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) { $_ }
  } catch { }
})
if ($Running.Count) {
  throw "Close Desktop and its running tasks before recovery. Still running: $(($Running | ForEach-Object { "$($_.ProcessName) (PID $($_.Id))" }) -join ', ')"
}

if (-not $PlanPath) {
  $MatchingPlans = @(Get-ChildItem -LiteralPath $UpdateRoot -Directory | ForEach-Object {
    $Candidate = Join-Path $_.FullName 'update-plan.json'
    if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
      $Saved = Get-Content -LiteralPath $Candidate -Raw | ConvertFrom-Json
      if ([IO.Path]::GetFullPath([string]$Saved.install_root).TrimEnd('\') -ieq $InstallRoot -and
          [string]$Saved.expected_version -eq $TargetVersion) { Get-Item -LiteralPath $Candidate }
    }
  } | Sort-Object LastWriteTime -Descending)
  if (-not $MatchingPlans.Count) { throw "No previously imported update to $TargetVersion found for $InstallRoot." }
  $PlanPath = $MatchingPlans[0].FullName
}
$PlanPath = (Resolve-Path -LiteralPath $PlanPath).Path
if (-not $PlanPath.StartsWith(([IO.Path]::GetFullPath($UpdateRoot).TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Use the original Desktop update plan from its profile updates directory.'
}
$Plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
if ($Plan.schema_version -ne 2 -or [string]$Plan.package_type -ne 'patch' -or
    [string]$Plan.expected_version -ne $TargetVersion -or
    [IO.Path]::GetFullPath([string]$Plan.install_root).TrimEnd('\') -ine $InstallRoot) {
  throw 'The saved patch plan does not match this recovery request.'
}
$BaseManifest = Get-Content -LiteralPath (Join-Path $InstallRoot 'resources\update\pangea-package-manifest.json') -Raw | ConvertFrom-Json
if ([string]$BaseManifest.version -ne [string]$Plan.expected_base_version) { throw 'The installed version no longer matches the saved patch base.' }
# Keep the original plan, including its verified package hash, for diagnosis.
# The old PID may have been reused; do not wait for an unrelated process.
$Plan.parent_pid = 0
$ResumePlan = Join-Path (Split-Path -Parent $PlanPath) ('resume-plan-' + [guid]::NewGuid().ToString('N') + '.json')
[IO.File]::WriteAllText($ResumePlan, ($Plan | ConvertTo-Json -Depth 10), (New-Object Text.UTF8Encoding($false)))
Write-Output "Resuming verified patch $($Plan.expected_base_version) -> $TargetVersion for $InstallRoot"
Write-Output "Log: $($Plan.log_path)"
# Both PowerShell's provider location and the native working directory must be
# outside the installation before attempting a Windows directory rename.
Set-Location -LiteralPath $env:TEMP
[Environment]::CurrentDirectory = $env:TEMP
& $Helper -PlanPath $ResumePlan
exit $LASTEXITCODE
