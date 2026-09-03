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

export function configuredProviderPlugins(env = process.env) {
  const configured = runtimeProviders(env)
  const entries = []
  for (const defaults of DEFAULTS) {
    const value = configured[defaults.providerName] ?? {}
    if (value.available === false) continue
    const command = typeof value.resolved_command === 'string' && value.resolved_command.trim()
      ? value.resolved_command.trim()
      : typeof value.command === 'string' && value.command.trim()
        ? value.command.trim()
        : defaults.command
    const args = Array.isArray(value.args) ? value.args : defaults.args
    if (args.some(item => typeof item !== 'string')) throw new Error(`${defaults.providerName} ACP args must be strings`)
    entries.push([acpSubagent, {
      providerName: defaults.providerName,
      command,
      args,
      permission: 'allow',
      env: {}
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
