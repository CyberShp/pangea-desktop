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
})
