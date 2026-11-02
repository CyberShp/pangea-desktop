import { describe, expect, it, vi } from 'vitest'
import { configureGlobalGitProxy, enterpriseGitProxyUrl, type GitConfigResult } from '../src/main/update/git-proxy'

const missing = { code: 1, stdout: '' }
const value = (text: string): GitConfigResult => ({ code: 0, stdout: `${text}\0` })
const success = { code: 0, stdout: '' }
function runner(...results: GitConfigResult[]) {
  return vi.fn(async (_args: string[]) => {
    const result = results.shift()
    if (!result) throw new Error('Unexpected Git invocation')
    return result
  })
}

describe('explicit global Git enterprise proxy configuration', () => {
  it('encodes the raw username exactly once without accepting a password', () => {
    expect(enterpriseGitProxyUrl('a@b:%20/\\')).toBe('http://a%40b%3A%2520%2F%5C@proxy.huawei.com:8080')
  })
  it.each(['', '  ', 'a\rb', 'a\nb', 'a\0b', null, 5, '\ud800'])('rejects invalid account before invoking Git: %j', async username => {
    const run = runner()
    await expect(configureGlobalGitProxy(username, async () => true, run)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('cancellation never writes and never exposes previous credentials to the dialog', async () => {
    const run = runner(value('http://old:very-secret@proxy.example'))
    const confirm = vi.fn(async () => false)
    expect(await configureGlobalGitProxy('employee', confirm, run)).toEqual({ configured: false })
    expect(confirm).toHaveBeenCalledWith({ proxyUrl: enterpriseGitProxyUrl('employee'), hasExistingProxy: true })
    expect(run).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(confirm.mock.calls)).not.toContain('very-secret')
  })
  it('confirms, checks for intervening changes, writes a password-free value and verifies it', async () => {
    const url = enterpriseGitProxyUrl('a@b')
    const run = runner(missing, missing, success, value(url))
    expect(await configureGlobalGitProxy('a@b', async () => true, run)).toEqual({ configured: true, proxyUrl: url })
    expect(run.mock.calls[2]![0]).toEqual(['config', '--global', '--replace-all', 'http.proxy', url])
    expect(run).toHaveBeenCalledTimes(4)
  })
  it('refuses ambiguous duplicate configuration', async () => {
    const confirm = vi.fn(async () => true)
    const run = runner({ code: 0, stdout: 'one\0two\0' })
    await expect(configureGlobalGitProxy('u', confirm, run)).rejects.toThrow('多个')
    expect(confirm).not.toHaveBeenCalled()
  })
  it('does not overwrite a change made during confirmation', async () => {
    const run = runner(missing, value('http://other'))
    await expect(configureGlobalGitProxy('u', async () => true, run)).rejects.toThrow('未覆盖')
    expect(run).toHaveBeenCalledTimes(2)
  })
  it('reports write failure without echoing Git output or claiming success', async () => {
    const run = runner(missing, missing, { code: 4, stdout: 'secret-password' })
    await expect(configureGlobalGitProxy('u', async () => true, run)).rejects.toThrow('写入全局代理配置失败（Git 4）')
    expect(run).toHaveBeenCalledTimes(3)
  })
  it('reports a missing Git executable safely', async () => {
    await expect(configureGlobalGitProxy('u', async () => true, runner({ code: 'ENOENT', stdout: '' }))).rejects.toThrow('ENOENT')
  })
  it.each([value('http://unexpected'), { code: 2, stdout: 'private diagnostic' }])('never claims success after failed verification', async readback => {
    const run = runner(missing, missing, success, readback)
    await expect(configureGlobalGitProxy('u', async () => true, run)).rejects.toThrow('已写入，但回读验证失败')
  })
  it('rejects a repeated operation while the confirmation is pending', async () => {
    let finish!: (value: boolean) => void
    const pending = configureGlobalGitProxy('u', () => new Promise(resolve => { finish = resolve }), runner(missing))
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await expect(configureGlobalGitProxy('u', async () => true, runner())).rejects.toThrow('正在配置')
    finish(false)
    await pending
  })
})
