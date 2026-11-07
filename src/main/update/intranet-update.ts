import { createPublicKey, verify } from 'node:crypto'
import { GitHubUpdateClient, type OnlineUpdate, type UpdateFetch } from './github-update'
import { isNewerPortableVersion, portableUpdateChannelForVersion } from './portable-update'

export function parseUpdateSource(input: { updateSource?: unknown; indexUrl?: unknown }): { updateSource: 'github' | 'intranet'; indexUrl: string } {
  if (!['github', 'intranet'].includes(String(input.updateSource))) throw new Error('更新源类型无效。')
  const indexUrl = typeof input.indexUrl === 'string' ? input.indexUrl.trim() : ''
  if (input.updateSource === 'intranet' || indexUrl) {
    try {
      const url = new URL(indexUrl)
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error()
    } catch { throw new Error('内网更新源需填写完整 HTTPS 索引地址，不能包含账号密码或片段。') }
  }
  return { updateSource: input.updateSource as 'github' | 'intranet', indexUrl }
}

/** The unsigned index locates immutable release files. Trust stays in signed metadata and ZIPs. */
export class IntranetUpdateClient extends GitHubUpdateClient {
  private readonly indexUrl: string
  constructor(fetcher: UpdateFetch, signal: AbortSignal, indexUrl: string) {
    const parsed = parseUpdateSource({ updateSource: 'intranet', indexUrl })
    super(fetcher, signal, new URL(parsed.indexUrl).origin)
    this.indexUrl = parsed.indexUrl
  }

  override async check(currentVersion: string, publicKeyPem: string): Promise<OnlineUpdate | undefined> {
    const index = JSON.parse((await this.bytes(this.indexUrl, '查询内网版本')).toString())
    const channel = portableUpdateChannelForVersion(currentVersion)
    if (!index || index.schema_version !== 1 || index.product !== 'PANGEA Desktop' || index.channel !== channel || index.platform !== 'win32' || index.arch !== 'x64') {
      throw new Error('内网索引格式、平台或更新通道不匹配。')
    }
    const url = (value: unknown): string => {
      try {
        if (typeof value !== 'string') throw new Error()
        const target = new URL(value)
        if (target.origin !== new URL(this.indexUrl).origin || target.username || target.password || target.hash) throw new Error()
        return target.href
      } catch { throw new Error('内网制品必须使用与索引同源的完整 HTTPS 地址。') }
    }
    const bytes = await this.bytes(url(index.manifest_url), '下载内网更新清单')
    const signature = await this.bytes(url(index.signature_url), '下载内网清单签名', 1024)
    const key = createPublicKey(publicKeyPem)
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(signature.toString().trim(), 'base64'))) throw new Error('内网更新清单签名校验失败。')
    const manifest = JSON.parse(bytes.toString())
    const version = manifest.version
    if (typeof version !== 'string' || manifest.schema_version !== 1 || manifest.product !== 'PANGEA Desktop' || manifest.channel !== channel || manifest.platform !== 'win32' || manifest.arch !== 'x64' || index.version !== version) throw new Error('内网索引与签名清单不一致。')
    const validPackage = (item: any) => item && typeof item.name === 'string' && /^[a-zA-Z0-9._-]+\.zip$/.test(item.name) && Number.isSafeInteger(item.size) && item.size > 0 && item.size <= 20 * 1024 ** 3 && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256)
    if (!validPackage(manifest.package) || manifest.package.name !== `pangea-desktop-${version}-windows-x64-portable.zip`) throw new Error('内网完整包元数据无效。')
    const minimum = manifest.minimum_source_version
    if (typeof minimum !== 'string' || !/^\d+\.\d+\.\d+$/.test(minimum)) throw new Error('在线更新最低版本无效。')
    if (!isNewerPortableVersion(version, currentVersion, channel)) return undefined
    if (isNewerPortableVersion(minimum, currentVersion.split('-')[0]!)) throw new Error(`此更新最低支持 ${minimum}，请在独立目录安装完整包。`)
    const fullUrl = url(index.full_url)
    if (!Array.isArray(index.patches) || index.patches.length > 1000) throw new Error('内网补丁索引无效。')
    const matches = index.patches.filter((p: any) => p?.from_version === currentVersion)
    if (matches.length > 1) throw new Error('内网索引包含重复补丁基线。')
    const patch = matches[0]
    if (patch && (!validPackage(patch) || patch.to_version !== version)) throw new Error('内网补丁元数据无效。')
    // Do not waste bandwidth on a patch larger than the full package.
    const selected = patch && patch.size < manifest.package.size ? patch : undefined
    const item = selected ?? manifest.package
    return {
      releaseId: 0, version, sha256: item.sha256,
      packageType: selected ? 'patch' : 'full', baseVersion: selected?.from_version,
      asset: { name: item.name, size: item.size, state: 'uploaded', browser_download_url: selected ? url(selected.url) : fullUrl }
    }
  }
}
