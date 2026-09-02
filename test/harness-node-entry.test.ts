import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('Harness Node entry diagnostics', () => {
  it('prints nested AggregateError members that identify the failing loader plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pangea-harness-entry-'))
    temporaryRoots.push(root)
    const failingEntry = join(root, 'failing-entry.mjs')
    await writeFile(failingEntry, `
const loaderFailure = new Error(
  'failed to apply loader entry pangea-nga-acp (@deepseek-ai/dsh-subagent-acp): missing ACP command'
)
throw new AggregateError([loaderFailure], 'loader entries failed to apply')
`)

    const result = spawnSync(
      process.execPath,
      [resolve('build/harness-node-entry.mjs'), failingEntry],
      { encoding: 'utf8' }
    )

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AggregateError: loader entries failed to apply')
    expect(result.stderr).toContain('Aggregate member 1:')
    expect(result.stderr).toContain('pangea-nga-acp (@deepseek-ai/dsh-subagent-acp)')
    expect(result.stderr).toContain('missing ACP command')
  })
})
