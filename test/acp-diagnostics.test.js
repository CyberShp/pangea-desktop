import path from 'node:path'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'

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

it('summarizes the exact two empty pending Terminal calls without inferring execution or completion', async () => {
  const events = []
  await fixtureRun('lifecycle-empty-pending', 'inspect', (run, result) => {
    expect(result).toMatchObject({ stopReason: 'completed', protocolStopReason: 'end_turn' })
    const lifecycle = run.readDiagnostics().toolLifecycle
    const prompt = events.find(event => event.type === 'prompt')
    expect(lifecycle).toMatchObject({ schema_version: 1, request_id: prompt.request_id, remote_session_id: run.remoteSessionId,
      unclosed_count: 2, pending_count: 2, in_progress_count: 0, unknown_count: 0, tools_truncated: false,
      received_tool_events: 4, accepted_tool_events: 4, unaccepted_tool_events: 0, validation_error_count: 0, observer_error_count: 0 })
    expect(lifecycle.captured_at_ms).toBeGreaterThanOrEqual(Date.parse(events.find(event => event.type === 'turn_end').at))
    expect(lifecycle.tools.map(tool => tool.tool_id)).toEqual(['chatcmpl-tool-a873a78f7e539d5e', 'chatcmpl-tool-9e4b74cbae3ac799'])
    for (const tool of lifecycle.tools) {
      expect(tool).toMatchObject({ status: 'pending', kind: 'execute', request_id: prompt.request_id, remote_session_id: run.remoteSessionId,
        seen_in_progress: false, input_observed: true, input_nonempty: false, output_observed: false,
        received_update_count: 1, accepted_update_count: 1, last_received_status: 'pending' })
      expect(tool.first_seen_at_ms).toBeLessThanOrEqual(tool.last_update_at_ms)
    }
    expect(events.find(event => event.type === 'tool_lifecycle').tool_lifecycle).toMatchObject({ unclosed_count: 2, pending_count: 2 })
    const raw = events.filter(event => event.type === 'acp_tool_transport')
    expect(raw).toHaveLength(4)
    expect(raw.every(event => event.phase === 'received' && event.schema_valid)).toBe(true)
    expect(events.indexOf(raw[0])).toBeLessThan(events.findIndex(event => event.type === 'session_update'))
  }, {}, { onSessionEvent: event => events.push(event) })
})

for (const mode of ['lifecycle-codeagent-edit-pending', 'lifecycle-codeagent-edit-tree', 'lifecycle-codeagent-edit-tree-root-exit']) {
  it(`confirms owned-process quiescence while preserving the four unresolved edit records (${mode})`, async () => {
    const events = []
    await fixtureRun(mode, 'inspect', async (run, result) => {
      expect(result).toMatchObject({ stopReason: 'completed', protocolStopReason: 'end_turn' })
      const before = run.readDiagnostics().toolLifecycle
      expect(before).toMatchObject({ unclosed_count: 4, pending_count: 4, in_progress_count: 0, unknown_count: 0,
        received_tool_events: 208, accepted_tool_events: 208, unaccepted_tool_events: 0, validation_error_count: 0,
        observer_error_count: 0, evidence_evicted_count: 0, tools_truncated: false })
      expect(before.tools.map(tool => tool.tool_id)).toEqual([
        'chatcmpl-tool-a5d001413b8ce96b', 'chatcmpl-tool-9d4de9f2c34f4134',
        'chatcmpl-tool-984abc3da7ac9c06', 'chatcmpl-tool-9f3f38a0ce05f4be',
      ])
      for (const tool of before.tools) expect(tool).toMatchObject({ status: 'pending', kind: 'edit',
        seen_in_progress: false, input_observed: true, input_nonempty: false, output_observed: false,
        received_update_count: 1, accepted_update_count: 1 })
      const descendantPid = mode.includes('-tree') ? JSON.parse(result.output[0].text).descendant_pid : null
      if (descendantPid) expect(() => process.kill(descendantPid, 0)).not.toThrow()
      expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
      expect(run.readDiagnostics()).toMatchObject({ processExited: true, activeToolCount: 4 })
      expect(run.readDiagnostics().toolLifecycle.tools).toEqual(before.tools)
      expect(events.some(event => event.type === 'process_exit')).toBe(true)
      if (descendantPid) {
        const alive = () => {
          try {
            process.kill(descendantPid, 0)
            // An orphan may remain briefly as a reaped-by-init zombie on Linux;
            // it cannot execute or mutate files and is no longer a live process.
            if (process.platform === 'linux') return !/\) Z /.test(readFileSync(`/proc/${descendantPid}/stat`, 'utf8'))
            return true
          } catch (error) {
            if (['ESRCH', 'ENOENT'].includes(error.code)) return false
            throw error
          }
        }
        await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 3000 })
      }
      const prompts = events.filter(event => event.type === 'prompt').length
      await expect(Promise.resolve().then(() => run.continuePrompt([{ type: 'text', text: 'must not run' }]))).rejects.toThrow()
      expect(events.filter(event => event.type === 'prompt')).toHaveLength(prompts)
      expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: true, processTreeStopped: true })
    }, { providerName: 'pangea-codeagent' }, { onSessionEvent: event => events.push(event) })
  }, 10000)
}

it('retains received terminal metadata when the real SDK rejects the notification before its callback', async () => {
  const events = [], sdkErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await fixtureRun('lifecycle-invalid-final', 'inspect', (run, result) => {
      expect(result.stopReason).toBe('completed')
      expect(sdkErrors).toHaveBeenCalledWith('Error handling notification', expect.anything(), expect.anything())
      const lifecycle = run.readDiagnostics().toolLifecycle
      expect(lifecycle).toMatchObject({ unclosed_count: 1, pending_count: 1, received_tool_events: 2, accepted_tool_events: 1,
        unaccepted_tool_events: 1, validation_error_count: 1, validation_errors_truncated: false })
      expect(lifecycle.tools[0]).toMatchObject({ status: 'pending', last_received_status: 'completed', output_observed: true,
        received_update_count: 2, accepted_update_count: 1 })
      expect(lifecycle.validation_errors[0]).toMatchObject({ tool_id: 'invalid-final-tool', code: 'invalid_union', path: ['update'] })
      expect(events.filter(event => event.type === 'session_update' && event.update.toolCallId === 'invalid-final-tool')).toHaveLength(1)
      expect(events.find(event => event.type === 'acp_tool_transport' && event.status === 'completed')).toMatchObject({ schema_valid: false })
      expect(JSON.stringify([lifecycle, ...events.filter(event => ['acp_tool_transport', 'tool_lifecycle'].includes(event.type))])).not.toContain('PRIVATE_')
    }, {}, { onSessionEvent: event => events.push(event) })
  } finally { sdkErrors.mockRestore() }
})

it('keeps successful complete lifecycles quiet and observes partial input/output without storing bodies', async () => {
  const events = []
  await fixtureRun('lifecycle-normal', 'inspect', run => {
    expect(run.readDiagnostics().toolLifecycle).toMatchObject({ unclosed_count: 0, tools: [], received_tool_events: 4, accepted_tool_events: 4, unaccepted_tool_events: 0 })
    expect(events.some(event => event.type === 'tool_lifecycle')).toBe(false)
  }, {}, { onSessionEvent: event => events.push(event) })
  await fixtureRun('lifecycle-partial', 'inspect', run => {
    const lifecycle = run.readDiagnostics().toolLifecycle
    expect(lifecycle).toMatchObject({ unclosed_count: 1, in_progress_count: 1, received_tool_events: 3, accepted_tool_events: 3 })
    expect(lifecycle.tools[0]).toMatchObject({ status: 'in_progress', seen_in_progress: true, input_observed: true,
      input_nonempty: true, output_observed: true, last_received_status: 'in_progress' })
    expect(JSON.stringify(lifecycle)).not.toContain('PRIVATE_')
    lifecycle.tools[0].status = 'completed'
    lifecycle.tools[0].input_observed = false
    lifecycle.validation_errors.push({ code: 'observer mutation' })
    expect(run.readDiagnostics().toolLifecycle.tools[0]).toMatchObject({ status: 'in_progress', input_observed: true })
    expect(run.readDiagnostics().toolLifecycle.validation_errors).toEqual([])
  }, {}, { onDiagnostic: diagnostic => {
    if (diagnostic.toolLifecycle.tools[0]) diagnostic.toolLifecycle.tools[0].status = 'completed'
    throw new Error('diagnostic observer failure')
  }, onSessionEvent: event => {
    if (event.type === 'tool_lifecycle') event.tool_lifecycle.tools[0].status = 'completed'
    if (event.type === 'acp_tool_transport') { event.status = 'completed'; throw new Error('transport observer failure') }
    return Promise.reject(new Error('event observer failure'))
  } })
  expect(JSON.stringify(events.filter(event => event.type === 'acp_tool_transport'))).not.toContain('PRIVATE_')
})

it('continues observing late terminal updates and preserves the earlier end-of-turn snapshot', async () => {
  const events = []
  let notifyLate
  const late = new Promise(resolve => { notifyLate = resolve })
  await fixtureRun('lifecycle-late', 'inspect', async run => {
    const paused = events.find(event => event.type === 'tool_lifecycle')
    expect(paused.tool_lifecycle).toMatchObject({ unclosed_count: 1, in_progress_count: 1 })
    await late
    expect(run.readDiagnostics().toolLifecycle).toMatchObject({ unclosed_count: 0, received_tool_events: 4, accepted_tool_events: 4 })
    expect(paused.tool_lifecycle.unclosed_count).toBe(1)
    const ingress = events.find(event => event.type === 'acp_tool_transport' && event.status === 'completed')
    expect(ingress.request_id).toBe(paused.request_id)
    expect(events.indexOf(ingress)).toBeGreaterThan(events.findIndex(event => event.type === 'turn_end'))
  }, {}, { onSessionEvent: event => { events.push(event); if (event.type === 'session_update' && event.update.status === 'completed') notifyLate() } })
})

it('rejects continuation while tools from the prior turn still lack a terminal status', async () => {
  const events = []
  await fixtureRun('lifecycle-unclosed-continue', 'inspect', async (run, result) => {
    expect(result).toMatchObject({ stopReason: 'completed', protocolStopReason: 'end_turn' })
    expect(run.readDiagnostics()).toMatchObject({ activeToolCount: 1 })
    expect(run.readDiagnostics().toolLifecycle).toMatchObject({ unclosed_count: 1, pending_count: 1 })
    const promptsBefore = events.filter(event => event.type === 'prompt').length
    await expect(run.continuePrompt([{ type: 'text', text: 'must not interrupt live tools' }]))
      .rejects.toThrow(/not idle for continuation/)
    expect(events.filter(event => event.type === 'prompt')).toHaveLength(promptsBefore)
    expect(events.find(event => event.type === 'continuation_rejected')).toMatchObject({
      reason: 'unclosed_tools', unclosed_count: 1, active_tool_count: 1,
    })
    expect(run.readDiagnostics().toolLifecycle.tools[0]).toMatchObject({ tool_id: 'stuck-read', status: 'pending' })
    await vi.waitFor(() => {
      expect(run.readDiagnostics()).toMatchObject({ activeToolCount: 0 })
      expect(run.readDiagnostics().toolLifecycle.unclosed_count).toBe(0)
    }, { timeout: 1000 })
    const resumed = await run.continuePrompt([{ type: 'text', text: 'safe after terminal' }])
    expect(resumed).toMatchObject({ stopReason: 'completed', protocolStopReason: 'end_turn' })
    expect(events.filter(event => event.type === 'prompt')).toHaveLength(promptsBefore + 1)
    expect(events.filter(event => event.type === 'continuation_rejected')).toHaveLength(1)
  }, {}, { onSessionEvent: event => events.push(event) })
})

it('retains prior request and remote session provenance after an idle prior turn', async () => {
  const events = []
  await fixtureRun('lifecycle-cross-request', 'inspect', async run => {
    expect(run.readDiagnostics().toolLifecycle.unclosed_count).toBe(0)
    await run.continuePrompt([{ type: 'text', text: 'next request' }])
    const prompts = events.filter(event => event.type === 'prompt')
    const lifecycle = run.readDiagnostics().toolLifecycle
    expect(lifecycle.request_id).toBe(prompts[1].request_id)
    // The existing execution map still resets statuses each turn. This change
    // reports that behavior and the original owner; it does not silently fix it.
    expect(lifecycle.tools[0]).toMatchObject({ tool_id: 'old-tool', status: 'unknown', request_id: prompts[0].request_id,
      remote_session_id: 'remote-fixture', received_update_count: 3, accepted_update_count: 3 })
    const foreign = events.filter(event => event.type === 'acp_tool_transport' && event.tool_id === 'foreign-tool')
    expect(foreign).toEqual([
      expect.objectContaining({ remote_session_id: 'foreign-fixture', request_id: prompts[1].request_id, status: 'pending' }),
      expect.objectContaining({ remote_session_id: 'remote-fixture', request_id: null, status: 'completed' }),
    ])
  }, {}, { onSessionEvent: event => events.push(event) })
})

it('bounds retained evidence and summaries while keeping totals and old unresolved tools', async () => {
  const sdkErrors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await fixtureRun('lifecycle-bounded', 'inspect', run => {
      const lifecycle = run.readDiagnostics().toolLifecycle
      expect(lifecycle).toMatchObject({ unclosed_count: 320, pending_count: 320, tools_truncated: true,
        received_tool_events: 340, accepted_tool_events: 320, unaccepted_tool_events: 20,
        validation_error_count: 20, validation_errors_truncated: true })
      expect(lifecycle.tools).toHaveLength(50)
      expect(lifecycle.validation_errors).toHaveLength(16)
      expect(lifecycle.evidence_evicted_count).toBeGreaterThan(0)
      expect(lifecycle.tools[0]).toMatchObject({ tool_id: 'bounded-0', status: 'pending', received_update_count: 21, accepted_update_count: 1, last_received_status: 'completed' })
      expect(lifecycle.tools.some(tool => tool.evidence_missing)).toBe(false)
      expect(JSON.stringify(lifecycle)).not.toContain('PRIVATE_')
    })
  } finally { sdkErrors.mockRestore() }
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
    expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
    expect(run.readDiagnostics()).toMatchObject({ promptPending: true, processExited: false })
    expect(await run.cancelTurn()).toMatchObject({ confirmed: true, outcome: { stopReason: 'aborted', protocolStopReason: 'cancelled' } })
    expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
    const end = events.find(event => event.type === 'turn_end')
    expect(end).toMatchObject({ stop_reason: 'aborted', protocol_stop_reason: 'cancelled', response_received: true })
    await late
    expect(events.at(-1)).toMatchObject({ type: 'session_update', request_id: end.request_id, update: { status: 'completed', rawOutput: { stdout: 'late tool result' } } })
    expect(events.filter(event => event.type === 'prompt')).toHaveLength(1)
    if (process.platform !== 'win32') {
      expect(await run.stopExecution()).toMatchObject({ confirmed: true, processTreeStopped: true })
      expect(run.readDiagnostics().processExited).toBe(true)
    }
  } finally { await run?.dispose(); await context.fiber.dispose() }
})

it('records protocol errors with an unconfirmed local turn ending', async () => {
  const events = []
  await fixtureRun('error', 'ping', async run => {
    expect(events.find(event => event.type === 'error')).toMatchObject({ stage: 'session_prompt', error: { code: '-32001' } })
    expect(events.find(event => event.type === 'turn_end')).toMatchObject({ stop_reason: 'error', protocol_stop_reason: null, response_received: false })
    expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
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

it('keeps replayed pending edits as history without reopening live tools or draining historical output', async () => {
  const events = []
  await fixtureRun('resume-replay-pending', '', async run => {
    const replay = events.filter(event => event.type === 'session_update')
    expect(replay).toHaveLength(2)
    expect(replay.every(event => event.replay === true && event.request_id === null)).toBe(true)
    expect(replay[1].update).toMatchObject({ toolCallId: 'earlier-tool', status: 'pending' })
    expect(run.readDiagnostics()).toMatchObject({ activeToolCount: 0, toolCalls: 0, messageChunks: 0 })
    expect(run.readDiagnostics().toolLifecycle.unclosed_count).toBe(0)
    expect(run.readOutput()).toBe('')
    expect(await run.quiesceForRecovery()).toMatchObject({ confirmed: false, processTreeStopped: false })
    const result = await run.continuePrompt([{ type: 'text', text: 'new turn' }])
    expect(result).toMatchObject({ stopReason: 'completed', protocolStopReason: 'end_turn' })
    expect(result.output).toEqual([{ type: 'text', text: 'PANGEA_PING_OK' }])
    expect(run.readDiagnostics().activeToolCount).toBe(0)
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
