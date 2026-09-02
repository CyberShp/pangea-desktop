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
  PORTABLE_PATCH_MANIFEST_PATH,
  PORTABLE_PATCH_PAYLOAD_PREFIX,
  PORTABLE_PATCH_SIGNATURE_PATH,
  PORTABLE_PATCH_TARGET_MANIFEST_PATH,
  PORTABLE_PATCH_TARGET_SIGNATURE_PATH,
  portableUpdateChannelForVersion,
  verifyPortablePatchManifest,
  verifyPortableUpdateManifest,
  type PortablePatchManifest,
  type PortableUpdateManifest
} from './portable-update'

const MAX_PACKAGE_BYTES = 20 * 1024 * 1024 * 1024
const MAX_METADATA_BYTES = 64 * 1024 * 1024

export interface StagedPortablePatch {
  kind: 'patch'
  manifest: PortablePatchManifest
  targetManifest: PortableUpdateManifest
  packagePath: string
  packageSize: number
  packageSha256: string
}

export async function isPortablePatchArchive(sourcePath: string): Promise<boolean> {
  const directory = await unzipper.Open.file(sourcePath)
  return directory.files.some((entry) => {
    try {
      return normalizePortableEntryPath(entry.path).toLowerCase() === PORTABLE_PATCH_MANIFEST_PATH
    } catch {
      return false
    }
  })
}

export async function stagePortablePatch(options: {
  sourcePath: string
  destinationPath: string
  publicKeyPem: string
  currentVersion: string
  onProgress?: (percent: number) => void
}): Promise<StagedPortablePatch> {
  if (!basename(options.sourcePath).toLowerCase().endsWith('.zip')) {
    throw new Error('请选择 PANGEA Desktop 补丁 ZIP 升级包。')
  }
  const source = await stat(options.sourcePath)
  if (!source.isFile() || source.size <= 0 || source.size > MAX_PACKAGE_BYTES) {
    throw new Error('补丁包文件大小无效。')
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
    throw new Error('补丁包目录无效。')
  }

  const entries = new Map<string, unzipper.File>()
  for (const entry of directory.files) {
    const path = normalizePortableEntryPath(entry.path)
    if (entry.type === 'Directory') continue
    const identity = path.toLowerCase()
    if (entries.has(identity)) throw new Error(`补丁包包含重复文件：${path}`)
    entries.set(identity, entry)
  }

  const patchBytes = await readLimitedEntry(requiredEntry(entries, PORTABLE_PATCH_MANIFEST_PATH), MAX_METADATA_BYTES)
  const patchSignature = (await readLimitedEntry(requiredEntry(entries, PORTABLE_PATCH_SIGNATURE_PATH), 1024)).toString('utf8')
  const expectedChannel = portableUpdateChannelForVersion(options.currentVersion)
  const patch = verifyPortablePatchManifest(patchBytes, patchSignature, options.publicKeyPem, expectedChannel)
  if (patch.from_version !== options.currentVersion) {
    throw new Error(`此补丁仅适用于 ${patch.from_version}，当前版本为 ${options.currentVersion}。`)
  }
  if (!isNewerPortableVersion(patch.to_version, options.currentVersion, expectedChannel)) {
    throw new Error(`补丁目标版本 ${patch.to_version} 不高于当前版本 ${options.currentVersion}。`)
  }

  const targetBytes = await readLimitedEntry(requiredEntry(entries, PORTABLE_PATCH_TARGET_MANIFEST_PATH), MAX_METADATA_BYTES)
  const targetSignature = (await readLimitedEntry(requiredEntry(entries, PORTABLE_PATCH_TARGET_SIGNATURE_PATH), 1024)).toString('utf8')
  const targetManifest = verifyPortableUpdateManifest(targetBytes, targetSignature, options.publicKeyPem, expectedChannel)
  if (targetManifest.version !== patch.to_version) throw new Error('补丁目标清单版本不一致。')
  const targetHash = createHash('sha256').update(targetBytes).digest('hex')
  if (targetHash !== patch.target_manifest_sha256) throw new Error('补丁目标清单校验失败。')

  const expectedPayload = new Map<string, { path: string; size: number; sha256: string }>()
  for (const file of patch.files) expectedPayload.set(`${PORTABLE_PATCH_PAYLOAD_PREFIX}${file.path}`.toLowerCase(), file)
  const metadata = new Set([
    PORTABLE_PATCH_MANIFEST_PATH,
    PORTABLE_PATCH_SIGNATURE_PATH,
    PORTABLE_PATCH_TARGET_MANIFEST_PATH,
    PORTABLE_PATCH_TARGET_SIGNATURE_PATH
  ].map((path) => path.toLowerCase()))
  const actualPayload = [...entries.keys()].filter((path) => !metadata.has(path))
  if (actualPayload.length !== expectedPayload.size) throw new Error('补丁文件清单与 ZIP 内容不一致。')
  for (const path of actualPayload) {
    const expected = expectedPayload.get(path)
    if (!expected) throw new Error(`补丁包包含未签名文件：${entries.get(path)?.path}`)
    const target = targetManifest.files.find((file) => file.path.toLowerCase() === expected.path.toLowerCase())
    if (!target || target.size !== expected.size || target.sha256 !== expected.sha256) {
      throw new Error(`补丁文件与目标清单不一致：${expected.path}`)
    }
    const entry = entries.get(path)!
    if (entry.uncompressedSize !== expected.size) throw new Error(`补丁文件大小不匹配：${expected.path}`)
    const digest = createHash('sha256')
    let received = 0
    for await (const chunk of entry.stream()) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      received += data.length
      if (received > expected.size) throw new Error(`补丁文件超过签名大小：${expected.path}`)
      digest.update(data)
    }
    if (received !== expected.size || digest.digest('hex') !== expected.sha256) {
      throw new Error(`补丁文件校验失败：${expected.path}`)
    }
  }

  return {
    kind: 'patch',
    manifest: patch,
    targetManifest,
    packagePath: options.destinationPath,
    packageSize: source.size,
    packageSha256
  }
}

async function copyAndHash(source: string, destination: string, size: number, onProgress: (percent: number) => void): Promise<string> {
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
  await pipeline(createReadStream(source), hashingStream, createWriteStream(destination, { flags: 'wx' }))
  return digest.digest('hex')
}

function requiredEntry(entries: Map<string, unzipper.File>, path: string): unzipper.File {
  const entry = entries.get(path.toLowerCase())
  if (!entry) throw new Error(`补丁包缺少文件：${path}`)
  return entry
}

async function readLimitedEntry(entry: unzipper.File, limit: number): Promise<Buffer> {
  if (entry.uncompressedSize > limit) throw new Error(`补丁包元数据过大：${entry.path}`)
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of entry.stream()) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    received += data.length
    if (received > limit) throw new Error(`补丁包元数据过大：${entry.path}`)
    chunks.push(data)
  }
  return Buffer.concat(chunks, received)
}
