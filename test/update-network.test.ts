import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), fromPartition: vi.fn(), network: {
  closeAllConnections: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}),
  resolveProxy: vi.fn(async () => 'DIRECT'),
  setProxy: vi.fn(async () => {}), setCertificateVerifyProc: vi.fn()
} }))
vi.mock('electron', () => ({ net: { request: mocks.request }, session: { fromPartition: mocks.fromPartition } }))
import { createUpdateTransport, matchesProxy, parseUpdateNetwork, updateRouteSummary, UpdateNetworkStore } from '../src/main/update/update-network'

const settings = { proxyUrl: 'http://proxy.example:8080', username: 'employee', password: 'secret', skipCertificateCheck: false }
let request: EventEmitter & { abort: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
const roots: string[] = []
beforeEach(() => {
  vi.clearAllMocks()
  request = Object.assign(new EventEmitter(), { abort: vi.fn(), setHeader: vi.fn(), end: vi.fn() })
  mocks.request.mockReturnValue(request)
  mocks.fromPartition.mockReturnValue(mocks.network)
})
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('update proxy configuration and credential boundary', () => {
  it('accepts credential URLs, decodes escaped characters and strips credentials from proxy rules', () => {
    expect(parseUpdateNetwork({ ...settings, proxyUrl: 'http://user:p%40ss%3A%23%25@proxy.example:8080' })).toEqual({ ...settings, username: 'user', password: 'p@ss:#%' })
  })
  it.each(['socks5://proxy.example:8080', 'http://proxy.example/path', 'http://proxy.example/#secret', 'http://u:%zz@proxy.example'])('rejects malformed settings without disclosing input: %s', proxyUrl => {
    try { parseUpdateNetwork({ ...settings, proxyUrl }); expect.fail() } catch (error) {
      expect(String(error)).toContain('代理地址无效')
      expect(String(error)).not.toContain(proxyUrl)
    }
  })
  it('persists address and account only; restart clears password and trust override', async () => {
    const root = await mkdtemp(join(tmpdir(), 'update-network-')); roots.push(root)
    const path = join(root, 'network.json')
    const store = new UpdateNetworkStore(path)
    const view = await store.save({ ...settings, proxyUrl: 'http://employee:secret@proxy.example:8080', skipCertificateCheck: true })
    expect(view).toEqual({ proxyUrl: settings.proxyUrl, username: 'employee', hasPassword: true, skipCertificateCheck: true })
    const saved = await readFile(path, 'utf8')
    expect(saved).not.toContain('secret')
    expect(saved).not.toContain('skipCertificateCheck')
    expect(await new UpdateNetworkStore(path).get()).toEqual({ ...settings, password: '' })
    expect(await store.get()).toEqual({ ...settings, skipCertificateCheck: true })
  })
  it('does not offer company credentials to origins, other proxies or other ports', () => {
    expect(matchesProxy({ isProxy: true, host: 'proxy.example', port: 8080 }, settings)).toBe(true)
    for (const auth of [{ isProxy: false, host: 'proxy.example', port: 8080 }, { isProxy: true, host: 'github.com', port: 8080 }, { isProxy: true, host: 'proxy.example', port: 80 }]) expect(matchesProxy(auth, settings)).toBe(false)
  })
})

describe('isolated Electron update transport', () => {
  it('reports system routing without including PAC credentials or asserting authentication', async () => {
    const diagnostic = vi.fn()
    mocks.network.resolveProxy.mockResolvedValueOnce('PROXY employee:secret@proxy.example:8080; DIRECT')
    const transport = await createUpdateTransport({ ...settings, proxyUrl: '', username: '', password: '' }, diagnostic)
    const pending = transport.fetch('https://github.com/asset', {})
    await Promise.resolve()
    expect(diagnostic).toHaveBeenLastCalledWith('系统网络 · github.com · 代理配置（实际连接及认证待确认）')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret')
    request.emit('redirect', 302, 'GET', 'https://github.com/next')
    await pending
    await transport.close()
    expect(updateRouteSummary('', 'github.com', 'DIRECT')).toContain('直连')
  })
  it('fails visibly when system proxy requires explicit credentials, without sending empty credentials', async () => {
    const transport = await createUpdateTransport({ ...settings, proxyUrl: '', username: '', password: '' })
    const pending = transport.fetch('https://api.github.com/releases', {})
    const failure = expect(pending).rejects.toThrow('系统代理要求认证（407）')
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    expect(callback).toHaveBeenCalledWith()
    await failure
    await transport.close()
  })

  it('uses system proxy by default and limits optional certificate override to update hosts', async () => {
    const transport = await createUpdateTransport({ ...settings, proxyUrl: '', skipCertificateCheck: true })
    expect(mocks.fromPartition).toHaveBeenLastCalledWith('pangea-online-update-diagnostic', { cache: false })
    expect(mocks.network.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    const verify = (mocks.network.setCertificateVerifyProc.mock.calls as unknown[][])[0]![0] as any
    const done = vi.fn()
    verify({ hostname: 'github.com' }, done); expect(done).toHaveBeenLastCalledWith(0)
    verify({ hostname: 'other.example' }, done); expect(done).toHaveBeenLastCalledWith(-3)
    await transport.close()
    expect(mocks.network.setCertificateVerifyProc).toHaveBeenLastCalledWith(null)
    expect(mocks.network.clearAuthCache).toHaveBeenCalledTimes(2)
    const normal = await createUpdateTransport(settings)
    expect(mocks.fromPartition).toHaveBeenLastCalledWith('pangea-online-update', { cache: false })
    expect(mocks.network.setCertificateVerifyProc).toHaveBeenLastCalledWith(null)
    await normal.close()
  })
  it('responds to matching proxy challenge once and rejects repeated bad credentials', async () => {
    const transport = await createUpdateTransport(settings)
    const pending = transport.fetch('https://api.github.com/releases', {})
    const failure = expect(pending).rejects.toThrow('407')
    const callback = vi.fn()
    const challenge = { isProxy: true, host: 'proxy.example', port: 8080 }
    request.emit('login', challenge, callback)
    expect(callback).toHaveBeenLastCalledWith('employee', 'secret')
    request.emit('login', challenge, callback)
    expect(callback).toHaveBeenLastCalledWith()
    await failure
    expect(request.abort).toHaveBeenCalled()
    await transport.close()
  })
  it('returns redirects without following them or leaking URL queries into errors', async () => {
    const transport = await createUpdateTransport(settings)
    const pending = transport.fetch('https://github.com/asset', {})
    request.emit('redirect', 302, 'GET', 'https://untrusted.example/?secret=123')
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://untrusted.example/?secret=123')
    expect(request.abort).toHaveBeenCalled()
    await expect(transport.fetch('https://untrusted.example/?secret=123', {})).rejects.toThrow('允许列表')
    await transport.close()
  })
  it('streams bytes and aborts when the consumer cancels', async () => {
    const transport = await createUpdateTransport(settings)
    const pending = transport.fetch('https://github.com/asset', {})
    const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
    request.emit('response', incoming)
    const response = await pending
    const reader = response.body!.getReader()
    incoming.write(Buffer.from('abc'))
    expect((await reader.read()).value).toEqual(new Uint8Array(Buffer.from('abc')))
    await reader.cancel()
    expect(request.abort).toHaveBeenCalled()
    await transport.close()
  })
  it('applies backpressure instead of buffering a whole package for a slow consumer', async () => {
    const transport = await createUpdateTransport(settings)
    const pending = transport.fetch('https://github.com/asset', {})
    const incoming = Object.assign(new PassThrough(), { statusCode: 200, headers: {} })
    request.emit('response', incoming)
    const response = await pending
    incoming.write(Buffer.alloc(256 * 1024))
    expect(incoming.isPaused()).toBe(true)
    const reader = response.body!.getReader()
    expect((await reader.read()).value!.length).toBe(256 * 1024)
    await new Promise(resolve => setImmediate(resolve))
    expect(incoming.isPaused()).toBe(false)
    incoming.end(Buffer.from('tail'))
    expect(Buffer.from((await reader.read()).value!).toString()).toBe('tail')
    expect((await reader.read()).done).toBe(true)
    await transport.close()
  })
  it('aborts pending requests and sanitizes native error URLs', async () => {
    const transport = await createUpdateTransport(settings)
    const controller = new AbortController()
    const pending = transport.fetch('https://github.com/asset', { signal: controller.signal })
    const failure = expect(pending).rejects.toThrow('已取消')
    controller.abort(); await failure
    const second = transport.fetch('https://github.com/asset', {})
    request.emit('error', new Error('net::ERR_CERT_AUTHORITY_INVALID https://employee:secret@proxy.example/'))
    await expect(second).rejects.toThrow(/^net::ERR_CERT_AUTHORITY_INVALID；/)
    await transport.close()
  })
})
