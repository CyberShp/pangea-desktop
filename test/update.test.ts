import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('portable package import manager', () => {
  it('selects, verifies and stages one local ZIP before restart', async () => {
    const [manager, validator] = await Promise.all([
      readFile('src/main/update/update-manager.ts', 'utf8'),
      readFile('src/main/update/portable-package-validator.ts', 'utf8')
    ])
    expect(manager).toContain("ipcMain.handle('updates:import'")
    expect(manager).toContain("extensions: ['zip']")
    expect(manager).toContain('stagePortablePackage({')
    expect(manager).toContain('stagePortablePatch({')
    expect(manager).toContain('isPortablePatchArchive')
    expect(manager).toContain('await prepareToInstall?.()')
    expect(validator).toContain('verifyPortableUpdateManifest')
    expect(validator).toContain('升级包包含未签名文件')
    const patchValidator = await readFile('src/main/update/portable-patch-validator.ts', 'utf8')
    expect(patchValidator).toContain('verifyPortablePatchManifest')
    expect(patchValidator).toContain('此补丁仅适用于')
  })
})
