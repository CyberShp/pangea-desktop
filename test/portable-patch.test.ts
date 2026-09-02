import { generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  parsePortablePatchManifest,
  verifyPortablePatchManifest
} from '../src/main/update/portable-update'

function patch(from = '1.2.3', to = '1.2.4', channel: 'stable' | 'test' = 'stable'): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    product: 'PANGEA Desktop',
    channel,
    from_version: from,
    to_version: to,
    published_at: '2026-09-02T00:00:00.000Z',
    target_manifest_sha256: 'a'.repeat(64),
    files: [{
      path: 'resources/app/main.js',
      operation: 'replace',
      size: 12,
      sha256: 'b'.repeat(64)
    }],
    deletes: ['resources/app/old.js']
  }))
}

describe('portable patch contract', () => {
  it('accepts a newer same-channel patch', () => {
    expect(parsePortablePatchManifest(patch()).to_version).toBe('1.2.4')
    expect(() => parsePortablePatchManifest(patch('1.2.4', '1.2.4'))).toThrow(/newer/)
  })

  it('rejects cross-channel and overlapping operations', () => {
    expect(() => parsePortablePatchManifest(patch('1.2.3-test.1.aaaaaaa', '1.2.3-test.2.bbbbbbb', 'test'), 'test')).not.toThrow()
    expect(() => parsePortablePatchManifest(patch('1.2.3-test.1.aaaaaaa', '1.2.3-test.2.bbbbbbb', 'stable'))).toThrow(/channel/)
    const value = JSON.parse(patch().toString())
    value.deletes.push(value.files[0].path)
    expect(() => parsePortablePatchManifest(JSON.stringify(value))).toThrow(/both changes and deletes/)
  })

  it('requires an Ed25519 signature over the exact patch bytes', () => {
    const keys = generateKeyPairSync('ed25519')
    const bytes = patch()
    const signature = sign(null, bytes, keys.privateKey).toString('base64')
    const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyPortablePatchManifest(bytes, signature, publicKey).from_version).toBe('1.2.3')
    expect(() => verifyPortablePatchManifest(Buffer.concat([bytes, Buffer.from(' ')]), signature, publicKey)).toThrow(/verification failed/)
  })
})
