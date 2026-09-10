import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveUserDataPath } from '../src/main/state/user-data-path'

describe('PANGEA Desktop user data path', () => {
  it('uses an explicit test profile when one is configured', () => {
    expect(resolveUserDataPath({
      configuredPath: join('D:', 'pangea-tests', 'profile'),
      appDataPath: join('C:', 'Users', 'tester', 'AppData', 'Roaming'),
      developmentBuild: false
    })).toBe(resolve(join('D:', 'pangea-tests', 'profile')))
  })

  it('keeps the existing stable packaged profile by default', () => {
    const appDataPath = join('C:', 'Users', 'tester', 'AppData', 'Roaming')
    expect(resolveUserDataPath({
      configuredPath: '   ',
      appDataPath,
      developmentBuild: false
    })).toBe(join(appDataPath, 'pangea-desktop'))
  })

  it('keeps the development profile separate by default', () => {
    const appDataPath = join('C:', 'Users', 'tester', 'AppData', 'Roaming')
    expect(resolveUserDataPath({
      appDataPath,
      developmentBuild: true
    })).toBe(join(appDataPath, 'pangea-desktop-dev'))
  })
})
