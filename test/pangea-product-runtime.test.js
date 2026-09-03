import { describe, expect, it, vi } from 'vitest'

import * as product from '../packages/dsh-pangea-product/index.js'

describe('PANGEA product server runtime', () => {
  it('mounts NGA, CodeAgent, OpenCode and Claude Code through DSH providers', () => {
    const plugin = vi.fn()

    product.apply({ plugin })

    expect(product.inject).toEqual(['subagents', 'subprocess'])
    expect(plugin).toHaveBeenCalledTimes(4)
    expect(plugin.mock.calls.map(([, config]) => config)).toEqual([
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
      },
      {
        providerName: 'pangea-claude-code',
        permissionMode: 'bypassPermissions',
        env: {}
      }
    ])
    expect(plugin.mock.calls.slice(0, 3).every(([acp]) => acp.name === 'subagent-acp')).toBe(true)
    expect(plugin.mock.calls[3][0].name).toBe('subagent-claude-code')
    expect(plugin.mock.calls[3][1]).toEqual({ providerName: 'pangea-claude-code', permissionMode: 'bypassPermissions', env: {} })
  })

  it('uses resolved commands and omits unavailable providers', () => {
    const entries = product.configuredProviderPlugins({
      PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({
        version: 1,
        providers: {
          'pangea-nga': { available: false },
          'pangea-opencode': { available: true, resolved_command: 'C:\\Tools\\opencode.exe', args: ['acp'] }
        }
      })
    })
    expect(entries.map(([, config]) => config.providerName)).toEqual([
      'pangea-codeagent', 'pangea-opencode', 'pangea-claude-code'
    ])
    expect(entries[1][1]).toMatchObject({ command: 'C:\\Tools\\opencode.exe', args: ['acp'] })
  })
})
