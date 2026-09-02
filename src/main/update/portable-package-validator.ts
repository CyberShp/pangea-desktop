import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import unzipper from 'unzipper'
import {
  isNewerPortableVersion,
  normalizePortableEntryPath,
  portableUpdateChannelForVersion,
  PORTABLE_UPDATE_MANIFEST_PATH,
  PORTABLE_UPDATE_SIGNATURE_PATH,
  verifyPortableUpdateManifest,
  type PortableUpdateManifest
} from './portable-update'

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024 * 1024

export interface StagedPortablePackage {
  kind: 'full'
  manifest: PortableUpdateManifest
  packagePath: string
  packageSize: number
  packageSha256: string
}

export async function stagePortablePackage(options: {
  sourcePath: string
  destinationPath: string
  publicKeyPem: string
  currentVersion: string
  onProgress?: (percent: number) => void
}): Promise<StagedPortablePackage> {
  if (!basename(options.sourcePath).toLowerCase().endsWith('.zip')) {
    throw new Error('请选择 PANGEA Desktop ZIP 升级包。')
  }
  const source = await stat(options.sourcePath)
  if (!source.isFile() || source.size <= 0 || source.size > MAX_PACKAGE_BYTES) {
    throw new Error('升级包文件大小无效。')
  }
  await mkdir(dirname(options.destinationPath), { recursive: true })
  const packageSha256 = await copyAndHash(
    options.sourcePath,
    options.destinationPath,
    source.size,
    (percent) => options.onProgress?.(percent * 0.1)
  )
  const directory = await unzipper.Open.file(options.destinationPath)
  if (directory.files.length === 0 || directory.files.length > 200_002) {
    throw new Error('升级包目录无效。')
  }

  const entries = new Map<string, unzipper.File>()
  for (const entry of directory.files) {
    const path = normalizePortableEntryPath(entry.path)
    if (entry.type === 'Directory') continue
    const identity = path.toLowerCase()
    if (entries.has(identity)) throw new Error(`升级包包含重复文件：${path}`)
    entries.set(identity, entry)
  }

  const manifestEntry = requiredEntry(entries, PORTABLE_UPDATE_MANIFEST_PATH)
  const signatureEntry = requiredEntry(entries, PORTABLE_UPDATE_SIGNATURE_PATH)
  const manifestBytes = await readLimitedEntry(manifestEntry, MAX_METADATA_BYTES)
  const signature = (await readLimitedEntry(signatureEntry, 1024)).toString('utf8')
  const expectedChannel = portableUpdateChannelForVersion(options.currentVersion)
  const manifest = verifyPortableUpdateManifest(
    manifestBytes,
    signature,
    options.publicKeyPem,
    expectedChannel
  )
  if (!isNewerPortableVersion(manifest.version, options.currentVersion, expectedChannel)) {
    throw new Error(`升级包版本 ${manifest.version} 不高于当前版本 ${options.currentVersion}。`)
  }

  const expected = new Map(manifest.files.map((file) => [file.path.toLowerCase(), file]))
  const metadata = new Set([
    PORTABLE_UPDATE_MANIFEST_PATH.toLowerCase(),
    PORTABLE_UPDATE_SIGNATURE_PATH.toLowerCase()
  ])
  const actualPayload = [...entries.keys()].filter((path) => !metadata.has(path))
  if (actualPayload.length !== expected.size) throw new Error('升级包文件清单与 ZIP 内容不一致。')
  for (const path of actualPayload) {
    if (!expected.has(path)) throw new Error(`升级包包含未签名文件：${entries.get(path)?.path}`)
  }

  const totalBytes = manifest.files.reduce((sum, file) => sum + file.size, 0)
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAX_PACKAGE_BYTES) {
    throw new Error('升级包展开大小无效。')
  }
  let verifiedBytes = 0
  for (const file of manifest.files) {
    const entry = requiredEntry(entries, file.path)
    if (entry.uncompressedSize !== file.size) throw new Error(`升级包文件大小不匹配：${file.path}`)
    const digest = createHash('sha256')
    let received = 0
    for await (const chunk of entry.stream()) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += data.length
      if (received > file.size) throw new Error(`升级包文件超过签名大小：${file.path}`)
      digest.update(data)
      verifiedBytes += data.length
      options.onProgress?.(10 + (verifiedBytes / totalBytes) * 90)
    }
    if (received !== file.size || digest.digest('hex') !== file.sha256) {
      throw new Error(`升级包文件校验失败：${file.path}`)
    }
  }

  return {
    kind: 'full',
    manifest,
    packagePath: options.destinationPath,
    packageSize: source.size,
    packageSha256
  }
}

async function copyAndHash(
  source: string,
  destination: string,
  size: number,
  onProgress: (percent: number) => void
): Promise<string> {
  const digest = createHash('sha256')
  let copied = 0
  const hashingStream = new Transform({
    transform(chunk, _encoding, callback) {
      digest.update(chunk)
      copied += chunk.length
      onProgress((copied / size) * 100)
      callback(null, chunk)
    }
  })
  await pipeline(
    createReadStream(source),
    hashingStream,
    createWriteStream(destination, { flags: 'wx' })
  )
  return digest.digest('hex')
}

function requiredEntry(entries: Map<string, unzipper.File>, path: string): unzipper.File {
  const entry = entries.get(path.toLowerCase())
  if (!entry) throw new Error(`升级包缺少文件：${path}`)
  return entry
}

async function readLimitedEntry(entry: unzipper.File, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error(`升级包元数据过大：${entry.path}`)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of entry.stream()) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += data.length
    if (received > limit) throw new Error(`升级包元数据过大：${entry.path}`)
    chunks.push(data)
  }
  return Buffer.concat(chunks, received)
}
