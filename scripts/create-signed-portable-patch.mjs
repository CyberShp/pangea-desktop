import { ZipArchive } from 'archiver'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { isSupportedPatchBase, MINIMUM_PATCH_BASE_VERSION } from './historical-release-lib.mjs'
import { verifyPackage } from './release-package-trust.mjs'

const baseDirectory = path.resolve(required('--base-dir'))
const targetDirectory = path.resolve(required('--target-dir'))
const privateKeyPath = path.resolve(required('--private-key'))
const outputPath = path.resolve(required('--output'))
const fromVersion = required('--from-version')
const toVersion = required('--to-version')
const channel = required('--channel')

const PATCH_MANIFEST = 'pangea-patch-manifest.json'
const PATCH_SIGNATURE = `${PATCH_MANIFEST}.sig`
const TARGET_MANIFEST = 'target/resources/update/pangea-package-manifest.json'
const TARGET_SIGNATURE = `${TARGET_MANIFEST}.sig`

if (!['stable', 'test'].includes(channel)) throw new Error(`Unsupported patch channel: ${channel}`)
if (!isSupportedPatchBase(fromVersion)) throw new Error(`Patch base must be ${MINIMUM_PATCH_BASE_VERSION} or newer; 1.x support is retired`)
if (!fromVersion || !toVersion || fromVersion === toVersion) throw new Error('Patch versions are invalid')
const privateKey = createPrivateKey({
  key: await readFile(privateKeyPath, 'utf8'),
  format: 'pem',
  passphrase: process.env.PANGEA_UPDATE_KEY_PASSPHRASE
})
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The patch signing key must use Ed25519')
const publicKey = createPublicKey(privateKey)
const { manifest: baseManifest } = await verifyPackage(baseDirectory, { version: fromVersion, channel, publicKey })
const {
  manifest: targetManifest,
  manifestBytes: targetManifestBytes,
  signatureBytes: targetSignature
} = await verifyPackage(targetDirectory, { version: toVersion, channel, publicKey })

const baseFiles = new Map((baseManifest.files ?? []).map((file) => [file.path.toLowerCase(), file]))
const targetFiles = new Map((targetManifest.files ?? []).map((file) => [file.path.toLowerCase(), file]))
const changed = []
for (const target of targetFiles.values()) {
  const base = baseFiles.get(target.path.toLowerCase())
  if (!base || base.size !== target.size || base.sha256 !== target.sha256) {
    const targetPath = path.join(targetDirectory, ...target.path.split('/'))
    changed.push({
      path: target.path,
      operation: base ? 'replace' : 'add',
      size: target.size,
      sha256: target.sha256,
      sourcePath: targetPath
    })
  }
}
const deletes = [...baseFiles.values()]
  .filter((base) => !targetFiles.has(base.path.toLowerCase()))
  .map((base) => base.path)
  .sort((left, right) => left.localeCompare(right, 'en'))

changed.sort((left, right) => left.path.localeCompare(right.path, 'en'))
const patch = {
  schema_version: 1,
  product: 'PANGEA Desktop',
  channel,
  from_version: fromVersion,
  to_version: toVersion,
  published_at: targetManifest.published_at,
  target_manifest_sha256: createHash('sha256').update(targetManifestBytes).digest('hex'),
  files: changed.map(({ sourcePath: _sourcePath, ...file }) => file),
  deletes
}
const signature = sign(null, Buffer.from(`${JSON.stringify(patch, null, 2)}\n`, 'utf8'), privateKey).toString('base64')

await createZip(outputPath, [
  { path: undefined, name: PATCH_MANIFEST, content: Buffer.from(`${JSON.stringify(patch, null, 2)}\n`, 'utf8') },
  { path: undefined, name: PATCH_SIGNATURE, content: Buffer.from(`${signature}\n`, 'utf8') },
  { path: undefined, name: TARGET_MANIFEST, content: targetManifestBytes },
  { path: undefined, name: TARGET_SIGNATURE, content: targetSignature },
  ...changed.map((file) => ({ path: file.sourcePath, name: `payload/${file.path}` }))
])
console.log(JSON.stringify({ fromVersion, toVersion, changed: changed.length, deleted: deletes.length, outputPath }))

async function createZip(destination, entries) {
  // ZIP timestamps and modes must not depend on extraction time, filesystem,
  // or the retry date. Ed25519 signatures and deflate are deterministic too.
  const timestamp = new Date(Math.max(Date.UTC(1980, 0, 1), Math.min(Date.UTC(2107, 11, 31, 23, 59, 58), Date.parse(targetManifest.published_at))))
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    for (const entry of entries) {
      const options = { name: entry.name, date: timestamp, mode: 0o644 }
      archive.append(entry.content ?? createReadStream(entry.path), options)
    }
    void archive.finalize()
  })
}

function required(name) {
  const value = valueAfter(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}

function valueAfter(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
