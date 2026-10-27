import { createInterface } from 'node:readline'
import { execFileSync, spawn } from 'node:child_process'
const mode = process.env.PANGEA_FIXTURE_MODE ?? 'ok'
if (process.argv.includes('--version')) { process.stdout.write('acp-fixture 1.0\n'); process.exit(0) }
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
let sessionId = 'remote-fixture', pendingPrompt, promptCount = 0, descendant
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
      if (mode === 'resume-replay' || mode === 'resume-replay-pending') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier conversation' } })
        update({ sessionUpdate: 'tool_call', toolCallId: 'earlier-tool', title: 'earlier tool', kind: 'edit', status: mode === 'resume-replay-pending' ? 'pending' : 'completed', rawInput: {} })
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
  promptCount++
  if (mode.startsWith('lifecycle-')) {
    const pending = (toolCallId, extra = {}) => update({ sessionUpdate: 'tool_call', toolCallId, title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {}, ...extra })
    if (mode === 'lifecycle-codeagent-edit-pending' || mode.startsWith('lifecycle-codeagent-edit-tree')) {
      const report = () => {
        for (const toolCallId of ['chatcmpl-tool-a5d001413b8ce96b', 'chatcmpl-tool-9d4de9f2c34f4134', 'chatcmpl-tool-984abc3da7ac9c06', 'chatcmpl-tool-9f3f38a0ce05f4be']) pending(toolCallId, { title: 'Edit', kind: 'edit' })
        // Match the reported 208 accepted events without inventing a terminal
        // update for any of the four unresolved IDs.
        for (let index = 0; index < 102; index++) {
          pending(`finished-${index}`, { kind: 'read' })
          update({ sessionUpdate: 'tool_call_update', toolCallId: `finished-${index}`, status: 'completed' })
        }
        if (descendant) update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify({ descendant_pid: descendant.pid }) } })
        reply({ stopReason: 'end_turn' })
      }
      if (mode.startsWith('lifecycle-codeagent-edit-tree')) {
        descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000); process.send("ready")'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
        descendant.once('message', report)
      } else report()
      return
    } else if (mode === 'lifecycle-empty-pending') {
      pending('chatcmpl-tool-a873a78f7e539d5e')
      pending('chatcmpl-tool-9e4b74cbae3ac799')
      pending('completed-tool', { status: 'in_progress', rawInput: { command: 'PRIVATE_COMMAND_BODY' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'completed-tool', status: 'completed', rawOutput: { stdout: 'PRIVATE_OUTPUT_BODY', exitCode: 0 } })
    } else if (mode === 'lifecycle-invalid-final') {
      pending('invalid-final-tool')
      // Invalid status/content can be silently defaulted by ACP SDK 0.25.1.
      // An invalid title type reliably fails that same SDK notification schema.
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'invalid-final-tool', status: 'completed', title: { invalid: 'PRIVATE_INVALID_TITLE' }, rawOutput: { stdout: 'PRIVATE_OUTPUT_BODY', exitCode: 0 } })
    } else if (mode === 'lifecycle-bounded') {
      for (let index = 0; index < 320; index++) pending(`bounded-${index}`)
      for (let index = 0; index < 20; index++) update({ sessionUpdate: 'tool_call_update', toolCallId: 'bounded-0', status: 'completed', title: { invalid: 'PRIVATE_INVALID_TITLE' } })
    } else if (mode === 'lifecycle-cross-request') {
      if (promptCount === 1) {
        pending('old-tool')
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed', rawOutput: { stdout: 'old-done', exitCode: 0 } })
      } else {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', title: 'late metadata' })
        send({ method: 'session/update', params: { sessionId: 'foreign-fixture', update: { sessionUpdate: 'tool_call', toolCallId: 'foreign-tool', title: 'Terminal', kind: 'execute', status: 'pending', rawInput: {} } } })
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'foreign-tool', status: 'completed' })
      }
    } else if (mode === 'lifecycle-unclosed-continue') {
      pending('stuck-read')
      setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'stuck-read', status: 'completed', rawOutput: { stdout: 'read-done', exitCode: 0 } }), 40)
    } else {
      pending('lifecycle-tool', { title: 'PRIVATE_TITLE_BODY', rawInput: { command: 'PRIVATE_COMMAND_BODY', token: 'PRIVATE_TOKEN_BODY' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'lifecycle-tool', status: 'in_progress' })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'lifecycle-tool', content: [{ type: 'content', content: { type: 'text', text: 'PRIVATE_PARTIAL_OUTPUT' } }] })
      if (mode === 'lifecycle-normal') update({ sessionUpdate: 'tool_call_update', toolCallId: 'lifecycle-tool', status: 'completed', rawOutput: { stdout: 'PRIVATE_OUTPUT_BODY', exitCode: 0 } })
    }
    reply({ stopReason: 'end_turn' })
    if (mode === 'lifecycle-late') setTimeout(() => update({ sessionUpdate: 'tool_call_update', toolCallId: 'lifecycle-tool', status: 'completed', rawOutput: { stdout: 'PRIVATE_LATE_OUTPUT', exitCode: 0 } }), 40)
    return
  }
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
}).on('close', () => {
  // Keep the owned descendant alive across EOF so the provider must use its
  // managed-tree teardown, rather than proving only the protocol PID exited.
  if (!descendant || mode === 'lifecycle-codeagent-edit-tree-root-exit') process.exit(0)
})
