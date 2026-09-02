import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ensurePangeaWebProfile,
  PANGEA_CORE_BUNDLE
} from '../src/main/state/pangea-profile'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })))
})

describe('PANGEA web profile', () => {
  it('creates a first-launch profile with the installation-owned bundle', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pangea-profile-'))
    temporaryRoots.push(home)
    const directory = await ensurePangeaWebProfile(home)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({})
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      PANGEA_CORE_BUNDLE
    ])
  })

  it('preserves user bundles and restores PANGEA without duplication', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pangea-profile-'))
    temporaryRoots.push(home)
    const directory = join(home, 'profiles', 'web')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'custom-web',
      dependencies: { 'user-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'user-bundle'] } }
    }))
    await writeFile(join(directory, 'cordis.patch.yml'), '# keep me\n[]\n')

    await ensurePangeaWebProfile(home)
    await ensurePangeaWebProfile(home)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'user-bundle': '1.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      'user-bundle',
      PANGEA_CORE_BUNDLE
    ])
    expect(await readFile(join(directory, 'cordis.patch.yml'), 'utf8')).toBe('# keep me\n[]\n')
  })

  it('migrates legacy PANGEA bundles without deleting user plugins or overrides', async () => {
    const home = await mkdtemp(join(tmpdir(), 'pangea-profile-'))
    temporaryRoots.push(home)
    const directory = join(home, 'profiles', 'web')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: 'legacy-pangea-web',
      dependencies: {
        'dsh-pangea': '0.1.0',
        'dsh-pangea-companion': '0.10.0',
        'dsh-pangea-asset-catalog': '0.1.0',
        'user-bundle': '1.0.0'
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            'dsh-pangea',
            'dsh-pangea-companion',
            'dsh-pangea-asset-catalog',
            'user-bundle'
          ]
        }
      }
    }))
    await writeFile(join(directory, 'cordis.patch.yml'), `# keep the user's layer
- insert:
    - id: legacy-workbench
      name: dsh-pangea
    - id: legacy-companion
      name: dsh-pangea-companion
    - id: user-tool
      name: user-bundle
- id: pangea-workbench
  config:
    preservedUserSetting: true
- insert:
    - id: legacy-assets
      name: dsh-pangea-asset-catalog
`)

    await ensurePangeaWebProfile(home)

    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    expect(manifest.dependencies).toEqual({ 'user-bundle': '1.0.0' })
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'user-bundle',
      PANGEA_CORE_BUNDLE
    ])
    const patch = await readFile(join(directory, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toContain('name: dsh-pangea\n')
    expect(patch).not.toContain('name: dsh-pangea-companion')
    expect(patch).not.toContain('name: dsh-pangea-asset-catalog')
    expect(patch).toContain('name: user-bundle')
    expect(patch).toContain('id: pangea-workbench')
    expect(patch).toContain('preservedUserSetting: true')
  })
})
