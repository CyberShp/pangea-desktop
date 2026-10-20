import { mkdir, open, rm, lstat, type FileHandle } from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const HEALTH_ARGUMENT = '--pangea-update-health='

export function portableUpdateHealthMarker(
  argv: readonly string[],
  userDataPath: string
): string | undefined {
  const raw = argv.find((argument) => argument.startsWith(HEALTH_ARGUMENT))?.slice(HEALTH_ARGUMENT.length)
  if (!raw) return undefined
  const updatesRoot = resolve(join(userDataPath, 'updates'))
  const marker = resolve(raw)
  if (!marker.startsWith(`${updatesRoot}${sep}`)) return undefined
  return marker
}

interface HealthMarkerIO {
  open: (marker: string) => Promise<FileHandle>
  inspect: (marker: string) => Promise<BigIntStats>
  remove: (marker: string) => Promise<void>
  ensureDirectory: (directory: string) => Promise<void>
}

/** Retain ownership of an incomplete marker across transient cleanup failures. */
export function createPortableHealthWriter(overrides: Partial<HealthMarkerIO> = {}): (
  marker: string | undefined, version: string
) => Promise<boolean> {
  const io: HealthMarkerIO = {
    open: marker => open(marker, 'wx'),
    inspect: marker => lstat(marker, { bigint: true }),
    remove: marker => rm(marker, { force: true }),
    ensureDirectory: async directory => { await mkdir(directory, { recursive: true }) },
    ...overrides
  }
  const incomplete = new Map<string, { file: FileHandle; identity: BigIntStats }>()
  const active = new Set<string>()
  const discardOwnedMarker = async (marker: string): Promise<void> => {
    const owned = incomplete.get(marker)
    if (!owned) return
    // If close itself failed, retry it before unlinking or opening another writer.
    await owned.file.close()
    let current: BigIntStats
    try { current = await io.inspect(marker) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { incomplete.delete(marker); return }
      throw error
    }
    if (current.isSymbolicLink() || current.dev !== owned.identity.dev || current.ino !== owned.identity.ino
      || current.birthtimeNs !== owned.identity.birthtimeNs) {
      incomplete.delete(marker)
      throw Object.assign(new Error('健康标记已被其他文件替换，不能覆盖。'), { code: 'EEXIST' })
    }
    await io.remove(marker)
    incomplete.delete(marker)
  }
  return async (marker, version) => {
    if (!marker) return false
    if (active.has(marker)) throw Object.assign(new Error('健康标记正在写入。'), { code: 'EBUSY' })
    active.add(marker)
    try {
      await discardOwnedMarker(marker)
      await io.ensureDirectory(dirname(marker))
      const file = await io.open(marker)
      try {
        const identity = await file.stat({ bigint: true })
        incomplete.set(marker, { file, identity })
        await file.writeFile(JSON.stringify({
          schema_version: 1, version, healthy_at: new Date().toISOString(), pid: process.pid
        }), 'utf8')
        await file.sync()
        await file.close()
        incomplete.delete(marker)
        return true
      } catch (error) {
        if (incomplete.has(marker)) await discardOwnedMarker(marker).catch(() => {})
        else await file.close().catch(() => {})
        // A failed cleanup remains owned. The next retry must recheck its identity
        // and finish cleanup; EEXIST must never cause deletion of another launch.
        throw error
      }
    } finally { active.delete(marker) }
  }
}

const writeHealthMarker = createPortableHealthWriter()
export async function markPortableUpdateHealthy(marker: string | undefined, version: string): Promise<boolean> {
  return writeHealthMarker(marker, version)
}

/** Share concurrent readiness notifications; success is recorded after disk I/O. */
export function createPortableHealthReporter(
  marker: string | undefined,
  version: string,
  options: {
    write?: typeof markPortableUpdateHealthy
    retryMs?: number
    timeoutMs?: number
  } = {}
): () => Promise<boolean> {
  let reported = false
  let pending: Promise<boolean> | undefined
  return () => {
    if (reported || !marker) return Promise.resolve(reported)
    if (pending) return pending
    pending = (async () => {
      const deadline = Date.now() + (options.timeoutMs ?? 30_000)
      while (true) {
        try {
          reported = await (options.write ?? markPortableUpdateHealthy)(marker, version)
          return reported
        } catch (error) {
          const retryable = ['EACCES', 'EPERM', 'EBUSY', 'ENOSPC', 'EIO', 'EMFILE', 'ENFILE', 'EAGAIN']
            .includes((error as NodeJS.ErrnoException).code ?? '')
          if (!retryable || Date.now() >= deadline) throw error
          await new Promise((resolve) => setTimeout(resolve, Math.min(options.retryMs ?? 500, Math.max(1, deadline - Date.now()))))
        }
      }
    })().finally(() => { pending = undefined })
    return pending
  }
}
