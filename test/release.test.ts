import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

describe('PANGEA Desktop release contract', () => {
  it('keeps the package and lockfile versions aligned', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    )
    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
  })

  it('produces one Windows x64 portable ZIP with the product identity', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    expect(packageJson.name).toBe('pangea-desktop')
    expect(packageJson.build.appId).toBe('io.pangea.desktop')
    expect(packageJson.build.productName).toBe('PANGEA Desktop')
    expect(packageJson.build.artifactName).toBe(
      'pangea-desktop-${version}-windows-${arch}-portable.${ext}'
    )
    expect(packageJson.build.win.icon).toBe('build/icon.ico')
    expect(packageJson.build.nsis).toBeUndefined()
    expect(packageJson.build.mac).toBeUndefined()
    expect(packageJson.build.publish).toBeNull()
  })

  it('ships the locked plugin, agent and Python resources', async () => {
    const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'))
    const resources = packageJson.build.extraResources as Array<{ from: string; to: string }>
    for (const expected of [
      { from: '.pangea-build/plugins/dsh-pangea', to: 'app/node_modules/dsh-pangea' },
      {
        from: '.pangea-build/plugins/dsh-pangea-companion',
        to: 'app/node_modules/dsh-pangea-companion'
      },
      {
        from: '.pangea-build/plugins/dsh-pangea-asset-catalog',
        to: 'app/node_modules/dsh-pangea-asset-catalog'
      },
      { from: '.pangea-build/runtime/pangea-runtime', to: 'pangea-runtime' },
      { from: '.pangea-build/runtime/python', to: 'pangea-python' },
      { from: '.pangea-build/manifest.json', to: 'pangea-manifest.json' },
      { from: '.pangea-build/update', to: 'update' },
      { from: 'build/apply-portable-update.ps1', to: 'update/apply-portable-update.ps1' }
    ]) {
      expect(resources).toContainEqual(expected)
    }
    expect(packageJson.dependencies['dsh-pangea-product']).toBe(
      'file:packages/dsh-pangea-product'
    )
  })

  it('pins every independently maintained component and keeps PANGEA core in recovery', async () => {
    const [components, profile, safeMode, workflow] = await Promise.all([
      readFile(path.join(projectRoot, 'pangea.components.json'), 'utf8'),
      readFile(path.join(projectRoot, 'src', 'main', 'state', 'pangea-profile.ts'), 'utf8'),
      readFile(path.join(projectRoot, 'src', 'main', 'state', 'safe-mode-profile.ts'), 'utf8'),
      readFile(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8')
    ])
    const lock = JSON.parse(components)
    expect(lock.desktopBase.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(lock.desktopBase.branch).toBe('main')
    expect(lock.dshPangea.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(lock.dshPangea.branch).toBe('codetalks-skill')
    expect(lock.pangeaAgent.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(lock.pangeaAgent.branch).toBe('codetalks-skill')
    expect(lock.python.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(profile).toContain("PANGEA_CORE_BUNDLE = 'dsh-pangea-product'")
    expect(safeMode).toContain("'dsh-pangea-product'")
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).not.toContain('-ResolveComponentBranches')
    expect(workflow).toContain('-RequireCurrentComponentHeads')
    expect(workflow).toContain('actions/upload-artifact@v4')
    expect(workflow).toContain('PANGEA_PACKAGE_CHANNEL')
    expect(workflow).toContain('gh release upload')
    expect(workflow).not.toContain('PANGEA_ARTIFACT_')
    expect(workflow).not.toContain('sftp')
  })

  it('builds through the single Windows assembly entrypoint', async () => {
    const [packageJson, script] = await Promise.all([
      readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
      readFile(path.join(projectRoot, 'scripts', 'build-pangea-desktop.ps1'), 'utf8')
    ])
    expect(packageJson.scripts['package:pangea:win']).toContain('build-pangea-desktop.ps1')
    expect(script).toContain("Invoke-Checked 'npm' @('ci', '--legacy-peer-deps')")
    expect(script).toContain("Invoke-Checked 'npm' @('run', 'package:dir')")
    expect(script).toContain('Get-VerifiedDownload')
    expect(script).toContain('pangea_agent.cli.main')
    expect(script).toContain("'..\\pangea-runtime\\src'")
    expect(script).toContain('prepare-portable-update.mjs')
    expect(script).toContain('create-signed-portable-package.mjs')
    expect(script).toContain("'--channel', $PackageChannel")
    expect(script).toContain('UpdatePrivateKeyPath is required')
  })

  it('boots the packaged Harness against a legacy PANGEA profile before publishing', async () => {
    const [workflow, smoke] = await Promise.all([
      readFile(path.join(projectRoot, '.github', 'workflows', 'release.yml'), 'utf8'),
      readFile(path.join(projectRoot, 'scripts', 'test-packaged-harness-startup.ps1'), 'utf8')
    ])
    expect(workflow).toContain('test-packaged-harness-startup.ps1')
    expect(workflow.indexOf('test-packaged-harness-startup.ps1')).toBeLessThan(
      workflow.indexOf('Publish GitHub release')
    )
    expect(smoke).toContain("'dsh-pangea-product'")
    expect(smoke).toContain("'dsh-pangea-companion'")
    expect(smoke).toContain('--pangea-update-health=')
    expect(smoke).toContain('product-workspace readiness')
    expect(smoke).toContain('Harness entry failed during startup')
    expect(smoke).toContain("Join-Path $UserDataRoot 'logs\\harness.log'")
  })
})
