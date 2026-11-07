import type { Readable } from 'node:stream'
import { net, session } from 'electron'
import { INTRANET_UPDATE_ORIGIN } from './intranet-update'
import type { UpdateFetch } from './online-update'

/** Never include raw proxy rules: PAC results may contain credentials. */
export function updateRouteSummary(hostname: string, route?: string): string {
  const mode = '系统网络'
  const hops = route?.split(';').map(item => item.trim()).filter(Boolean) ?? []
  const direct = hops.length === 1 && hops[0] === 'DIRECT'
  const proxied = hops.some(item => /^(PROXY|HTTPS?|SOCKS[45]?)\s/i.test(item))
  const path = direct ? '直连' : proxied ? '代理配置（实际连接及认证待确认）' : '路由未确认'
  // hostname comes exclusively from the allowlisted request URL.
  return `${mode} · ${hostname} · ${path}`
}

/** Dedicated ephemeral session: no changes to renderer/Agent networking or trust. */
export async function createUpdateTransport(onDiagnostic: (summary: string) => void = () => {}): Promise<{ fetch: UpdateFetch; close: () => Promise<void> }> {
  const origin = INTRANET_UPDATE_ORIGIN
  const network = session.fromPartition('pangea-intranet-update', { cache: false })
  await network.closeAllConnections()
  await network.clearAuthCache()
  await network.setProxy({ mode: 'system' })
  network.setCertificateVerifyProc(null)
  onDiagnostic('网络模式：系统网络')
  const active = new Set<Electron.ClientRequest>()
  const fetch: UpdateFetch = (url, init) => new Promise((resolve, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.hash || target.origin !== origin) {
      reject(new Error('更新下载地址不在当前更新源允许列表中。')); return
    }
    if (init.signal?.aborted) { reject(new Error('更新请求已取消。')); return }
    const request = net.request({ url, session: network, redirect: 'manual' })
    active.add(request)
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    // Diagnostics must not delay a request or turn a successful transfer into a failure.
    void network.resolveProxy(url).then(route => {
      if (!ended) onDiagnostic(updateRouteSummary(target.hostname, route))
    }).catch(() => {
      if (!ended) onDiagnostic(updateRouteSummary(target.hostname))
    })
    const cleanup = () => { active.delete(request); init.signal?.removeEventListener('abort', abort) }
    const fail = (error: Error) => {
      if (ended) return
      ended = true; cleanup(); reject(error); stream?.error(error); request.abort()
    }
    const abort = () => fail(new Error('更新请求已取消或等待响应超时。'))
    init.signal?.addEventListener('abort', abort, { once: true })
    new Headers(init.headers).forEach((value, name) => request.setHeader(name, value))
    request.on('login', (auth, callback) => {
      callback()
      fail(new Error(auth.isProxy ? '系统代理要求认证（407），请检查系统代理或内网直连配置。' : '内网更新服务器要求身份认证。'))
    })
    request.on('error', error => {
      const code = error.message.match(/net::ERR_[A-Z_]+/)?.[0] ?? '网络连接失败'
      fail(new Error(`${code}；请检查在线更新的代理认证、网络及证书配置。`))
    })
    request.on('redirect', (status, _method, location) => {
      // Let OnlineUpdateDownloader validate every redirect before opening it.
      ended = true; cleanup()
      resolve(new Response(null, { status, headers: { location } }))
      request.abort()
    })
    request.on('response', response => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(response.headers)) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
      // Electron 43.4 IncomingMessage extends Node Readable, though its public
      // type omits those methods. Pause/resume propagates backpressure to Chromium.
      const incoming = response as unknown as Readable
      const body = new ReadableStream<Uint8Array>({
        start(controller) { stream = controller },
        pull() { if (!ended) incoming.resume() },
        cancel() { ended = true; cleanup(); request.abort() }
      }, { highWaterMark: 256 * 1024, size: chunk => chunk.byteLength })
      response.on('end', () => { if (!ended) { ended = true; cleanup(); stream!.close() } })
      response.on('error', () => fail(new Error('更新下载连接中断，请重试。')))
      response.on('aborted', () => fail(new Error('更新下载连接被中止，请重试。')))
      response.on('data', chunk => {
        if (ended) return
        stream!.enqueue(new Uint8Array(chunk))
        if ((stream!.desiredSize ?? 0) <= 0) incoming.pause()
      })
      resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : body, { status: response.statusCode, headers }))
    })
    request.end()
  })
  return { fetch, close: async () => {
    for (const request of active) request.abort()
    active.clear()
    network.setCertificateVerifyProc(null)
    await network.closeAllConnections()
    await network.clearAuthCache()
  } }
}
