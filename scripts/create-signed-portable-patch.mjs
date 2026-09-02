import { ZipArchive } from 'archiver'
import { createHash, createPrivateKey, sign } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

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
if (!fromVersion || !toVersion || fromVersion === toVersion) throw new Error('Patch versions are invalid')
const baseManifest = await readJson(path.join(baseDirectory, 'resources/update/pangea-package-manifest.json'))
const targetManifestPath = path.join(targetDirectory, 'resources/update/pangea-package-manifest.json')
const targetManifest = await readJson(targetManifestPath)
const targetSignature = await readFile(`${targetManifestPath}.sig`)
if (baseManifest.version !== fromVersion) throw new Error(`Base directory is ${baseManifest.version}, expected ${fromVersion}`)
if (targetManifest.version !== toVersion) throw new Error(`Target directory is ${targetManifest.version}, expected ${toVersion}`)
if (baseManifest.channel !== channel || targetManifest.channel !== channel) throw new Error('Patch channel does not match package manifests')
if (targetManifest.product !== 'PANGEA Desktop') throw new Error('Unexpected target package product')

const baseFiles = new Map((baseManifest.files ?? []).map((file) => [file.path.toLowerCase(), file]))
const targetFiles = new Map((targetManifest.files ?? []).map((file) => [file.path.toLowerCase(), file]))
for (const base of baseFiles.values()) {
  const basePath = path.join(baseDirectory, ...base.path.split('/'))
  const baseStat = await stat(basePath)
  if (baseStat.size !== base.size || await sha256(basePath) !== base.sha256) {
    throw new Error(`Base file hash disagrees with manifest: ${base.path}`)
  }
}
const changed = []
for (const target of targetFiles.values()) {
  const base = baseFiles.get(target.path.toLowerCase())
  if (!base || base.size !== target.size || base.sha256 !== target.sha256) {
    const targetPath = path.join(targetDirectory, ...target.path.split('/'))
    const targetStat = await stat(targetPath)
    if (targetStat.size !== target.size) throw new Error(`Target file size disagrees with manifest: ${target.path}`)
    const actual = await sha256(targetPath)
    if (actual !== target.sha256) throw new Error(`Target file hash disagrees with manifest: ${target.path}`)
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
const targetManifestBytes = Buffer.from(`${JSON.stringify(targetManifest, null, 2)}\n`, 'utf8')
const patch = {
  schema_version: 1,
  product: 'PANGEA Desktop',
  channel,
  from_version: fromVersion,
  to_version: toVersion,
  published_at: new Date().toISOString(),
  target_manifest_sha256: createHash('sha256').update(targetManifestBytes).digest('hex'),
  files: changed.map(({ sourcePath: _sourcePath, ...file }) => file),
  deletes
}
const privateKey = createPrivateKey({
  key: await readFile(privateKeyPath, 'utf8'),
  format: 'pem',
  passphrase: process.env.PANGEA_UPDATE_KEY_PASSPHRASE
})
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The patch signing key must use Ed25519')
const signature = sign(null, Buffer.from(`${JSON.stringify(patch, null, 2)}\n`, 'utf8'), privateKey).toString('base64')

await createZip(outputPath, [
  { path: undefined, name: PATCH_MANIFEST, content: Buffer.from(`${JSON.stringify(patch, null, 2)}\n`, 'utf8') },
  { path: undefined, name: PATCH_SIGNATURE, content: Buffer.from(`${signature}\n`, 'utf8') },
  { path: targetManifestPath, name: TARGET_MANIFEST },
  { path: `${targetManifestPath}.sig`, name: TARGET_SIGNATURE },
  ...changed.map((file) => ({ path: file.sourcePath, name: `payload/${file.path}` }))
])
console.log(JSON.stringify({ fromVersion, toVersion, changed: changed.length, deleted: deletes.length, outputPath }))

async function createZip(destination, entries) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    for (const entry of entries) {
      if (entry.content) archive.append(entry.content, { name: entry.name })
      else archive.file(entry.path, { name: entry.name })
    }
    void archive.finalize()
  })
}

async function sha256(filePath) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  return digest.digest('hex')
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''))
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
