import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isolatedEnvironment, isWithin, parseOptions, parseProcessGroups } from '../scripts/verify-packaged-macos.mjs'

test('packaged smoke requires an explicit version and rejects invalid target/options', () => {
  assert.throws(() => parseOptions(['--app', '/tmp/Product.app']), /Usage:/)
  assert.throws(() => parseOptions(['--app', '/tmp/Product.app', '--expected-version', '1', '--arch', 'ia32']), /architecture/)
  assert.throws(() => parseOptions(['--app', '/tmp/Product.app', '--expected-version', '1', '--skip-launch']), /Invalid argument/)
  assert.throws(() => parseOptions(['--app', '/tmp/Product.app', '--expected-version', '1', '--timeout-seconds', '0']), /Timeout/)
  const options = parseOptions(['--app', '/tmp/Product with spaces.app', '--expected-version', '2.1.4-macaccept.1', '--arch', 'arm64', '--evidence', '/tmp/new evidence'])
  assert.equal(options.app, '/tmp/Product with spaces.app')
  assert.equal(options.version, '2.1.4-macaccept.1')
})

test('smoke child environment is isolated from shell injection, credentials and existing profiles', () => {
  const original = { ...process.env }
  process.env.PANGEA_USER_DATA_DIR = '/existing/user/profile'
  process.env.DSH_HOME = '/existing/user/harness'
  process.env.NODE_OPTIONS = '--require=/untrusted/injection.cjs'
  process.env.PYTHONPATH = '/developer/checkout'
  process.env.OPENAI_API_KEY = 'must-not-be-inherited'
  try {
    const root = path.resolve('/tmp/packaged-smoke-owned')
    const env = isolatedEnvironment(root, '/bundle/node/bin')
    assert.equal(env.PANGEA_USER_DATA_DIR, path.join(root, 'profile'))
    assert.equal(env.DSH_HOME, path.join(root, 'profile/harness'))
    assert.equal(env.HOME, path.join(root, 'home'))
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE']) assert.equal(env[name], undefined, name)
    assert.equal(env.PYTHONNOUSERSITE, '1')
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
  }
})

test('process cleanup selection uses the spawned group rather than app names or executable paths', () => {
  const entries = parseProcessGroups('  501 1 501\n 502 501 501\n 503 1 503\n')
  assert.deepEqual(entries.filter(item => item.pgid === 501).map(item => item.pid), [501, 502])
  assert.throws(() => parseProcessGroups('501 1 malformed'), /Invalid process table/)
})

test('bundle containment distinguishes a sibling prefix from a writable bundle child', () => {
  const bundle = path.resolve('/tmp/Product.app')
  assert.equal(isWithin(bundle, path.join(bundle, 'Contents/evidence')), true)
  assert.equal(isWithin(bundle, bundle), true)
  assert.equal(isWithin(bundle, path.resolve('/tmp/Product.app-evidence')), false)
  assert.equal(isWithin(bundle, path.resolve('/tmp/evidence')), false)
})

test('non-macOS execution fails instead of reporting packaged acceptance', { skip: process.platform === 'darwin' }, () => {
  const result = spawnSync(process.execPath, ['scripts/verify-packaged-macos.mjs', '--app', '/tmp/Product.app', '--expected-version', '1', '--arch', 'arm64'], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 10000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must run on a macOS runner/)
  assert.doesNotMatch(result.stdout, /"status":"passed"/)
})
