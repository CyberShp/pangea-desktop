import { execFileSync } from 'node:child_process'

export class AgentCommandResolutionError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'AgentCommandResolutionError'
    this.status = status
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export function runAgentCommandPowerShellProbe(command, environment) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        '$item=Get-Command -CommandType Application -Name $env:PANGEA_AGENT_COMMAND -ErrorAction SilentlyContinue | Select-Object -First 1; ' +
        "if ($null -eq $item) { @{found=$false} | ConvertTo-Json -Compress; exit 0 }; " +
        "$line=''; $versionError=''; " +
        'try { ' +
        '$versionOutput=& $item.Source --version 2>&1; $versionExitCode=$LASTEXITCODE; ' +
        '$line=($versionOutput | Select-Object -First 1 | Out-String).Trim(); ' +
        "if ($versionExitCode -ne 0) { $versionError='--version exited with code ' + $versionExitCode } " +
        "} catch { $versionError=$_.Exception.Message }; " +
        '@{found=$true;command=$item.Source;version=$line;version_error=$versionError} | ConvertTo-Json -Compress; exit 0'
    ],
    {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      env: { ...environment, PANGEA_AGENT_COMMAND: command },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
}

export function resolveAgentCommandWithPowerShell(
  command,
  environment,
  runProbe = runAgentCommandPowerShellProbe
) {
  let output
  try {
    output = runProbe(command, environment)
  } catch {
    throw new AgentCommandResolutionError(
      `PowerShell 无法完成启动命令“${command}”的探测。请确认 powershell.exe 可用，并在 Agent Runtime 中填写可执行文件或 .cmd 的绝对路径。`,
      'probe_error'
    )
  }

  let parsed
  try {
    parsed = object(JSON.parse(output.trim()))
  } catch {
    throw new AgentCommandResolutionError(`PowerShell 没有返回启动命令“${command}”的有效探测结果。`, 'probe_error')
  }
  if (parsed.found === false) {
    throw new AgentCommandResolutionError(
      `未找到启动命令“${command}”。请确认它已安装并加入当前用户 PATH，或填写可执行文件或 .cmd 的绝对路径，然后重启 Harness。`,
      'not_found'
    )
  }
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new AgentCommandResolutionError(`PowerShell 没有返回启动命令“${command}”的可执行文件路径。`, 'probe_error')
  }
  return {
    command: parsed.command.trim(),
    ...(typeof parsed.version === 'string' && parsed.version.trim() ? { version: parsed.version.trim() } : {}),
    ...(typeof parsed.version_error === 'string' && parsed.version_error.trim() ? { versionError: parsed.version_error.trim() } : {})
  }
}
