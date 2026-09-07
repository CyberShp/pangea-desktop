$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$AppDirectory = Join-Path $ProjectRoot 'dist-dev/win-unpacked'
$Executable = Join-Path $AppDirectory 'PANGEA Desktop Dev.exe'
if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Build package:dev:dir first.' }
$PreviousUserData = $env:PANGEA_USER_DATA_DIR
try {
  $env:PANGEA_USER_DATA_DIR = Join-Path $ProjectRoot '.pangea-build/dev-profile'
  Start-Process -FilePath $Executable -WorkingDirectory $AppDirectory -WindowStyle Hidden
} finally { $env:PANGEA_USER_DATA_DIR = $PreviousUserData }
