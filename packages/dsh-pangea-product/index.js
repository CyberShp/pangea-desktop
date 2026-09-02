import * as acpSubagent from '@deepseek-ai/dsh-subagent-acp'
import * as claudeCodeSubagent from '@deepseek-ai/dsh-subagent-claude-code'

export const name = 'dsh-pangea-product'
export const inject = ['subagents', 'subprocess']

const providers = [
  {
    providerName: 'pangea-nga',
    command: 'nga',
    args: ['acp'],
    permission: 'allow',
    env: {}
  },
  {
    providerName: 'pangea-codeagent',
    command: 'codeagent',
    args: ['acp'],
    permission: 'allow',
    env: {}
  },
  {
    providerName: 'pangea-opencode',
    command: 'opencode',
    args: ['acp'],
    permission: 'allow',
    env: {}
  }
]

// Claude Code is a dedicated DSH provider. It uses the official Agent SDK,
// not a shell command fallback; bypassPermissions is required because the
// Skill must read source and write its Markdown artifacts unattended.
const claudeCode = {
  providerName: 'pangea-claude-code',
  permissionMode: 'bypassPermissions',
  env: {}
}

export function apply(ctx) {
  for (const config of providers) ctx.plugin(acpSubagent, config)
  ctx.plugin(claudeCodeSubagent, claudeCode)
}
