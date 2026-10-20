import { ZipArchive } from 'archiver'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertSupportedPortableUpgradeSource, MINIMUM_PORTABLE_UPGRADE_SOURCE } from '../src/main/update/portable-update'
import { stagePortablePackage } from '../src/main/update/portable-package-validator'
import { stagePortablePatch } from '../src/main/update/portable-patch-validator'

const roots: string[] = []
const keys = generateKeyPairSync('ed25519')
const publicKeyPem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('portable upgrade source policy', () => {
  it('accepts the 2.0.7 boundary and newer versions in both channels', () => {
    expect(MINIMUM_PORTABLE_UPGRADE_SOURCE).toBe('2.0.7')
    for (const version of ['2.0.7', '2.0.7-test.0.abcdef0', '2.0.10', '2.1.0', '3.0.0']) {
      expect(() => assertSupportedPortableUpgradeSource(version)).not.toThrow()
    }
    for (const version of ['1.99.99', '2.0.0', '2.0.6', '2.0.6-test.9999.abcdef0']) {
      expect(() => assertSupportedPortableUpgradeSource(version)).toThrow(/最低支持版本为 2\.0\.7/)
    }
  })

  for (const [kind, stage] of [['full', stagePortablePackage], ['patch', stagePortablePatch]] as const) {
    for (const version of ['2.0.6', '2.0.6-test.9999.abcdef0']) {
      it(`rejects ${kind} import from ${version} before reading or staging any package`, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'pangea-retired-upgrade-'))
        roots.push(root)
        const destinationPath = path.join(root, 'import', 'package.zip')
        await expect(stage({
          currentVersion: version, publicKeyPem,
          sourcePath: path.join(root, 'not-read.zip'), destinationPath
        })).rejects.toThrow(/最低支持版本为 2\.0\.7/)
        await expect(stat(path.dirname(destinationPath))).rejects.toMatchObject({ code: 'ENOENT' })
      })
    }
  }

  for (const channel of ['stable', 'test'] as const) {
    it(`imports a real signed full package from the minimum ${channel} version`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'pangea-supported-upgrade-'))
      roots.push(root)
      const currentVersion = channel === 'stable' ? '2.0.7' : '2.0.7-test.1.abcdef0'
      const version = channel === 'stable' ? '2.0.8' : '2.0.8-test.2.abcdef0'
      const sourcePath = path.join(root, 'full.zip')
      await writeSignedFullPackage(sourcePath, version, channel)
      const staged = await stagePortablePackage({ sourcePath, destinationPath: path.join(root, 'import', 'full.zip'), currentVersion, publicKeyPem })
      expect(staged.manifest.version).toBe(version)
      expect(staged.manifest.channel).toBe(channel)
      expect(staged.packageSize).toBe((await stat(sourcePath)).size)
    })
  }
})

async function writeSignedFullPackage(destination: string, version: string, channel: 'stable' | 'test'): Promise<void> {
  const files: Record<string, string> = {
    'PANGEA Desktop.exe': 'fixture executable',
    'resources/pangea-manifest.json': JSON.stringify({ product: { version } }),
    'resources/update/pangea-update.json': JSON.stringify({ schema_version: 1, enabled: true }),
    'resources/update/pangea-update-public-key.pem': publicKeyPem,
    'resources/update/apply-portable-update.ps1': 'Write-Host fixture'
  }
  const manifest = Buffer.from(JSON.stringify({
    schema_version: 1, product: 'PANGEA Desktop', channel, version,
    published_at: '2026-10-20T00:00:00.000Z',
    files: Object.entries(files).map(([path, value]) => ({ path, size: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') }))
  }))
  files['resources/update/pangea-package-manifest.json'] = manifest.toString()
  files['resources/update/pangea-package-manifest.json.sig'] = sign(null, manifest, keys.privateKey).toString('base64')
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination)
    const archive = new ZipArchive({ zlib: { level: 1 } })
    output.once('close', resolve)
    output.once('error', reject)
    archive.once('error', reject)
    archive.pipe(output)
    for (const [name, content] of Object.entries(files)) archive.append(content, { name })
    void archive.finalize()
  })
}
