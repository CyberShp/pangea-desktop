import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  fromWebContents: vi.fn(), showMessageBox: vi.fn(), configure: vi.fn(), authorize: vi.fn(), isDestroyed: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getVersion: () => '2.1.8' },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  dialog: { showMessageBox: mocks.showMessageBox },
  ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => mocks.handlers.set(name, handler) }
}))
vi.mock('../src/main/update/git-proxy', () => ({ configureGlobalGitProxy: mocks.configure }))
vi.mock('../src/main/update/update-network', () => ({ createUpdateTransport: vi.fn(), UpdateNetworkStore: vi.fn() }))
vi.mock('../src/main/update/portable-package-validator', () => ({ stagePortablePackage: vi.fn() }))
vi.mock('../src/main/update/portable-patch-validator', () => ({
  isPortablePatchArchive: vi.fn(), PortablePatchBaseVersionMismatch: class extends Error {}, stagePortablePatch: vi.fn()
}))
vi.mock('../src/main/update/launch-portable-helper', () => ({ launchPortableHelper: vi.fn() }))
vi.mock('../src/main/update/stage-update-helper', () => ({ stageUpdateHelper: vi.fn() }))

const proxyUrl = 'http://employee@proxy.huawei.com:8080'
const window = { identity: 'owned-window' }
const frame = { identity: 'main-frame' }
const event = { sender: { mainFrame: frame, isDestroyed: mocks.isDestroyed }, senderFrame: frame }
let invoke: (...args: any[]) => any

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.fromWebContents.mockReturnValue(window)
  mocks.authorize.mockReturnValue(true)
  mocks.isDestroyed.mockReturnValue(false)
  mocks.showMessageBox.mockResolvedValue({ response: 0 })
  mocks.configure.mockImplementation(async (_username, confirm) => ({
    configured: await confirm({ proxyUrl, hasExistingProxy: true })
  }))
  const manager = await import('../src/main/update/update-manager')
  manager.registerUpdateHandlers({ authorizeGitProxy: mocks.authorize })
  invoke = mocks.handlers.get('updates:git-proxy')!
})

describe('Git proxy privileged IPC and native consent', () => {
  it('rejects an unowned webContents before any Git action', async () => {
    mocks.fromWebContents.mockReturnValue(null)
    await expect(invoke(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
  it('rejects a subframe before any Git action', async () => {
    await expect(invoke({ ...event, senderFrame: {} }, 'employee')).rejects.toThrow('不允许')
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
  it('rejects an untrusted origin before Git configuration or native consent', async () => {
    mocks.authorize.mockReturnValue(false)
    await expect(invoke(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
  it('fails closed when no trusted-page authorization callback is installed', async () => {
    vi.resetModules()
    const manager = await import('../src/main/update/update-manager')
    manager.registerUpdateHandlers()
    await expect(mocks.handlers.get('updates:git-proxy')!(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
  it('rejects a destroyed sender before Git configuration', async () => {
    mocks.isDestroyed.mockReturnValue(true)
    await expect(invoke(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.configure).not.toHaveBeenCalled()
    expect(mocks.showMessageBox).not.toHaveBeenCalled()
  })
  it('rechecks page authorization after native confirmation, blocking navigation races', async () => {
    mocks.authorize.mockReturnValueOnce(true).mockReturnValueOnce(false)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    await expect(invoke(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.authorize).toHaveBeenCalledTimes(2)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    await expect(mocks.configure.mock.results[0]!.value).rejects.toThrow('不允许')
  })
  it('rechecks sender lifetime after native confirmation', async () => {
    mocks.isDestroyed.mockReturnValueOnce(false).mockReturnValueOnce(true)
    mocks.showMessageBox.mockResolvedValue({ response: 1 })
    await expect(invoke(event, 'employee')).rejects.toThrow('不允许')
    expect(mocks.isDestroyed).toHaveBeenCalledTimes(2)
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
  })
  it.each([0, 1])('uses the native cancel/confirm decision (response=%i)', async response => {
    mocks.showMessageBox.mockResolvedValue({ response })
    expect(await invoke(event, 'employee')).toEqual({ configured: response === 1 })
    expect(mocks.configure).toHaveBeenCalledWith('employee', expect.any(Function))
    const [owner, options] = mocks.showMessageBox.mock.calls[0]!
    expect(owner).toBe(window)
    expect(options).toMatchObject({ defaultId: 0, cancelId: 0, buttons: ['取消', '确认配置'] })
    expect(options.message).toContain('影响所有仓库')
    expect(options.detail).toContain(proxyUrl)
    expect(options.detail).toContain('已有全局代理，将被替换')
    expect(options.detail).toContain('不会写入密码')
    expect(options.detail).toContain('现有凭据管理器')
    expect(options.detail).toContain('不验证 Git 网络连接')
  })
  it('does not include arbitrary previous-configuration secrets in native consent', async () => {
    mocks.configure.mockImplementation(async (_username, confirm) => ({ configured: await confirm({
      proxyUrl, hasExistingProxy: true, previous: 'http://old:previous-secret@old-proxy'
    }) }))
    await invoke(event, 'employee')
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toContain('previous-secret')
    expect(JSON.stringify(mocks.showMessageBox.mock.calls)).not.toContain('old-proxy')
  })
  it('prevents duplicate native dialogs and recovers after dismissal', async () => {
    let dismiss!: (result: { response: number }) => void
    mocks.showMessageBox.mockImplementationOnce(() => new Promise(resolve => { dismiss = resolve }))
    const pending = invoke(event, 'employee')
    await vi.waitFor(() => expect(dismiss).toBeTypeOf('function'))
    await expect(invoke(event, 'employee')).rejects.toThrow('正在进行')
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(1)
    dismiss({ response: 0 })
    await pending
    await invoke(event, 'employee')
    expect(mocks.showMessageBox).toHaveBeenCalledTimes(2)
  })
  it('propagates a safe configuration failure and releases the in-flight guard', async () => {
    mocks.configure.mockRejectedValueOnce(new Error('写入全局代理配置失败（Git 4）'))
    await expect(invoke(event, 'employee')).rejects.toThrow('Git 4')
    expect(await invoke(event, 'employee')).toEqual({ configured: false })
  })
})
