import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

// Explicit opt-in real-provider probe. Never points at an existing user task.
const cwd = process.env.PANGEA_TEST_ACP_CWD
const model = process.env.PANGEA_TEST_ACP_MODEL
assert.ok(cwd && path.isAbsolute(cwd), 'Set an absolute isolated PANGEA_TEST_ACP_CWD')
assert.ok(model, 'Set PANGEA_TEST_ACP_MODEL to an available model ID')
mkdirSync(cwd, { recursive: true })
const lines = Number(process.env.PANGEA_TEST_ACP_LINES || 800)
assert.ok(Number.isInteger(lines) && lines >= 10 && lines <= 2000)
const eventsPath = path.join(cwd, 'events.jsonl'), results = []
// Fail rather than overwrite evidence from an earlier run.
writeFileSync(eventsPath, '', { flag: 'wx' })
const markers = []
for (let round = 1; round <= 3; round++) {
  const marker = `VERIFIED_${round}_${createHash('sha256').update(`round-${round}`).digest('hex').slice(0, 12)}`
  markers.push(marker)
  const body = Array.from({ length: lines }, (_, i) => `${String(i + 1).padStart(4, '0')} record=${createHash('sha256').update(`${round}:${i}`).digest('hex')} payload=${createHash('sha256').update(`payload:${round}:${i}`).digest('hex')}${i === lines - 1 ? ` final_marker=${marker}` : ''}`).join('\n')
  writeFileSync(path.join(cwd, `input-${round}.txt`), body + '\n', { flag: 'wx' })
}
const context = new Context(), controller = new AbortController()
let provider, run, failure
const env = {}
for (const name of ['OPENCODE_CONFIG_CONTENT', ...(process.env.PANGEA_TEST_ACP_FORWARD_ENV || '').split(',').filter(Boolean)]) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
apply({ logger: { warn: message => process.stderr.write(`${message}\n`) },
  subprocess: new LocalSubprocessRuntime(context), subagents: { registerProvider(value) { provider = value } } }, Config({
  providerName: 'pangea-opencode', command: process.env.PANGEA_TEST_OPENCODE_COMMAND || 'opencode', args: ['acp'],
  cwd, env, permission: 'allow', disposeEofGraceMs: 3000, disposeGraceMs: 1000,
}))
const timer = setTimeout(() => controller.abort(new Error('Long-context probe timed out')), 600000)
const record = event => appendFileSync(eventsPath, JSON.stringify(event) + '\n')
try {
  for (let round = 1; round <= 3; round++) {
    const before = run?.readDiagnostics()
    const prompt = [{ type: 'text', text: `Round ${round} of a sequential reading verification. Read every line of input-${round}.txt using the read tool in chunks of at most 150 lines until all ${lines} lines are read. Do not use bash, scripts, grep, or summarize without reading. Do not reread previous inputs. After reading, reply with only the exact final_marker value from the last line. No file edits.` }]
    record({ type: 'host_dispatch', round, at: new Date().toISOString(), prompt_bytes: Buffer.byteLength(prompt[0].text), before })
    if (before) {
      assert.equal(before.activeToolCount, 0)
      assert.equal(before.toolLifecycle.unclosed_count, 0)
    }
    if (!run) run = await provider.start({ parent: { session: { header: { cwd } } }, signal: controller.signal,
      agentOptions: { model }, prompt, onSessionEvent: record })
    const outcome = round === 1 ? await run.result : await run.continuePrompt(prompt)
    const diagnostics = run.readDiagnostics()
    results.push({ round, outcome, diagnostics })
    record({ type: 'host_result', round, at: new Date().toISOString(), outcome, diagnostics })
    process.stdout.write(JSON.stringify({ round, model: diagnostics.model, stopReason: outcome.stopReason,
      active: diagnostics.activeToolCount, toolCalls: diagnostics.toolCalls, error: diagnostics.errorSummary }) + '\n')
    assert.equal(outcome.stopReason, 'completed')
    assert.equal(diagnostics.model, model)
    assert.ok(outcome.output.some(item => item.type === 'text' && item.text.includes(markers[round - 1])))
    assert.ok(diagnostics.toolCalls > (before?.toolCalls ?? 0), 'each turn must actually use tools')
    assert.equal(diagnostics.activeToolCount, 0)
    assert.equal(diagnostics.toolLifecycle.unclosed_count, 0)
  }
} catch (error) {
  failure = { name: error.name, message: error.message, code: error.code }
  process.exitCode = 1
  console.error(JSON.stringify(failure))
} finally {
  clearTimeout(timer)
  await run?.dispose()
  await context.fiber.dispose()
  writeFileSync(path.join(cwd, 'result.json'), JSON.stringify({ model, lines, results, failure,
    finalDiagnostics: run?.readDiagnostics() }, null, 2))
}
