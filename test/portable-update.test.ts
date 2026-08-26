import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  isNewerPortableVersion,
  normalizePortableEntryPath,
  parsePortableUpdateManifest,
  verifyPortableUpdateManifest
} from '../src/main/update/portable-update'

function manifest(version = '1.2.3'): Buffer {
  const required = [
    'PANGEA Desktop.exe',
    'resources/pangea-manifest.json',
    'resources/update/pangea-update.json',
    'resources/update/pangea-update-public-key.pem',
    'resources/update/apply-portable-update.ps1'
  ]
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    product: 'PANGEA Desktop',
    channel: 'stable',
    version,
    published_at: '2026-08-27T00:00:00.000Z',
    files: required.map((path, index) => ({
      path,
      size: index + 1,
      sha256: String(index).padStart(64, 'a')
    }))
  }))
}

describe('portable package contract', () => {
  it('accepts only an Ed25519-signed file manifest', () => {
    const keys = generateKeyPairSync('ed25519')
    const bytes = manifest()
    const signature = sign(null, bytes, keys.privateKey).toString('base64')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyPortableUpdateManifest(bytes, signature, publicKey).version).toBe('1.2.3')
    expect(() => verifyPortableUpdateManifest(
      Buffer.concat([bytes, Buffer.from(' ')]),
      signature,
      publicKey
    )).toThrow(/verification failed/)
  })

  it('rejects unsafe, duplicate and incomplete file manifests', () => {
    expect(() => normalizePortableEntryPath('../outside.exe')).toThrow(/unsafe/)
    expect(() => normalizePortableEntryPath('C:\\outside.exe')).toThrow(/absolute/)
    const duplicate = JSON.parse(manifest().toString())
    duplicate.files.push({ ...duplicate.files[0], path: 'pangea desktop.exe' })
    expect(() => parsePortableUpdateManifest(JSON.stringify(duplicate))).toThrow(/duplicate/)
    const incomplete = JSON.parse(manifest().toString())
    incomplete.files = incomplete.files.filter((file: { path: string }) => file.path !== 'PANGEA Desktop.exe')
    expect(() => parsePortableUpdateManifest(JSON.stringify(incomplete))).toThrow(/missing/)
  })

  it('accepts stable newer versions only', () => {
    expect(() => parsePortableUpdateManifest(manifest('1.2.3-beta.1'))).toThrow(/stable SemVer/)
    expect(isNewerPortableVersion('1.2.4', '1.2.3')).toBe(true)
    expect(isNewerPortableVersion('1.2.3', '1.2.3')).toBe(false)
    expect(isNewerPortableVersion('1.1.9', '1.2.3')).toBe(false)
  })
})
