import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { assertUpgradeableTarget } from '../scripts/historical-release-lib.mjs'
test('Desktop stable and test build targets can themselves be upgraded', async () => {
  for (const version of ['2.1.9', '2.99.99', '3.0.0', '3.0.0-test.999.abcdef0', '3.0.2', '3.0.2-test.999.abcdef0']) assert.throws(() => assertUpgradeableTarget(version), /baseline/)
  for (const version of ['3.0.3', '3.0.3-test.1.abcdef0', '3.0.4', '3.0.4-test.1.abcdef0', '3.0.5', '3.0.5-test.1.abcdef0']) assert.equal(assertUpgradeableTarget(version), version)
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const version = /default: (\d+\.\d+\.\d+)/.exec(workflow)[1]
  assertUpgradeableTarget(version)
  assert.match(workflow, /assertUpgradeableTarget\(process.env.PANGEA_TARGET_VERSION\)/)
  const helperBytes = await readFile(new URL('../build/apply-portable-update.ps1', import.meta.url))
  assert.deepEqual([...helperBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'build/apply-portable-update.ps1 must keep UTF-8 BOM for Windows PowerShell 5.1')
  for (const dir of ['build', 'scripts']) {
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ps1')) continue
      const bytes = await readFile(new URL(`../${dir}/${entry.name}`, import.meta.url))
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], `${dir}/${entry.name} must keep UTF-8 BOM for Windows PowerShell 5.1`)
    }
  }
})
