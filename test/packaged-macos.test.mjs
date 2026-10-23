import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { isolatedEnvironment, isWithin, parseOptions, parseProcessGroups } from '../scripts/verify-packaged-macos.mjs'
import { runProcessProbe } from '../scripts/macos-process-probe.mjs'

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

test('a real timed-out subprocess retains both streams and termination evidence', { skip: process.platform === 'win32' }, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'pangea-probe-timeout-'))
  try {
    const { record } = await runProcessProbe({ label: 'waiting-node', executable: process.execPath,
      args: ['-e', 'console.log("stdout-before-timeout"); console.error("stderr-before-timeout"); setInterval(() => {}, 1000)'],
      cwd: evidence, env: { PATH: process.env.PATH }, evidence, timeoutMs: 1000 })
    assert.equal(record.status, 'timed_out')
    assert.equal(record.timed_out, true)
    assert.ok(record.pid > 0)
    assert.ok(record.elapsed_ms >= 900)
    assert.match(await readFile(record.stdout_log, 'utf8'), /stdout-before-timeout/)
    assert.match(await readFile(record.stderr_log, 'utf8'), /stderr-before-timeout/)
    assert.deepEqual(record.cleanup, { remaining_processes: [], error: null })
    assert.equal(record.signal, 'SIGTERM')
    assert.throws(() => process.kill(record.pid, 0), { code: 'ESRCH' })
    const saved = JSON.parse(await readFile(path.join(evidence, 'waiting-node.process.json'), 'utf8'))
    assert.equal(saved.pid, record.pid)
    assert.equal(saved.status, 'timed_out')
  } finally { await rm(evidence, { recursive: true, force: true }) }
})

test('a nonzero subprocess preserves the actual exit code without inventing a cause', { skip: process.platform === 'win32' }, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'pangea-probe-nonzero-'))
  try {
    const { record, stdout, stderr } = await runProcessProbe({ label: 'failed-node', executable: process.execPath,
      args: ['-e', 'console.log("probe-output"); console.error("specific-rejection"); process.exitCode = 23'],
      cwd: evidence, env: { PATH: process.env.PATH }, evidence })
    assert.equal(record.status, 'failed')
    assert.equal(record.failure_kind, 'nonzero_exit')
    assert.equal(record.exit_code, 23)
    assert.equal(record.timed_out, false)
    assert.equal(record.signal, null)
    assert.match(stdout, /probe-output/)
    assert.match(stderr, /specific-rejection/)
    assert.equal(await readFile(record.stderr_log, 'utf8'), stderr)
    assert.deepEqual(record.cleanup.remaining_processes, [])
    assert.equal(JSON.parse(await readFile(path.join(evidence, 'failed-node.process.json'), 'utf8')).exit_code, 23)
  } finally { await rm(evidence, { recursive: true, force: true }) }
})

test('a spawn failure writes an explicit error record and empty stream files', { skip: process.platform === 'win32' }, async () => {
  const evidence = await mkdtemp(path.join(os.tmpdir(), 'pangea-probe-missing-'))
  try {
    const { record } = await runProcessProbe({ label: 'missing-node', executable: path.join(evidence, 'not-an-executable'),
      cwd: evidence, env: { PATH: process.env.PATH }, evidence })
    assert.equal(record.status, 'failed')
    assert.equal(record.failure_kind, 'spawn_error')
    assert.equal(record.spawn_error.code, 'ENOENT')
    assert.equal(record.pid, null)
    assert.equal(record.timed_out, false)
    assert.equal(await readFile(record.stdout_log, 'utf8'), '')
    assert.equal(await readFile(record.stderr_log, 'utf8'), '')
    assert.deepEqual(record.cleanup.remaining_processes, [])
  } finally { await rm(evidence, { recursive: true, force: true }) }
})
