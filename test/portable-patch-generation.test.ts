import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { stagePortablePatch } from '../src/main/update/portable-patch-validator'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable patch generation', () => {
  it('rebuilds a target package from changed and deleted files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-patch-generation-'))
    roots.push(root)
    const base = path.join(root, 'base')
    const target = path.join(root, 'target')
    const output = path.join(root, 'pangea-desktop-1.0.1-from-1.0.0-windows-x64.patch.zip')
    const keyPair = generateKeyPairSync('ed25519')
    const privateKey = keyPair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const publicKey = keyPair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
    const privateKeyPath = path.join(root, 'update-private.pem')
    await writeFile(privateKeyPath, privateKey)

    await writePackage(base, '1.0.0', publicKey, {
      'PANGEA Desktop.exe': 'old executable',
      'resources/app/old.js': 'old file',
      'resources/app/unchanged.js': 'keep me'
    }, keyPair.privateKey)
    await writePackage(target, '1.0.1', publicKey, {
      'PANGEA Desktop.exe': 'new executable',
      'resources/app/new.js': 'new file',
      'resources/app/unchanged.js': 'keep me'
    }, keyPair.privateKey)

    const generated = spawnSync(process.execPath, [
      path.join(process.cwd(), 'scripts/create-signed-portable-patch.mjs'),
      '--base-dir', base,
      '--target-dir', target,
      '--private-key', privateKeyPath,
      '--from-version', '1.0.0',
      '--to-version', '1.0.1',
      '--channel', 'stable',
      '--output', output
    ], { encoding: 'utf8' })
    expect(generated.status, generated.stderr).toBe(0)

    const staged = await stagePortablePatch({
      sourcePath: output,
      destinationPath: path.join(root, 'import', 'patch.zip'),
      publicKeyPem: publicKey,
      currentVersion: '1.0.0'
    })
    expect(staged.manifest.from_version).toBe('1.0.0')
    expect(staged.manifest.to_version).toBe('1.0.1')
    expect(staged.manifest.files.map((file) => file.path)).toEqual([
      'PANGEA Desktop.exe',
      'resources/app/new.js',
      'resources/pangea-manifest.json'
    ])
    expect(staged.manifest.deletes).toEqual(['resources/app/old.js'])
    expect(staged.targetManifest.version).toBe('1.0.1')
  })
})

async function writePackage(root: string, version: string, publicKey: string, files: Record<string, string>, privateKey: KeyObject): Promise<void> {
  await Promise.all(Object.entries({
    ...files,
    'resources/update/pangea-update.json': JSON.stringify({ schema_version: 1, enabled: true, public_key_file: 'pangea-update-public-key.pem' }),
    'resources/update/pangea-update-public-key.pem': publicKey,
    'resources/update/apply-portable-update.ps1': 'Write-Host update',
    'resources/pangea-manifest.json': JSON.stringify({ product: { name: 'PANGEA Desktop', version } })
  }).map(async ([relative, content]) => {
    const filePath = path.join(root, ...relative.split('/'))
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
  }))
  const manifestFiles = await listFiles(root)
  const manifest = {
    schema_version: 1,
    product: 'PANGEA Desktop',
    channel: 'stable',
    version,
    published_at: '2026-09-02T00:00:00.000Z',
    files: await Promise.all(manifestFiles.map(async (filePath) => ({
      path: path.relative(root, filePath).split(path.sep).join('/'),
      size: (await stat(filePath)).size,
      sha256: await sha256(filePath)
    })))
  }
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(path.join(root, 'resources/update/pangea-package-manifest.json'), bytes)
  await writeFile(path.join(root, 'resources/update/pangea-package-manifest.json.sig'), `${sign(null, bytes, privateKey).toString('base64')}\n`)
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(filePath)
      else files.push(filePath)
    }
  }
  await visit(root)
  return files.sort()
}

async function sha256(filePath: string): Promise<string> {
  const digest = createHash('sha256')
  const bytes = await readFile(filePath)
  digest.update(bytes)
  return digest.digest('hex')
}
