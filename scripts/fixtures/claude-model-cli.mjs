import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
createInterface({ input: process.stdin }).on('line', line => {
  appendFileSync(process.env.PANGEA_FIXTURE_LOG, `${line}\n`)
  const request = JSON.parse(line)
  if (request.type === 'control_request') {
    if (process.env.PANGEA_FIXTURE_MODE === 'hang') return
    send({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id, response: {
      commands: [], agents: [], models: [{ value: 'fixture/claude', displayName: 'Fixture Claude', description: '' }],
      output_style: 'default', available_output_styles: [], account: {},
    } } })
  }
  if (request.type === 'user') send({ type: 'result', subtype: 'success', is_error: false,
    result: 'fixture result', duration_ms: 1, duration_api_ms: 1, num_turns: 1, stop_reason: 'end_turn',
    total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], session_id: 'fixture-session', uuid: randomUUID() })
}).on('close', () => process.exit(0))
