import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
const mode = process.env.PANGEA_FIXTURE_MODE ?? 'ok'
if (process.argv.includes('--version')) { process.stdout.write('acp-fixture 1.0\n'); process.exit(0) }
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
const update = value => send({ method: 'session/update', params: { sessionId: 'remote-fixture', update: value } })
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  const reply = result => send({ id: request.id, result })
  if (request.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fixture', version: '1.0' } })
  if (request.method === 'session/new') reply({ sessionId: 'remote-fixture', ...(mode === 'no-model' ? {} : { models: { currentModelId: 'fixture/model', availableModels: [{ modelId: 'fixture/model', name: 'Fixture' }] } }) })
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
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'echo', kind: 'execute', status: 'in_progress' })
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool-1', status: mode === 'tool-failed' ? 'failed' : 'completed', content: [{ type: 'content', content: { type: 'text', text: 'PANGEA_TOOL_OK' } }] })
  }
  const message = () => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: mode === 'empty' ? 'authentication is a topic, not an error' : mode === 'volume' ? 'x'.repeat(200000) + 'PANGEA_PING_OK' : tool ? 'PANGEA_TOOL_OK' : 'PANGEA_PING_OK' } })
  if (mode === 'delayed') setTimeout(message, 80)
  else message()
  reply({ stopReason: 'end_turn' })
}).on('close', () => process.exit(0))
