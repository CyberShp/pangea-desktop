import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { diagnose, diagnosticText } from '../scripts/diagnose-acp-initialization.mjs'

const options = mode => ({ providerName: 'pangea-nga', cwd: process.cwd(), timeoutMs: 1500, drainMs: 150, stages: ['ping', 'tool'], env: {
  PANGEA_ACP_RUNTIME_CONFIG: JSON.stringify({ version: 1, providers: { 'pangea-nga': { command: process.execPath, args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')] } } }),
} })
// Fixture mode is non-secret; LocalSubprocessRuntime must retain this normal environment field.
async function probe(mode, overrides = {}) {
  const previous = process.env.PANGEA_FIXTURE_MODE
  process.env.PANGEA_FIXTURE_MODE = mode
  try { return await diagnose({ ...options(mode), ...overrides }) }
  finally { if (previous === undefined) delete process.env.PANGEA_FIXTURE_MODE; else process.env.PANGEA_FIXTURE_MODE = previous }
}
it('observes late notifications, real tool output, and disposes the owned child', async () => {
  const report = await probe('delayed')
  expect(report.status).toBe('passed')
  expect(report.cleanup).toBe('completed')
  expect(() => process.kill(report.launcherPid, 0)).toThrow()
})
it('stops on marker-free end_turn without inventing an authentication category', async () => {
  const report = await probe('empty')
  expect(report.status).toBe('failed')
  expect(report.phases.map(item => item.phase)).toEqual(['session', 'ping'])
  expect(report.phases.at(-1).errorCode).toBeNull()
})
it('rejects failed tools even when the model echoes the expected marker', async () => {
  const report = await probe('tool-failed')
  expect(report.phases.at(-1)).toMatchObject({ phase: 'tool', status: 'failed', toolFailures: 1 })
})
it('preserves structured errors and redacts credentials', async () => {
  const report = await probe('error')
  expect(report.phases.at(-1).errorCode).toBe('-32001')
  expect(JSON.stringify(report)).not.toMatch(/private-key|private-token/)
})
it('bounds retained output during a verbose turn', async () => {
  const report = await probe('volume', { stages: ['ping'] })
  expect(report.status).toBe('passed')
  expect(JSON.stringify(report).length).toBeLessThan(4000)
})
it('times out and reaps a nonresponsive prompt', async () => {
  const events = []
  const report = await probe('hang', { timeoutMs: 500, emit: item => events.push(item) })
  expect(report.status).toBe('failed')
  expect(report.cleanup).toBe('completed')
  expect(() => process.kill(report.launcherPid, 0)).toThrow()
  expect(events.some(item => item.phase === 'ping' && item.status === 'start')).toBe(true)
  expect(events.at(-1)).toMatchObject({ phase: 'cleanup', status: 'passed' })
  expect(report.phases.at(-1).durationMs).toBeGreaterThanOrEqual(400)
  expect(report.processes.every(item => item.role && item.finishedAt)).toBe(true)
})
it('redacts URL credentials, bearer authorization and quoted secret fields', () => {
  expect(diagnosticText('https://u:p@host?a=secret Authorization: Bearer private api_key="private value"')).not.toMatch(/secret|private|u:p/)
  expect(diagnosticText('x'.repeat(100000)).length).toBe(8192)
})
it('writes phase evidence and a final report and refuses to overwrite an existing diagnostic directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-probe-journal-test-'))
  const output = path.join(root, 'evidence')
  const args = ['scripts/diagnose-acp-initialization.mjs', '--provider', 'pangea-nga', '--ping-only', '--output-dir', output]
  try {
    await promisify(execFile)(process.execPath, args, { env: { ...process.env, ...options('ok').env, PANGEA_FIXTURE_MODE: 'ok' }, timeout: 10000 })
    const original = await readFile(path.join(output, 'events.jsonl'), 'utf8')
    const events = original.trim().split('\n').map(JSON.parse)
    expect(events.some(item => item.phase === 'ping' && item.status === 'start')).toBe(true)
    expect(events.at(-1)).toMatchObject({ phase: 'cleanup', status: 'passed' })
    expect(JSON.parse(await readFile(path.join(output, 'report.json'), 'utf8')).status).toBe('passed')
    await expect(promisify(execFile)(process.execPath, args, { timeout: 10000 })).rejects.toThrow()
    expect(await readFile(path.join(output, 'events.jsonl'), 'utf8')).toBe(original)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 20000)
it.skipIf(!process.env.PANGEA_TEST_PYTHON || !process.env.PANGEA_TEST_RUNTIME)('initializes an isolated Run and verifies the real Python public API', async () => {
  const report = await probe('ok', { timeoutMs: 10000, stages: ['ping', 'tool', 'init'], python: process.env.PANGEA_TEST_PYTHON, runtimeRoot: process.env.PANGEA_TEST_RUNTIME })
  expect(report.status, JSON.stringify(report)).toBe('passed')
  expect(report.state).toMatchObject({ exists: true, phase: 'STEP_BOOTSTRAP', completed: 0 })
}, 20000)
