import { createHash, createPublicKey, verify } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { isNewerPortableVersion, portableUpdateChannelForVersion } from './portable-update'

export const UPDATE_REPOSITORY = 'CyberShp/pangea-desktop'
export const UPDATE_MANIFEST_NAME = 'pangea-desktop-update.json'
const MAX_PACKAGE_BYTES = 20 * 1024 ** 3
export type UpdateFetch = (url: string, init: RequestInit) => Promise<Response>
interface Asset { name: string; size: number; browser_download_url: string; state: string }
interface Release { id: number; tag_name: string; draft: boolean; prerelease: boolean; assets: Asset[] }
export interface OnlineUpdate {
  releaseId: number
  version: string
  asset: Asset
  sha256: string
}

/** Uses the Electron network session (including system proxy) in production. */
export class GitHubUpdateClient {
  constructor(private readonly fetcher: UpdateFetch, private readonly signal: AbortSignal) {}

  private async consume(url: string, limit: number, consume: (chunk: Uint8Array) => Promise<void>): Promise<number> {
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
        if (target.protocol !== 'https:' || target.username || target.password || target.port ||
          !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
          throw new Error('更新下载地址不在 GitHub 允许列表中。')
        }
        response = await this.fetcher(url, { redirect: 'manual', signal: controller.signal,
          headers: { 'User-Agent': 'PANGEA-Desktop-Updater', Accept: target.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' } })
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location || redirects === 5) throw new Error('GitHub 下载重定向无效。')
        url = new URL(location, url).href
      }
      if (!response?.ok || !response.body) throw new Error(`GitHub 更新请求失败（HTTP ${response?.status ?? 'unknown'}）。请检查网络或仓库访问权限。`)
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body.cancel()
        throw new Error('GitHub 更新内容超过大小限制。')
      }
      const reader = response.body.getReader()
      let received = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          touch()
          received += value.byteLength
          if (received > limit) throw new Error('GitHub 更新内容超过大小限制。')
          await consume(value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
      return received
    } finally {
      clearTimeout(timer!)
      this.signal.removeEventListener('abort', abort)
    }
  }

  private async bytes(url: string, limit = 2 * 1024 * 1024): Promise<Buffer> {
    const chunks: Buffer[] = []
    await this.consume(url, limit, async chunk => { chunks.push(Buffer.from(chunk)) })
    return Buffer.concat(chunks)
  }

  async check(currentVersion: string, publicKeyPem: string): Promise<OnlineUpdate | undefined> {
    const channel = portableUpdateChannelForVersion(currentVersion)
    let candidate: Release | undefined
    // Enumerate by channel instead of relying on /latest, which omits test releases.
    for (let page = 1; ; page++) {
      if (page > 100) throw new Error('GitHub Release 数量超过检查上限，请稍后重试。')
      const releases = JSON.parse((await this.bytes(`https://api.github.com/repos/${UPDATE_REPOSITORY}/releases?per_page=100&page=${page}`)).toString()) as Release[]
      if (!Array.isArray(releases)) throw new Error('GitHub Release 响应无效。')
      for (const release of releases) {
        if (release.draft || release.prerelease !== (channel === 'test') || !release.tag_name?.startsWith('v')) continue
        const version = release.tag_name.slice(1)
        if (isNewerPortableVersion(version, candidate?.tag_name.slice(1) ?? currentVersion, channel)) candidate = release
      }
      if (releases.length < 100) break
    }
    if (!candidate) return undefined
    const version = candidate.tag_name.slice(1)
    const asset = (name: string): Asset => {
      const matches = candidate!.assets.filter(item => item.name === name && item.state === 'uploaded')
      if (matches.length !== 1) throw new Error(`Release ${candidate!.tag_name} 缺少唯一的 ${name}；请等待发布完成或使用离线导入。`)
      const item = matches[0]!
      const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${candidate!.tag_name}/${name}`
      if (item.browser_download_url !== expected) throw new Error('Release 附件地址与锁定版本不一致。')
      return item
    }
    const manifestBytes = await this.bytes(asset(UPDATE_MANIFEST_NAME).browser_download_url)
    const signature = await this.bytes(asset(`${UPDATE_MANIFEST_NAME}.sig`).browser_download_url, 1024)
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, manifestBytes, key, Buffer.from(signature.toString().trim(), 'base64'))) {
      throw new Error('在线更新清单签名校验失败。')
    }
    const manifest = JSON.parse(manifestBytes.toString())
    const packageName = `pangea-desktop-${version}-windows-x64-portable.zip`
    if (manifest.schema_version !== 1 || manifest.product !== 'PANGEA Desktop' || manifest.version !== version ||
      manifest.channel !== channel || manifest.platform !== 'win32' || manifest.arch !== 'x64' ||
      manifest.package?.name !== packageName || !Number.isSafeInteger(manifest.package.size) ||
      manifest.package.size <= 0 || manifest.package.size > MAX_PACKAGE_BYTES || !/^[a-f0-9]{64}$/.test(manifest.package.sha256)) {
      throw new Error('在线更新清单与 Release 不一致。')
    }
    const minimum = manifest.minimum_source_version
    // Compare the numeric base for test builds, exactly as the installed policy does.
    const base = currentVersion.split('-')[0]!
    if (typeof minimum !== 'string' || !/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error('在线更新最低版本无效。')
    if (isNewerPortableVersion(minimum, base)) throw new Error(`此更新最低支持 ${minimum}，请在独立目录安装完整包。`)
    const packageAsset = asset(packageName)
    if (packageAsset.size !== manifest.package.size) throw new Error('Release 附件大小与签名清单不一致。')
    return { releaseId: candidate.id, version, asset: packageAsset, sha256: manifest.package.sha256 }
  }

  async download(update: OnlineUpdate, destination: string, progress: (percent: number) => void): Promise<void> {
    const file = await open(destination, 'wx')
    let succeeded = false
    try {
      const hash = createHash('sha256')
      let received = 0
      await this.consume(update.asset.browser_download_url, update.asset.size, async chunk => {
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
