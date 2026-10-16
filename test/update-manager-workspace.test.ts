import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  showOpenDialog: vi.fn(),
  stagePortablePackage: vi.fn(),
  stageUpdateHelper: vi.fn(),
  launchPortableHelper: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath, getVersion: () => '1.0.4', isPackaged: true, quit: vi.fn() },
  BrowserWindow: { getFocusedWindow: () => undefined, getAllWindows: () => [] },
  dialog: { showOpenDialog: mocks.showOpenDialog },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('../src/main/update/update-capability', () => ({ canImportPortableUpdate: () => true }))
vi.mock('../src/main/update/portable-package-validator', () => ({ stagePortablePackage: mocks.stagePortablePackage }))
vi.mock('../src/main/update/portable-patch-validator', () => ({
  isPortablePatchArchive: async () => false,
  stagePortablePatch: vi.fn(),
  PortablePatchBaseVersionMismatch: class extends Error {}
}))
vi.mock('../src/main/update/stage-update-helper', () => ({ stageUpdateHelper: mocks.stageUpdateHelper }))
vi.mock('../src/main/update/launch-portable-helper', () => ({ launchPortableHelper: mocks.launchPortableHelper }))

let root: string
let originalResourcesPath: PropertyDescriptor | undefined

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  root = await mkdtemp(join(tmpdir(), 'pangea-update-workspace-'))
  const resourcesPath = join(root, 'resources')
  const updateResources = join(resourcesPath, 'update')
  await mkdir(updateResources, { recursive: true })
  await writeFile(join(updateResources, 'pangea-update.json'), JSON.stringify({
    schema_version: 1, enabled: true, public_key_file: 'test-key.pem'
  }))
  await writeFile(join(updateResources, 'test-key.pem'), 'fixture public key')
  originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: resourcesPath, configurable: true })
  mocks.getPath.mockReturnValue(join(root, 'profile'))
  mocks.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [join(root, 'selected.zip')] })
  mocks.stagePortablePackage.mockImplementation(async ({ destinationPath }) => {
    await writeFile(destinationPath, 'verified fixture package', { flag: 'wx' })
    return {
      kind: 'full', manifest: { version: '1.0.5', channel: 'stable' },
      packagePath: destinationPath, packageSize: 24, packageSha256: 'a'.repeat(64)
    }
  })
  mocks.stageUpdateHelper.mockImplementation(async (_staged, _installed, destination) => {
    await writeFile(destination, '# verified fixture helper', { flag: 'wx' })
  })
})

afterEach(async () => {
  if (originalResourcesPath) Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  else Reflect.deleteProperty(process, 'resourcesPath')
  await rm(root, { recursive: true, force: true })
})

describe('portable update workspaces', () => {
  it('uses short names while isolating retry handshakes, health markers and logs', async () => {
    const manager = await import('../src/main/update/update-manager')
    manager.startUpdateManager({ prepareToInstall: async () => {} })
    expect((await manager.importPortableUpdatePackage()).phase).toBe('downloaded')
    const imported = mocks.stagePortablePackage.mock.calls[0]![0].destinationPath as string
    expect(basename(dirname(imported))).toMatch(/^import-[A-Za-z0-9]{6}$/)
    const attempts: { helper: string; plan: string; health: string; log: string }[] = []
    mocks.launchPortableHelper.mockImplementation(async (helper, plan) => {
      const saved = JSON.parse(await readFile(plan, 'utf8'))
      expect(saved.package_path).toBe(imported)
      expect(saved.expected_sha256).toBe('a'.repeat(64))
      expect(existsSync(`${plan}.ready`)).toBe(false)
      expect(existsSync(`${plan}.continue`)).toBe(false)
      expect(existsSync(saved.health_marker)).toBe(false)
      expect(existsSync(saved.log_path)).toBe(false)
      await writeFile(`${plan}.ready`, 'stale readiness marker')
      await writeFile(`${plan}.continue`, 'stale handoff marker')
      await writeFile(saved.health_marker, 'stale healthy marker')
      await writeFile(saved.log_path, 'previous attempt diagnostics')
      attempts.push({ helper, plan, health: saved.health_marker, log: saved.log_path })
      throw new Error('fixture startup failure')
    })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(attempts).toHaveLength(2)
    expect(dirname(attempts[0]!.plan)).not.toBe(dirname(attempts[1]!.plan))
    for (const attempt of attempts) {
      expect(basename(dirname(attempt.plan))).toMatch(/^run-[A-Za-z0-9]{6}$/)
      // The recovery script scans one directory below updates, including old imports.
      expect(dirname(dirname(attempt.plan))).toBe(dirname(dirname(imported)))
      expect(basename(attempt.helper)).toBe('apply-update.ps1')
      expect(basename(attempt.plan)).toBe('update-plan.json')
      expect(basename(attempt.health)).toBe('healthy.json')
      expect(basename(attempt.log)).toBe('apply-update.log')
      expect(await readFile(attempt.log, 'utf8')).toBe('previous attempt diagnostics')
    }
    expect(await readFile(imported, 'utf8')).toBe('verified fixture package')
  })

  it('reports a staging directory failure and permits importing again', async () => {
    const manager = await import('../src/main/update/update-manager')
    manager.startUpdateManager({ prepareToInstall: async () => {} })
    const profile = join(root, 'profile')
    await mkdir(profile)
    await writeFile(join(profile, 'updates'), 'blocks directory creation')
    expect((await manager.importPortableUpdatePackage()).phase).toBe('error')
    await rm(join(profile, 'updates'))
    expect((await manager.importPortableUpdatePackage()).phase).toBe('downloaded')
    expect(mocks.stagePortablePackage).toHaveBeenCalledOnce()
  })
})
