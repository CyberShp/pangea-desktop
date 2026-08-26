import { ZipArchive } from 'archiver'
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, opendir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const appDirectory = path.resolve(required('--app-dir'))
const privateKeyPath = path.resolve(required('--private-key'))
const outputPath = path.resolve(required('--output'))
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const metadataDirectory = path.join(appDirectory, 'resources', 'update')
const manifestPath = path.join(metadataDirectory, 'pangea-package-manifest.json')
const signaturePath = `${manifestPath}.sig`
const publicKeyPath = path.join(metadataDirectory, 'pangea-update-public-key.pem')
const componentManifestPath = path.join(appDirectory, 'resources', 'pangea-manifest.json')

const expectedName = `pangea-desktop-${packageJson.version}-windows-x64-portable.zip`
if (path.basename(outputPath) !== expectedName) throw new Error(`Portable package must be named ${expectedName}`)
const outputRelativeToApp = path.relative(appDirectory, outputPath)
if (
  outputRelativeToApp === '' ||
  (
    outputRelativeToApp !== '..' &&
    !outputRelativeToApp.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(outputRelativeToApp)
  )
) {
  throw new Error('Portable package output must be outside the application directory')
}
await rm(manifestPath, { force: true })
await rm(signaturePath, { force: true })

const privatePem = await readFile(privateKeyPath, 'utf8')
const privateKey = createPrivateKey({
  key: privatePem,
  format: 'pem',
  passphrase: process.env.PANGEA_UPDATE_KEY_PASSPHRASE
})
if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The package signing key must use Ed25519')
const embeddedPublicKey = createPublicKey(await readFile(publicKeyPath, 'utf8'))
const signingPublicKey = createPublicKey(privateKey)
if (!embeddedPublicKey.equals(signingPublicKey)) {
  throw new Error('The embedded package public key does not match the signing key')
}

const componentManifest = JSON.parse((await readFile(componentManifestPath, 'utf8')).replace(/^\uFEFF/, ''))
if (componentManifest.product?.version !== packageJson.version) {
  throw new Error('Component manifest and Desktop package versions differ')
}

const files = []
for (const filePath of await listFiles(appDirectory)) {
  const relativePath = path.relative(appDirectory, filePath).split(path.sep).join('/')
  const fileStat = await stat(filePath)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) digest.update(chunk)
  files.push({ path: relativePath, size: fileStat.size, sha256: digest.digest('hex') })
}
files.sort((left, right) => left.path.localeCompare(right.path, 'en'))
const manifest = {
  schema_version: 1,
  product: 'PANGEA Desktop',
  channel: 'stable',
  version: packageJson.version,
  published_at: new Date().toISOString(),
  files,
  components: componentManifest.components
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
const signature = sign(null, manifestBytes, privateKey).toString('base64')
await writeFile(manifestPath, manifestBytes)
await writeFile(signaturePath, `${signature}\n`, 'utf8')

await mkdir(path.dirname(outputPath), { recursive: true })
await rm(outputPath, { force: true })
await createZip(appDirectory, outputPath)
console.log(`Signed portable package created at ${outputPath}`)

async function listFiles(root) {
  const files = []
  async function visit(directory) {
    const entries = []
    const handle = await opendir(directory)
    for await (const entry of handle) entries.push(entry)
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(entryPath)
      else if (entry.isFile()) files.push(entryPath)
      else throw new Error(`Portable package contains an unsupported filesystem entry: ${entryPath}`)
    }
  }
  await visit(root)
  return files
}

async function createZip(sourceDirectory, destination) {
  await new Promise((resolve, reject) => {
    const output = createWriteStream(destination, { flags: 'wx' })
    const archive = new ZipArchive({ zlib: { level: 9 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    archive.directory(sourceDirectory, false)
    void archive.finalize()
  })
}

function valueAfter(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function required(name) {
  const value = valueAfter(name)
  if (!value) throw new Error(`${name} is required`)
  return value
}
