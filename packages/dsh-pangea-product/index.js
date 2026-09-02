import * as acpSubagent from '@deepseek-ai/dsh-subagent-acp'

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
  }
]

export function apply(ctx) {
  for (const config of providers) ctx.plugin(acpSubagent, config)
}
