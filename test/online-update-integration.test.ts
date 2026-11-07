import { ZipArchive } from 'archiver'
import unzipper from 'unzipper'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), getPath: vi.fn(), launch: vi.fn(), quit: vi.fn(), admission: vi.fn(), messages: [] as any[] }))
vi.mock('electron', () => ({
  app: { getVersion: () => '2.1.17', getPath: mocks.getPath, isPackaged: true, quit: mocks.quit },
  BrowserWindow: { fromWebContents: () => ({}), getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_: string, status: unknown) => mocks.messages.push(status) } }] },
  dialog: {}, ipcMain: { handle: vi.fn() }, net: { fetch: mocks.fetch }
}))
vi.mock('../src/main/update/update-network', async importOriginal => ({ ...(await importOriginal<any>()), createUpdateTransport: async () => ({ fetch: mocks.fetch, close: async () => {} }) }))
vi.mock('../src/main/update/update-capability', () => ({ canImportPortableUpdate: () => true }))
vi.mock('../src/main/update/launch-portable-helper', () => ({ launchPortableHelper: mocks.launch }))

let root: string
let resourcesDescriptor: PropertyDescriptor | undefined
let manager: typeof import('../src/main/update/update-manager')
let activeIndex: any
let intranetIndex: any
let intranetUrl: string
const intranetResponses = new Map<string, Buffer>()
const responses = new Map<string, Buffer>()
const version = '2.1.18'
const name = `pangea-desktop-${version}-windows-x64-portable.zip`
const prefix = 'fixture:'

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
  // Generate a real signed baseline/patch, then exercise the upload-index CLI.
  const base = join(root, 'base')
  await cp(app, base, { recursive: true })
  await writeFile(join(base, 'PANGEA Desktop.exe'), 'baseline executable')
  await writeFile(join(base, 'resources', 'pangea-manifest.json'), JSON.stringify({ product: { version: '2.1.17' }, components: { agent: { commit: 'a'.repeat(40) } } }))
  await mkdir(join(root, 'base-dist'))
  execFileSync(process.execPath, ['scripts/create-signed-portable-package.mjs', '--app-dir', base,
    '--private-key', join(root, 'private.pem'), '--output', join(root, 'base-dist', 'pangea-desktop-2.1.17-windows-x64-portable.zip'), '--version', '2.1.17'])
  execFileSync(process.execPath, ['scripts/create-signed-portable-patch.mjs', '--base-dir', base, '--target-dir', app,
    '--private-key', join(root, 'private.pem'), '--output', join(root, 'dist', 'patch.zip'), '--from-version', '2.1.17', '--to-version', version, '--channel', 'stable'])
  execFileSync(process.execPath, ['scripts/create-intranet-update-index.mjs', '--directory', join(root, 'dist'),
    '--public-key', join(resources, 'update', 'pangea-update-public-key.pem'), '--full-remote-name', 'pangea-desktop.zip'])
  intranetIndex = JSON.parse(await readFile(join(root, 'dist', 'latest.json'), 'utf8'))
  const uploadList = JSON.parse(await readFile(join(root, 'dist', 'intranet-upload-list.json'), 'utf8'))
  expect(new URL(intranetIndex.full_url, 'https://pangea.rnd.huawei.com/api/tools/27/files/download').searchParams.get('path')).toBe(`stable/windows/x64/${version}/pangea-desktop.zip`)
  expect(uploadList.upload_first.find((file: any) => file.local === name).path).toBe(`stable/windows/x64/${version}/pangea-desktop.zip`)
  intranetUrl = new URL(uploadList.publish_last.url, 'https://pangea.rnd.huawei.com/api/tools/27/files/download').href
  expect(intranetIndex.full_url.startsWith('?path=')).toBe(true)
  expect(JSON.stringify(intranetIndex)).not.toContain('https://')
  for (const file of uploadList.upload_first) intranetResponses.set(new URL(file.verify_download, intranetUrl).href, await readFile(join(root, 'dist', file.local)))
  resourcesDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true })
})
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); mocks.messages.length = 0
  mocks.getPath.mockReturnValue(join(root, 'profile'))
  await rm(join(root, 'profile', 'update-network.json'), { force: true })
  await enableIntranet({ ...intranetIndex, patches: [] })
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

describe('online update production pipeline with simulated intranet and Windows launcher', () => {
  it.each([false, true])('checks metadata without downloading or installing (manual=%s)', async manual => {
    expect(await manager.checkForOnlineUpdate(manual)).toMatchObject({ phase: 'available', availableVersion: version, manual })
    expect(mocks.fetch.mock.calls.map(([url]) => url)).not.toContain(new URL(intranetIndex.full_url, intranetUrl).href)
    expect(mocks.admission).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    await manager.downloadOnlineUpdate()
    expect(mocks.fetch.mock.calls.map(([url]) => url)).toContain(new URL(intranetIndex.full_url, intranetUrl).href)
    expect(manager.getUpdateStatus().phase).toBe('downloaded')
    expect(mocks.launch).not.toHaveBeenCalled()
  })
  it('revalidates a changed release before an explicit download', async () => {
    await manager.checkForOnlineUpdate(false)
    mocks.fetch.mockRejectedValueOnce(new Error('index changed'))
    expect((await manager.downloadOnlineUpdate()).phase).toBe('error')
    expect(mocks.fetch.mock.calls.map(([url]) => url)).not.toContain(new URL(intranetIndex.full_url, intranetUrl).href)
  })

  it('signs release metadata, downloads, verifies real ZIP, stages signed helper and hands off health plan', async () => {
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'downloaded', availableVersion: version, source: 'intranet', packageType: 'full' })
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
    mocks.fetch.mockImplementationOnce(async () => { await wait; return Response.json(activeIndex) })
    const first = manager.downloadOnlineUpdate()
    expect((await manager.downloadOnlineUpdate()).phase).toBe('checking')
    expect((await manager.importPortableUpdatePackage()).phase).toBe('checking')
    resolveCheck()
    await first
    const count = mocks.fetch.mock.calls.length
    expect((await manager.downloadOnlineUpdate()).phase).toBe('downloaded')
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
  })
  it('reports index and network failures without invoking installation', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('index changed'))
    expect((await manager.downloadOnlineUpdate()).phase).toBe('error')
    mocks.fetch.mockResolvedValueOnce(new Response('', { status: 403 }))
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'error', source: 'intranet', manual: true })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(mocks.launch).not.toHaveBeenCalled()
  })
})

async function enableIntranet(index = intranetIndex) {
  activeIndex = index
  mocks.fetch.mockImplementation(async (url: string) => url === intranetUrl || url === intranetUrl.replaceAll('%2F', '/') ? Response.json(activeIndex) : intranetResponses.has(url) ? new Response(new Uint8Array(intranetResponses.get(url)!)) : new Response('', { status: 404 }))
}
it('generates query URLs and uses a real signed patch through the online install handoff', async () => {
  expect(intranetIndex.patches).toHaveLength(1)
  await enableIntranet()
  expect(await manager.checkForOnlineUpdate()).toMatchObject({ phase: 'available', source: 'intranet' })
  expect(mocks.fetch).toHaveBeenCalledTimes(3)
  expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'downloaded', source: 'intranet', packageType: 'patch', baseVersion: '2.1.17', availableVersion: version })
  expect(mocks.fetch.mock.calls.every(([url]) => url.startsWith('https://pangea.rnd.huawei.com/'))).toBe(true)
  mocks.launch.mockImplementation(async (_: string, planPath: string) => {
    expect(JSON.parse(await readFile(planPath, 'utf8'))).toMatchObject({ package_type: 'patch', expected_version: version, expected_base_version: '2.1.17' })
  })
  vi.useFakeTimers()
  expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: true })
  expect(mocks.launch).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
})
it('uses full package when the mirror has no patch for this baseline', async () => {
  await enableIntranet({ ...intranetIndex, patches: [] })
  expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'downloaded', source: 'intranet', packageType: 'full', availableVersion: version })
})
it('rejects modified mirrored patch bytes before installation', async () => {
  await enableIntranet()
  const patchUrl = new URL(intranetIndex.patches[0].url, intranetUrl).href
  const original = intranetResponses.get(patchUrl)!
  intranetResponses.set(patchUrl, Buffer.alloc(original.length))
  try {
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'error', source: 'intranet' })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(mocks.launch).not.toHaveBeenCalled()
  } finally { intranetResponses.set(patchUrl, original) }
})

it('rejects a broken internal signature even when the unsigned index hash is recomputed', async () => {
  const patchUrl = new URL(intranetIndex.patches[0].url, intranetUrl).href
  const original = intranetResponses.get(patchUrl)!
  const directory = await unzipper.Open.buffer(original)
  const archive = new ZipArchive({ zlib: { level: 9 } })
  const chunks: Buffer[] = []
  const completed = new Promise<Buffer>((resolve, reject) => {
    archive.on('data', chunk => chunks.push(Buffer.from(chunk)))
    archive.on('end', () => resolve(Buffer.concat(chunks)))
    archive.on('error', reject)
  })
  for (const entry of directory.files) archive.append(entry.path === 'pangea-patch-manifest.json.sig' ? Buffer.alloc(64).toString('base64') : await entry.buffer(), { name: entry.path })
  await archive.finalize()
  const tampered = await completed
  const index = structuredClone(intranetIndex)
  index.patches[0].size = tampered.length
  index.patches[0].sha256 = createHash('sha256').update(tampered).digest('hex')
  intranetResponses.set(patchUrl, tampered)
  try {
    await enableIntranet(index)
    expect(await manager.downloadOnlineUpdate()).toMatchObject({ phase: 'error', source: 'intranet', message: expect.stringMatching(/signature verification failed/) })
    expect(await manager.installImportedUpdate()).toEqual({ helperLaunched: false })
    expect(mocks.launch).not.toHaveBeenCalled()
  } finally { intranetResponses.set(patchUrl, original) }
})
it('ignores legacy GitHub configuration and registers no settings handlers', async () => {
  await mkdir(join(root, 'profile'), { recursive: true })
  await writeFile(join(root, 'profile', 'update-network.json'), JSON.stringify({ updateSource: 'github', proxyUrl: 'http://obsolete.invalid' }))
  expect(await manager.checkForOnlineUpdate()).toMatchObject({ phase: 'available', source: 'intranet' })
  expect(mocks.fetch.mock.calls.every(([url]) => new URL(url).origin === 'https://pangea.rnd.huawei.com')).toBe(true)
  manager.registerUpdateHandlers()
  const { ipcMain } = await import('electron')
  expect(vi.mocked(ipcMain.handle).mock.calls.map(([name]) => name)).not.toContain('updates:network-save')
})
