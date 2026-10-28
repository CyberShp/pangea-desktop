import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Readable } from 'node:stream'
import { net, session } from 'electron'
import type { UpdateFetch } from './github-update'

export interface UpdateNetworkSettings {
  proxyUrl: string
  username: string
  password: string
  skipCertificateCheck: boolean
}
export function parseUpdateNetwork(input: unknown): UpdateNetworkSettings {
  const value = input as Partial<UpdateNetworkSettings> | null
  if (!value || typeof value.proxyUrl !== 'string' || typeof value.username !== 'string' || typeof value.password !== 'string' || typeof value.skipCertificateCheck !== 'boolean') {
    throw new Error('在线更新网络配置无效。')
  }
  const result = { proxyUrl: '', username: value.username, password: value.password, skipCertificateCheck: value.skipCertificateCheck }
  if (!value.proxyUrl.trim()) return { ...result, username: '', password: '' }
  try {
    const url = new URL(value.proxyUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.pathname !== '/' || url.search || url.hash) throw new Error()
    if (url.username || url.password) {
      result.username = decodeURIComponent(url.username)
      result.password = decodeURIComponent(url.password)
    }
    url.username = ''; url.password = ''
    result.proxyUrl = url.origin
    return result
  } catch { throw new Error('代理地址无效，请填写 http://主机:端口；账号密码可单独填写，URL 中的特殊字符需要百分号编码。') }
}

// Credentials and the diagnostic certificate override never go to disk or back to the renderer.
export class UpdateNetworkStore {
  private settings: UpdateNetworkSettings = { proxyUrl: '', username: '', password: '', skipCertificateCheck: false }
  private loaded = false
  constructor(private readonly path: string) {}
  async get(): Promise<UpdateNetworkSettings> {
    if (!this.loaded) {
      try {
        const saved = JSON.parse(await readFile(this.path, 'utf8'))
        this.settings = parseUpdateNetwork({ proxyUrl: saved.proxyUrl, username: saved.username, password: '', skipCertificateCheck: false })
      } catch { /* First run or invalid configuration: use system proxy. */ }
      this.loaded = true
    }
    return { ...this.settings }
  }
  async view() {
    const value = await this.get()
    return { proxyUrl: value.proxyUrl, username: value.username, hasPassword: !!value.password, skipCertificateCheck: value.skipCertificateCheck }
  }
  async save(input: unknown) {
    const value = parseUpdateNetwork(input)
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify({ proxyUrl: value.proxyUrl, username: value.username }), { mode: 0o600 })
    this.settings = value
    this.loaded = true
    return this.view()
  }
}

export const UPDATE_HOSTS = ['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']
export function matchesProxy(auth: { isProxy: boolean; host: string; port: number }, settings: UpdateNetworkSettings): boolean {
  if (!auth.isProxy || !settings.proxyUrl || !settings.username) return false
  const proxy = new URL(settings.proxyUrl)
  return auth.host.toLowerCase() === proxy.hostname.toLowerCase() && auth.port === Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))
}

/** Never include raw proxy rules: PAC results may contain credentials. */
export function updateRouteSummary(proxyUrl: string, hostname: string, route?: string): string {
  const mode = proxyUrl ? '手动代理' : '系统网络'
  const hops = route?.split(';').map(item => item.trim()).filter(Boolean) ?? []
  const direct = hops.length === 1 && hops[0] === 'DIRECT'
  const proxied = hops.some(item => /^(PROXY|HTTPS?|SOCKS[45]?)\s/i.test(item))
  const path = direct ? '直连' : proxied ? '代理配置（实际连接及认证待确认）' : '路由未确认'
  // hostname comes exclusively from the allowlisted request URL.
  return `${mode} · ${hostname} · ${path}`
}

/** Dedicated ephemeral session: no changes to renderer/Agent networking or trust. */
export async function createUpdateTransport(settings: UpdateNetworkSettings, onDiagnostic: (summary: string) => void = () => {}): Promise<{ fetch: UpdateFetch; close: () => Promise<void> }> {
  // Keep diagnostic certificate decisions out of the normal session's verifier cache.
  const network = session.fromPartition(settings.skipCertificateCheck ? 'pangea-online-update-diagnostic' : 'pangea-online-update', { cache: false })
  await network.closeAllConnections()
  await network.clearAuthCache()
  await network.setProxy(settings.proxyUrl ? { mode: 'fixed_servers', proxyRules: settings.proxyUrl } : { mode: 'system' })
  network.setCertificateVerifyProc(settings.skipCertificateCheck
    ? (request, callback) => callback(UPDATE_HOSTS.includes(request.hostname) ? 0 : -3)
    : null)
  onDiagnostic(settings.proxyUrl ? '网络模式：手动代理' : '网络模式：系统网络（无需预先填写代理账号密码）')
  const active = new Set<Electron.ClientRequest>()
  const fetch: UpdateFetch = (url, init) => new Promise((resolve, reject) => {
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.port || !UPDATE_HOSTS.includes(target.hostname)) {
      reject(new Error('更新下载地址不在 GitHub 允许列表中。')); return
    }
    if (init.signal?.aborted) { reject(new Error('更新请求已取消。')); return }
    const request = net.request({ url, session: network, redirect: 'manual' })
    active.add(request)
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    let ended = false
    let attempts = 0
    // Diagnostics must not delay a request or turn a successful transfer into a failure.
    void network.resolveProxy(url).then(route => {
      if (!ended) onDiagnostic(updateRouteSummary(settings.proxyUrl, target.hostname, route))
    }).catch(() => {
      if (!ended) onDiagnostic(updateRouteSummary(settings.proxyUrl, target.hostname))
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
      // Never send company credentials to a release server or another proxy.
      if (matchesProxy(auth, settings) && attempts++ === 0) callback(settings.username, settings.password)
      else {
        callback()
        fail(new Error(!auth.isProxy
          ? '更新服务器要求身份认证，已拒绝发送代理凭据。'
          : settings.proxyUrl
            ? '代理认证失败（407）：请在在线更新网络设置中确认代理地址并重新填写账号密码。密码仅在本次运行有效。'
            : '系统代理要求认证（407）：系统网络未能自动完成认证，请在在线更新网络设置中填写代理地址、账号和密码。'))
      }
    })
    request.on('error', error => {
      const code = error.message.match(/net::ERR_[A-Z_]+/)?.[0] ?? '网络连接失败'
      fail(new Error(`${code}；请检查在线更新的代理认证、网络及证书配置。`))
    })
    request.on('redirect', (status, _method, location) => {
      // Let GitHubUpdateClient validate every redirect before opening it.
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
