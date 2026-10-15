import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
const mode = process.env.PANGEA_FIXTURE_MODE ?? 'ok'
if (process.argv.includes('--version')) { process.stdout.write('acp-fixture 1.0\n'); process.exit(0) }
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
let sessionId = 'remote-fixture', pendingPrompt
const update = value => send({ method: 'session/update', params: { sessionId, update: value } })
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  const reply = result => send({ id: request.id, result })
  if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { loadSession: mode.startsWith('resume') }, agentInfo: { name: 'fixture', version: '1.0' } })
  if (request.method === 'session/new' && mode.startsWith('resume')) { process.stderr.write('UNEXPECTED_NEW_SESSION'); process.exit(4) }
  if (request.method === 'session/load') {
    if (mode === 'resume-missing') send({ id: request.id, error: { code: -32001, message: 'session not found' } })
    else if (request.params.sessionId !== 'original-remote') send({ id: request.id, error: { code: -32001, message: 'wrong session' } })
    else {
      sessionId = request.params.sessionId
      if (mode === 'resume-replay') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier conversation' } })
        update({ sessionUpdate: 'tool_call', toolCallId: 'earlier-tool', title: 'earlier tool', status: 'completed' })
      }
      reply({})
    }
  }
  if (request.method === 'session/new') reply({ sessionId: 'remote-fixture', ...(mode === 'no-model' ? {} : { models: { currentModelId: 'fixture/model', availableModels: [{ modelId: 'fixture/model', name: 'Fixture' }] } }) })
  if (request.method === 'session/cancel' && mode === 'transcript-cancel' && pendingPrompt) {
    send({ id: pendingPrompt.id, result: { stopReason: 'cancelled' } })
    pendingPrompt = null
    setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: 'completed', rawOutput: { stdout: 'late tool result', exitCode: 0 } }), 40)
  }
  if (request.id === 'permission-1' && request.result && pendingPrompt) {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Permission: ${request.result.outcome.outcome}` } })
    send({ id: pendingPrompt.id, result: { stopReason: 'end_turn' } })
    pendingPrompt = null
  }
  if (request.method !== 'session/prompt') return
  if (mode === 'hang') return
  if (mode === 'error') {
    process.stderr.write('provider request failed api_key="private-key"\n')
    send({ id: request.id, error: { code: -32001, message: 'request rejected token=private-token' } })
    return
  }
  const text = request.params.prompt.map(block => block.text ?? '').join('')
  const init = text.split('Initialization arguments (JSON): ')[1]
  if (init) {
    const [command, ...args] = JSON.parse(init)
    execFileSync(command, args, { timeout: 10000, maxBuffer: 8192 })
  }
  const tool = text.includes('PANGEA_TOOL_OK')
  if (tool) {
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'echo', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo PANGEA_TOOL_OK' } })
    if (mode === 'transcript-cancel') { pendingPrompt = request; return }
    if (mode !== 'tool-partial-pending') update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: mode === 'tool-failed' || mode === 'tool-partial-failed' ? 'failed' : 'completed', rawOutput: { stdout: 'PANGEA_TOOL_OK', exitCode: 0 }, content: [{ type: 'content', content: { type: 'text', text: 'PANGEA_TOOL_OK' } }] })
    if (mode.startsWith('tool-partial')) {
      if (mode === 'tool-partial-concurrent') update({ sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'still running', kind: 'execute', status: 'pending' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', title: 'final output', content: [{ type: 'content', content: { type: 'text', text: 'late output' } }] })
    }
  }
  if (mode === 'transcript-permission') {
    update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will inspect the fixture.' } })
    pendingPrompt = request
    send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId,
      toolCall: { toolCallId: 'tool-permission', title: 'inspect fixture', kind: 'read', rawInput: { path: '/fixture' } },
      options: [{ optionId: 'allow-one', kind: 'allow_once', name: 'Allow once' }] } })
    return
  }
  const message = () => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'empty' ? 'authentication is a topic, not an error' : mode === 'volume' ? 'x'.repeat(200000) + 'PANGEA_PING_OK' : tool ? 'PANGEA_TOOL_OK' : 'PANGEA_PING_OK' } })
  if (mode === 'delayed') setTimeout(message, 80)
  else message()
  reply({ stopReason: 'end_turn' })
}).on('close', () => process.exit(0))
