import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ request: vi.fn(), fromPartition: vi.fn(), network: {
  closeAllConnections: vi.fn(async () => {}), clearAuthCache: vi.fn(async () => {}),
  resolveProxy: vi.fn(async () => 'DIRECT'),
  setProxy: vi.fn(async () => {}), setCertificateVerifyProc: vi.fn()
} }))
vi.mock('electron', () => ({ net: { request: mocks.request }, session: { fromPartition: mocks.fromPartition } }))
import { createUpdateTransport, updateRouteSummary } from '../src/main/update/update-network'

let request: EventEmitter & { abort: ReturnType<typeof vi.fn>; setHeader: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.clearAllMocks()
  request = Object.assign(new EventEmitter(), { abort: vi.fn(), setHeader: vi.fn(), end: vi.fn() })
  mocks.request.mockReturnValue(request)
  mocks.fromPartition.mockReturnValue(mocks.network)
})

describe('isolated Electron update transport', () => {
  it('reports system routing without including PAC credentials or asserting authentication', async () => {
    const diagnostic = vi.fn()
    mocks.network.resolveProxy.mockResolvedValueOnce('PROXY employee:secret@proxy.example:8080; DIRECT')
    const transport = await createUpdateTransport(diagnostic)
    const pending = transport.fetch('https://pangea.rnd.huawei.com/asset', {})
    await Promise.resolve()
    expect(diagnostic).toHaveBeenLastCalledWith('系统网络 · pangea.rnd.huawei.com · 代理配置（实际连接及认证待确认）')
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret')
    request.emit('redirect', 302, 'GET', 'https://pangea.rnd.huawei.com/next')
    await pending
    await transport.close()
    expect(updateRouteSummary('pangea.rnd.huawei.com', 'DIRECT')).toContain('直连')
  })
  it('fails visibly when system proxy requires explicit credentials, without sending empty credentials', async () => {
    const transport = await createUpdateTransport()
    const pending = transport.fetch('https://pangea.rnd.huawei.com/releases', {})
    const failure = expect(pending).rejects.toThrow('系统代理要求认证（407）')
    const callback = vi.fn()
    request.emit('login', { isProxy: true, host: 'proxy.example', port: 8080 }, callback)
    expect(callback).toHaveBeenCalledWith()
    await failure
    await transport.close()
  })

  it('uses system networking with normal certificate validation', async () => {
    const transport = await createUpdateTransport()
    expect(mocks.fromPartition).toHaveBeenCalledWith('pangea-intranet-update', { cache: false })
    expect(mocks.network.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    expect(mocks.network.setCertificateVerifyProc).toHaveBeenCalledWith(null)
    for (const url of ['https://github.com/asset', 'http://pangea.rnd.huawei.com/file', 'https://pangea.rnd.huawei.com:8443/file']) {
      await expect(transport.fetch(url, {})).rejects.toThrow('允许列表')
    }
    expect(mocks.request).not.toHaveBeenCalled()
    await transport.close()
  })
  it('returns redirects without following them or leaking URL queries into errors', async () => {
    const transport = await createUpdateTransport()
    const pending = transport.fetch('https://pangea.rnd.huawei.com/asset', {})
    request.emit('redirect', 302, 'GET', 'https://untrusted.example/?secret=123')
    const response = await pending
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://untrusted.example/?secret=123')
    expect(request.abort).toHaveBeenCalled()
    await expect(transport.fetch('https://untrusted.example/?secret=123', {})).rejects.toThrow('允许列表')
    await transport.close()
  })
  it('streams bytes and aborts when the consumer cancels', async () => {
    const transport = await createUpdateTransport()
    const pending = transport.fetch('https://pangea.rnd.huawei.com/asset', {})
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
    const transport = await createUpdateTransport()
    const pending = transport.fetch('https://pangea.rnd.huawei.com/asset', {})
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
    const transport = await createUpdateTransport()
    const controller = new AbortController()
    const pending = transport.fetch('https://pangea.rnd.huawei.com/asset', { signal: controller.signal })
    const failure = expect(pending).rejects.toThrow('已取消')
    controller.abort(); await failure
    const second = transport.fetch('https://pangea.rnd.huawei.com/asset', {})
    request.emit('error', new Error('net::ERR_CERT_AUTHORITY_INVALID https://employee:secret@proxy.example/'))
    await expect(second).rejects.toThrow(/^net::ERR_CERT_AUTHORITY_INVALID；/)
    await transport.close()
  })
})
