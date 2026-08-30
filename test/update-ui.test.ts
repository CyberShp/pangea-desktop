import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../src/shared/contracts'
import {
  isUpdateDismissed,
  shouldShowUpdate,
  updateMessage
} from '../src/preload/update-view'

const downloading: UpdateStatus = {
  phase: 'downloading',
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  percent: 42.2,
  manual: true
}

const downloaded: UpdateStatus = {
  phase: 'downloaded',
  currentVersion: '1.0.0',
  availableVersion: '1.1.0',
  manual: true
}

describe('desktop update card visibility', () => {
  it('shows user-initiated package verification', () => {
    expect(shouldShowUpdate(downloading)).toBe(true)
    expect(
      shouldShowUpdate({ phase: 'checking', currentVersion: '1.0.0', manual: false })
    ).toBe(false)
    expect(
      shouldShowUpdate({ phase: 'checking', currentVersion: '1.0.0', manual: true })
    ).toBe(true)
  })

  it('keeps a dismissed imported version hidden while its phase changes', () => {
    expect(isUpdateDismissed(downloading, '1.1.0')).toBe(true)
    expect(isUpdateDismissed({ ...downloading, availableVersion: '1.2.0' }, '1.1.0')).toBe(
      false
    )
  })

  it('dismisses a downloaded update when the user closes the card', () => {
    expect(isUpdateDismissed(downloaded, null)).toBe(false)
    expect(isUpdateDismissed(downloaded, '1.0.0')).toBe(false)
    expect(isUpdateDismissed(downloaded, '1.1.0')).toBe(true)
  })

  it('formats localized progress copy', () => {
    expect(updateMessage(downloading, 'zh')).toBe('正在校验升级包 42%')
    expect(updateMessage(downloading, 'en')).toBe('Verifying update package 42%')
  })

  it('shows a persisted install failure after the working version restarts', () => {
    const failed: UpdateStatus = {
      phase: 'install-error',
      currentVersion: '1.0.0',
      availableVersion: '1.1.0',
      message: 'restored',
      manual: true
    }
    expect(shouldShowUpdate(failed)).toBe(true)
    expect(updateMessage(failed, 'zh')).toBe('PANGEA Desktop 1.1.0 升级未完成')
  })
})

describe('secure update card wiring', () => {
  it('bundles a preload and mounts it without enabling Node in Harness', async () => {
    const [config, main, preload] = await Promise.all([
      readFile('electron.vite.config.ts', 'utf8'),
      readFile('src/main/index.ts', 'utf8'),
      readFile('src/preload/index.ts', 'utf8')
    ])

    expect(config).toContain('preload:')
    expect(main).toContain("preload: join(import.meta.dirname, '../preload/index.cjs')")
    expect(main).toContain('nodeIntegration: false')
    expect(preload).toContain("ipcRenderer.on('updates:status-changed'")
    expect(preload).toContain("ipcRenderer.invoke('updates:import')")
    expect(preload).toContain("ipcRenderer.invoke('updates:install')")
    expect(preload).toContain("'right:20px'")
    expect(preload).toContain("'bottom:20px'")
  })
})

describe('portable package selection', () => {
  it('announces that the selected package is being read', () => {
    const checking: UpdateStatus = {
      phase: 'checking',
      currentVersion: '0.4.3',
      manual: true
    }
    expect(updateMessage(checking, 'zh')).toBe('正在读取升级包…')
    expect(updateMessage(checking, 'en')).toBe('Reading update package…')
  })
})
