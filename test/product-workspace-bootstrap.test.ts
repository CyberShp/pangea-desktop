import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('PANGEA product workspace bootstrap bridge', () => {
  it('returns the Desktop-owned launch root to the trusted Harness client', async () => {
    const [main, preload] = await Promise.all([
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8')
    ])

    expect(main).toContain("ipcMain.handle('pangea:product-workspace'")
    expect(main).toContain("ipcMain.handle('pangea:product-workspace-ready'")
    expect(main).toContain('assertTrustedMainWindowEvent(event)')
    expect(main).toContain('return launchDirectory')
    expect(preload).toContain("ipcRenderer.invoke('pangea:product-workspace')")
    expect(preload).toContain("ipcRenderer.invoke('pangea:product-workspace-ready')")
  })
})
