import { readFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

async function batchEncoder() {
  const source = await readFile(join(root, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'), 'utf8')
  const start = source.indexOf('function windowsBatchLaunch(')
  const end = source.indexOf('\n/**', start)
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  // Run the installed encoder; only the Windows file checks are substituted.
  // The packaged Windows test additionally checks the child's actual argv.
  return runInNewContext('(' + source.slice(start, end) + ')', {
    extname: win32.extname, win32,
    environmentValue: (env: Record<string, string>, name: string) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) ?? ''],
    statSync: () => ({ isFile: () => true }), accessSync() {}, constants: { F_OK: 0 },
  })
}

describe('external Agent provider patches', () => {
  it('passes plain option names without quotes to batch wrappers', async () => {
    const encode = await batchEncoder()
    const batch = 'C:\\Users\\tester\\OCHOME\\nga.cmd'
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    // Match the user-verified command: only the option loses its quotes.
    expect(encode([batch, 'acp', '--skip-safe-check'], env).args.at(-1))
      .toBe(`""${batch}" "acp" --skip-safe-check"`)
    expect(encode([batch, '--print-logs', '--log-level', 'ERROR', '-v'], env).args.at(-1))
      .toBe(`""${batch}" --print-logs --log-level "ERROR" -v"`)
  })

  it('keeps values and option-like arguments containing shell syntax quoted', async () => {
    const encode = await batchEncoder()
    const batch = 'C:\\Agent Tools\\nga.cmd'
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    for (const value of ['', 'value with spaces', '中文参数', 'A&B', '--x&echo', '--x|more', '--x>out', '--x<input', '--x(group)', '--x!', '--x\ty', '--cwd=C:\\some path', '--', '-1', '--flag=value', 'acp']) {
      expect(encode([batch, value], env).args.at(-1)).toBe(`""${batch}" "${value}""`)
    }
  })

  it('quotes trailing backslashes and rejects argv changed by cmd expansion or nested CALL', async () => {
    const encode = await batchEncoder()
    const env = { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    const batch = 'C:\\Program Files\\Agent\\nga.cmd'
    const launch = encode([batch, 'acp', '', 'C:\\tail\\'], env)
    expect(launch.args.slice(0, -1)).toEqual(['/d', '/q', '/v:off', '/s', '/c'])
    expect(launch.args.at(-1)).toBe('"' + '"' + batch + '" "acp" "" "C:\\tail\\\\"' + '"')
    expect(launch.windowsVerbatimArguments).toBe(true)
    for (const invalid of ['caret^', 'bad"quote', '%PATH%', 'line\nbreak', 'line\rbreak', 'nul\0byte']) {
      expect(() => encode([batch, invalid], env)).toThrow(/windowsBatch argv cannot contain.*argv\[1\]/)
    }
    expect(() => encode(['C:\\Agent^Tools\\nga.cmd', 'acp'], env)).toThrow(/windowsBatch argv cannot contain.*argv\[0\]/)
  })

  it('applies the explicit Windows batch contract to the installed dependency graph', async () => {
    const [subprocessTypes, localRuntime, acpProvider] = await Promise.all([
      readFile(join(root, 'node_modules/@deepseek-ai/dsh-subprocess/lib/types/types.d.ts'), 'utf8'),
      readFile(join(root, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js'), 'utf8'),
      readFile(join(root, 'node_modules/@deepseek-ai/dsh-subagent-acp/lib/index.js'), 'utf8')
    ])

    expect(subprocessTypes).toContain('windowsBatch?: boolean | undefined')
    expect(localRuntime).toContain('function windowsBatchLaunch(argv, env)')
    expect(localRuntime).toContain('windowsVerbatimArguments: true')
    expect(localRuntime).toContain('["/d", "/q", "/v:off", "/s", "/c"')
    expect(acpProvider).toContain('const windowsBatch = process.platform === "win32"')
    expect(acpProvider).toContain('windowsBatch: spec.windowsBatch')
    expect(acpProvider).toContain('launchStage: "spawn_process"')
    expect(acpProvider).toContain('ACP_CONTINUATION_NOT_IDLE')
    expect(acpProvider).toContain('continuation_rejected')
    expect(acpProvider).toContain('unclosed_tools')
  })

  it('ships the shared command probe through the product package export', async () => {
    const manifest = JSON.parse(await readFile(join(root, 'packages/dsh-pangea-product/package.json'), 'utf8'))
    expect(manifest.exports['./agent-command-probe']).toEqual({
      types: './agent-command-probe.d.ts',
      default: './agent-command-probe.js'
    })
    const probe = await import('../packages/dsh-pangea-product/agent-command-probe.js')
    expect(probe.resolveAgentCommandWithPowerShell('nga', {}, () => JSON.stringify({
      found: true,
      command: 'C:\\Users\\tester\\OCHOME\\nga.cmd',
      version: 'nga 1.0'
    }))).toEqual({ command: 'C:\\Users\\tester\\OCHOME\\nga.cmd', version: 'nga 1.0' })
  })
})
