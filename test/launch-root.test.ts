import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ensureLaunchRoot, launchRootBasePath, launchRootPath } from '../src/main/state/launch-root'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('Harness launch root', () => {
  it('keeps development launch data under Electron userData', () => {
    expect(launchRootBasePath('/application/user-data', { defaultApp: true, resourcesPath: '/repo/node_modules/electron/dist/resources' })).toBe(
      '/application/user-data'
    )
    expect(launchRootPath('/application/user-data', { defaultApp: true, resourcesPath: '/repo/node_modules/electron/dist/resources' })).toBe(
      join('/application/user-data', 'launch-root')
    )
  })

  it('keeps packaged launch data beside PANGEA Desktop instead of userData', () => {
    const runtime = { defaultApp: false, resourcesPath: join('D:', 'PANGEA Desktop', 'resources') }
    expect(launchRootBasePath(join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'pangea-desktop'), runtime)).toBe(
      join('D:', 'PANGEA Desktop')
    )
    expect(launchRootPath(join('C:', 'Users', 'tester', 'AppData', 'Roaming', 'pangea-desktop'), runtime)).toBe(
      join('D:', 'PANGEA Desktop', 'launch-root')
    )
  })

  it('creates the packaged launch root idempotently', async () => {
    const desktopRoot = await mkdtemp(join(tmpdir(), 'pangea-desktop-'))
    temporaryRoots.push(desktopRoot)
    const userData = join(desktopRoot, 'user-data')
    const runtime = { defaultApp: false, resourcesPath: join(desktopRoot, 'resources') }

    const first = await ensureLaunchRoot(userData, runtime)
    const second = await ensureLaunchRoot(userData, runtime)

    expect(first).toBe(join(desktopRoot, 'launch-root'))
    expect(second).toBe(first)
    expect((await stat(first)).isDirectory()).toBe(true)
  })
})
