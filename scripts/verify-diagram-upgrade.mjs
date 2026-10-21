// Prepare before replacement; verify only reads the pre-existing Run and renders outside it.
import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { directoryHashes, writeNativeDiagramFixture, verifyNativeDiagrams } from './native-diagram-smoke.mjs'
const [mode, packageDirectory, dataDirectory] = process.argv.slice(2)
if (!['prepare', 'verify'].includes(mode) || !packageDirectory || !dataDirectory) throw new Error('Usage: verify-diagram-upgrade.mjs prepare|verify <package> <data-root>')
const dataRoot = path.resolve(dataDirectory), resources = path.resolve(packageDirectory, 'resources')
const companionRoot = path.join(resources, 'app/node_modules/dsh-pangea-companion')
const receiptPath = path.join(dataRoot, 'native-diagram-upgrade-fixture.json')
if (mode === 'prepare') {
  await mkdir(dataRoot, { recursive: true })
  const fixture = await writeNativeDiagramFixture(dataRoot)
  await writeFile(receiptPath, JSON.stringify({ ...fixture, hashes: await directoryHashes(fixture.run) }))
} else {
  const fixture = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(fixture.task.data_root, dataRoot, 'The installation path must remain stable during upgrade')
  assert.deepEqual(await directoryHashes(fixture.run), fixture.hashes, 'Upgrade changed existing Run or historical diagram bytes')
  await assert.rejects(access(path.join(resources, 'archify')), { code: 'ENOENT' })
  const result = await verifyNativeDiagrams(companionRoot, fixture, path.join(dataRoot, 'native-diagram-verification'))
  assert.deepEqual(await directoryHashes(fixture.run), fixture.hashes, 'Verification changed existing Run or historical diagram bytes')
  console.log(`PASS: patched companion renders all three native diagrams; stored Agent facts, legacy Run and historical HTML/SVG preserved. ${JSON.stringify(result)}`)
}
