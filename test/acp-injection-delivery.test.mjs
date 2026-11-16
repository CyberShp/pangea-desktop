import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

const companionRoot = process.env.PANGEA_TEST_COMPANION_ROOT
// Real companion generator, shipped ACP adapter, SDK, subprocess and filesystem.
// The JSON-RPC CLI is a deterministic fixture, not the internal CodeAgent binary.
for (const [mode, error] of [
  ['injection-result', null],
  ['connection-error', /Unable to connect: ConnectionRefused/],
  ['silent-session-error', /未交付.*task-fixture.*remote-fixture/],
  ['injection-invalid-json', /打桩生成结果不可读取.*JSON/],
  ['max_tokens', /打桩生成结束：max-tokens/],
  ['cancelled', /打桩生成结束：aborted/],
]) test(`ACP → injection delivery: ${mode}`, {
  skip: !companionRoot && 'Set PANGEA_TEST_COMPANION_ROOT to the pinned Companion plugin directory', timeout: 10000,
}, async t => {
  const { createInjectionGenerator } = await import(pathToFileURL(path.join(companionRoot, 'src/fault-injection-agent.js')).href)
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'acp-injection-'))
  const outputPath = path.join(cwd, 'result.json')
  await mkdir(path.join(cwd, '.agents/pangea'), { recursive: true })
  await writeFile(path.join(cwd, '.agents/pangea/dsh.md'), '# fixture')
  const context = new Context(), events = []
  let provider, worker, disposed = 0
  apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context),
    subagents: { registerProvider(value) { provider = value } } }, Config({
    providerName: 'pangea-nga', command: process.execPath,
    args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: mode, PANGEA_FIXTURE_OUTPUT: outputPath }, disposeEofGraceMs: 100, disposeGraceMs: 100,
  }))
  const runtime = { agents: { get: () => ({ session: { header: { cwd } } }) }, subagents: {
    start: async (_, request) => {
      worker = await provider.start({ ...request, onSessionEvent: value => events.push(value) })
      const dispose = worker.dispose.bind(worker)
      worker.dispose = async () => { disposed++; await dispose() }
      return worker
    },
  } }
  try {
    const generate = createInjectionGenerator(runtime, { resolveModel: async () => 'fixture/model', createSession: async () => 'parent' })
    const result = generate({ record: { id: 'task-fixture', provider_id: 'pangea-nga', agent_model: 'fixture/model' },
      cwd, scratchDirectory: cwd, outputPath, prompt: 'generate fixture result', signal: AbortSignal.any([t.signal, AbortSignal.timeout(7000)]), onStarted: async () => {} })
    if (error) await assert.rejects(result, error)
    else assert.deepEqual(await result, { summary: 'fixture delivery', edits: [] })
    assert.equal(disposed, 1)
    assert.equal(worker.readDiagnostics().processExited, true)
    if (mode === 'connection-error') {
      assert.equal(events.find(event => event.type === 'turn_end').stop_reason, 'error')
      assert.match(worker.readDiagnostics().errorSummary, /ConnectionRefused/)
    }
    if (mode === 'silent-session-error') assert.equal(events.find(event => event.type === 'turn_end').protocol_stop_reason, 'end_turn')
  } finally {
    await worker?.dispose()
    await context.fiber.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
