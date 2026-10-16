import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  markPortableUpdateHealthy,
  portableUpdateHealthMarker
} from '../src/main/update/portable-update-health'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('portable update startup health', () => {
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
