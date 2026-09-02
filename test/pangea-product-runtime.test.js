import { describe, expect, it, vi } from 'vitest'

import * as product from '../packages/dsh-pangea-product/index.js'

describe('PANGEA product server runtime', () => {
  it('mounts NGA and CodeAgent through the bundled ACP module', () => {
    const plugin = vi.fn()

    product.apply({ plugin })

    expect(product.inject).toEqual(['subagents', 'subprocess'])
    expect(plugin).toHaveBeenCalledTimes(2)
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
      }
    ])
    for (const [acp] of plugin.mock.calls) expect(acp.name).toBe('subagent-acp')
  })
})
