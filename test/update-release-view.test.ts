// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import { createUpdateReleaseView } from '../src/preload/update-release-view'
import type { UpdateStatus } from '../src/shared/contracts'
const status: UpdateStatus = { phase: 'available', currentVersion: '2.1.19', availableVersion: '2.1.20', source: 'intranet', manual: false, publishedAt: '2026-11-07T12:00:00Z', releaseNotes: { features: ['查看更新说明'], fixes: [], notices: ['请先完成分析任务'] } }
beforeEach(() => {
  document.getElementById('pangea-update-release')?.remove()
  document.body.replaceChildren()
})
const root = () => document.getElementById('pangea-update-release')!.shadowRoot!
const click = (text: string) => [...root().querySelectorAll('button')].find(button => button.textContent === text)!.click()
it('automatically shows only a light notice; explicit viewing opens notes without downloading', async () => {
  const actions = { claim: vi.fn(async () => true), download: vi.fn(async () => {}) }
  const view = createUpdateReleaseView(actions)
  await view.update(status)
  expect(root().querySelector('dialog')).toBeNull()
  expect(root().querySelector('.toast')?.textContent).toContain('发现 v2.1.20')
  click('查看更新')
  expect(root().querySelector('dialog')?.open).toBe(true)
  expect(root().textContent).toContain('新增功能')
  expect(root().textContent).not.toContain('问题修复')
  expect(actions.download).not.toHaveBeenCalled()
  click('稍后再说')
  await view.update({ ...status })
  expect(actions.claim).toHaveBeenCalledTimes(1)
  expect(root().querySelector('dialog')).toBeNull()
})
it('manual check opens the dialog even when automatic reminders are suppressed', async () => {
  const view = createUpdateReleaseView({ claim: async () => false, download: async () => {} })
  await view.update(status)
  expect(document.getElementById('pangea-update-release')).toBeNull()
  await view.update({ ...status, manual: true, releaseNotes: undefined })
  expect(root().querySelector('dialog')?.open).toBe(true)
  expect(root().textContent).toContain('此版本未提供更新说明')
})
it('renders text safely and downloads only after the explicit action', async () => {
  const download = vi.fn(async () => {})
  const view = createUpdateReleaseView({ claim: async () => true, download })
  await view.update({ ...status, manual: true, releaseNotes: { features: ['<img src=x onerror=alert(1)>'], fixes: [], notices: [] } })
  expect(root().querySelector('img')).toBeNull()
  expect(root().querySelector('li')?.textContent).toContain('<img')
  click('下载更新'); click('下载更新')
  await Promise.resolve()
  expect(download).toHaveBeenCalledTimes(1)
})
it('discards a late automatic claim after the update state changes', async () => {
  let resolve!: (allowed: boolean) => void
  const view = createUpdateReleaseView({ claim: () => new Promise(r => { resolve = r }), download: async () => {} })
  const pending = view.update(status)
  await view.update({ ...status, phase: 'up-to-date' })
  resolve(true); await pending
  expect(document.getElementById('pangea-update-release')).toBeNull()
})
it('Escape closes the dialog and restores focus', async () => {
  const opener = document.createElement('button'); document.body.append(opener); opener.focus()
  const view = createUpdateReleaseView({ claim: async () => true, download: async () => {} })
  await view.update({ ...status, manual: true })
  root().querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
  expect(root().querySelector('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
})
