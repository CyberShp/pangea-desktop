import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'

test('Windows Python dependency lock covers direct requirements with exact versions and hashes', async () => {
  const components = JSON.parse(await readFile(new URL('../pangea.components.json', import.meta.url), 'utf8'))
  const bytes = await readFile(new URL('../' + components.pythonRequirements.file, import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), components.pythonRequirements.sha256)
  const rows = bytes.toString().replace(/\\\r?\n/g, ' ').split(/\r?\n/).filter(row => row.trim() && !row.trim().startsWith('#'))
  const versions = new Map()
  for (const row of rows) {
    const match = row.match(/^([A-Za-z0-9_.-]+)==([^\s;]+)\s+(.+)$/)
    assert.ok(match, `Unpinned dependency: ${row}`)
    assert.match(match[3], /--hash=sha256:[0-9a-f]{64}/)
    const name = match[1].toLowerCase().replace(/[-_.]+/g, '-')
    assert.ok(!versions.has(name), `Duplicate requirement: ${name}`)
    versions.set(name, match[2])
  }
  const direct = await readFile(new URL('../build/pangea-runtime-requirements.txt', import.meta.url), 'utf8')
  for (const line of direct.split(/\r?\n/).filter(x => x.trim() && !x.startsWith('#'))) {
    const [name, version] = line.split('==')
    assert.equal(versions.get(name.toLowerCase().replace(/[-_.]+/g, '-')), version, line)
  }
})
