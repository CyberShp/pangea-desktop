[CmdletBinding()]
param([string]$ReportPath='.pangea-build/verification/portable-ps51-ast.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'Native Windows PowerShell 5.1 is required.' }
$Root=Split-Path -Parent $PSScriptRoot
$Files=@(& git -C $Root ls-files -- '*.ps1' '*.psm1' '*.psd1')
if ($LASTEXITCODE -ne 0 -or $Files.Count -eq 0) { throw 'Cannot enumerate tracked PowerShell sources.' }
$Results=@(foreach ($Relative in $Files) {
  $Path=Join-Path $Root $Relative
  $Bytes=[IO.File]::ReadAllBytes($Path)
  $Bom=$Bytes.Length -ge 3 -and $Bytes[0] -eq 0xEF -and $Bytes[1] -eq 0xBB -and $Bytes[2] -eq 0xBF
  $Tokens=$null; $ParseErrors=$null
  [void][Management.Automation.Language.Parser]::ParseFile($Path,[ref]$Tokens,[ref]$ParseErrors)
  [pscustomobject]@{
    path=$Relative; utf8_bom=$Bom; sha256=(Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    parse_errors=@($ParseErrors | ForEach-Object { @{message=$_.Message;line=$_.Extent.StartLineNumber;column=$_.Extent.StartColumnNumber} })
  }
})
$Failures=@($Results | Where-Object { -not $_.utf8_bom -or $_.parse_errors.Count -gt 0 })
$Report=@{status=$(if($Failures.Count){'failed'}else{'passed'});powershell=$PSVersionTable.PSVersion.ToString();scope='All Git-tracked PowerShell source files, recursively; no script execution';file_count=$Results.Count;files=$Results}
$Output=[IO.Path]::GetFullPath($ReportPath)
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Output))|Out-Null
[IO.File]::WriteAllText($Output,($Report|ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding($false)))
if ($Failures.Count) { throw ($Failures|ConvertTo-Json -Depth 8) }
Write-Output ("PASS: {0} tracked PowerShell files have UTF-8 BOM and parse under PS {1}" -f $Results.Count,$PSVersionTable.PSVersion)
$global:LASTEXITCODE=0
