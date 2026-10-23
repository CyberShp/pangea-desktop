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

  it('isolates a directly launched acceptance application without environment overrides', () => {
    const appDataPath = '/Users/tester/Library/Application Support'
    expect(resolveUserDataPath({
      appDataPath,
      developmentBuild: false,
      acceptanceBuild: true
    })).toBe(join(appDataPath, 'pangea-desktop-acceptance'))
  })

  it('preserves an explicit profile for an acceptance smoke test', () => {
    expect(resolveUserDataPath({
      configuredPath: '/tmp/pangea-acceptance-smoke',
      appDataPath: '/Users/tester/Library/Application Support',
      developmentBuild: false,
      acceptanceBuild: true
    })).toBe(resolve('/tmp/pangea-acceptance-smoke'))
  })
})
