$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
  throw 'Run this regression with Windows PowerShell 5.1 (powershell.exe).'
}
$Updater = Join-Path $PSScriptRoot '..\build\apply-portable-update.ps1'
$Tokens = $null; $ParseErrors = $null
$Ast = [Management.Automation.Language.Parser]::ParseFile($Updater, [ref]$Tokens, [ref]$ParseErrors)
if ($ParseErrors.Count) { throw ($ParseErrors | Out-String) }
foreach ($Definition in $Ast.FindAll({ param($Node) $Node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  Invoke-Expression $Definition.Extent.Text
}

$Root = Join-Path ([IO.Path]::GetTempPath()) ('pangea-rollback-start-' + [guid]::NewGuid().ToString('N'))
$Installed = Join-Path $Root 'installed [中文 version]'
$Executable = Join-Path $Installed 'desktop [fixture].exe'
$ScenarioPath = Join-Path $Installed 'scenario.txt'
$EvidencePath = Join-Path $Installed 'evidence.json'
$Marker = Join-Path $Root 'health [标记].json'
$LaunchLog = Join-Path $Root 'desktop launch [日志].log'
$LogPath = Join-Path $Root 'update.log'
$PlanPath = Join-Path $Root 'plan.json'
$ExpectedVersion = '1.0.0'
$OwnedProcesses = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$SavedEnvironment = @{}
$DirtyEnvironment = @{
  ELECTRON_RUN_AS_NODE = '1'
  NODE_OPTIONS = '--require=this-module-must-not-be-loaded'
  NODE_PATH = 'fixture-only-untrusted-module-path'
}
$FixtureSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
public static class RollbackDesktopFixture {
  static string Argument(string[] args, string prefix) {
    foreach (string arg in args) if (arg.StartsWith(prefix, StringComparison.Ordinal)) return arg.Substring(prefix.Length);
    return null;
  }
  public static int Main(string[] args) {
    string root = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);
    string scenario = File.ReadAllText(Path.Combine(root, "scenario.txt")).Trim();
    string marker = Argument(args, "--pangea-update-health=");
    string log = Argument(args, "--log-file=");
    var json = new JavaScriptSerializer();
    var environment = new Dictionary<string, string>();
    foreach (string name in new[] { "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH" }) {
      environment[name] = Environment.GetEnvironmentVariable(name);
    }
    var evidence = new Dictionary<string, object> {
      { "pid", Process.GetCurrentProcess().Id }, { "cwd", Environment.CurrentDirectory },
      { "args", args }, { "marker", marker }, { "log", log }, { "environment", environment }
    };
    File.WriteAllText(Path.Combine(root, "evidence.json"), json.Serialize(evidence), new UTF8Encoding(false));
    if (!String.IsNullOrEmpty(log)) File.WriteAllText(log, "fixture Desktop started", new UTF8Encoding(false));
    if (scenario == "exit17") return 17;
    if (scenario != "no-marker" && !String.IsNullOrEmpty(marker)) {
      var health = new Dictionary<string, object> {
        { "schema_version", scenario == "wrong-schema" ? 2 : 1 },
        { "pid", Process.GetCurrentProcess().Id + (scenario == "wrong-pid" ? 1 : 0) },
        { "version", scenario == "wrong-version" ? "0.0.0" : "1.0.0" },
        { "healthy_at", (scenario == "stale-time" ? DateTime.UtcNow.AddDays(-1) : DateTime.UtcNow).ToString("o") }
      };
      File.WriteAllText(marker, json.Serialize(health), new UTF8Encoding(false));
    }
    // Bound the lifetime even if the test runner itself unexpectedly exits.
    Thread.Sleep(30000);
    return 0;
  }
}
'@

function Start-DesktopFixture {
  param([string]$Scenario)
  foreach ($Path in @($Marker, $EvidencePath, $LaunchLog, "$PlanPath.progress.json")) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  }
  $script:UpdateProgressData = $null
  [IO.File]::WriteAllText($ScenarioPath, $Scenario, (New-Object Text.UTF8Encoding($false)))
  $Process = Start-PortableDesktop $Executable $Marker $LaunchLog
  if (-not $Process -or $Process.Id -le 0) { throw 'Desktop launch did not return a process identity.' }
  $OwnedProcesses.Add($Process)
  $Deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ($true) {
    try {
      $Evidence = [IO.File]::ReadAllText($EvidencePath) | ConvertFrom-Json
      if ($Evidence.pid -eq $Process.Id) { break }
    } catch { }
    if ([DateTime]::UtcNow -ge $Deadline) { throw "Fixture did not report startup evidence: $Scenario" }
    Start-Sleep -Milliseconds 50
  }
  return $Process
}
function Stop-DesktopFixture {
  param([Diagnostics.Process]$Process)
  # Only process objects returned by this test's own fixture launches are eligible.
  if (-not $OwnedProcesses.Contains($Process)) { throw 'Refusing to stop a process not owned by this test.' }
  $Process.Refresh()
  if (-not $Process.HasExited) { $Process.Kill(); $Process.WaitForExit() }
}
function Assert-HealthRejected {
  param([Diagnostics.Process]$Process, [string]$Scenario, [int]$TimeoutSeconds = 1)
  $Failure = ''
  $Accepted = $false
  try {
    $Accepted = Wait-PortableDesktopHealthy $Process $Marker $ExpectedVersion -TimeoutSeconds $TimeoutSeconds -Stage 'rollback-health' -Percent 35
  } catch { $Failure = $_.Exception.Message }
  if ($Accepted -eq $true) { throw "Invalid health evidence was accepted: $Scenario" }
  if (-not $Failure) { throw "Rejected Desktop startup must report a diagnostic failure: $Scenario" }
  if ($Scenario -eq 'exit17') {
    $Diagnostics = $Failure + [IO.File]::ReadAllText($LogPath)
    if ($Diagnostics -notmatch '(?i)(exit.{0,30}\b17\b|\b17\b.{0,30}exit|退出.{0,30}\b17\b)') {
      throw "Exited Desktop did not expose exit code 17: $Failure"
    }
  } else {
    $Process.Refresh()
    if ($Process.HasExited) { throw "Negative health fixture exited unexpectedly: $Scenario" }
  }
  Write-Output "PASS: $Scenario does not pass Desktop health checks"
}

try {
  [IO.Directory]::CreateDirectory($Installed) | Out-Null
  Add-Type -TypeDefinition $FixtureSource -Language CSharp -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll' -OutputAssembly $Executable -OutputType ConsoleApplication
  foreach ($Name in $DirtyEnvironment.Keys) {
    $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    [Environment]::SetEnvironmentVariable($Name, $DirtyEnvironment[$Name], 'Process')
  }

  $Healthy = Start-DesktopFixture 'healthy'
  $Evidence = Get-Content -LiteralPath $EvidencePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($Evidence.pid -ne $Healthy.Id -or $Evidence.cwd -ine $Installed) { throw 'Desktop must launch in its own installation directory.' }
  $LoggingArguments = @($Evidence.args | Where-Object { $_ -match '^--enable-logging(?:=file)?$' })
  if ($Evidence.marker -ne $Marker -or $Evidence.log -ne $LaunchLog -or $LoggingArguments.Count -ne 1) {
    throw 'Quoted health/log arguments were not delivered intact to the Desktop.'
  }
  foreach ($Name in $DirtyEnvironment.Keys) {
    if (-not [string]::IsNullOrEmpty([string]$Evidence.environment.$Name)) { throw "Inherited unsafe Desktop environment: $Name" }
    if ([Environment]::GetEnvironmentVariable($Name, 'Process') -ne $DirtyEnvironment[$Name]) { throw "Launch changed its parent environment: $Name" }
  }
  if (-not (Wait-PortableDesktopHealthy $Healthy $Marker $ExpectedVersion -TimeoutSeconds 5 -Stage 'rollback-health' -Percent 35)) {
    throw 'Correct live Desktop health marker was rejected.'
  }
  Write-Output 'PASS: explicit working directory, clean child environment, intact arguments and correct live health identity'
  Stop-DesktopFixture $Healthy

  $Exited = Start-DesktopFixture 'exit17'
  Assert-HealthRejected $Exited 'exit17' 3
  Stop-DesktopFixture $Exited

  foreach ($Scenario in @('wrong-pid', 'wrong-version', 'wrong-schema', 'stale-time')) {
    $Invalid = Start-DesktopFixture $Scenario
    Assert-HealthRejected $Invalid $Scenario
    Stop-DesktopFixture $Invalid
  }

  $NoMarker = Start-DesktopFixture 'no-marker'
  $StartedAt = [DateTime]::UtcNow
  Assert-HealthRejected $NoMarker 'no-marker' 6
  $Progress = Read-UpdateProgress "$PlanPath.progress.json"
  if (-not $Progress -or $Progress.stage -ne 'rollback-health' -or $Progress.percent -ne 35 -or ([DateTime]$Progress.updated_at).ToUniversalTime() -lt $StartedAt.AddSeconds(4)) {
    throw 'Waiting for rollback startup did not refresh visible progress after five seconds.'
  }
  if (([DateTime]::UtcNow - $StartedAt).TotalSeconds -gt 15) { throw 'Desktop health timeout was not bounded by the requested deadline.' }
  Stop-DesktopFixture $NoMarker
  Write-Output 'PASS: missing marker times out while refreshing persistent rollback progress'
} finally {
  foreach ($Process in $OwnedProcesses) {
    try { Stop-DesktopFixture $Process } finally { $Process.Dispose() }
  }
  foreach ($Name in $SavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], 'Process') }
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
$global:LASTEXITCODE = 0
