import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitHubUpdateClient, UPDATE_MANIFEST_NAME, UPDATE_REPOSITORY } from '../src/main/update/github-update'

const keys = generateKeyPairSync('ed25519')
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function fixture(version = '2.0.22', bytes = Buffer.from('verified download')) {
  const url = (name: string) => `https://github.com/${UPDATE_REPOSITORY}/releases/download/v${version}/${name}`
  const name = `pangea-desktop-${version}-windows-x64-portable.zip`
  const manifest = Buffer.from(JSON.stringify({ schema_version: 1, product: 'PANGEA Desktop', version,
    channel: version.includes('-test.') ? 'test' : 'stable', platform: 'win32', arch: 'x64', minimum_source_version: '2.0.20',
    package: { name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }))
  const assets = [UPDATE_MANIFEST_NAME, `${UPDATE_MANIFEST_NAME}.sig`, name].map(name => ({ name, size: bytes.length, state: 'uploaded', browser_download_url: url(name) }))
  const release = { id: 123, tag_name: `v${version}`, draft: false, prerelease: version.includes('-test.'), assets }
  const responses = new Map<string, () => Response>([
    [url(UPDATE_MANIFEST_NAME), () => new Response(manifest)],
    [url(`${UPDATE_MANIFEST_NAME}.sig`), () => new Response(sign(null, manifest, keys.privateKey).toString('base64'))],
    [url(name), () => new Response(bytes)]
  ])
  const fetcher = vi.fn(async (url: string, _init: RequestInit) => {
    if (url.startsWith('https://api.github.com/')) return Response.json([release])
    return responses.get(url)?.() ?? new Response('', { status: 404 })
  })
  const controller = new AbortController()
  return { client: new GitHubUpdateClient(fetcher, controller.signal), fetcher, release, responses, url, name, bytes, controller }
}

describe('GitHub signed online update', () => {
  it('pins discovery to a release, follows asset redirect and verifies streamed bytes', async () => {
    const f = fixture()
    const target = 'https://release-assets.githubusercontent.com/github-production-release-asset/123'
    f.responses.set(f.url(f.name), () => new Response(null, { status: 302, headers: { location: target } }))
    f.responses.set(target, () => new Response(f.bytes))
    const update = await f.client.check('2.0.21', publicKey)
    expect(update).toMatchObject({ releaseId: 123, version: '2.0.22' })
    const root = await mkdtemp(join(tmpdir(), 'github-update-')); roots.push(root)
    const progress = vi.fn()
    await f.client.download(update!, join(root, 'package.zip'), progress)
    expect(await readFile(join(root, 'package.zip'))).toEqual(f.bytes)
    expect(progress).toHaveBeenLastCalledWith(100)
    expect(f.fetcher.mock.calls.filter(([url]) => url.includes('/releases?'))).toHaveLength(1)
    expect(f.fetcher.mock.calls.every(([, init]) => init.redirect === 'manual')).toBe(true)
  })
  it('ignores drafts, the other channel, same and older versions', async () => {
    const f = fixture()
    f.release.draft = true
    expect(await f.client.check('2.0.21', publicKey)).toBeUndefined()
    f.release.draft = false; f.release.prerelease = true
    expect(await f.client.check('2.0.21', publicKey)).toBeUndefined()
    f.release.prerelease = false
    expect(await f.client.check('2.0.22', publicKey)).toBeUndefined()
    expect(await f.client.check('2.0.23', publicKey)).toBeUndefined()
  })
  it('updates test builds only within their own channel', async () => {
    const f = fixture('2.0.22-test.11.abcdef0')
    expect(await f.client.check('2.0.22-test.10.abcdef0', publicKey)).toMatchObject({ version: '2.0.22-test.11.abcdef0' })
    expect(await f.client.check('2.0.21', publicKey)).toBeUndefined()
  })
  it('paginates and selects highest SemVer rather than latest publication order', async () => {
    const f = fixture()
    f.fetcher.mockImplementation(async (url, _init) => {
      if (new URL(url).searchParams.get('page') === '1') return Response.json(Array(100).fill({ ...f.release, tag_name: 'v2.0.20' }))
      if (new URL(url).searchParams.get('page') === '2') return Response.json([f.release])
      return f.responses.get(url)!()
    })
    expect(await f.client.check('2.0.21', publicKey)).toMatchObject({ version: '2.0.22' })
  })
  it('rejects unsigned/tampered metadata and missing assets without downloading a package', async () => {
    const f = fixture()
    f.responses.set(f.url(UPDATE_MANIFEST_NAME), () => new Response('{}'))
    await expect(f.client.check('2.0.21', publicKey)).rejects.toThrow('签名')
    expect(f.fetcher.mock.calls.some(([url]) => url.endsWith('.zip'))).toBe(false)
    f.release.assets.pop()
    // The signature is still checked before selecting the package.
    await expect(f.client.check('2.0.21', publicKey)).rejects.toThrow()
  })
  it('rejects unsupported old installations before downloading', async () => {
    await expect(fixture().client.check('2.0.19', publicKey)).rejects.toThrow('最低支持')
  })
  it.each(['corrupt', 'short', 'oversized', 'redirect'])('removes partial downloads after %s failure', async mode => {
    const f = fixture()
    const update = (await f.client.check('2.0.21', publicKey))!
    f.responses.set(f.url(f.name), () => mode === 'redirect'
      ? new Response(null, { status: 302, headers: { location: 'https://example.com/evil.zip' } })
      : new Response(mode === 'short' ? f.bytes.subarray(0, 2) : mode === 'oversized' ? Buffer.alloc(100) : Buffer.alloc(f.bytes.length)))
    const root = await mkdtemp(join(tmpdir(), 'github-update-')); roots.push(root)
    await expect(f.client.download(update, join(root, 'package.zip'), () => {})).rejects.toThrow()
    await expect(readFile(join(root, 'package.zip'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.fetcher.mock.calls.some(([url]) => url.includes('example.com'))).toBe(false)
  })
  it('reports HTTP failures and cancellation', async () => {
    const f = fixture()
    f.fetcher.mockResolvedValue(new Response('', { status: 403 }))
    await expect(f.client.check('2.0.21', publicKey)).rejects.toThrow('403')
    f.controller.abort()
    f.fetcher.mockImplementation(async (_url, init) => { init.signal!.throwIfAborted(); return Response.json([]) })
    await expect(f.client.check('2.0.21', publicKey)).rejects.toThrow()
  })
})

it('aborts a stalled metadata request after 60 seconds', async () => {
  vi.useFakeTimers()
  try {
    const f = fixture()
    f.fetcher.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('request aborted')), { once: true })
    }))
    const check = expect(f.client.check('2.0.21', publicKey)).rejects.toThrow('aborted')
    await vi.advanceTimersByTimeAsync(60_000)
    await check
  } finally { vi.useRealTimers() }
})
