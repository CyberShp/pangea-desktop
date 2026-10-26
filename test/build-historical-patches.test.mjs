import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { extractPackage, sha256 } from '../scripts/release-package-trust.mjs'
import { fullName, patchName } from '../scripts/historical-release-lib.mjs'

// These orchestration tests use real signed ZIPs, hashing, extraction, and patch
// generation, but fake gh and pwsh commands. They prove the Windows verifier is
// invoked and respected; they DO NOT replace real Windows patch application.
let ZipArchive
try {
  await import('unzipper')
  ;({ ZipArchive } = await import('archiver'))
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error
}
const integration = { skip: process.platform === 'win32' ? 'The fake executable harness is Linux/POSIX only' : !ZipArchive && 'Install archiver and unzipper for signed ZIP orchestration tests' }
const script = fileURLToPath(new URL('../scripts/build-historical-patches.mjs', import.meta.url))
const MANIFEST = 'resources/update/pangea-package-manifest.json'
const keys = generateKeyPairSync('ed25519')
const wrongKeys = generateKeyPairSync('ed25519')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

async function packageZip(destination, version, options = {}) {
  const files = {
    'PANGEA Desktop.exe': `immutable published executable ${version}`,
    'resources/app/unchanged.js': 'unchanged trusted content',
    'resources/pangea-manifest.json': JSON.stringify({ product: { name: 'PANGEA Desktop', version } }),
    'resources/update/pangea-update-public-key.pem': keys.publicKey.export({ format: 'pem', type: 'spki' }),
    'resources/update/apply-portable-update.ps1': options.legacyUpdater ? 'Write-Host legacy' : 'function Apply-VerifiedPatch { Write-Host fixture }'
  }
  const manifest = {
    schema_version: options.schema ?? 1,
    product: 'PANGEA Desktop', channel: 'stable', version,
    published_at: '2026-09-02T00:00:00.000Z',
    files: Object.entries(files).map(([name, content]) => ({ path: name, size: Buffer.byteLength(content), sha256: hash(content) }))
  }
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\r\n`)
  if (!options.unsigned) {
    files[MANIFEST] = manifestBytes
    files[`${MANIFEST}.sig`] = `${sign(null, manifestBytes, options.badSignature ? wrongKeys.privateKey : keys.privateKey).toString('base64')}\n`
  }
  await mkdir(path.dirname(destination), { recursive: true })
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' })
    const zip = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    zip.once('error', reject)
    zip.pipe(output)
    for (const [name, content] of Object.entries(files)) zip.append(content, { name, date: new Date(manifest.published_at), mode: 0o644 })
    void zip.finalize()
  })
  const digest = await sha256(destination)
  await writeFile(`${destination}.sha256`, `${digest}  ${path.basename(destination)}\n`)
  return { file: destination, sha256: digest, manifestBytes, files }
}

async function harness(t, { targetVersion = '2.1.6', targetPublished = true, target = {}, bases = [{ version: '2.1.5' }] } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-history-integration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const output = path.join(root, 'output')
  await mkdir(bin)
  await mkdir(output)
  const log = path.join(root, 'commands.jsonl')
  const configPath = path.join(root, 'github.json')
  const key = path.join(root, 'private.pem')
  await writeFile(key, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  const targetRelease = { id: 200, tag_name: `v${targetVersion}`, draft: false }
  const config = { releases: targetPublished ? [targetRelease] : [], assets: {} }
  const targetPackage = await packageZip(path.join(root, 'remote', 'target', fullName(targetVersion)), targetVersion, target)
  config.assets[200] = assetsFor(targetPackage.file)
  for (const [index, base] of bases.entries()) {
    const id = index + 1
    config.releases.push({ id, tag_name: `v${base.version}`, draft: false })
    config.assets[id] = []
    if (!base.missing) {
      const archive = await packageZip(path.join(root, 'remote', String(id), fullName(base.version)), base.version, base)
      config.assets[id] = assetsFor(archive.file)
    }
  }
  await writeFile(path.join(bin, 'gh'), fakeGh)
  await writeFile(path.join(bin, 'pwsh'), fakePwsh)
  await chmod(path.join(bin, 'gh'), 0o755)
  await chmod(path.join(bin, 'pwsh'), 0o755)
  async function run({ mode = 'backfill', directory = output, failVerifier = false } = {}) {
    await writeFile(configPath, JSON.stringify(config))
    const result = spawnSync(process.execPath, [
      script, '--mode', mode, '--target-version', targetVersion, '--channel', 'stable',
      '--private-key', key, '--output-dir', directory
    ], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        GITHUB_REPOSITORY: 'fixture/project', GH_TOKEN: 'fixture-only-no-network',
        PANGEA_TEST_CONFIG: configPath, PANGEA_TEST_LOG: log,
        PANGEA_TEST_FAIL_VERIFIER: failVerifier ? '1' : '0'
      }
    })
    const reports = (await readdir(directory)).filter(name => /-patch-report-[a-f0-9]{12}\.json$/.test(name))
    assert.equal(reports.length, 1, `Expected final coverage report. ${result.stderr}`)
    const reportBytes = await readFile(path.join(directory, reports[0]))
    assert.ok(reports[0].endsWith(`-${hash(reportBytes).slice(0, 12)}.json`))
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(calls.filter(call => call.command === 'gh').every(call => call.args[0] === 'api' || call.args[0] === 'release' && call.args[1] === 'download'), 'No real or fake publication mutation is allowed')
    return { ...result, report: JSON.parse(reportBytes), calls, directory }
  }
  return { root, output, config, targetPackage, targetVersion, run }
}

function assetsFor(file) {
  return [file, `${file}.sha256`].map((source, index) => ({ id: index + 1, name: path.basename(source), source }))
}

async function inspectPatch(fixture, result, baseVersion = '2.1.5') {
  const name = patchName(fixture.targetVersion, baseVersion)
  const patch = path.join(result.directory, name)
  const extracted = path.join(fixture.root, `inspect-${path.basename(result.directory)}`)
  await extractPackage(patch, extracted)
  const bytes = await readFile(path.join(extracted, 'pangea-patch-manifest.json'))
  const manifest = JSON.parse(bytes)
  const signature = await readFile(path.join(extracted, 'pangea-patch-manifest.json.sig'), 'utf8')
  assert.ok(verify(null, bytes, keys.publicKey, Buffer.from(signature.trim(), 'base64')))
  assert.equal(manifest.from_version, baseVersion)
  assert.equal(manifest.to_version, fixture.targetVersion)
  assert.equal(manifest.target_manifest_sha256, hash(fixture.targetPackage.manifestBytes))
  assert.deepEqual(await readFile(path.join(extracted, 'target', MANIFEST)), fixture.targetPackage.manifestBytes)
  assert.equal(await readFile(path.join(extracted, 'payload/PANGEA Desktop.exe'), 'utf8'), `immutable published executable ${fixture.targetVersion}`)
  assert.equal(await readFile(`${patch}.sha256`, 'utf8'), `${await sha256(patch)}  ${name}\n`)
  return patch
}

test('backfill downloads the immutable signed target and invokes the Windows verifier for a real generated patch', integration, async t => {
  const fixture = await harness(t)
  const localFull = path.join(fixture.output, fullName(fixture.targetVersion))
  await writeFile(localFull, 'untrusted local build must never become the backfill target')
  const result = await fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.report.complete, true)
  assert.equal(result.report.full_fallback.sha256, fixture.targetPackage.sha256)
  assert.equal(result.report.bases.find(base => base.version === '2.1.5').status, 'verified')
  assert.ok(result.calls.some(call => call.command === 'gh' && call.args[1] === 'download' && call.args[2] === 'v2.1.6' && call.args.includes(fullName('2.1.6'))))
  const verifier = result.calls.filter(call => call.command === 'pwsh')
  assert.equal(verifier.length, 1)
  assert.ok(verifier[0].args.some(value => value.endsWith('verify-release-patch.ps1')))
  assert.equal(verifier[0].targetVersion, '2.1.6')
  assert.equal(verifier[0].baseVersion, '2.1.5')
  await inspectPatch(fixture, result)
  assert.equal(await readFile(localFull, 'utf8'), 'untrusted local build must never become the backfill target')
})

test('build mode verifies the shipped local target ZIP without downloading a target release', integration, async t => {
  const fixture = await harness(t, { targetPublished: false })
  const localFull = path.join(fixture.output, fullName(fixture.targetVersion))
  await copyFile(fixture.targetPackage.file, localFull)
  await copyFile(`${fixture.targetPackage.file}.sha256`, `${localFull}.sha256`)
  const result = await fixture.run({ mode: 'build' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.report.complete, true)
  assert.equal(result.report.full_fallback.sha256, fixture.targetPackage.sha256)
  assert.ok(!result.calls.some(call => call.command === 'gh' && call.args[1] === 'download' && call.args[2] === 'v2.1.6'))
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 1)
  await inspectPatch(fixture, result)
})

test('missing packages, unsigned history, trusted unsupported schemas, and legacy updaters remain explicit gaps', integration, async t => {
  const fixture = await harness(t, {
    targetVersion: '2.1.9',
    bases: [
      { version: '2.1.8', missing: true },
      { version: '2.1.7', unsigned: true },
      { version: '2.1.6', schema: 2 },
      { version: '2.1.5', legacyUpdater: true }
    ]
  })
  const result = await fixture.run()
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.report.discovery_complete, true)
  assert.equal(result.report.complete, false)
  assert.equal(result.report.full_fallback.sha256, fixture.targetPackage.sha256)
  const eligible = result.report.bases.filter(base => base.eligible)
  assert.deepEqual(eligible.map(base => base.status), ['missing', 'unsupported', 'unsupported', 'unsupported'])
  assert.match(eligible[0].reason, /full package or checksum unavailable/)
  assert.match(eligible[1].reason, /Legacy package has no signed metadata/)
  assert.match(eligible[2].reason, /Unsupported package manifest schema/)
  assert.match(eligible[3].reason, /Apply-VerifiedPatch/)
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 0)
  assert.ok(!(await readdir(fixture.output)).some(name => name.endsWith('.patch.zip')))
})

test('an untrusted baseline signature fails closed and removes stale patch output', integration, async t => {
  const fixture = await harness(t, { bases: [{ version: '2.1.5', badSignature: true }] })
  const name = patchName('2.1.6', '2.1.5')
  await writeFile(path.join(fixture.output, name), 'stale unverified patch')
  await writeFile(path.join(fixture.output, `${name}.sha256`), 'stale checksum')
  const result = await fixture.run()
  assert.equal(result.status, 1)
  const row = result.report.bases.find(base => base.version === '2.1.5')
  assert.equal(row.status, 'failed')
  assert.match(row.reason, /signature/)
  assert.equal(result.report.complete, false)
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 0)
  assert.ok(!(await readdir(fixture.output)).some(file => file.startsWith(name)))
})

test('a failed Windows verifier invocation removes the generated ZIP and checksum', integration, async t => {
  const fixture = await harness(t)
  const result = await fixture.run({ failVerifier: true })
  assert.equal(result.status, 1)
  assert.equal(result.report.bases.find(base => base.version === '2.1.5').status, 'failed')
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 1)
  assert.ok(!(await readdir(fixture.output)).some(name => name.includes('.patch.zip')))
})

test('backfill recovers a published ZIP without its checksum, reuses its bytes, and invokes verification', integration, async t => {
  const fixture = await harness(t)
  const initial = await fixture.run()
  assert.equal(initial.status, 0, initial.stderr)
  const name = patchName('2.1.6', '2.1.5')
  const original = path.join(fixture.output, name)
  fixture.config.assets[200].push({ id: 9, name, source: original })
  const retryDirectory = path.join(fixture.root, 'retry')
  const result = await fixture.run({ directory: retryDirectory })
  assert.equal(result.status, 0, result.stderr)
  const row = result.report.bases.find(base => base.version === '2.1.5')
  assert.equal(row.status, 'verified')
  assert.equal(row.reused, true)
  assert.equal(await sha256(path.join(retryDirectory, name)), await sha256(original))
  assert.ok(result.calls.some(call => call.command === 'gh' && call.args[1] === 'download' && call.args.includes(name)))
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 2)
  await inspectPatch(fixture, result)
})

for (const [description, target] of [['bad signature', { badSignature: true }], ['unsupported schema', { schema: 2 }]]) {
  test(`a target with ${description} is fatal before any baseline is patched`, integration, async t => {
    const fixture = await harness(t, { target })
    const result = await fixture.run()
    assert.equal(result.status, 1)
    assert.match(result.report.error, /signature|Unsupported package manifest schema/)
    assert.equal(result.report.complete, false)
    assert.equal(result.report.full_fallback, undefined)
    assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 0)
    assert.ok(!(await readdir(fixture.output)).some(name => name.endsWith('.patch.zip')))
  })
}

const fakeGh = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const config = JSON.parse(fs.readFileSync(process.env.PANGEA_TEST_CONFIG, 'utf8'))
fs.appendFileSync(process.env.PANGEA_TEST_LOG, JSON.stringify({ command: 'gh', args }) + '\\n')
function fail(message) { throw new Error('Fake GitHub command rejected: ' + message) }
if (args[0] === 'api' && args.length === 2) {
  const url = new URL(args[1], 'https://fixture.invalid/')
  const page = Number(url.searchParams.get('page') || 1)
  const assets = /^\\/repos\\/fixture\\/project\\/releases\\/(\\d+)\\/assets$/.exec(url.pathname)
  let result
  if (url.pathname === '/repos/fixture/project/releases') result = config.releases
  else if (assets) result = (config.assets[assets[1]] || []).map(({ source, ...asset }) => asset)
  else fail('unknown read endpoint')
  process.stdout.write(JSON.stringify(result.slice((page - 1) * 100, page * 100)))
} else if (args[0] === 'release' && args[1] === 'download') {
  if (args.includes('--clobber')) fail('overwrite is forbidden')
  const release = config.releases.find(release => release.tag_name === args[2])
  if (!release) fail('unknown release')
  const name = args[args.indexOf('--pattern') + 1]
  const asset = (config.assets[release.id] || []).find(asset => asset.name === name)
  if (!asset) fail('unknown asset')
  const directory = args[args.indexOf('--dir') + 1]
  fs.copyFileSync(asset.source, path.join(directory, name), fs.constants.COPYFILE_EXCL)
} else fail('only read-only API and download commands are allowed')
`

const fakePwsh = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
const value = flag => args[args.indexOf(flag) + 1]
if (args[0] !== '-NoProfile' || args[1] !== '-File' || !value('-File').endsWith('verify-release-patch.ps1')) throw new Error('Unexpected PowerShell invocation')
const readManifest = directory => JSON.parse(fs.readFileSync(path.join(directory, '${MANIFEST}'), 'utf8').replace(/^\\uFEFF/, ''))
const baseVersion = readManifest(value('-BaseDirectory')).version
const targetVersion = readManifest(value('-TargetDirectory')).version
if (!fs.statSync(value('-PatchPath')).isFile()) throw new Error('Patch was not generated')
fs.appendFileSync(process.env.PANGEA_TEST_LOG, JSON.stringify({ command: 'pwsh', args, baseVersion, targetVersion }) + '\\n')
if (process.env.PANGEA_TEST_FAIL_VERIFIER === '1') process.exit(7)
`

test('retired pre-2.1.5 history is excluded before asset lookup, download, trust and Windows verification', integration, async t => {
  const fixture = await harness(t, { bases: [
    { version: '1.0.9', badSignature: true },
    { version: '1.0.3', unsigned: true },
    { version: '0.1.6', missing: true },
    { version: '2.0.0', badSignature: true },
    { version: '2.0.6', unsigned: true },
    { version: '2.0.6-test.99.abcdef0', missing: true },
    { version: '2.1.4', unsigned: true },
    { version: '2.1.4-test.99.abcdef0', missing: true },
    { version: '2.1.5' }
  ] })
  const result = await fixture.run()
  assert.equal(result.status, 0, result.stderr)
  for (const version of ['1.0.9', '1.0.3', '0.1.6', '2.0.0', '2.0.6', '2.0.6-test.99.abcdef0', '2.1.4', '2.1.4-test.99.abcdef0']) {
    const row = result.report.bases.find(base => base.version === version)
    assert.equal(row.status, 'unsupported')
    assert.equal(row.eligible, false)
    assert.match(row.reason, /minimum supported patch baseline 2.1.5/)
    assert.ok(!result.calls.some(call => call.command === 'gh' && call.args.includes(`v${version}`)))
  }
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8]) assert.ok(!result.calls.some(call => call.command === 'gh' && call.args.some(arg => arg.includes(`/releases/${id}/assets`))))
  assert.equal(result.calls.filter(call => call.command === 'pwsh').length, 1)
  assert.equal(result.report.bases.find(base => base.version === '2.1.5').status, 'verified')
  assert.ok(!(await readdir(fixture.output)).some(name => name.includes('-from-1.')))
})
