import { generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getPath: vi.fn(), launch: vi.fn(), quit: vi.fn(), admission: vi.fn(), messages: [] as any[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '2.1.8', getPath: mocks.getPath, isPackaged: true, quit: mocks.quit },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_: string, status: unknown) => mocks.messages.push(status) } }] },
  dialog: {}, ipcMain: { handle: vi.fn() }, net: { fetch: mocks.fetch }
}))
vi.mock('../src/main/update/update-network', async importOriginal => ({ ...(await importOriginal<any>()), createUpdateTransport: async () => ({ fetch: mocks.fetch, close: async () => {} }) }))
vi.mock('../src/main/update/update-capability', () => ({ canImportPortableUpdate: () => true }))
vi.mock('../src/main/update/launch-portable-helper', () => ({ launchPortableHelper: mocks.launch }))

let root: string
let resourcesDescriptor: PropertyDescriptor | undefined
let manager: typeof import('../src/main/update/update-manager')
let release: any
const responses = new Map<string, Buffer>()
const version = '2.1.9'
const name = `pangea-desktop-${version}-windows-x64-portable.zip`
const prefix = `https://github.com/CyberShp/pangea-desktop/releases/download/v${version}/`

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'online-integration-'))
  const app = join(root, 'app')
  const resources = join(app, 'resources')
  await mkdir(join(resources, 'update'), { recursive: true })
  await mkdir(join(root, 'dist'))
  const key = generateKeyPairSync('ed25519')
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  await writeFile(join(root, 'private.pem'), key.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  await writeFile(join(app, 'PANGEA Desktop.exe'), 'fixture executable; not launched on Linux')
  await writeFile(join(resources, 'pangea-manifest.json'), JSON.stringify({ product: { version }, components: { agent: { commit: 'a'.repeat(40) } } }))
  await writeFile(join(resources, 'update', 'pangea-update.json'), JSON.stringify({ schema_version: 1, enabled: true, public_key_file: 'pangea-update-public-key.pem' }))
  await writeFile(join(resources, 'update', 'pangea-update-public-key.pem'), publicKey)
  // Real signed helper from the repository; staging must extract the signed copy.
  await writeFile(join(resources, 'update', 'apply-portable-update.ps1'), await readFile(resolve('build/apply-portable-update.ps1')))
  execFileSync(process.execPath, ['scripts/create-signed-portable-package.mjs', '--app-dir', app,
    '--private-key', join(root, 'private.pem'), '--output', join(root, 'dist', name), '--version', version], { cwd: resolve('.') })
  for (const file of [name, 'pangea-desktop-update.json', 'pangea-desktop-update.json.sig']) {
    responses.set(prefix + file, await readFile(join(root, 'dist', file)))
  }
  resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
})
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); mocks.messages.length = 0
  mocks.getPath.mockReturnValue(join(root, 'profile'))
  release = { id: 42, tag_name: `v${version}`, draft: false, prerelease: false,
    assets: [...responses].map(([url, data]) => ({ name: url.slice(prefix.length), size: data.length, state: 'uploaded', browser_download_url: url })) }
  mocks.fetch.mockImplementation(async (url: string) => url.startsWith('https://api.github.com/')
    ? Response.json([release]) : new Response(new Uint8Array(responses.get(url)!)))
  manager = await import('../src/main/update/update-manager')
  mocks.admission.mockResolvedValue(undefined)
  manager.startUpdateManager({ prepareToInstall: mocks.admission })
})
afterEach(() => { manager.stopUpdateManager(); vi.useRealTimers() })
afterAll(async () => {
  if (resourcesDescriptor) Object.defineProperty(process, 'resourcesPath', resourcesDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  await rm(root, { recursive: true, force: true })
})

describe('online update production pipeline with simulated GitHub and Windows launcher', () => {
  it.each([false, true])('checks metadata without downloading or installing (manual=%s)', async manual => {
    expect(await manager.checkForOnlineUpdate(manual)).toMatchObject({ phase: 'available', availableVersion: version, manual })
    expect(mocks.fetch.mock.calls.map(([url]) => url)).not.toContain(prefix + name)
    expect(mocks.admission).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    await manager.downloadOnlineUpdate()
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toContain(prefix + name)
    expect(manager.getUpdateStatus().phase).toBe('downloaded')
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('revalidates a changed release before an explicit download', async () => {
    await manager.checkForOnlineUpdate(false)
    release.tag_name = 'v2.1.8'
    expect((await manager.downloadOnlineUpdate()).phase).toBe('up-to-date')
    expect(mocks.fetch.mock.calls.map(([url]) => url)).not.toContain(prefix + name)
  })

  it('signs release metadata, downloads, verifies real ZIP, stages signed helper and hands off health plan', async () => {
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'downloaded', availableVersion: version, source: 'github', packageType: 'full' })
    expect(mocks.messages.some(s => s.activity === 'download')).toBe(true)
    expect(mocks.messages.some(s => s.activity === 'verify')).toBe(true)
    mocks.launch.mockImplementation(async (helper: string, planPath: string) => {
      expect(await readFile(helper)).toEqual(await readFile(resolve('build/apply-portable-update.ps1')))
      const plan = JSON.parse(await readFile(planPath, 'utf8'))
      expect(plan).toMatchObject({ expected_version: version, handoff_required: true, package_type: 'full', package_channel: 'stable', startup_health_timeout_seconds: 300 })
      expect(plan.health_marker).toMatch(/healthy.json$/)
      expect(plan.result_path).toMatch(/last-update-result.json$/)
      expect(await readFile(plan.package_path)).toEqual(responses.get(prefix + name))
    })
    vi.useFakeTimers()
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: true })
    expect(mocks.admission).toHaveBeenCalledOnce()
    expect(mocks.launch).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect(mocks.quit).toHaveBeenCalledOnce()
  })
  it('does not launch or quit when forced task stop cannot be confirmed', async () => {
    await manager.downloadOnlineUpdate()
    mocks.admission.mockRejectedValueOnce(Object.assign(new Error('任务仍在运行'), { code: 'PANGEA_UPDATE_BUSY' }))
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(manager.getUpdateStatus().canForceStop).toBe(true)
    mocks.admission.mockRejectedValueOnce(new Error('ACP Job 身份不匹配，旧执行停止尚未确认'))
    expect(await manager.installImportedUpdate(true)).toEqual({ helperLaunched: false })
    expect(mocks.admission).toHaveBeenLastCalledWith(true)
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(mocks.quit).not.toHaveBeenCalled()
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'downloaded', canForceStop: false })
    const log = await readFile(join(root, 'profile', 'online-update.log'), 'utf8')
    expect(log).toContain('install-requested')
    expect(log).toContain('"force":true')
  })
  it('retains verified package when active task admission denies install, then retries', async () => {
    await manager.downloadOnlineUpdate()
    mocks.admission.mockRejectedValueOnce(new Error('存在正在运行的分析任务'))
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(manager.getUpdateStatus()).toMatchObject({ phase: 'downloaded', message: '存在正在运行的分析任务' })
    expect(mocks.launch).not.toHaveBeenCalled()
    mocks.launch.mockRejectedValueOnce(new Error('helper handoff failed'))
    const releaseAdmission = vi.fn()
    mocks.admission.mockResolvedValueOnce(releaseAdmission)
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(releaseAdmission).toHaveBeenCalledOnce()
    expect(mocks.quit).not.toHaveBeenCalled()
  })
  it('excludes overlapping checks and imports and reopens ready result without downloading again', async () => {
    let resolveCheck!: () => void
    const wait = new Promise<void>(r => { resolveCheck = r })
    mocks.fetch.mockImplementationOnce(async () => { await wait; return Response.json([release]) })
    const first = manager.downloadOnlineUpdate()
    expect((await manager.downloadOnlineUpdate()).phase).toBe('checking')
    expect((await manager.importPortableUpdatePackage()).phase).toBe('checking')
    resolveCheck()
    await first
    const count = mocks.fetch.mock.calls.length
    expect((await manager.downloadOnlineUpdate()).phase).toBe('downloaded')
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
  })
  it('reports no-update and network failures without invoking installation', async () => {
    release.tag_name = 'v2.1.8'
    expect((await manager.downloadOnlineUpdate()).phase).toBe('up-to-date')
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'error', source: 'github', manual: true })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(mocks.launch).not.toHaveBeenCalled()
  })
})
