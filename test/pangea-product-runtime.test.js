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
  it('mounts only NGA, CodeAgent and OpenCode through DSH providers', () => {
    const plugin = vi.fn()

    product.apply({ plugin })

    expect(product.inject).toEqual(['subagents', 'subprocess'])
    expect(plugin).toHaveBeenCalledTimes(3)
    expect(plugin.mock.calls.map(([, config]) => config)).toEqual([
      {
        providerName: 'pangea-nga',
        command: 'nga',
        configuredCommand: 'nga',
        args: ['acp', '--skip-safe-check'],
        permission: 'allow',
        env: {}
      },
      {
        providerName: 'pangea-codeagent',
        command: 'codeagent',
        configuredCommand: 'codeagent',
        args: ['acp', '--skip-safe-check'],
        permission: 'allow',
        env: process.platform === 'win32' ? { CODEAGENT3_WINDOWS_SHELL_TYPE: 'powershell' } : {}
      },
      {
        providerName: 'pangea-opencode',
        command: 'opencode',
        configuredCommand: 'opencode',
        args: ['acp', '--print-logs', '--log-level', 'ERROR'],
        permission: 'allow',
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { 'pangea_*': 'deny' } }) }
      }
    ])
    expect(plugin.mock.calls.slice(0, 3).every(([acp]) => acp.name === 'subagent-acp')).toBe(true)
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
      'pangea-codeagent', 'pangea-opencode'
    ])
    expect(entries[1][1]).toMatchObject({
      command: 'C:\\Tools\\opencode.exe',
      configuredCommand: 'opencode-custom',
      args: ['acp', '--print-logs', '--log-level', 'ERROR']
    })
  })

  it.each(['pangea-nga', 'pangea-codeagent'])('normalizes persisted and custom arguments for %s without changing the caller', providerName => {
    const args = ['acp', '--workspace', 'project with spaces', '--skip-safe-check', '--skip-safe-check', '--', 'prompt']
    const env = { PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({ version: 1, providers: {
      [providerName]: { command: 'custom-agent', args },
      'pangea-claude-code': { available: true }
    } }) }
    const before = env.PANGEA_ACP_RUNTIME_CONFIG
    const entries = product.configuredProviderPlugins(env)
    expect(entries.find(([, config]) => config.providerName === providerName)[1]).toMatchObject({
      command: 'custom-agent', args: ['acp', '--workspace', 'project with spaces', '--skip-safe-check', '--', 'prompt']
    })
    expect(entries.some(([, config]) => config.providerName === 'pangea-claude-code')).toBe(false)
    expect(entries.find(([, config]) => config.providerName === 'pangea-opencode')[1].args).not.toContain('--skip-safe-check')
    expect(env.PANGEA_ACP_RUNTIME_CONFIG).toBe(before)
    expect(args.filter(arg => arg === '--skip-safe-check')).toHaveLength(2)
  })

  it('rejects non-string runtime arguments before registering providers', () => {
    expect(() => product.configuredProviderPlugins({ PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({
      version: 1, providers: { 'pangea-nga': { args: ['acp', 42] } }
    }) })).toThrow('pangea-nga ACP args must be strings')
  })

  it.each(['pangea-nga', 'pangea-codeagent'])('preserves positional flag-shaped values after -- for %s', providerName => {
    for (const options of [['acp'], ['acp', '--skip-safe-check', '--skip-safe-check']]) {
      const positional = ['--', '--skip-safe-check', 'prompt with spaces', '--', '--skip-safe-check']
      const environment = { PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({ version: 1, providers: {
        [providerName]: { args: [...options, ...positional] }
      } }) }
      const config = product.configuredProviderPlugins(environment).find(([, value]) => value.providerName === providerName)[1]
      expect(config.args).toEqual(['acp', '--skip-safe-check', ...positional])
      const secondPass = product.configuredProviderPlugins({ PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({ version: 1, providers: {
        [providerName]: { args: config.args }
      } }) }).find(([, value]) => value.providerName === providerName)[1]
      expect(secondPass.args).toEqual(config.args)
    }
  })

  it('isolates OpenCode plugin tools without changing inherited models or other permissions', () => {
    for (const permission of ['ask', { 'pangea_*': 'allow', bash: 'ask', pangea_task_open: 'allow' }]) {
      const original = { model: 'provider/model', permission, tools: { webfetch: false } }
      const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify(original) }
      const entries = product.configuredProviderPlugins(env)
      const scoped = JSON.parse(entries.find(([, config]) => config.providerName === 'pangea-opencode')[1].env.OPENCODE_CONFIG_CONTENT)
      expect(scoped.model).toBe(original.model)
      expect(scoped.tools).toEqual(original.tools)
      expect(scoped.permission['pangea_*']).toBe('deny')
      expect(Object.keys(scoped.permission).at(-1)).toBe('pangea_*')
      expect(scoped.permission[typeof permission === 'string' ? '*' : 'bash']).toBe('ask')
      expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual(original)
      expect(entries.find(([, config]) => config.providerName === 'pangea-nga')[1].env).toEqual({})
    }
  })
})
