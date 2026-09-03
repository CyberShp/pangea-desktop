import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ACP_RUNTIME_CONFIG_ENV = 'PANGEA_ACP_RUNTIME_CONFIG'

const PROVIDERS = [
  { id: 'pangea-nga', command: 'nga', args: ['acp'] },
  { id: 'pangea-codeagent', command: 'codeagent', args: ['acp'] },
  { id: 'pangea-opencode', command: 'opencode', args: ['acp'] },
  { id: 'pangea-claude-code', command: 'DSH Claude Code Provider', args: [], builtin: true }
] as const

export interface ResolvedAgentCommand {
  command: string
  version?: string
  versionError?: string
}

type CommandResolver = (command: string, environment: NodeJS.ProcessEnv) => ResolvedAgentCommand
type PowerShellProbeRunner = (command: string, environment: NodeJS.ProcessEnv) => string

class AgentCommandResolutionError extends Error {
  constructor(
    message: string,
    readonly status: 'not_found' | 'probe_error'
  ) {
    super(message)
    this.name = 'AgentCommandResolutionError'
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function configuredRuntime(dshHome: string): Record<string, unknown> {
  const file = join(dshHome, 'dsh-pangea-companion', 'acp-runtime-v1.json')
  if (!existsSync(file)) return { version: 1, providers: {} }
  const value = object(JSON.parse(readFileSync(file, 'utf8')))
  if (value.version !== 1) throw new Error('Agent Runtime 配置必须使用 version=1')
  if (value.providers === null || typeof value.providers !== 'object' || Array.isArray(value.providers)) {
    throw new Error('Agent Runtime 配置缺少 providers 对象')
  }
  return value
}

function runAgentCommandPowerShellProbe(
  command: string,
  environment: NodeJS.ProcessEnv
): string {
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
  command: string,
  environment: NodeJS.ProcessEnv,
  runProbe: PowerShellProbeRunner = runAgentCommandPowerShellProbe
): ResolvedAgentCommand {
  let output: string
  try {
    output = runProbe(command, environment)
  } catch {
    throw new AgentCommandResolutionError(
      `PowerShell 无法完成启动命令“${command}”的探测。请确认 powershell.exe 可用，并在 Agent Runtime 中填写可执行文件或 .cmd 的绝对路径。`,
      'probe_error'
    )
  }

  let parsed: Record<string, unknown>
  try {
    parsed = object(JSON.parse(output.trim()))
  } catch {
    throw new AgentCommandResolutionError(
      `PowerShell 没有返回启动命令“${command}”的有效探测结果。`,
      'probe_error'
    )
  }
  if (parsed.found === false) {
    throw new AgentCommandResolutionError(
      `未找到启动命令“${command}”。请确认它已安装并加入当前用户 PATH，或填写可执行文件或 .cmd 的绝对路径，然后重启 Harness。`,
      'not_found'
    )
  }
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new AgentCommandResolutionError(
      `PowerShell 没有返回启动命令“${command}”的可执行文件路径。`,
      'probe_error'
    )
  }
  return {
    command: parsed.command.trim(),
    ...(typeof parsed.version === 'string' && parsed.version.trim()
      ? { version: parsed.version.trim() }
      : {}),
    ...(typeof parsed.version_error === 'string' && parsed.version_error.trim()
      ? { versionError: parsed.version_error.trim() }
      : {})
  }
}

export function withAcpRuntimeEnvironment(
  dshHome: string,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  resolveCommand: CommandResolver = resolveAgentCommandWithPowerShell
): NodeJS.ProcessEnv {
  const config = configuredRuntime(dshHome)
  const configured = object(config.providers)
  const providers: Record<string, unknown> = {}

  for (const defaults of PROVIDERS) {
    const override = object(configured[defaults.id])
    const command =
      typeof override.command === 'string' && override.command.trim()
        ? override.command.trim()
        : defaults.command
    const args = Array.isArray(override.args) ? override.args : defaults.args
    const models = Array.isArray(override.models) ? override.models : []
    const base = { ...override, command, args, models }
    if ('builtin' in defaults && defaults.builtin) {
      providers[defaults.id] = {
        ...base,
        available: true,
        resolution_status: 'built-in',
        version: 'Claude Agent SDK（内置）',
        login_status: 'not_checked'
      }
      continue
    }
    if (platform !== 'win32') {
      providers[defaults.id] = {
        ...base,
        available: true,
        resolved_command: command,
        resolution_status: 'not_checked',
        login_status: 'not_checked'
      }
      continue
    }
    try {
      const resolved = resolveCommand(command, environment)
      providers[defaults.id] = {
        ...base,
        available: true,
        resolved_command: resolved.command,
        resolution_status: 'resolved',
        ...(resolved.version ? { version: resolved.version } : {}),
        version_status: resolved.version ? 'resolved' : 'unavailable',
        ...(resolved.versionError ? { version_error: resolved.versionError } : {}),
        login_status: 'not_checked'
      }
    } catch (error) {
      providers[defaults.id] = {
        ...base,
        available: false,
        resolution_status:
          error instanceof AgentCommandResolutionError ? error.status : 'probe_error',
        resolution_error: error instanceof Error ? error.message : String(error),
        version_status: 'not_checked',
        login_status: 'not_checked'
      }
    }
  }

  return {
    ...environment,
    [ACP_RUNTIME_CONFIG_ENV]: JSON.stringify({ version: 1, providers })
  }
}
