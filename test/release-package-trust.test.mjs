import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { extractPackage, sha256, UnsupportedPackageError, verifyPackage } from '../scripts/release-package-trust.mjs'

const MANIFEST = 'resources/update/pangea-package-manifest.json'
const SIGNATURE = `${MANIFEST}.sig`
const keys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' })
const options = { version: '2.0.0', channel: 'stable', publicKey }
const patchScript = fileURLToPath(new URL('../scripts/create-signed-portable-patch.mjs', import.meta.url))
const hasUnzipper = await dependencyAvailable('unzipper')
const hasArchiver = await dependencyAvailable('archiver')
const zipOptions = { skip: !hasUnzipper && 'Install unzipper to exercise ZIP extraction' }
const patchOptions = { skip: !(hasUnzipper && hasArchiver) && 'Install unzipper and archiver to exercise patch generation' }

async function dependencyAvailable(name) {
  try { await import(name); return true } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return false
    throw error
  }
}

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-package-trust-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeRelative(root, relative, content) {
  const target = path.join(root, relative)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function writeManifest(root, manifest, { privateKey = keys.privateKey, compact = false } = {}) {
  const bytes = Buffer.from(compact ? `\uFEFF${JSON.stringify(manifest)}\r\n` : `${JSON.stringify(manifest, null, 2)}\n`)
  await writeRelative(root, MANIFEST, bytes)
  await writeRelative(root, SIGNATURE, `${sign(null, bytes, privateKey).toString('base64')}\n`)
  return bytes
}

async function writePackage(root, { version = '2.0.0', files = {}, ...manifestOptions } = {}) {
  const entries = {
    'PANGEA Desktop.exe': 'fixture executable',
    'resources/app/unchanged.js': 'export const safe = true\n',
    ...files
  }
  const manifest = {
    schema_version: 1,
    product: 'PANGEA Desktop',
    channel: 'stable',
    version,
    published_at: '2026-09-02T00:00:00.000Z',
    files: Object.entries(entries).map(([relative, value]) => ({ path: relative, size: Buffer.byteLength(value), sha256: digest(value) }))
  }
  for (const [relative, content] of Object.entries(entries)) await writeRelative(root, relative, content)
  const bytes = await writeManifest(root, manifest, manifestOptions)
  return { manifest, bytes }
}

test('verifies trusted raw signed bytes, hashes, sizes, and expected package identity', async t => {
  const root = await temporary(t)
  const { manifest, bytes } = await writePackage(root, { compact: true })
  const result = await verifyPackage(root, options)
  assert.deepEqual(result.manifest, manifest)
  assert.deepEqual(result.manifestBytes, bytes)
  assert.deepEqual(result.signatureBytes, await readFile(path.join(root, SIGNATURE)))
  assert.equal(await sha256(path.join(root, MANIFEST)), digest(bytes))
  assert.deepEqual((await verifyPackage(root, { ...options, publicKey: keys.publicKey })).manifest, manifest)
})

test('requires CI trust instead of trusting a package-provided key', async t => {
  const root = await temporary(t)
  await writePackage(root, {
    privateKey: otherKeys.privateKey,
    files: { 'resources/update/pangea-update-public-key.pem': otherKeys.publicKey.export({ format: 'pem', type: 'spki' }) }
  })
  await assert.rejects(verifyPackage(root, options), /signature/)
  await assert.rejects(verifyPackage(root, { ...options, publicKey: undefined }), /trusted package public key/)
  await assert.rejects(verifyPackage(root, { ...options, publicKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey }), /Ed25519/)
})

test('classifies legacy unsigned packages and trusted unsupported schemas separately from trust failures', async t => {
  const root = await temporary(t)
  const { manifest } = await writePackage(root)
  manifest.schema_version = 2
  await writeManifest(root, manifest)
  await assert.rejects(verifyPackage(root, options), error => error instanceof UnsupportedPackageError && error.code === 'UNSUPPORTED_PACKAGE')
  await writeManifest(root, manifest, { privateKey: otherKeys.privateKey })
  await assert.rejects(verifyPackage(root, options), error => !(error instanceof UnsupportedPackageError) && /signature/.test(error.message))
  await rm(path.join(root, MANIFEST))
  await rm(path.join(root, SIGNATURE))
  await assert.rejects(verifyPackage(root, options), { code: 'UNSUPPORTED_PACKAGE' })
})

for (const change of ['manifest', 'signature', 'signature encoding', 'file hash', 'file size', 'missing file', 'unlisted file', 'missing signature']) {
  test(`rejects ${change} tampering`, async t => {
    const root = await temporary(t)
    await writePackage(root)
    if (change === 'manifest') await writeRelative(root, MANIFEST, `${await readFile(path.join(root, MANIFEST), 'utf8')} `)
    if (change === 'signature') await writeRelative(root, SIGNATURE, `${Buffer.alloc(64).toString('base64')}\n`)
    if (change === 'signature encoding') await writeRelative(root, SIGNATURE, `${await readFile(path.join(root, SIGNATURE), 'utf8')}garbage`)
    if (change === 'file hash') await writeRelative(root, 'PANGEA Desktop.exe', 'fixture executablX')
    if (change === 'file size') await writeRelative(root, 'PANGEA Desktop.exe', 'short')
    if (change === 'missing file') await rm(path.join(root, 'PANGEA Desktop.exe'))
    if (change === 'unlisted file') await writeRelative(root, 'unexpected.dll', 'unlisted')
    if (change === 'missing signature') await rm(path.join(root, SIGNATURE))
    await assert.rejects(verifyPackage(root, options), error => !(error instanceof UnsupportedPackageError) && /signature|hash|size|missing|unlisted/.test(error.message))
  })
}

for (const [name, change] of [
  ['schema', manifest => { manifest.schema_version = 2 }],
  ['product', manifest => { manifest.product = 'Another product' }],
  ['version', manifest => { manifest.version = '2.0.1' }],
  ['channel', manifest => { manifest.channel = 'test' }],
  ['timestamp', manifest => { manifest.published_at = 'invalid date' }],
  ['platform', manifest => { manifest.platform = 'linux' }],
  ['architecture', manifest => { manifest.arch = 'arm64' }],
  ['empty files', manifest => { manifest.files = [] }],
  ['invalid files', manifest => { manifest.files = {} }],
  ['null entry', manifest => { manifest.files.push(null) }],
  ['negative size', manifest => { manifest.files[0].size = -1 }],
  ['unsafe size', manifest => { manifest.files[0].size = Number.MAX_SAFE_INTEGER + 1 }],
  ['invalid hash', manifest => { manifest.files[0].sha256 = 'invalid' }],
  ['missing executable', manifest => { manifest.files = manifest.files.slice(1) }],
  ['self-listed manifest', manifest => { manifest.files.push({ ...manifest.files[0], path: MANIFEST }) }],
  ['self-listed signature', manifest => { manifest.files.push({ ...manifest.files[0], path: SIGNATURE }) }],
  ['case duplicate', manifest => { manifest.files.push({ ...manifest.files[0], path: 'pangea desktop.EXE' }) }],
  ['directory case alias', manifest => { manifest.files.push({ ...manifest.files[0], path: 'Resources/app/extra.js' }) }],
  ['file-directory collision', manifest => { manifest.files.push({ ...manifest.files[0], path: 'PANGEA Desktop.exe/file' }) }]
]) {
  test(`rejects a signed manifest with ${name}`, async t => {
    const root = await temporary(t)
    const { manifest } = await writePackage(root)
    change(manifest)
    await writeManifest(root, manifest)
    await assert.rejects(verifyPackage(root, options))
  })
}

const unsafePaths = [
  '../escape', '/absolute', 'C:/absolute', 'C:relative', '\\\\server\\share', 'resources\\escape',
  'resources/../escape', 'resources/./escape', 'resources//file', 'resources/file/',
  'resources/file:stream', 'resources/CON', 'nul.txt', 'CON .txt', 'PRN', 'aux.log', 'com1.txt', 'LPT9',
  'resources/COM¹', 'CONIN$', 'resources/trailing.', 'resources/trailing ', 'resources/a\0b',
  'resources/a\nb', 'resources/a?b', 'resources/a*b'
]
for (const unsafe of unsafePaths) {
  test(`rejects signed Windows-unsafe path ${JSON.stringify(unsafe)}`, async t => {
    const root = await temporary(t)
    const { manifest } = await writePackage(root)
    manifest.files.push({ ...manifest.files[0], path: unsafe })
    await writeManifest(root, manifest)
    await assert.rejects(verifyPackage(root, options), /Unsafe Windows package path/)
  })
}

test('accepts signed test-channel versions and rejects mismatched version formats', async t => {
  const root = await temporary(t)
  const version = '2.0.0-test.42.abcdef1'
  const { manifest } = await writePackage(root, { version })
  manifest.channel = 'test'
  await writeManifest(root, manifest)
  await verifyPackage(root, { ...options, version, channel: 'test' })
  await assert.rejects(verifyPackage(root, { ...options, channel: 'test' }), /Invalid test package version/)
  await assert.rejects(verifyPackage(root, { ...options, version }), /Invalid stable package version/)
  await assert.rejects(verifyPackage(root, { ...options, channel: 'release' }), /Unsupported package channel/)
})

test('rejects filesystem case collisions even if each file has a matching signed hash', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t)
  await writePackage(root, { files: { 'pangea desktop.EXE': 'case alias' } })
  await assert.rejects(verifyPackage(root, options), /Duplicate or conflicting/)
})

for (const relative of ['PANGEA Desktop.exe', MANIFEST, 'resources/app']) {
  test(`rejects symlinks at ${relative}`, { skip: process.platform === 'win32' }, async t => {
    const root = await temporary(t)
    const packageRoot = path.join(root, 'package')
    await writePackage(packageRoot)
    const target = path.join(packageRoot, relative)
    const outside = path.join(root, 'outside')
    await writeFile(outside, 'outside')
    await rm(target, { recursive: true })
    await symlink(outside, target)
    await assert.rejects(verifyPackage(packageRoot, options), /symlink/)
    assert.equal(await readFile(outside, 'utf8'), 'outside')
  })
}

test('rejects a package reached through a symlinked directory', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t)
  await writePackage(path.join(root, 'real', 'package'))
  await symlink(path.join(root, 'real'), path.join(root, 'alias'))
  await assert.rejects(verifyPackage(path.join(root, 'alias', 'package'), options), /not a real directory/)
})

test('extracts regular ZIP files and directories without executing package content', zipOptions, async t => {
  const root = await temporary(t)
  const zip = path.join(root, 'package.zip')
  await writeFile(zip, zipBytes([
    { name: 'resources/', attributes: 0o040755 << 16 },
    { name: 'resources/app/file.js', content: 'throw new Error("never execute package code")' },
    { name: 'PANGEA Desktop.exe', content: 'fixture' }
  ]))
  const destination = path.join(root, 'unpacked')
  assert.equal(await extractPackage(zip, destination), destination)
  assert.equal(await readFile(path.join(destination, 'resources/app/file.js'), 'utf8'), 'throw new Error("never execute package code")')
})

for (const [name, entries] of [
  ...unsafePaths.map(name => [JSON.stringify(name), [{ name }]]),
  ['symlink', [{ name: 'link', content: '../outside', attributes: 0o120777 << 16 }]],
  ['device', [{ name: 'device', attributes: 0o020666 << 16 }]],
  ['Windows reparse point', [{ name: 'link', attributes: 0x400 }]],
  ['case duplicate', [{ name: 'file' }, { name: 'FILE' }]],
  ['Unicode case duplicate', [{ name: 'file' }, { name: 'fıle' }]],
  ['exact duplicate', [{ name: 'file' }, { name: 'file' }]],
  ['directory duplicate', [{ name: 'dir/' }, { name: 'dir/' }]],
  ['directory case alias', [{ name: 'dir/first' }, { name: 'DIR/second' }]],
  ['file-directory collision', [{ name: 'dir' }, { name: 'dir/file' }]],
  ['encrypted file', [{ name: 'file', flags: 1 }]]
]) {
  test(`ZIP preflight rejects ${name} before writing any files`, zipOptions, async t => {
    const root = await temporary(t)
    const zip = path.join(root, 'package.zip')
    await writeFile(zip, zipBytes([{ name: 'safe-first', content: 'must not be written' }, ...entries]))
    const destination = path.join(root, 'unpacked')
    await assert.rejects(extractPackage(zip, destination))
    await assert.rejects(lstat(destination), { code: 'ENOENT' })
  })
}

test('ZIP extraction refuses an occupied destination without overwriting it', zipOptions, async t => {
  const root = await temporary(t)
  const zip = path.join(root, 'package.zip')
  await writeFile(zip, zipBytes([{ name: 'file', content: 'replacement' }]))
  const destination = path.join(root, 'unpacked')
  await writeRelative(destination, 'file', 'original')
  await assert.rejects(extractPackage(zip, destination), /must be empty/)
  assert.equal(await readFile(path.join(destination, 'file'), 'utf8'), 'original')
})

test('ZIP extraction refuses a symlinked destination', { ...zipOptions, skip: zipOptions.skip || process.platform === 'win32' }, async t => {
  const root = await temporary(t)
  const zip = path.join(root, 'package.zip')
  await writeFile(zip, zipBytes([{ name: 'file' }]))
  await mkdir(path.join(root, 'real'))
  await symlink(path.join(root, 'real'), path.join(root, 'alias'))
  await assert.rejects(extractPackage(zip, path.join(root, 'alias')), /not a real directory/)
})

test('ZIP extraction rejects content exceeding its declared uncompressed size', zipOptions, async t => {
  const root = await temporary(t)
  const zip = path.join(root, 'package.zip')
  await writeFile(zip, zipBytes([{ name: 'file', content: 'too much', declaredSize: 1 }]))
  await assert.rejects(extractPackage(zip, path.join(root, 'unpacked')), /declared size/)
})

async function patchFixture(t) {
  const root = await temporary(t)
  const base = path.join(root, 'base')
  const target = path.join(root, 'target')
  await writePackage(base, { version: '2.0.7', files: { 'resources/old.txt': 'delete me' } })
  const result = await writePackage(target, { version: '2.0.8', compact: true, files: { 'PANGEA Desktop.exe': 'new executable', 'resources/new.txt': 'add me' } })
  const key = path.join(root, 'key.pem')
  await writeFile(key, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }))
  const run = output => spawnSync(process.execPath, [
    patchScript, '--base-dir', base, '--target-dir', target, '--private-key', key,
    '--from-version', '2.0.7', '--to-version', '2.0.8', '--channel', 'stable', '--output', output
  ], { encoding: 'utf8' })
  return { root, base, target, run, ...result }
}

test('patches preserve raw target signatures and are byte-identical across retries and source mtimes', patchOptions, async t => {
  const fixture = await patchFixture(t)
  const first = path.join(fixture.root, 'first.zip')
  const second = path.join(fixture.root, 'second.zip')
  const generated = fixture.run(first)
  assert.equal(generated.status, 0, generated.stderr)
  for (const file of fixture.manifest.files) {
    const target = path.join(fixture.target, file.path)
    await utimes(target, new Date('2025-01-01'), new Date('2025-01-01'))
    await chmod(target, 0o600)
  }
  const regenerated = fixture.run(second)
  assert.equal(regenerated.status, 0, regenerated.stderr)
  assert.equal(await sha256(first), await sha256(second))
  const extracted = path.join(fixture.root, 'patch')
  await extractPackage(first, extracted)
  const patchBytes = await readFile(path.join(extracted, 'pangea-patch-manifest.json'))
  const patch = JSON.parse(patchBytes)
  assert.equal(patch.published_at, fixture.manifest.published_at)
  assert.equal(patch.target_manifest_sha256, digest(fixture.bytes))
  assert.deepEqual(await readFile(path.join(extracted, 'target', MANIFEST)), fixture.bytes)
  assert.ok(verify(null, patchBytes, keys.publicKey, Buffer.from((await readFile(path.join(extracted, 'pangea-patch-manifest.json.sig'), 'utf8')).trim(), 'base64')))
  assert.deepEqual(patch.deletes, ['resources/old.txt'])
  assert.deepEqual(patch.files.map(file => file.path), ['PANGEA Desktop.exe', 'resources/new.txt'])
})

for (const change of ['base signature', 'target signature', 'unchanged target file', 'unlisted base file', 'unlisted target file']) {
  test(`patch generation rejects ${change} before producing output`, patchOptions, async t => {
    const fixture = await patchFixture(t)
    if (change === 'base signature' || change === 'target signature') {
      const root = change.startsWith('base') ? fixture.base : fixture.target
      const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8').then(value => value.replace(/^\uFEFF/, '')))
      await writeManifest(root, manifest, { privateKey: otherKeys.privateKey })
    }
    if (change === 'unchanged target file') await writeRelative(fixture.target, 'resources/app/unchanged.js', 'export const evil = true\n')
    if (change === 'unlisted base file') await writeRelative(fixture.base, 'evil.dll', 'unlisted')
    if (change === 'unlisted target file') await writeRelative(fixture.target, 'evil.dll', 'unlisted')
    const output = path.join(fixture.root, 'patch.zip')
    const result = fixture.run(output)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /signature|hash|unlisted/)
    await assert.rejects(lstat(output), { code: 'ENOENT' })
  })
}

// Minimal stored ZIP fixtures keep archive-generation tests independent of an
// archiving library and let malformed names/attributes reach the preflight.
function zipBytes(entries) {
  const local = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const content = Buffer.from(entry.content ?? '')
    const crc = crc32(content)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x800 | (entry.flags ?? 0), 6)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(content.length, 18)
    header.writeUInt32LE(entry.declaredSize ?? content.length, 22)
    header.writeUInt16LE(name.length, 26)
    const record = Buffer.alloc(46)
    record.writeUInt32LE(0x02014b50)
    record.writeUInt16LE(0x0314, 4)
    header.copy(record, 6, 4, 28)
    record.writeUInt32LE((entry.attributes ?? (0o100644 << 16)) >>> 0, 38)
    record.writeUInt32LE(offset, 42)
    local.push(header, name, content)
    central.push(record, name)
    offset += header.length + name.length + content.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

test('direct patch generator rejects retired sources before reading package files', patchOptions, async () => {
  for (const fromVersion of ['1.0.9', '2.0.0', '2.0.6', '2.0.6-test.99.abcdef0']) {
    const result = spawnSync(process.execPath, [
      patchScript, '--base-dir', 'absent-base', '--target-dir', 'absent-target', '--private-key', 'absent-key',
      '--from-version', fromVersion, '--to-version', '2.0.13', '--channel', 'stable', '--output', 'absent-output.zip'
    ], { encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /Patch base must be 2.0.7 or newer/)
    assert.doesNotMatch(result.stderr, /ENOENT/)
  }
})
