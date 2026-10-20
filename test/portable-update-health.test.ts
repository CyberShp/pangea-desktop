import { mkdtemp, readFile, rm, open, writeFile, rename, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markPortableUpdateHealthy,
  createPortableHealthReporter,
  createPortableHealthWriter,
  portableUpdateHealthMarker
} from '../src/main/update/portable-update-health'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable update startup health', () => {
  it('retries transient marker failures and coalesces concurrent readiness notifications', async () => {
    let attempts = 0
    const report = createPortableHealthReporter('/fixture/marker', '2.0.14', {
      retryMs: 1,
      write: async () => {
        attempts++
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        return true
      }
    })
    const first = report()
    expect(report()).toBe(first)
    await expect(first).resolves.toBe(true)
    await expect(report()).resolves.toBe(true)
    expect(attempts).toBe(3)
  })

  it('does not retry stale markers, and bounds retries for persistent write failures', async () => {
    let attempts = 0
    const stale = createPortableHealthReporter('/fixture/marker', '2.0.14', {
      write: async () => { attempts++; throw Object.assign(new Error('stale'), { code: 'EEXIST' }) }
    })
    await expect(stale()).rejects.toMatchObject({ code: 'EEXIST' })
    expect(attempts).toBe(1)
    const denied = createPortableHealthReporter('/fixture/marker', '2.0.14', {
      retryMs: 1, timeoutMs: 5,
      write: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    })
    await expect(denied()).rejects.toMatchObject({ code: 'EACCES' })
  })

  it('accepts markers only below the application update directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-update-health-'))
    temporaryRoots.push(root)
    const marker = path.join(root, 'updates', '1.2.3', 'healthy.json')
    expect(portableUpdateHealthMarker([`--pangea-update-health=${marker}`], root)).toBe(marker)
    expect(portableUpdateHealthMarker([
      `--pangea-update-health=${path.join(root, '..', 'outside.json')}`
    ], root)).toBeUndefined()
    await expect(markPortableUpdateHealthy(marker, '1.2.3')).resolves.toBe(true)
    expect(JSON.parse(await readFile(marker, 'utf8')).version).toBe('1.2.3')
  })

  it('reports rollback readiness with the actual process identity in paths containing spaces', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea rollback health '))
    temporaryRoots.push(root)
    const marker = path.join(root, 'updates', 'run-1', 'update-plan.json.rollback-healthy.json')
    const accepted = portableUpdateHealthMarker([`--pangea-update-health=${marker}`], root)
    expect(accepted).toBe(marker)

    const startedAt = Date.now()
    await expect(markPortableUpdateHealthy(accepted, '1.0.4')).resolves.toBe(true)
    const health = JSON.parse(await readFile(marker, 'utf8'))
    expect(health).toMatchObject({ schema_version: 1, version: '1.0.4', pid: process.pid })
    expect(Date.parse(health.healthy_at)).toBeGreaterThanOrEqual(startedAt)
    expect(Date.parse(health.healthy_at)).toBeLessThanOrEqual(Date.now())
  })

  it('does not turn a stale readiness marker into a new successful launch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pangea-update-health-'))
    temporaryRoots.push(root)
    const marker = path.join(root, 'updates', 'run-1', 'healthy.json')
    await markPortableUpdateHealthy(marker, '1.0.4')
    const original = await readFile(marker, 'utf8')

    await expect(markPortableUpdateHealthy(marker, '1.0.5')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(marker, 'utf8')).toBe(original)
  })

  it('rejects sibling-prefix and traversal paths without requesting a health report on ordinary launch', async () => {
    const root = path.join(tmpdir(), 'pangea-update-health')
    expect(portableUpdateHealthMarker([], root)).toBeUndefined()
    expect(portableUpdateHealthMarker(['--pangea-update-health='], root)).toBeUndefined()
    for (const marker of [
      path.join(root, 'updates-other', 'healthy.json'),
      path.join(root, 'updates', '..', 'healthy.json'),
      path.join(root, 'updates')
    ]) {
      expect(portableUpdateHealthMarker([`--pangea-update-health=${marker}`], root)).toBeUndefined()
    }
    await expect(markPortableUpdateHealthy(undefined, '1.0.4')).resolves.toBe(false)
  })
})


it('retries an owned partial marker even when its first cleanup is denied', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-health-partial-'))
  temporaryRoots.push(root)
  const marker = path.join(root, 'healthy.json')
  let opens = 0
  let removes = 0
  const write = createPortableHealthWriter({
    open: async target => {
      const file = await open(target, 'wx')
      opens++
      if (opens === 1) {
        file.writeFile = async () => {
          await file.write('{"schema_')
          throw Object.assign(new Error('temporary disk failure'), { code: 'EIO' })
        }
      }
      return file
    },
    remove: async target => {
      removes++
      if (removes === 1) throw Object.assign(new Error('temporary sharing violation'), { code: 'EBUSY' })
      await rm(target, { force: true })
    }
  })
  const report = createPortableHealthReporter(marker, '2.0.14', { write, retryMs: 1 })
  await expect(report()).resolves.toBe(true)
  expect(opens).toBe(2)
  expect(removes).toBe(2)
  expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ schema_version: 1, version: '2.0.14', pid: process.pid })
})

it('never deletes a replacement marker after an owned partial marker cleanup fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-health-replaced-'))
  temporaryRoots.push(root)
  const marker = path.join(root, 'healthy.json')
  const write = createPortableHealthWriter({
    open: async target => {
      const file = await open(target, 'wx')
      file.writeFile = async () => {
        await file.write('{"partial":')
        throw Object.assign(new Error('temporary failure'), { code: 'EIO' })
      }
      return file
    },
    remove: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) }
  })
  await expect(write(marker, '2.0.14')).rejects.toMatchObject({ code: 'EIO' })
  await rename(marker, `${marker}.old`)
  await writeFile(marker, 'another launch owns this file')
  await expect(write(marker, '2.0.14')).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(marker, 'utf8')).toBe('another launch owns this file')
})

it('retries close failures before cleaning up and opening a new health writer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-health-close-'))
  temporaryRoots.push(root)
  const marker = path.join(root, 'healthy.json')
  let closes = 0
  let opens = 0
  const write = createPortableHealthWriter({
    open: async target => {
      opens++
      const file = await open(target, 'wx')
      if (opens === 1) {
        const originalClose = file.close.bind(file)
        file.close = async () => {
          closes++
          if (closes <= 2) throw Object.assign(new Error('temporary close error'), { code: 'EBUSY' })
          await originalClose()
        }
      }
      return file as FileHandle
    }
  })
  await expect(createPortableHealthReporter(marker, '2.0.14', { write, retryMs: 1 })()).resolves.toBe(true)
  expect(closes).toBe(3)
  expect(opens).toBe(2)
  expect(JSON.parse(await readFile(marker, 'utf8')).version).toBe('2.0.14')
})
