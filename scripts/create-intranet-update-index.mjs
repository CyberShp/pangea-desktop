import { createPublicKey, verify } from 'node:crypto'
import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import unzipper from 'unzipper'
import { sha256 } from './release-package-trust.mjs'

// No private signing key is needed on the upload workstation.
export async function createIntranetIndex({ directory, downloadUrl, publicKeyFile, root = '', fullRemoteName, releaseNotesFile }) {
  const base = new URL(downloadUrl ?? 'https://intranet.invalid/download')
  if (base.protocol !== 'https:' || base.username || base.password || base.hash) throw new Error('download-url must be an HTTPS download endpoint without credentials')
  if (base.searchParams.has('path')) throw new Error('download-url must omit path; use --root for the storage prefix')
  if (root.split('/').some(part => part === '..' || part === '.') || root.includes('\\')) throw new Error('Invalid storage root')
  const key = createPublicKey(await readFile(publicKeyFile))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Trusted Ed25519 public key required')
  const verifyBytes = (bytes, signature) => {
    if (!verify(null, bytes, key, Buffer.from(signature.toString().trim(), 'base64'))) throw new Error('Invalid metadata signature')
    return JSON.parse(bytes.toString())
  }
  const manifestName = 'pangea-desktop-update.json'
  const manifest = verifyBytes(await readFile(path.join(directory, manifestName)), await readFile(path.join(directory, manifestName + '.sig')))
  if (manifest.schema_version !== 1 || manifest.product !== 'PANGEA Desktop' || manifest.platform !== 'win32' || manifest.arch !== 'x64' || !['stable', 'test'].includes(manifest.channel) || !/^\d+\.\d+\.\d+(?:-test\.\d+\.[a-f0-9]{7})?$/.test(manifest.version)) throw new Error('Invalid Windows x64 release manifest')
  const full = manifest.package
  if (full?.name !== `pangea-desktop-${manifest.version}-windows-x64-portable.zip` || !Number.isSafeInteger(full.size) || full.size <= 0 || !/^[a-f0-9]{64}$/.test(full.sha256)) throw new Error('Invalid full package metadata')
  const remoteName = fullRemoteName ?? full.name
  if (typeof remoteName !== 'string' || !/^[a-zA-Z0-9._-]+\.zip$/.test(remoteName)) throw new Error('full-remote-name must be a ZIP filename without directories')
  if ((await stat(path.join(directory, full.name))).size !== full.size || await sha256(path.join(directory, full.name)) !== full.sha256) throw new Error('Full package size/hash mismatch')
  const channelDirectory = manifest.channel === 'test' ? 'beta' : 'stable'
  const prefix = [root.replace(/^\/+|\/+$/g, ''), channelDirectory].filter(Boolean).join('/')
  const versionPath = `${prefix}/${manifest.version}`
  const url = relative => { const target = new URL(base); target.searchParams.set('path', relative); return downloadUrl === undefined ? target.search : target.href }
  const patches = []
  const uploads = [full.name, manifestName, manifestName + '.sig']
  for (const name of (await readdir(directory)).sort()) {
    if (!name.endsWith('.zip') || name === full.name) continue
    const archive = await unzipper.Open.file(path.join(directory, name))
    const entry = archive.files.find(item => item.path === 'pangea-patch-manifest.json')
    if (!entry) continue
    const read = async file => {
      const entries = archive.files.filter(item => item.path === file)
      if (entries.length !== 1 || entries[0].uncompressedSize > 64 * 1024 ** 2) throw new Error(`Invalid patch metadata: ${name}`)
      return entries[0].buffer()
    }
    const patch = verifyBytes(await read('pangea-patch-manifest.json'), await read('pangea-patch-manifest.json.sig'))
    if (patch.product !== 'PANGEA Desktop' || patch.channel !== manifest.channel || patch.to_version !== manifest.version || typeof patch.from_version !== 'string') throw new Error(`Patch release mismatch: ${name}`)
    if (patches.some(item => item.from_version === patch.from_version)) throw new Error(`Duplicate patch baseline: ${patch.from_version}`)
    if (!/^[a-zA-Z0-9._-]+\.zip$/.test(name)) throw new Error('Invalid patch filename')
    if (name === remoteName) throw new Error('Full package remote name collides with a patch filename')
    patches.push({ name, from_version: patch.from_version, to_version: patch.to_version, size: (await stat(path.join(directory, name))).size, sha256: await sha256(path.join(directory, name)), url: url(`${versionPath}/${name}`) })
    uploads.push(name)
  }
  // A version-keyed editorial file prevents stale notes from appearing on a new release.
  const catalog = releaseNotesFile ? JSON.parse(await readFile(releaseNotesFile, 'utf8')) : {}
  const notes = catalog[manifest.version] ?? catalog[manifest.version.split('-')[0]]
  if (notes !== undefined && (!notes || typeof notes !== 'object' || Array.isArray(notes) || Object.keys(notes).some(key => !['features', 'fixes', 'notices'].includes(key)) || Object.values(notes).some(items => !Array.isArray(items) || items.length > 30 || items.some(item => typeof item !== 'string' || !item.trim() || item.length > 1000)))) throw new Error('Release notes must contain curated features/fixes/notices text lists')
  const index = { published_at: new Date().toISOString(), ...(notes ? { release_notes: notes } : {}), schema_version: 1, product: 'PANGEA Desktop', channel: manifest.channel, platform: 'win32', arch: 'x64', version: manifest.version,
    manifest_url: url(`${versionPath}/${manifestName}`), signature_url: url(`${versionPath}/${manifestName}.sig`), full_url: url(`${versionPath}/${remoteName}`), patches }
  await writeFile(path.join(directory, 'latest.json'), JSON.stringify(index, null, 2) + '\n')
  const uploadList = { upload_first: uploads.map(name => {
    const remote = name === full.name ? remoteName : name
    return { local: name, path: `${versionPath}/${remote}`, verify_download: url(`${versionPath}/${remote}`) }
  }),
    publish_last: { local: 'latest.json', path: `${prefix}/latest.json`, url: url(`${prefix}/latest.json`) } }
  await writeFile(path.join(directory, 'intranet-upload-list.json'), JSON.stringify(uploadList, null, 2) + '\n')
  return { index, uploadList }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2].replace(/^--/, ''), process.argv[3 + i * 2]]))
  await createIntranetIndex({ directory: path.resolve(args.directory ?? 'dist'), downloadUrl: args['download-url'], publicKeyFile: args['public-key'], root: args.root ?? '', fullRemoteName: args['full-remote-name'], releaseNotesFile: args['release-notes'] })
  console.log('Created latest.json and intranet-upload-list.json. Upload and verify version files first; publish latest.json last.')
}
