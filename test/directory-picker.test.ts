import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import ts from 'typescript'
import { patchPath } from './patch-path'

describe('desktop Electron directory picker', () => {
  it('restricts the sender and selects files only for coverage requests', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const start = main.indexOf("ipcMain.handle('directory-picker:open'")
    const end = main.indexOf("ipcMain.handle('mobile:open-pairing'", start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const script = ts.transpile(main.slice(start, end), { target: ts.ScriptTarget.ES2022 })
    let handler: any
    const mainWindow = { isDestroyed: () => false, webContents: { mainFrame: {} } }
    const event = { sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }
    const dialog = { showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['/fixture'] }) }
    new Function('ipcMain', 'mainWindow', 'dialog', 'harnessLocale', script)(
      { handle: (_: string, fn: any) => { handler = fn } }, mainWindow, dialog, () => 'zh')
    for (const purpose of [undefined, 'workspace', 'repository', 'coverage', 'unknown']) {
      await expect(handler(event, { purpose })).resolves.toBe('/fixture')
      expect(dialog.showOpenDialog).toHaveBeenLastCalledWith(mainWindow, expect.objectContaining({
        properties: [purpose === 'coverage' ? 'openFile' : 'openDirectory']
      }))
    }
    dialog.showOpenDialog.mockClear()
    await expect(handler({ ...event, senderFrame: {} })).rejects.toThrow('only allowed')
    await expect(handler({ ...event, sender: {} })).rejects.toThrow('only allowed')
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    await expect(handler(event)).resolves.toBeNull()
  })

  it('exposes a narrow preload bridge and handles it in the main process', async () => {
    const preload = await readFile('src/preload/index.ts', 'utf8')
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(preload).toContain("contextBridge.exposeInMainWorld('dshDesktopDirectoryPicker'")
    expect(preload).toContain("ipcRenderer.invoke('directory-picker:open', options)")
    expect(main).toContain("ipcMain.handle('directory-picker:open'")
    expect(main).toContain('event.senderFrame !== mainWindow.webContents.mainFrame')
    expect(main).toContain('dialog.showOpenDialog(mainWindow')
    expect(main).toContain("properties: coveragePicker ? ['openFile'] : ['openDirectory']")
    expect(main).toContain("app.commandLine.appendSwitch('lang', harnessLocale() === 'zh' ? 'zh-CN' : 'en-US')")
  })

  it('keeps native Chinese resources for both macOS and Windows locale names', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      build?: { electronLanguages?: string[] }
    }

    expect(packageJson.build?.electronLanguages).toEqual(
      expect.arrayContaining(['zh-CN', 'zh_CN', 'zh-TW', 'zh_TW'])
    )
  })

  it('keeps the stock picker composition: the seam comes from the stock auto row', async () => {
    const desktopPatch = await readFile('build/dsh-desktop.patch.yml', 'utf8')

    // No picker rows at all - the stock auto row mounts the native backend.
    expect(desktopPatch).not.toMatch(/id:\s*directory-picker/)
    expect(desktopPatch).not.toContain('dsh-client-ui-directory-picker-native')
  })

  it('captures the client bridge as a reproducible dependency patch', async () => {
    const dependencyPatch = await readFile(
      patchPath('@deepseek-ai/dsh-client-ui-directory-picker-native'),
      'utf8'
    )

    expect(dependencyPatch).toContain('window.dshDesktopDirectoryPicker')
    expect(dependencyPatch).toContain('DSH Desktop directory picker bridge is unavailable')
  })

  it('keeps the Host API proxy active when the legacy picker service is absent', async () => {
    const apiProxyPatch = await readFile(
      patchPath('@deepseek-ai/dsh-host-apiproxy'),
      'utf8'
    )

    expect(apiProxyPatch).toContain('const directoryPicker = ctx.get("directoryPicker")')
    expect(apiProxyPatch).toContain('-\t\t"directoryPicker",')
    expect(apiProxyPatch).toContain('details: { capability: "none" }')
  })
})
