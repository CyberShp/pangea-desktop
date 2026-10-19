import { createHash, createPublicKey, verify } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const MANIFEST = 'resources/update/pangea-package-manifest.json'
const SIGNATURE = `${MANIFEST}.sig`
const EXECUTABLE = 'PANGEA Desktop.exe'
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const testVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-test\.(0|[1-9]\d*)\.[0-9a-f]{7}$/

export class UnsupportedPackageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsupportedPackageError'
    this.code = 'UNSUPPORTED_PACKAGE'
  }
}

export async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

// The caller supplies trust from CI, never from the downloaded package itself.
// Keep the original bytes: a valid signature need not use our JSON formatting.
export async function verifyPackage(directory, { version, channel, publicKey } = {}) {
  if (!['stable', 'test'].includes(channel)) throw new Error(`Unsupported package channel: ${channel}`)
  if (typeof version !== 'string' || !(channel === 'stable' ? stableVersion : testVersion).test(version)) {
    throw new Error(`Invalid ${channel} package version: ${version}`)
  }
  if (!publicKey) throw new Error('A trusted package public key is required')
  const key = publicKey.type === 'public' ? publicKey : createPublicKey(publicKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('The trusted package key must use Ed25519')

  const root = path.resolve(directory)
  await assertDirectoryChain(root)
  const actualFiles = await listPackageFiles(root)
  if (!actualFiles.has(MANIFEST) && !actualFiles.has(SIGNATURE)) {
    throw new UnsupportedPackageError('Legacy package has no signed metadata')
  }
  if (!actualFiles.has(MANIFEST) || !actualFiles.has(SIGNATURE)) {
    throw new Error('Incomplete signed package: manifest or signature is missing')
  }
  const manifestBytes = await readFile(path.join(root, MANIFEST))
  const signatureBytes = await readFile(path.join(root, SIGNATURE))
  const signature = signatureBytes.toString('utf8').trim()
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature) || !verify(null, manifestBytes, key, Buffer.from(signature, 'base64'))) {
    throw new Error('Package manifest signature is not valid for the trusted key')
  }
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('Signed package manifest is not valid JSON')
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid package manifest object')
  if (manifest.schema_version !== 1) throw new UnsupportedPackageError('Unsupported package manifest schema')
  if (manifest.product !== 'PANGEA Desktop') throw new Error('Unexpected package product')
  if (manifest.version !== version) throw new Error(`Package version is ${manifest.version}, expected ${version}`)
  if (manifest.channel !== channel) throw new Error(`Package channel is ${manifest.channel}, expected ${channel}`)
  if (typeof manifest.published_at !== 'string' || !Number.isFinite(Date.parse(manifest.published_at))) {
    throw new Error('Package published_at must be a valid timestamp')
  }
  if (manifest.platform !== undefined && !['windows', 'win32'].includes(manifest.platform)) {
    throw new Error('Package platform must be Windows')
  }
  if (manifest.arch !== undefined && manifest.arch !== 'x64') throw new Error('Package architecture must be x64')
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Package manifest files must be a nonempty array')

  const paths = new Map()
  const listedFiles = new Set()
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Invalid package file entry')
    registerPath(paths, file.path, false)
    if ([MANIFEST, SIGNATURE].some(metadata => windowsPathKey(metadata) === windowsPathKey(file.path))) {
      throw new Error(`Package manifest cannot list its own metadata: ${file.path}`)
    }
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid package file size or SHA-256: ${file.path}`)
    }
    listedFiles.add(file.path)
  }
  if (!listedFiles.has(EXECUTABLE)) throw new Error(`Windows package must contain ${EXECUTABLE}`)

  for (const relative of actualFiles.keys()) {
    if (relative !== MANIFEST && relative !== SIGNATURE && !listedFiles.has(relative)) {
      throw new Error(`Package contains an unlisted file: ${relative}`)
    }
  }
  for (const file of manifest.files) {
    const actual = actualFiles.get(file.path)
    if (!actual) throw new Error(`Package file is missing: ${file.path}`)
    if (actual.size !== file.size) throw new Error(`Package file size disagrees with manifest: ${file.path}`)
    if (await sha256(path.join(root, ...file.path.split('/'))) !== file.sha256) {
      throw new Error(`Package file hash disagrees with manifest: ${file.path}`)
    }
  }
  return { manifest, manifestBytes, signatureBytes }
}

// Validate the entire central directory before creating anything. Unzipper's
// generic extract() is deliberately avoided so archive paths never choose a
// destination, overwrite an existing entry, or create a link.
export async function extractPackage(zip, destination) {
  const module = await import('unzipper')
  const archive = await (module.Open ?? module.default.Open).file(zip)
  const paths = new Map()
  const entries = archive.files.map(entry => {
    const directory = entry.type === 'Directory'
    if (!directory && entry.type !== 'File') throw new Error(`Unsupported ZIP entry: ${entry.path}`)
    const relative = directory && entry.path.endsWith('/') ? entry.path.slice(0, -1) : entry.path
    registerPath(paths, relative, directory)
    const attributes = entry.externalFileAttributes >>> 0
    const unixType = (attributes >>> 16) & 0o170000
    if ((unixType !== 0 && unixType !== (directory ? 0o040000 : 0o100000)) || (attributes & 0x400) !== 0) {
      throw new Error(`ZIP contains a symlink or unsupported filesystem entry: ${entry.path}`)
    }
    if ((entry.flags & 1) !== 0) throw new Error(`Encrypted ZIP entries are unsupported: ${entry.path}`)
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new Error(`Invalid ZIP entry size: ${entry.path}`)
    }
    if (directory && entry.uncompressedSize !== 0) throw new Error(`ZIP directory has file content: ${entry.path}`)
    return { entry, relative, directory }
  })

  const root = path.resolve(destination)
  await assertDirectoryChain(root, true)
  try {
    if ((await readdir(root)).length !== 0) throw new Error('Package extraction destination must be empty')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const { entry, relative, directory } of entries) {
    const target = path.join(root, ...relative.split('/'))
    await mkdir(directory ? target : path.dirname(target), { recursive: true, mode: 0o700 })
    await assertDirectoryChain(directory ? target : path.dirname(target))
    if (directory) continue
    let size = 0
    const checkSize = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length
        if (size > entry.uncompressedSize) callback(new Error(`ZIP entry exceeds declared size: ${relative}`))
        else callback(null, chunk)
      },
      flush(callback) {
        callback(size === entry.uncompressedSize ? null : new Error(`ZIP entry size mismatch: ${relative}`))
      }
    })
    await pipeline(entry.stream(), checkSize, createWriteStream(target, { flags: 'wx', mode: 0o600 }))
  }
  return root
}

function validatePath(relative) {
  if (typeof relative !== 'string' || relative.length === 0 || /[\\\x00-\x1f\x7f<>:"|?*]/.test(relative)) {
    throw new Error(`Unsafe Windows package path: ${JSON.stringify(relative)}`)
  }
  for (const segment of relative.split('/')) {
    const deviceName = segment.split('.')[0].replace(/ +$/, '')
    if (!segment || segment === '.' || segment === '..' || /[. ]$/.test(segment) ||
      /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i.test(deviceName)) {
      throw new Error(`Unsafe Windows package path: ${relative}`)
    }
  }
}

function windowsPathKey(relative) {
  // Include non-ASCII case aliases such as dotless i and final sigma. A
  // conservative collision rejection is safer than relying on the host OS.
  return relative.toUpperCase().toLowerCase()
}

function registerPath(paths, relative, directory) {
  validatePath(relative)
  const segments = relative.split('/')
  for (let index = 1; index <= segments.length; index++) {
    const name = segments.slice(0, index).join('/')
    const key = windowsPathKey(name)
    const explicit = index === segments.length
    const isDirectory = !explicit || directory
    const existing = paths.get(key)
    if (existing && (existing.name !== name || existing.directory !== isDirectory || explicit && existing.explicit)) {
      throw new Error(`Duplicate or conflicting Windows package path: ${relative}`)
    }
    paths.set(key, { name, directory: isDirectory, explicit: explicit || existing?.explicit || false })
  }
}

async function listPackageFiles(root) {
  const files = new Map()
  const paths = new Map()
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = path.join(directory, entry.name)
      const info = await lstat(absolute)
      if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) {
        throw new Error(`Package contains a symlink or unsupported filesystem entry: ${relative}`)
      }
      registerPath(paths, relative, info.isDirectory())
      if (info.isDirectory()) await visit(absolute, relative)
      else files.set(relative, info)
    }
  }
  await visit(root)
  return files
}

async function assertDirectoryChain(directory, allowMissing = false) {
  const parent = path.dirname(directory)
  if (parent !== directory) await assertDirectoryChain(parent, allowMissing)
  try {
    const info = await lstat(directory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Package directory is not a real directory: ${directory}`)
  } catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error
  }
}
