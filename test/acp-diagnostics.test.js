import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'

async function fixtureRun(mode, prompt, inspect, config = {}, request = {}) {
  const context = new Context()
  let provider
  apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, Config({
    command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: mode }, disposeEofGraceMs: 100, disposeGraceMs: 100,
    ...config,
  }))
  let run
  try {
    run = await provider.start({ prompt: [{ type: 'text', text: prompt }], parent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal, ...request })
    await inspect(run, await run.result)
  } finally { await run?.dispose(); await context.fiber.dispose() }
}

it('observes initial and continuation prompts, raw tool payloads and terminal protocol evidence', async () => {
  const events = []
  await fixtureRun('tool-partial', 'PANGEA_TOOL_OK', async run => {
    await run.continuePrompt([{ type: 'text', text: 'Follow up in the same session' }])
    await run.dispose()
    const prompts = events.filter(event => event.type === 'prompt')
    expect(prompts.map(event => event.prompt[0].text)).toEqual(['PANGEA_TOOL_OK', 'Follow up in the same session'])
    expect(new Set(prompts.map(event => event.request_id)).size).toBe(2)
    expect(events[0]).toMatchObject({ type: 'session_bound', agent_session_id: run.id, remote_session_id: run.remoteSessionId, resumed: false })
    expect(events.every(event => !Number.isNaN(Date.parse(event.at)) && event.agent_session_id === run.id && event.remote_session_id === run.remoteSessionId)).toBe(true)
    expect(events.find(event => event.update?.sessionUpdate === 'tool_call').update.rawInput).toEqual({ command: 'echo PANGEA_TOOL_OK' })
    expect(events.find(event => event.update?.rawOutput).update.rawOutput).toEqual({ stdout: 'PANGEA_TOOL_OK', exitCode: 0 })
    expect(events.find(event => event.update?.title === 'final output').update).not.toHaveProperty('status')
    expect(events.filter(event => event.type === 'turn_end')).toEqual(prompts.map(prompt => expect.objectContaining({ request_id: prompt.request_id, stop_reason: 'completed', protocol_stop_reason: 'end_turn', response_received: true })))
    expect(events.at(-1)).toMatchObject({ type: 'process_exit', exit_code: 0 })
    expect(JSON.stringify(events)).not.toContain('PANGEA_FIXTURE_MODE')
  }, {}, { onSessionEvent: event => events.push(event) })
})

it('isolates observer mutation, synchronous exceptions and asynchronous rejections from execution', async () => {
  let observed = 0
  await fixtureRun('tool-partial', 'PANGEA_TOOL_OK', (run, result) => {
    expect(observed).toBeGreaterThan(4)
    expect(result.stopReason).toBe('completed')
    expect(result.output[0].text).toBe('PANGEA_TOOL_OK')
    expect(run.readDiagnostics()).toMatchObject({ lastToolStatus: 'completed', activeToolCount: 0 })
  }, {}, { onSessionEvent: event => {
    observed++
    if (event.type === 'prompt') { event.prompt[0].text = 'observer mutation'; throw new Error('observer sync failure') }
    if (event.update) event.update.status = 'pending'
    return Promise.reject(new Error('observer async failure'))
  } })
})

it('retains thought updates and actual permission decisions', async () => {
  const events = []
  await fixtureRun('transcript-permission', 'inspect', (run, result) => {
    expect(result.stopReason).toBe('completed')
    expect(events.find(event => event.update?.sessionUpdate === 'agent_thought_chunk').update.content.text).toContain('inspect')
    expect(events.find(event => event.type === 'permission')).toMatchObject({
      request: { toolCall: { toolCallId: 'tool-permission', rawInput: { path: '/fixture' } } },
      outcome: { outcome: 'selected', optionId: 'allow-one' },
    })
  }, { permission: 'allow' }, { onSessionEvent: event => events.push(event) })
})

it('observes real cancellation followed by a late tool result without inventing completion', async () => {
  const context = new Context(), events = []
  let provider, run, notifyTool, notifyLate
  const started = new Promise(resolve => { notifyTool = resolve })
  const late = new Promise(resolve => { notifyLate = resolve })
  apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, Config({
    command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: 'transcript-cancel' }, disposeEofGraceMs: 100, disposeGraceMs: 100,
  }))
  try {
    run = await provider.start({ prompt: [{ type: 'text', text: 'PANGEA_TOOL_OK' }], parent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal,
      onSessionEvent: event => { events.push(event); if (event.update?.status === 'in_progress') notifyTool(); if (event.update?.rawOutput?.stdout === 'late tool result') notifyLate() } })
    await started
    expect(await run.cancelTurn()).toMatchObject({ confirmed: true, outcome: { stopReason: 'aborted', protocolStopReason: 'cancelled' } })
    const end = events.find(event => event.type === 'turn_end')
    expect(end).toMatchObject({ stop_reason: 'aborted', protocol_stop_reason: 'cancelled', response_received: true })
    await late
    expect(events.at(-1)).toMatchObject({ type: 'session_update', request_id: end.request_id, update: { status: 'completed', rawOutput: { stdout: 'late tool result' } } })
    expect(events.filter(event => event.type === 'prompt')).toHaveLength(1)
  } finally { await run?.dispose(); await context.fiber.dispose() }
})

it('records protocol errors with an unconfirmed local turn ending', async () => {
  const events = []
  await fixtureRun('error', 'ping', () => {
    expect(events.find(event => event.type === 'error')).toMatchObject({ stage: 'session_prompt', error: { code: '-32001' } })
    expect(events.find(event => event.type === 'turn_end')).toMatchObject({ stop_reason: 'error', protocol_stop_reason: null, response_received: false })
  }, {}, { onSessionEvent: event => events.push(event) })
})

it('marks session/load history as replay instead of attributing it to a new prompt', async () => {
  const events = []
  await fixtureRun('resume-replay', '', async run => {
    const replay = events.filter(event => event.type === 'session_update')
    expect(replay).toHaveLength(2)
    expect(replay.every(event => event.replay === true && event.request_id === null && event.remote_session_id === 'original-remote')).toBe(true)
    await run.continuePrompt([{ type: 'text', text: 'new turn' }])
    const live = events.filter(event => event.type === 'session_update' && !event.replay)
    expect(live).toHaveLength(1)
    expect(live[0].request_id).toBe(events.find(event => event.type === 'prompt').request_id)
  }, {}, { prompt: [], resume: { taskId: 'original-local', remoteSessionId: 'original-remote' }, onSessionEvent: event => events.push(event) })
})

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

for (const mode of ['tool-partial', 'tool-partial-concurrent', 'tool-partial-pending', 'tool-partial-failed']) {
  it(`preserves terminal tool status across partial metadata updates (${mode})`, async () => {
    await fixtureRun(mode, 'PANGEA_TOOL_OK', (run, result) => {
      expect(result.protocolStopReason).toBe('end_turn')
      expect(run.readDiagnostics()).toMatchObject({
        lastToolId: 'tool-1', lastToolStatus: mode === 'tool-partial-pending' ? 'in_progress' : mode === 'tool-partial-failed' ? 'failed' : 'completed',
        activeToolCount: ['tool-partial-concurrent', 'tool-partial-pending'].includes(mode) ? 1 : 0,
      })
    })
  })
}
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

for (const mode of ['resume', 'resume-missing', 'no-model']) {
  it(`restores only the original ACP session (${mode})`, async () => {
    const context = new Context()
    let provider, run
    const events = [], sessionEvents = []
    apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, Config({
      command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
      env: { PANGEA_FIXTURE_MODE: mode }, disposeEofGraceMs: 100, disposeGraceMs: 100,
    }))
    try {
      const pending = provider.start({ prompt: [], resume: { taskId: 'original-local', remoteSessionId: 'original-remote' },
        parent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal,
        onDiagnostic: value => events.push(value), onSessionEvent: value => sessionEvents.push(value) })
      if (mode !== 'resume') {
        await expect(pending).rejects.toThrow(mode === 'resume-missing' ? /session not found/ : /未声明支持恢复/)
        expect(events.some(value => value.stage === 'session_new')).toBe(false)
        return
      }
      run = await pending
      expect(run.id).toBe('original-local')
      expect(run.remoteSessionId).toBe('original-remote')
      expect((await run.result).output).toEqual([])
      expect(run.readOutput()).toBe('')
      expect(sessionEvents).toEqual([expect.objectContaining({ type: 'session_bound', agent_session_id: 'original-local', remote_session_id: 'original-remote', resumed: true })])
      expect((await run.continuePrompt([{ type: 'text', text: 'ping' }])).stopReason).toBe('completed')
      expect(run.readOutput()).toContain('PANGEA_PING_OK')
      expect(sessionEvents.every(event => event.agent_session_id === 'original-local' && event.remote_session_id === 'original-remote')).toBe(true)
    } finally { await run?.dispose(); await context.fiber.dispose() }
  })
}
