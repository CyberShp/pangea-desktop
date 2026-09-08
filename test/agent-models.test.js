import path from 'node:path'
import os from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'

async function withProvider(mode, test) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-models-'))
  const log = path.join(root, 'requests.jsonl')
  const context = new Context()
  const subprocess = new LocalSubprocessRuntime(context)
  let provider, child
  apply({ logger: { warn() {} }, subprocess: { spawn(spec) { return child = subprocess.spawn(spec) },
    resolveExecutable: (...args) => subprocess.resolveExecutable(...args) },
  subagents: { registerProvider(value) { provider = value } } }, Config({
    command: process.execPath, args: [path.resolve('scripts/fixtures/acp-model-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: mode, PANGEA_FIXTURE_LOG: log }, disposeEofGraceMs: 100, disposeGraceMs: 100,
  }))
  try {
    await test(provider, async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse))
    if (child) expect(await child.waitForExit()).toBe(true)
  } finally { await context.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}
for (const mode of ['config', 'legacy', 'none']) {
  it(`discovers ${mode} models without sending a prompt and reaps its process`, async () => {
    await withProvider(mode, async (provider, requests) => {
      const result = await provider.discoverModels({ cwd: process.cwd(), signal: new AbortController().signal })
      expect(result.models.map(item => item.id)).toEqual(mode === 'none' ? [] : ['fixture/default', 'fixture/selected'])
      expect((await requests()).map(item => item.method)).toEqual(['initialize', 'session/new'])
    })
  })
}
for (const mode of ['config', 'legacy']) {
  it(`applies ${mode} selection before prompt and keeps it during continuation`, async () => {
    await withProvider(mode, async (provider, requests) => {
      const run = await provider.start({ parent: { session: { header: { cwd: process.cwd() } } },
        signal: new AbortController().signal, prompt: [{ type: 'text', text: 'first' }], agentOptions: { model: 'fixture/selected' } })
      try {
        expect((await run.result).output[0].text).toBe('fixture/selected')
        expect((await run.continuePrompt([{ type: 'text', text: 'next' }])).output[0].text).toBe('fixture/selected')
        expect(run.readDiagnostics().model).toBe('fixture/selected')
        expect((await requests()).map(item => item.method)).toEqual(['initialize', 'session/new',
          mode === 'legacy' ? 'session/set_model' : 'session/set_config_option', 'session/prompt', 'session/prompt'])
      } finally { await run.dispose() }
    })
  })
}
for (const mode of ['none', 'reject', 'ignored']) {
  it(`does not send an analysis prompt when selection is ${mode}`, async () => {
    await withProvider(mode, async (provider, requests) => {
      await expect(provider.start({ parent: { session: { header: { cwd: process.cwd() } } },
        signal: new AbortController().signal, prompt: [{ type: 'text', text: 'must not run' }], agentOptions: { model: 'fixture/selected' } })).rejects.toThrow()
      expect((await requests()).some(item => item.method === 'session/prompt')).toBe(false)
    })
  })
}
it('cancels a stalled handshake and reaps the discovery child', async () => {
  await withProvider('hang', async provider => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 150)
    try { await expect(provider.discoverModels({ cwd: process.cwd(), signal: controller.signal })).rejects.toThrow(/aborted/) }
    finally { clearTimeout(timer) }
  })
})
