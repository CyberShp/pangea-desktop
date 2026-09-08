import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
const mode = process.env.PANGEA_FIXTURE_MODE
let model = 'fixture/default'
const options = () => [{ id: 'llm', name: 'Model', category: 'model', type: 'select', currentValue: model,
  options: [{ group: 'fixture', name: 'Fixture', options: [
    { value: 'fixture/default', name: 'Default' }, { value: 'fixture/selected', name: 'Selected' },
  ] }] }]
const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  appendFileSync(process.env.PANGEA_FIXTURE_LOG, `${line}\n`)
  const reply = result => send({ id: request.id, result })
  if (request.method === 'initialize' && mode !== 'hang') reply({ protocolVersion: 1, agentCapabilities: {} })
  if (request.method === 'session/new') reply({ sessionId: 'models-session',
    ...(mode === 'none' ? {} : mode === 'legacy' ? { models: { currentModelId: model, availableModels: [
      { modelId: 'fixture/default', name: 'Default' }, { modelId: 'fixture/selected', name: 'Selected' },
    ] } } : { configOptions: options() }) })
  if (['session/set_config_option', 'session/set_model'].includes(request.method)) {
    if (mode === 'reject') { send({ id: request.id, error: { code: -32602, message: 'Model access denied' } }); return }
    if (mode !== 'ignored') model = request.params.value ?? request.params.modelId
    reply(request.method === 'session/set_model' ? {} : { configOptions: options() })
  }
  if (request.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: 'models-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: model },
    } } })
    reply({ stopReason: 'end_turn' })
  }
}).on('close', () => process.exit(0))
