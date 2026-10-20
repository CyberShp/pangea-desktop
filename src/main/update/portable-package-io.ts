import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RESERVE_BYTES = 64 * 1024 * 1024

export async function assertPackageStagingSpace(
  destination: string,
  packageBytes: number,
  inspect = statfs
): Promise<void> {
  const root = dirname(destination)
  const disk = await inspect(root)
  const available = Number(disk.bavail) * Number(disk.bsize)
  const required = packageBytes + Math.max(RESERVE_BYTES, Math.ceil(packageBytes * 0.05))
  if (!Number.isFinite(available) || available < required) {
    throw new Error(`升级包暂存空间不足：${root}，需要至少 ${Math.ceil(required / 1048576)} MiB，可用 ${Math.floor(available / 1048576)} MiB。`)
  }
}

export async function copyAndHashPackage(
  source: string,
  destination: string,
  size: number,
  onProgress: (percent: number) => void,
  limits: { idleMs?: number; totalMs?: number } = {}
): Promise<string> {
  await assertPackageStagingSpace(destination, size)
  const abort = new AbortController()
  let failure: Error | undefined
  const stop = (message: string) => { failure = new Error(message); abort.abort(failure) }
  const idleMs = limits.idleMs ?? 120_000
  let idle = setTimeout(() => stop('升级包复制长时间没有进展，已停止导入。'), idleMs)
  const total = setTimeout(() => stop('升级包复制超过 30 分钟，已停止导入。'), limits.totalMs ?? 30 * 60_000)
  const digest = createHash('sha256')
  let copied = 0
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        clearTimeout(idle)
        idle = setTimeout(() => stop('升级包复制长时间没有进展，已停止导入。'), idleMs)
        copied += chunk.length
        if (copied > size) throw new Error('升级包在导入期间发生变化，请重新选择完整文件。')
        digest.update(chunk)
        onProgress((copied / size) * 100)
      } catch (error) {
        // Transform callbacks must report errors: an exception thrown directly
        // by a progress consumer otherwise escapes pipeline and leaves I/O live.
        callback(error instanceof Error ? error : new Error(String(error)))
        return
      }
      callback(null, chunk)
    }
  })
  try {
    // Abort destroys both streams; no detached writer is left modifying staging.
    await pipeline(createReadStream(source), hashing, createWriteStream(destination, { flags: 'wx' }), { signal: abort.signal })
    if (copied !== size) throw new Error('升级包在导入期间发生变化，请重新选择完整文件。')
    return digest.digest('hex')
  } catch (error) {
    throw failure ?? error
  } finally {
    clearTimeout(idle)
    clearTimeout(total)
  }
}
