import * as acpSubagent from '@deepseek-ai/dsh-subagent-acp'
import * as claudeCodeSubagent from '@deepseek-ai/dsh-subagent-claude-code'

export const name = 'dsh-pangea-product'
export const inject = ['subagents', 'subprocess']

const DEFAULTS = [
  { providerName: 'pangea-nga', command: 'nga', args: ['acp'] },
  { providerName: 'pangea-codeagent', command: 'codeagent', args: ['acp'] },
  { providerName: 'pangea-opencode', command: 'opencode', args: ['acp'] }
]

function runtimeProviders(env = process.env) {
  const raw = env.PANGEA_ACP_RUNTIME_CONFIG
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  const parsed = JSON.parse(raw)
  if (parsed?.version !== 1 || !parsed.providers || typeof parsed.providers !== 'object' || Array.isArray(parsed.providers)) {
    throw new Error('PANGEA_ACP_RUNTIME_CONFIG must contain version=1 and a providers object')
  }
  return parsed.providers
}

export function configuredProviderPlugins(env = process.env, platform = process.platform) {
  const configured = runtimeProviders(env)
  const entries = []
  for (const defaults of DEFAULTS) {
    const value = configured[defaults.providerName] ?? {}
    if (value.available === false) continue
    const configuredCommand = typeof value.command === 'string' && value.command.trim()
      ? value.command.trim()
      : defaults.command
    const command = typeof value.resolved_command === 'string' && value.resolved_command.trim()
      ? value.resolved_command.trim()
      : configuredCommand
    const args = [...(Array.isArray(value.args) ? value.args : defaults.args)]
    if (args.some(item => typeof item !== 'string')) throw new Error(`${defaults.providerName} ACP args must be strings`)
    if (defaults.providerName === 'pangea-opencode' && args.includes('acp')) {
      if (!args.includes('--print-logs')) args.push('--print-logs')
      if (!args.some(arg => arg === '--log-level' || arg.startsWith('--log-level='))) args.push('--log-level', 'ERROR')
    }
    const providerEnv = {}
    if (platform === 'win32' && defaults.providerName === 'pangea-codeagent') {
      const key = Object.keys(env).find(key => key.toUpperCase() === 'CODEAGENT3_WINDOWS_SHELL_TYPE') ?? 'CODEAGENT3_WINDOWS_SHELL_TYPE'
      providerEnv[key] = typeof env[key] === 'string' && env[key].trim() ? env[key] : 'powershell'
    }
    entries.push([acpSubagent, {
      providerName: defaults.providerName,
      command,
      configuredCommand,
      args,
      permission: 'allow',
      env: providerEnv
    }])
  }
  const claude = configured['pangea-claude-code'] ?? {}
  if (claude.available !== false) entries.push([claudeCodeSubagent, {
    providerName: 'pangea-claude-code',
    permissionMode: 'bypassPermissions',
    env: {}
  }])
  return entries
}

export function apply(ctx) {
  for (const [plugin, config] of configuredProviderPlugins()) ctx.plugin(plugin, config)
}
