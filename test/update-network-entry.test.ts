// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { DshDesktopBridge } from '../src/preload/desktop-bridge'
import { createUpdateNetworkMenuItem } from '../src/main/update/update-network-menu'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  expose: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: (channel: string, listener: (...args: unknown[]) => void) => mocks.listeners.set(channel, listener),
    removeListener: vi.fn()
  }
}))
vi.mock('../src/preload/history-navigation', () => ({ installHistoryNavigationGuard: vi.fn() }))

let bridge: Readonly<DshDesktopBridge>
let root: ShadowRoot
const host = () => document.getElementById('dsh-desktop-update-network-root')
const close = () => root?.querySelector<HTMLButtonElement>('.actions button[type=button]')?.click()

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.listeners.clear()
  document.body.innerHTML = '<button id="settings-entry">更新网络设置</button>'
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading')
  // Exercise the real contextBridge registration without starting unrelated
  // mobile/status observers when the test document is already loaded.
  vi.spyOn(window, 'addEventListener').mockImplementation(() => {})
  const attach = HTMLElement.prototype.attachShadow
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) {
    root = attach.call(this, options)
    return root
  })
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel === 'updates:status') return { phase: 'idle', currentVersion: '1.0.4', manual: false }
    if (channel === 'updates:network-get') return { proxyUrl: '', username: '', hasPassword: false, skipCertificateCheck: false }
    throw new Error(`Unexpected IPC from dialog entry: ${channel}`)
  })
  await import('../src/preload/index')
  bridge = mocks.expose.mock.calls.find(([name]) => name === 'dshDesktop')![1]
  mocks.invoke.mockClear()
})

afterEach(() => {
  close()
  host()?.remove()
  vi.restoreAllMocks()
})

describe('normal-window update network settings entry', () => {
  it('exposes a working dialog opener before any update failure, without changing or checking the network', async () => {
    expect(typeof bridge.openUpdateNetworkSettings).toBe('function')
    expect(host()).toBeNull()
    await bridge.openUpdateNetworkSettings()
    expect(host()).not.toBeNull()
    expect(root.querySelector('[role=dialog]')?.getAttribute('aria-modal')).toBe('true')
    expect(root.textContent).toContain('在线更新网络设置')
    expect(mocks.invoke.mock.calls).toEqual([['updates:network-get']])
    expect(bridge).not.toHaveProperty('getUpdateNetworkSettings')
    expect(bridge).not.toHaveProperty('saveUpdateNetworkSettings')
  })

  it('keeps rapid clicks and the menu shortcut on one dialog, then allows closing and reopening', async () => {
    let resolve!: (value: unknown) => void
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done }))
    const pending = bridge.openUpdateNetworkSettings()
    const firstHost = host()
    await bridge.openUpdateNetworkSettings()
    const menu = createUpdateNetworkMenuItem(true, () => ({
      isDestroyed: () => false,
      webContents: { send: channel => mocks.listeners.get(channel)?.({}) }
    }))
    expect(menu.accelerator).toBe('CmdOrCtrl+Alt+N')
    menu.click()
    expect(host()).toBe(firstHost)
    expect(document.querySelectorAll('#dsh-desktop-update-network-root')).toHaveLength(1)
    expect(mocks.invoke.mock.calls).toEqual([['updates:network-get']])
    close()
    expect(host()).toBeNull()
    resolve({ proxyUrl: '', username: '', hasPassword: false, skipCertificateCheck: false })
    await pending
    await bridge.openUpdateNetworkSettings()
    expect(host()).not.toBe(firstHost)
    expect(mocks.invoke.mock.calls).toEqual([['updates:network-get'], ['updates:network-get']])
  })

  it('routes a first menu/shortcut activation into the same dialog and restores focus on Escape', async () => {
    const entry = document.getElementById('settings-entry')!
    entry.focus()
    const menu = createUpdateNetworkMenuItem(false, () => ({
      isDestroyed: () => false,
      webContents: { send: channel => mocks.listeners.get(channel)?.({}) }
    }))
    menu.click()
    await vi.waitFor(() => expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(false))
    expect(host()).not.toBeNull()
    root.querySelector('form')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(host()).toBeNull()
    expect(document.activeElement).toBe(entry)
    expect(mocks.invoke.mock.calls).toEqual([['updates:network-get']])
    menu.click()
    expect(host()).not.toBeNull()
  })

  it('shows a read error in the opened dialog without starting any update work', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('network settings unavailable'))
    await bridge.openUpdateNetworkSettings()
    expect(host()).not.toBeNull()
    expect(root.querySelector('[role=alert]')?.textContent).toContain('无法读取网络设置')
    expect(root.querySelector<HTMLButtonElement>('[type=submit]')!.disabled).toBe(true)
    expect(mocks.invoke.mock.calls).toEqual([['updates:network-get']])
  })

  it('registers the dedicated shortcut in the hidden native menu without replacing update/import shortcuts', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    expect(main).toContain('createUpdateNetworkMenuItem(isChinese, () => mainWindow)')
    expect(main).toContain("accelerator: 'CmdOrCtrl+U'")
    expect(main).toContain("accelerator: 'CmdOrCtrl+Shift+U'")
    expect(main).toContain('contextIsolation: true')
    expect(main).toContain('nodeIntegration: false')
    const send = vi.fn()
    createUpdateNetworkMenuItem(true, () => undefined).click()
    createUpdateNetworkMenuItem(true, () => ({ isDestroyed: () => true, webContents: { send } })).click()
    expect(send).not.toHaveBeenCalled()
  })
})
