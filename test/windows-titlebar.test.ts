import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_TITLEBAR_HEIGHT,
  desktopMenuCommands,
  formatZoomPercentage,
  isDesktopMenuCommand
} from '../src/shared/desktop-menu'

describe('Windows titlebar and native fallback menu', () => {
  it('uses a Windows-only overlay while preserving the macOS frame behavior', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("const isWindows = process.platform === 'win32'")
    expect(main).toContain("frame: process.platform !== 'darwin'")
    expect(main).toContain("titleBarStyle: 'hidden' as const")
    expect(main).toContain('titleBarOverlay: windowsTitleBarOverlay')
    expect(main).toContain('autoHideMenuBar: true')
    expect(main).toContain('window.setMenuBarVisibility(false)')
    expect(main).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(template))')
  })

  it('keeps the entire Windows app full-height with a draggable product header', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')

    expect(WINDOWS_TITLEBAR_HEIGHT).toBe(36)
    expect(main).toContain("color: '#00000000'")
    expect(preload).toContain('padding-top: 0 !important')
    expect(preload).toContain('trackSidebarLayout(document)')
    expect(preload).toContain("dragRegion.id = DRAG_REGION_ID")
    expect(preload).toContain('-webkit-app-region: drag')
    expect(preload).toContain('right: var(${CAPTION_WIDTH_PROPERTY}, 140px)')
    expect(preload).toContain('pointer-events: none')
    expect(preload).toContain('-webkit-app-region: no-drag !important')
  })

  it('removes the non-interactive child-view arrow menu', async () => {
    const [main, preloadConfig, packageJson] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('electron.vite.config.ts', 'utf8'),
      readFile('package.json', 'utf8')
    ])

    expect(main).not.toContain('WebContentsView')
    expect(main).not.toContain('windowsMenuView')
    expect(main).not.toContain('desktop-titlebar:set-menu-open')
    expect(preloadConfig).not.toContain('windows-menu')
    expect(packageJson).not.toContain('windows-menu.html')
  })

  it('keeps menu commands allowlisted and uses the main window as the only renderer caller', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(desktopMenuCommands).toContain('connect-phone')
    expect(desktopMenuCommands).toContain('import-update-package')
    expect(desktopMenuCommands).toContain('safe-mode')
    expect(desktopMenuCommands).toContain('toggle-fullscreen')
    expect(isDesktopMenuCommand('copy')).toBe(true)
    expect(isDesktopMenuCommand('run-shell-command')).toBe(false)
    expect(isDesktopMenuCommand({ command: 'quit' })).toBe(false)
    expect(main).toContain("ipcMain.handle('desktop-menu:execute'")
    expect(main).toContain("ipcMain.handle('desktop-menu:get-zoom-factor'")
    expect(main).toContain('assertTrustedDesktopMenuEvent(event)')
    expect(main).toContain('assertTrustedMainWindowEvent(event)')
    expect(main).toContain('if (!isDesktopMenuCommand(command))')
  })

  it('preserves zoom commands without coupling them to a separate titlebar renderer', () => {
    expect(formatZoomPercentage(1)).toBe('100%')
    expect(formatZoomPercentage(Math.sqrt(1.2))).toBe('110%')
    expect(formatZoomPercentage(1 / Math.sqrt(1.2))).toBe('91%')
  })

  it('keeps package import in the native menu with Ctrl+U as a focused-window fallback', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("label: isChinese ? '导入升级包…' : 'Import Update Package…'")
    expect(main).toContain("accelerator: 'CmdOrCtrl+U'")
    expect(main).toContain('importPortableUpdatePackage()')
  })

  it('synchronizes native caption controls with the Harness theme', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')

    expect(main).toContain('window.setTitleBarOverlay(windowsTitleBarOverlay(isDark))')
    expect(main).toContain("ipcMain.handle('desktop-titlebar:set-theme'")
    expect(preload).toContain("attributeFilter: ['data-ds-dark-theme', 'class', 'style']")
    expect(preload).toContain("ipcRenderer.invoke('desktop-titlebar:set-theme', isDark)")
  })
})
