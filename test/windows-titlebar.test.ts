import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import {
  desktopMenuCommands,
  formatZoomPercentage,
  isDesktopMenuCommand
} from '../src/shared/desktop-menu'

describe('Windows titlebar and native fallback menu', () => {
  it('uses native Windows chrome outside product content while preserving the macOS frame behavior', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')

    expect(main).toContain("const isWindows = process.platform === 'win32'")
    expect(main).toContain("frame: process.platform !== 'darwin'")
    expect(main).not.toContain("titleBarStyle: 'hidden' as const")
    expect(main).not.toContain('titleBarOverlay:')
    expect(main).toContain('autoHideMenuBar: true')
    expect(main).toContain('window.setMenuBarVisibility(false)')
    expect(main).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(template))')
  })

  it('does not install overlay drag regions or reserve product content for captions', async () => {
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')
    const entry = await readFile('src/preload/index.ts', 'utf8')
    expect(entry).toContain('mountWindowsTheme({ document, ipcRenderer })')
    expect(preload).not.toContain('titlebar-area-width')
    expect(preload).not.toContain('installDragRegion')
    expect(preload).not.toContain('document.createElement')
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

  it('preserves window background theme synchronization without overlay calls', async () => {
    const main = await readFile('src/main/index.ts', 'utf8')
    const preload = await readFile('src/preload/windows-titlebar.ts', 'utf8')

    expect(main).not.toContain('setTitleBarOverlay')
    expect(main).toContain("window.setBackgroundColor(isDark ? '#141416' : '#ffffff')")
    expect(main).toContain("ipcMain.handle('desktop-titlebar:set-theme'")
    expect(preload).toContain("attributeFilter: ['data-ds-dark-theme', 'class', 'style']")
    expect(preload).toContain("ipcRenderer.invoke('desktop-titlebar:set-theme', isDark)")
  })
})
