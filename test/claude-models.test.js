import path from 'node:path'
import os from 'node:os'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-claude-code'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it } from 'vitest'

async function fixture(test, mode = 'ok') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'claude-models-'))
  const log = path.join(root, 'requests.jsonl')
  const context = new Context()
  const runtime = new LocalSubprocessRuntime(context)
  let provider, child, sdkArgv
  apply({ logger: { warn() {} }, subprocess: { spawn(spec) {
    sdkArgv = spec.argv
    return child = runtime.spawn({ ...spec, argv: [process.execPath, path.resolve('scripts/fixtures/claude-model-cli.mjs')] })
  } }, subagents: { registerProvider(value) { provider = value } } }, Config({
    env: { PANGEA_FIXTURE_MODE: mode, PANGEA_FIXTURE_LOG: log }, disposeGraceMs: 100,
  }))
  try { await test(provider, { requests: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse), argv: () => sdkArgv }) }
  finally {
    if (child) { child.terminate(); await child.waitForExit() }
    await context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}
it('reads the official SDK supportedModels response without submitting a user turn', async () => {
  await fixture(async (provider, trace) => {
    expect(await provider.discoverModels({ cwd: process.cwd(), signal: new AbortController().signal })).toEqual({
      current_model: null, models: [{ id: 'fixture/claude', label: 'Fixture Claude' }],
    })
    expect((await trace.requests()).some(item => item.type === 'user')).toBe(false)
  })
})
it('passes explicit Claude model to the SDK and releases the prompt only after discovery', async () => {
  await fixture(async (provider, trace) => {
    const run = await provider.start({ parent: { session: { header: { cwd: process.cwd() } } },
      signal: new AbortController().signal, prompt: [{ type: 'text', text: 'analyze' }], agentOptions: { model: 'fixture/claude' } })
    try {
      expect((await run.result).stopReason).toBe('completed')
      expect(trace.argv().slice(trace.argv().indexOf('--model'), trace.argv().indexOf('--model') + 2)).toEqual(['--model', 'fixture/claude'])
      expect((await trace.requests()).map(item => item.type)).toEqual(['control_request', 'user'])
    } finally { await run.dispose() }
  })
})
it('rejects a removed Claude model without submitting a prompt', async () => {
  await fixture(async (provider, trace) => {
    await expect(provider.start({ parent: { session: { header: { cwd: process.cwd() } } },
      signal: new AbortController().signal, prompt: [{ type: 'text', text: 'must not run' }], agentOptions: { model: 'removed' } })).rejects.toThrow()
    expect((await trace.requests()).some(item => item.type === 'user')).toBe(false)
  })
})
it('cancels Claude model discovery while SDK initialization is stalled', async () => {
  await fixture(async provider => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    try { await expect(provider.discoverModels({ cwd: process.cwd(), signal: controller.signal })).rejects.toThrow() }
    finally { clearTimeout(timer) }
  }, 'hang')
})
