import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { IntranetUpdateClient, intranetIndexUrl } from '../src/main/update/intranet-update'

const keys = generateKeyPairSync('ed25519')
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
function fixture() {
  const url = (file: string) => `https://updates.example:8443/api/tools/pangea/files/download?path=${encodeURIComponent('stable/' + file)}`
  const full = Buffer.from('full package fixture')
  const patch = Buffer.from('patch')
  const info = (name: string, bytes: Buffer) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  const manifest = { schema_version: 1, product: 'PANGEA Desktop', channel: 'stable', platform: 'win32', arch: 'x64', version: '2.1.24', minimum_source_version: '2.1.23', package: info('pangea-desktop-2.1.24-windows-x64-portable.zip', full) }
  const index = { ...manifest, manifest_url: url('2.1.24/manifest'), signature_url: url('2.1.24/signature'), full_url: url('2.1.24/full.zip'), patches: [{ ...info('patch.zip', patch), from_version: '2.1.23', to_version: '2.1.24', url: url('2.1.24/patch.zip') }] }
  const responses = new Map<string, () => Response>()
  const resign = () => {
    const bytes = Buffer.from(JSON.stringify(manifest))
    responses.set(index.manifest_url, () => new Response(bytes))
    responses.set(index.signature_url, () => new Response(sign(null, bytes, keys.privateKey).toString('base64')))
  }
  resign()
  responses.set(url('latest.json'), () => Response.json(index))
  responses.set(index.full_url, () => new Response(full))
  responses.set(index.patches[0]!.url, () => new Response(patch))
  const fetcher = vi.fn(async (url: string) => responses.get(url)?.() ?? new Response('', { status: 404 }))
  const client = new IntranetUpdateClient(fetcher, new AbortController().signal, url('latest.json'))
  return { index, manifest, fetcher, client, responses, patch, resign }
}
it('selects an exact smaller patch and streams query-addressed downloads', async () => {
  const f = fixture()
  const update = (await f.client.check('2.1.23', pem))!
  expect(update).toMatchObject({ packageType: 'patch', baseVersion: '2.1.23', version: '2.1.24' })
  expect(f.fetcher).toHaveBeenCalledTimes(3)
  const root = await mkdtemp(join(tmpdir(), 'intranet-'))
  try {
    await f.client.download(update, join(root, 'download.zip'), () => {})
    expect(await readFile(join(root, 'download.zip'))).toEqual(f.patch)
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('selects full when no exact patch exists or patch is not smaller', async () => {
  const f = fixture()
  f.index.patches[0]!.from_version = '2.1.22'
  expect(await f.client.check('2.1.23', pem)).toMatchObject({ packageType: 'full' })
  f.index.patches[0]!.from_version = '2.1.23'; f.index.patches[0]!.size = 100
  expect(await f.client.check('2.1.23', pem)).toMatchObject({ packageType: 'full' })
})
it('enforces signed metadata, minimum source, channel and matching versions', async () => {
  const f = fixture()
  expect(await f.client.check('2.1.24', pem)).toBeUndefined()
  await expect(f.client.check('2.1.22', pem)).rejects.toThrow('最低支持')
  f.index.version = '2.1.25'
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('不一致')
  f.index.version = '2.1.24'; f.index.channel = 'test'
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('通道')
  f.index.channel = 'stable'; f.responses.set(f.index.signature_url, () => new Response('invalid'))
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('签名')
})
it('rejects off-origin URLs and redirects without contacting GitHub', async () => {
  const f = fixture()
  f.responses.set(f.index.manifest_url, () => new Response(null, { status: 302, headers: { location: 'https://github.com/evil' } }))
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('允许列表')
  expect(f.fetcher.mock.calls.every(([url]) => url.startsWith('https://updates.example:8443/'))).toBe(true)
  f.index.manifest_url = 'https://other.example/manifest'
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('同源')
})
it('rejects duplicate baselines and invalid source settings', async () => {
  const f = fixture(); f.index.patches.push(f.index.patches[0]!)
  await expect(f.client.check('2.1.23', pem)).rejects.toThrow('重复')
  for (const indexUrl of ['', 'http://host/index', 'https://user:pass@host/index', 'https://host/index#x']) expect(() => new IntranetUpdateClient(vi.fn(), new AbortController().signal, indexUrl)).toThrow()
})

it('maps stable and test versions to separate built-in indexes', () => {
  expect(new URL(intranetIndexUrl('2.1.25')).searchParams.get('path')).toBe('stable/latest.json')
  expect(new URL(intranetIndexUrl('2.1.20-test.1.abcdef0')).searchParams.get('path')).toBe('beta/latest.json')
})

it('does not offer the installed or an older version', async () => {
  const f = fixture()
  expect(await f.client.check('2.1.24', pem)).toBeUndefined()
  expect(await f.client.check('2.1.25', pem)).toBeUndefined()
})

function testFixture() {
  const f = fixture()
  const version = '2.1.26-test.10.abcdef0'
  f.index.channel = f.manifest.channel = 'test'
  f.index.version = f.manifest.version = version
  f.manifest.package.name = `pangea-desktop-${version}-windows-x64-portable.zip`
  f.index.patches[0]!.from_version = '2.1.26-test.9.abcdef0'
  f.index.patches[0]!.to_version = version
  f.resign()
  return f
}
it('Desktop test upgrades compare numeric builds and require the exact patch source', async () => {
  const f = testFixture()
  expect(await f.client.check('2.1.26-test.9.abcdef0', pem)).toMatchObject({ version: '2.1.26-test.10.abcdef0', packageType: 'patch' })
  expect(await f.client.check('2.1.26-test.9.1234567', pem)).toMatchObject({ packageType: 'full' })
  expect(await f.client.check('2.1.25-test.99.abcdef0', pem)).toMatchObject({ packageType: 'full' })
  expect(await f.client.check('2.1.26-test.10.abcdef0', pem)).toBeUndefined()
  expect(await f.client.check('2.1.26-test.11.abcdef0', pem)).toBeUndefined()
  await expect(f.client.check('2.1.25', pem)).rejects.toThrow('通道')
  await expect(f.client.check('2.1.22-test.999.abcdef0', pem)).rejects.toThrow('最低支持')
})
it('Desktop test full-package fallback downloads and verifies bytes', async () => {
  const f = testFixture()
  f.index.patches = []
  const update = (await f.client.check('2.1.25-test.2.abcdef0', pem))!
  expect(update.packageType).toBe('full')
  const root = await mkdtemp(join(tmpdir(), 'test-upgrade-'))
  try {
    await f.client.download(update, join(root, 'full.zip'), () => {})
    expect((await readFile(join(root, 'full.zip'))).toString()).toBe('full package fixture')
  } finally { await rm(root, { recursive: true, force: true }) }
})
