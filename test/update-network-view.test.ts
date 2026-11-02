// @vitest-environment happy-dom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('electron', () => ({ ipcRenderer: { invoke: mocks.invoke } }))
let root: ShadowRoot
let open: typeof import('../src/preload/update-network-view').openUpdateNetworkSettings
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks()
  document.body.innerHTML = ''
  const attach = HTMLElement.prototype.attachShadow
  vi.spyOn(HTMLElement.prototype, 'attachShadow').mockImplementation(function (this: HTMLElement, options) { root = attach.call(this, options); return root })
  mocks.invoke.mockImplementation(async (channel: string) => channel === 'updates:network-get' ? { proxyUrl: '', username: '', hasPassword: false, skipCertificateCheck: false } : { configured: true })
  open = (await import('../src/preload/update-network-view')).openUpdateNetworkSettings
})
afterEach(() => { root?.querySelector<HTMLButtonElement>('.actions button[type=button]')?.click(); vi.restoreAllMocks() })
const field = (name: string) => root.querySelector<HTMLInputElement>(`[name=${name}]`)!
const mode = (value: string) => { field('mode').value = value; field('mode').dispatchEvent(new Event('change')) }
const submit = async () => { root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('updates:check')) }
it('has no URL input; sends raw special-character credentials and company mode', async () => {
  await open(); expect(root.querySelector('[name=proxyUrl]')).toBeNull()
  mode('company'); field('username').value = 'a@corp'; field('password').value = 's:@%#'
  await submit()
  expect(mocks.invoke).toHaveBeenCalledWith('updates:network-save', { mode: 'company', proxyUrl: '', username: 'a@corp', password: 's:@%#', skipCertificateCheck: false })
})
it('preserves old custom proxy until explicitly selecting company', async () => {
  mocks.invoke.mockResolvedValueOnce({ proxyUrl: 'http://old.example:8080', username: 'old', skipCertificateCheck: false })
  await open(); expect(field('mode').value).toBe('custom'); expect(root.textContent).toContain('http://old.example:8080')
  await submit(); expect(mocks.invoke).toHaveBeenCalledWith('updates:network-save', expect.objectContaining({ mode: 'custom', proxyUrl: 'http://old.example:8080' }))
})
it('Git action sends username only and accurately reports cancellation', async () => {
  await open(); mode('company'); field('username').value = 'id'; field('password').value = 'never-send'
  mocks.invoke.mockResolvedValueOnce({ configured: false })
  root.querySelector<HTMLButtonElement>('#git-proxy')!.click()
  await vi.waitFor(() => expect(root.querySelector('#git-result')!.textContent).toContain('已取消'))
  expect(mocks.invoke).toHaveBeenCalledWith('updates:git-proxy', 'id')
  expect(mocks.invoke.mock.calls.some(call => call.includes('never-send'))).toBe(false)
})
it('surfaces Git write failure without reporting success and supports retry', async () => {
  await open(); mode('company'); field('username').value = 'id'
  mocks.invoke.mockRejectedValueOnce(new Error('写入失败（Git 5）'))
  root.querySelector<HTMLButtonElement>('#git-proxy')!.click()
  await vi.waitFor(() => expect(root.querySelector('#git-result')!.textContent).toContain('Git 5'))
  expect(root.querySelector<HTMLButtonElement>('#git-proxy')!.disabled).toBe(false)
})
it('cancel removes panel without changing any settings; repeated open stays single', async () => {
  await open(); await open()
  expect(mocks.invoke.mock.calls).toHaveLength(1)
  root.querySelector<HTMLButtonElement>('.actions button[type=button]')!.click()
  expect(mocks.invoke.mock.calls).toHaveLength(1)
  await open(); expect(mocks.invoke.mock.calls).toHaveLength(2)
})
it('ignores a closed panel network read without replacing a newer panel', async () => {
  let resolve!: (value: unknown) => void
  mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const pending = open()
  root.querySelector<HTMLButtonElement>('.actions button[type=button]')!.click()
  await open(); const current = root
  resolve({ proxyUrl: 'http://old.example', username: 'old' }); await pending
  expect(root).toBe(current); expect(field('mode').value).toBe('system')
})
it('ignores Git completion after closing and reopening the panel', async () => {
  await open(); mode('company'); field('username').value = 'id'
  let resolve!: (value: unknown) => void
  mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done }))
  root.querySelector<HTMLButtonElement>('#git-proxy')!.click()
  root.querySelector<HTMLButtonElement>('.actions button[type=button]')!.click()
  await open(); resolve({ configured: true }); await new Promise(done => setTimeout(done, 0))
  expect(root.querySelector('#git-result')!.textContent).toBe('')
  expect(field('mode').value).toBe('system')
})
