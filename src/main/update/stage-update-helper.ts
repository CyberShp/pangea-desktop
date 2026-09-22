import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import unzipper from 'unzipper'
import { normalizePortableEntryPath, PORTABLE_PATCH_PAYLOAD_PREFIX } from './portable-update'
import type { StagedPortablePackage } from './portable-package-validator'
import type { StagedPortablePatch } from './portable-patch-validator'

const HELPER_PATH = 'resources/update/apply-portable-update.ps1'
const MAX_HELPER_BYTES = 2 * 1024 * 1024

// Accept only bytes covered by the already signature-verified target manifest.
// A patch may omit an unchanged helper; in that case verify the installed copy.
export async function stageUpdateHelper(
  staged: StagedPortablePackage | StagedPortablePatch,
  installedHelper: string,
  destination: string
): Promise<void> {
  const target = staged.kind === 'patch' ? staged.targetManifest : staged.manifest
  const expected = target.files.find(file => file.path.toLowerCase() === HELPER_PATH)
  if (!expected || expected.size <= 0 || expected.size > MAX_HELPER_BYTES) {
    throw new Error('升级包缺少有效的已签名更新器。')
  }
  const changed = staged.kind === 'full' || staged.manifest.files.some(file => file.path.toLowerCase() === HELPER_PATH)
  let bytes: Buffer
  if (changed) {
    const archive = await unzipper.Open.file(staged.packagePath)
    const entryPath = (staged.kind === 'patch' ? PORTABLE_PATCH_PAYLOAD_PREFIX : '') + HELPER_PATH
    const entries = archive.files.filter(entry => entry.type !== 'Directory' && normalizePortableEntryPath(entry.path).toLowerCase() === entryPath)
    const entry = entries[0]
    if (entries.length !== 1 || !entry || entry.uncompressedSize !== expected.size) throw new Error('升级包更新器条目无效。')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of entry.stream()) {
      const data = Buffer.from(chunk)
      size += data.length
      if (size > expected.size) throw new Error('升级包更新器超过签名大小。')
      chunks.push(data)
    }
    bytes = Buffer.concat(chunks)
  } else {
    bytes = await readFile(installedHelper)
  }
  if (bytes.length !== expected.size || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('升级包更新器校验失败，未执行更新。')
  }
  await writeFile(destination, bytes, { flag: 'wx' })
}
