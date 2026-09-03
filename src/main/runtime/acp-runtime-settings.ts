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
}

type CommandResolver = (command: string, environment: NodeJS.ProcessEnv) => ResolvedAgentCommand

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

export function resolveAgentCommandWithPowerShell(
  command: string,
  environment: NodeJS.ProcessEnv
): ResolvedAgentCommand {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-OutputFormat',
      'Text',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
        '$item=Get-Command -CommandType Application -Name $env:PANGEA_AGENT_COMMAND -ErrorAction Stop | Select-Object -First 1; ' +
        '$line=(& $item.Source --version 2>&1 | Select-Object -First 1 | Out-String).Trim(); ' +
        '@{command=$item.Source;version=$line} | ConvertTo-Json -Compress'
    ],
    {
      encoding: 'utf8',
      timeout: 8_000,
      windowsHide: true,
      env: { ...environment, PANGEA_AGENT_COMMAND: command },
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  const parsed = object(JSON.parse(output.trim()))
  if (typeof parsed.command !== 'string' || parsed.command.trim() === '') {
    throw new Error(`PowerShell 没有返回 ${command} 的可执行文件路径`)
  }
  return {
    command: parsed.command.trim(),
    ...(typeof parsed.version === 'string' && parsed.version.trim()
      ? { version: parsed.version.trim() }
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
        login_status: 'not_checked'
      }
    } catch (error) {
      providers[defaults.id] = {
        ...base,
        available: false,
        resolution_status: 'error',
        resolution_error: error instanceof Error ? error.message : String(error),
        login_status: 'not_checked'
      }
    }
  }

  return {
    ...environment,
    [ACP_RUNTIME_CONFIG_ENV]: JSON.stringify({ version: 1, providers })
  }
}
