import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAcpProvider } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixture = path.join(projectRoot, 'scripts', 'fixtures', 'acp-batch-agent.mjs')

describe('patched ACP provider launch', () => {
  it('runs the packaged verification registration, continuation, and cancellation on the native path', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(projectRoot, 'scripts/verify-packaged-acp-batch-launch.mjs'), '--native',
    ], { cwd: projectRoot, env: { ...process.env, PANGEA_TEST_APP_ROOT: projectRoot }, timeout: 20_000 })
    const report = JSON.parse(stdout)
    expect(report.status).toBe('ok')
    expect(report.results.some(result => result.sameSessionContinuation === true && result.launcherKind === 'direct')).toBe(true)
    expect(report.results.some(result => result.cancellation === 'aborted')).toBe(true)
  }, 25_000)

  it.each([
    { command: process.execPath, cwd: projectRoot },
    ...(process.platform === 'win32' ? [] : [{ command: `./${path.basename(process.execPath)}`, cwd: path.dirname(process.execPath) }]),
  ])('keeps native command $command on the direct subprocess path', async ({ command, cwd }) => {
    const serviceContext = new Context()
    let provider
    const ctx = {
      logger: { warn() {} },
      subagents: { registerProvider(value) { provider = value } },
    }
    ctx.subprocess = new LocalSubprocessRuntime(serviceContext)
    applyAcpProvider(ctx, {
      providerName: 'fixture-acp',
      command,
      configuredCommand: 'fixture-agent',
      args: [fixture],
      cwd,
      permission: 'allow',
      env: { PANGEA_TEST_APP_ROOT: projectRoot },
      disposeEofGraceMs: 1_000,
      disposeGraceMs: 1_000,
    })

    let run
    try {
      run = await provider.start({
        prompt: [{ type: 'text', text: 'fixture prompt' }],
        parent: { session: { header: { cwd: projectRoot } } },
        signal: new AbortController().signal,
      })
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(result.output.map(item => item.type === 'text' ? item.text : '').join('')).toContain('ACP_BATCH_READY')
      expect(run.launch).toMatchObject({
        configuredCommand: 'fixture-agent',
        resolvedCommand: command,
        launcherKind: 'direct',
        launcherCommand: command,
        cwd,
      })
      expect(run.processId).toBeGreaterThan(0)
    } finally {
      await run?.dispose?.()
      await serviceContext.fiber.dispose()
    }
  })
})
