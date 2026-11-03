import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'

// Linux protocol subprocess, Windows proof seam mocked only during stop. This
// validates orchestration, not native Windows kernel containment.
async function fixture(inspect, { providerName = 'pangea-opencode', discoverOnly = false } = {}) {
  const context = new Context(), runtime = new LocalSubprocessRuntime(context)
  const events = [], specs = []
  let provider, child, run
  apply({ logger: { warn() {} }, subprocess: {
    resolveExecutable: (...args) => runtime.resolveExecutable(...args),
    spawn(spec) {
      specs.push(spec); child = runtime.spawn(spec)
      child.recoveryFenceStatus = { supported: false, reason: 'fixture startup denied', rootPid: child.pid, method: 'windows-job' }
      return child
    },
  }, subagents: { registerProvider(value) { provider = value } } }, Config({
    providerName, command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
    env: { PANGEA_FIXTURE_MODE: 'tool-partial' }, disposeEofGraceMs: 100, disposeGraceMs: 100,
  }))
  try {
    run = await provider.start({ prompt: [{ type: 'text', text: 'PANGEA_TOOL_OK' }], discoverOnly,
      parent: { session: { header: { cwd: process.cwd() } } }, signal: new AbortController().signal,
      onDiagnostic: event => events.push(event) })
    await run.result
    await inspect({ run, child, events, specs })
  } finally { await run?.dispose?.(); await context.fiber.dispose() }
}

for (const providerName of ['pangea-opencode', 'pangea-codeagent', 'pangea-nga', 'ordinary-acp']) {
  for (const discoverOnly of [false, true]) {
    it(`requests launch containment only for executable supported runs: ${providerName}, discovery ${discoverOnly}`, async () => {
      await fixture(({ specs, events }) => {
        expect(specs[0].recoveryFence).toBe(providerName !== 'ordinary-acp' && !discoverOnly)
        expect(events[0]).toMatchObject({ stage: 'spawn_process', stopProofCapability: { supported: false, reason: 'fixture startup denied' } })
      }, { providerName, discoverOnly })
    })
  }
}

for (const mode of ['missing', 'false', 'empty-reason', 'throws', 'success']) {
  it(`cleans up the owned process even when Windows proof is ${mode}, without fabricating proof`, async () => {
    await fixture(async ({ run, child }) => {
      const end = vi.spyOn(child.stdin, 'end')
      let release
      const pending = new Promise(resolve => { release = resolve })
      const proof = vi.fn(async () => {
        await pending
        if (mode === 'throws') throw new Error('query denied')
        return { confirmed: mode === 'success', processTreeStopped: mode === 'success', reason: mode === 'empty-reason' ? '' : 'job unavailable' }
      })
      if (mode !== 'missing') child.quiesceForRecovery = proof
      const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { value: 'win32' })
      try {
        const first = run.stopExecution()
        expect(run.stopExecution()).toBe(first)
        release()
        expect(await first).toMatchObject({ confirmed: mode === 'success', processTreeStopped: mode === 'success' })
        expect(end).toHaveBeenCalledTimes(1)
        expect(await child.waitForExit()).toBe(true)
        expect(run.readDiagnostics().processTreeStopped === true).toBe(mode === 'success')
        if (mode !== 'success') {
          child.quiesceForRecovery = vi.fn(async () => ({ confirmed: true, processTreeStopped: true }))
          expect(await run.stopExecution()).toMatchObject({ confirmed: true })
          expect(child.quiesceForRecovery).toHaveBeenCalledTimes(1)
          expect(end).toHaveBeenCalledTimes(1)
        } else {
          expect(await run.stopExecution()).toMatchObject({ confirmed: true })
          expect(proof).toHaveBeenCalledTimes(1)
        }
      } finally { Object.defineProperty(process, 'platform', descriptor) }
    })
  })
}
