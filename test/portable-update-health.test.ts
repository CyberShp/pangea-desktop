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
})
