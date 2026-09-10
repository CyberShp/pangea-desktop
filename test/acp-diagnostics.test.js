import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'

async function fixtureRun(mode, prompt, inspect, config = {}) {
  const context = new Context()
  let provider
  apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, Config({
    command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: mode }, disposeEofGraceMs: 100, disposeGraceMs: 100,
    ...config,
  }))
  let run
  try {
    run = await provider.start({ prompt: [{ type: 'text', text: prompt }], parent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal })
    await inspect(run, await run.result)
  } finally { await run?.dispose(); await context.fiber.dispose() }
}

it('exposes remote model/session and tool failures through the real ACP transport', async () => {
  await fixtureRun('tool-failed', 'PANGEA_TOOL_OK', (run, result) => {
    expect(run.remoteSessionId).toBe('remote-fixture')
    expect(run.id).not.toBe(run.remoteSessionId)
    expect(result.protocolStopReason).toBe('end_turn')
    expect(run.readDiagnostics()).toMatchObject({ model: 'fixture/model', messageChunks: 1, toolCalls: 1, toolFailures: 1 })
  })
})
it('leaves an unadvertised model unknown', async () => {
  await fixtureRun('no-model', 'ping', run => expect(run.readDiagnostics().model).toBeNull())
})
it('retains bounded structured RPC error evidence', async () => {
  await fixtureRun('error', 'ping', (run, result) => {
    expect(result.stopReason).toBe('error')
    expect(run.readDiagnostics()).toMatchObject({ errorCode: '-32001' })
    expect(run.readDiagnostics().errorSummary).toContain('request rejected')
    expect(run.readDiagnostics().stderrSummary.length).toBeLessThanOrEqual(8192)
  })
})
it('bounds both diagnostic streaming output and result retention', async () => {
  await fixtureRun('volume', 'ping', (run, result) => {
    expect(run.readOutput().length).toBe(8192)
    expect(result.output[0].text.length).toBe(8192)
    expect(result.output[0].text).toContain('PANGEA_PING_OK')
    expect(run.readDiagnostics().outputTruncated).toBe(true)
  }, { diagnosticOutputLimit: 8192 })
})

it('records handshake, turn timing and process exit without retaining arbitrary tool input', async () => {
  await fixtureRun('tool-failed', 'PANGEA_TOOL_OK', async run => {
    const details = run.readDiagnostics()
    expect(details.agentVersion).toBe('1.0')
    expect(details.lastToolStatus).toBe('failed')
    expect(details.lastToolId).toBe('tool-1')
    expect(details.turnDurationMs).toBeGreaterThanOrEqual(0)
    expect(details.firstEventMs).toBeGreaterThanOrEqual(0)
    await run.dispose()
    expect(run.readDiagnostics()).toMatchObject({ processExited: true, exitCode: 0 })
  })
})
