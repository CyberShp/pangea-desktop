import assert from 'node:assert/strict'
import path from 'node:path'
import process from 'node:process'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyAcpProvider } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

const command = process.env.PANGEA_TEST_OPENCODE_COMMAND || 'opencode'
const cwd = path.resolve(process.env.PANGEA_TEST_ACP_CWD || process.cwd())
let provider
const serviceContext = new Context()
const ctx = {
  logger: { warn(message) { process.stderr.write(`${message}\n`) } },
  subagents: { registerProvider(value) { provider = value } },
}
ctx.subprocess = new LocalSubprocessRuntime(serviceContext)
applyAcpProvider(ctx, {
  providerName: 'pangea-opencode',
  command,
  args: ['acp'],
  cwd,
  permission: 'allow',
  env: {},
  disposeEofGraceMs: 6_000,
  disposeGraceMs: 3_000,
})

const controller = new AbortController()
const timeout = setTimeout(() => controller.abort('OpenCode ACP continuation smoke test timed out'), 180_000)
let run
try {
  run = await provider.start({
    prompt: [{ type: 'text', text: 'Reply with exactly TURN_ONE_READY and do not use tools.' }],
    parent: { session: { header: { cwd } } },
    signal: controller.signal,
  })
  const first = await run.result
  assert.equal(first.stopReason, 'completed')
  assert.match(first.output.map(item => item.type === 'text' ? item.text : '').join(''), /TURN_ONE_READY/)

  const second = await run.continuePrompt([
    { type: 'text', text: 'This is the second turn in the same session. Reply with exactly TURN_TWO_READY and do not use tools.' },
  ])
  assert.equal(second.stopReason, 'completed')
  assert.match(second.output.map(item => item.type === 'text' ? item.text : '').join(''), /TURN_TWO_READY/)
  process.stdout.write(JSON.stringify({
    provider: 'pangea-opencode',
    processId: run.processId,
    firstStopReason: first.stopReason,
    firstProtocolStopReason: first.protocolStopReason,
    secondStopReason: second.stopReason,
    secondProtocolStopReason: second.protocolStopReason,
    sameProcess: true,
  }, null, 2))
  process.stdout.write('\n')
} finally {
  clearTimeout(timeout)
  await run?.dispose?.().catch(() => undefined)
}
