import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'

export const UPDATE_MANIFEST_NAME = 'pangea-desktop-update.json'
export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>
interface Asset { name: string; size: number; browser_download_url: string; state: string }
export interface OnlineUpdate {
  packageType?: 'full' | 'patch'
  baseVersion?: string
  releaseId: number
  version: string
  asset: Asset
  sha256: string
}

/** Uses the Electron network session (including system proxy) in production. */
export class OnlineUpdateDownloader {
  constructor(private readonly fetcher: UpdateFetch, private readonly signal: AbortSignal, private readonly allowedOrigin: string) {}

  private async consume(url: string, limit: number, stage: string, consume: (chunk: Uint8Array) => Promise<void>): Promise<number> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    this.signal.addEventListener('abort', abort, { once: true })
    if (this.signal.aborted) controller.abort()
    let timer: ReturnType<typeof setTimeout>
    const touch = () => { clearTimeout(timer); timer = setTimeout(abort, 60_000) }
    touch()
    try {
      let response: Response | undefined
      for (let redirects = 0; redirects <= 5; redirects++) {
        const target = new URL(url)
        if (target.protocol !== 'https:' || target.username || target.password || target.hash ||
          target.origin !== this.allowedOrigin) {
          throw new Error('更新下载地址不在当前更新源允许列表中。')
        }
        response = await this.fetcher(url, { redirect: 'manual', signal: controller.signal,
          headers: { 'User-Agent': 'PANGEA-Desktop-Updater', 'Cache-Control': 'no-cache', Accept: 'application/octet-stream' } })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || redirects === 5) throw new Error('内网下载重定向无效。')
        url = new URL(location, url).href
      }
      if (!response?.ok || !response.body) {
        const status = response?.status
        const reason = status === 407 ? '代理要求认证，请检查系统代理认证。'
          : status === 504 ? '网关等待上游超时；请对比浏览器能否下载同一附件。'
          : status === 403 ? '访问被拒绝；请检查内网访问权限。'
          : '请检查代理、网络或内网更新文件是否可访问。'
        await response?.body?.cancel()
        throw new Error(`HTTP ${status ?? 'unknown'}：${reason}`)
      }
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body.cancel()
        throw new Error('内网更新内容超过大小限制。')
      }
      const reader = response.body.getReader()
      let received = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          touch()
          received += value.byteLength
          if (received > limit) throw new Error('内网更新内容超过大小限制。')
          await consume(value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      return received
    } catch (error) {
      const message = error instanceof Error ? error.message : '更新请求失败。'
      throw new Error(`${stage}（${new URL(url).hostname}）：${message}`)
    } finally {
      clearTimeout(timer!)
      this.signal.removeEventListener('abort', abort)
    }
  }

  protected async bytes(url: string, stage: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = []
    await this.consume(url, limit, stage, async chunk => { chunks.push(Buffer.from(chunk)) })
    return Buffer.concat(chunks)
  }

  async download(update: OnlineUpdate, destination: string, progress: (percent: number) => void): Promise<void> {
    const file = await open(destination, 'wx')
    let succeeded = false
    try {
      const hash = createHash('sha256')
      let received = 0
      await this.consume(update.asset.browser_download_url, update.asset.size, '下载安装包', async chunk => {
        await file.writeFile(chunk)
        hash.update(chunk)
        received += chunk.byteLength
        progress(received / update.asset.size * 100)
      })
      if (received !== update.asset.size || hash.digest('hex') !== update.sha256) throw new Error('下载的升级包大小或 SHA-256 校验失败。')
      succeeded = true
    } finally {
      await file.close()
      if (!succeeded) await rm(destination, { force: true })
    }
  }
}
