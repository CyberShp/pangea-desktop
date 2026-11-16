import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { assertUpgradeableTarget } from '../scripts/historical-release-lib.mjs'
test('Desktop stable and test build targets can themselves be upgraded', async () => {
  for (const version of ['2.1.9', '2.1.9-test.999.abcdef0']) assert.throws(() => assertUpgradeableTarget(version), /baseline/)
  for (const version of ['2.1.26', '2.1.26-test.1.abcdef0']) assert.equal(assertUpgradeableTarget(version), version)
  const workflow = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const version = /default: (\d+\.\d+\.\d+)/.exec(workflow)[1]
  assertUpgradeableTarget(version)
  assert.match(workflow, /assertUpgradeableTarget\(process.env.PANGEA_TARGET_VERSION\)/)
})
