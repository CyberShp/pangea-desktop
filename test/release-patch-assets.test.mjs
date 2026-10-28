import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import test from 'node:test'
import { patchName } from '../scripts/historical-release-lib.mjs'

const script = fileURLToPath(new URL('../scripts/list-release-patch-assets.mjs', import.meta.url))
const digest = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, { base = '2.1.8', badChecksum = false, badReportDigest = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-release-assets-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const patch = patchName('2.1.11', base)
  const patchBytes = 'verified patch fixture'
  await writeFile(path.join(root, patch), patchBytes)
  await writeFile(path.join(root, `${patch}.sha256`), `${badChecksum ? 'b'.repeat(64) : digest(patchBytes)}  ${patch}\n`)
  const report = JSON.stringify({
    target: '2.1.11', discovery_complete: true,
    bases: [{ version: base, status: 'verified', patch, patch_sha256: digest(patchBytes) }]
  })
  const reportName = `pangea-desktop-2.1.11-patch-report-${badReportDigest ? '0'.repeat(12) : digest(report).slice(0, 12)}.json`
  await writeFile(path.join(root, reportName), report)
  return { root, patch, reportName, run: () => spawnSync(process.execPath, [script, '--version', '2.1.11', '--directory', root], { encoding: 'utf8' }) }
}

test('new-release asset listing omits stale retired and unreported patches without modifying files', async t => {
  const f = await fixture(t)
  const stale = patchName('2.1.11', '2.1.7')
  const unreported = patchName('2.1.11', '2.1.9')
  await writeFile(path.join(f.root, stale), 'old build output')
  await writeFile(path.join(f.root, unreported), 'not verified')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(new Set(result.stdout.trim().split(/\r?\n/).map(file => path.basename(file))), new Set([f.patch, `${f.patch}.sha256`, f.reportName]))
  assert.equal(await readFile(path.join(f.root, stale), 'utf8'), 'old build output')
})

for (const [name, options, error] of [
  ['retired verified baseline', { base: '2.1.7' }, /Invalid verified patch record/],
  ['future verified baseline', { base: '2.1.12' }, /Invalid verified patch record/],
  ['cross-channel baseline', { base: '2.1.8-test.1.abcdef0' }, /Invalid verified patch record/],
  ['changed patch checksum', { badChecksum: true }, /Checksum mismatch/],
  ['changed report bytes', { badReportDigest: true }, /Report filename digest mismatch/]
]) {
  test(`new-release asset listing fails closed on ${name}`, async t => {
    const f = await fixture(t, options)
    const result = f.run()
    assert.notEqual(result.status, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, error)
  })
}
