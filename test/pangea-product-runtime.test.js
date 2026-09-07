import { describe, expect, it, vi } from 'vitest'

import * as product from '../packages/dsh-pangea-product/index.js'

describe('PANGEA product server runtime', () => {
  it('defaults only Windows CodeAgent to PowerShell and preserves explicit shell values', () => {
    const shell = (env, platform) => product.configuredProviderPlugins(env, platform)
      .find(([, config]) => config.providerName === 'pangea-codeagent')[1].env
    expect(shell({}, 'win32')).toEqual({ CODEAGENT3_WINDOWS_SHELL_TYPE: 'powershell' })
    expect(shell({ CODEAGENT3_WINDOWS_SHELL_TYPE: ' ' }, 'win32')).toEqual({ CODEAGENT3_WINDOWS_SHELL_TYPE: 'powershell' })
    expect(shell({ codeagent3_windows_shell_type: 'custom-shell' }, 'win32')).toEqual({ codeagent3_windows_shell_type: 'custom-shell' })
    expect(shell({}, 'linux')).toEqual({})
    expect(product.configuredProviderPlugins({}, 'win32').find(([, config]) => config.providerName === 'pangea-nga')[1].env).toEqual({})
  })
  it('mounts NGA, CodeAgent, OpenCode and Claude Code through DSH providers', () => {
    const plugin = vi.fn()

    product.apply({ plugin })

    expect(product.inject).toEqual(['subagents', 'subprocess'])
    expect(plugin).toHaveBeenCalledTimes(4)
    expect(plugin.mock.calls.map(([, config]) => config)).toEqual([
      {
        providerName: 'pangea-nga',
        command: 'nga',
        configuredCommand: 'nga',
        args: ['acp'],
        permission: 'allow',
        env: {}
      },
      {
        providerName: 'pangea-codeagent',
        command: 'codeagent',
        configuredCommand: 'codeagent',
        args: ['acp'],
        permission: 'allow',
        env: process.platform === 'win32' ? { CODEAGENT3_WINDOWS_SHELL_TYPE: 'powershell' } : {}
      },
      {
        providerName: 'pangea-opencode',
        command: 'opencode',
        configuredCommand: 'opencode',
        args: ['acp', '--print-logs', '--log-level', 'ERROR'],
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
          'pangea-opencode': { available: true, command: 'opencode-custom', resolved_command: 'C:\\Tools\\opencode.exe', args: ['acp'] }
        }
      })
    })
    expect(entries.map(([, config]) => config.providerName)).toEqual([
      'pangea-codeagent', 'pangea-opencode', 'pangea-claude-code'
    ])
    expect(entries[1][1]).toMatchObject({
      command: 'C:\\Tools\\opencode.exe',
      configuredCommand: 'opencode-custom',
      args: ['acp', '--print-logs', '--log-level', 'ERROR']
    })
  })
})
