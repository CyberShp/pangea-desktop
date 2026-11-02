import { execFile } from 'node:child_process'

export interface GitConfigResult { code: number | string; stdout: string }
export type GitConfigRunner = (args: string[]) => Promise<GitConfigResult>
export interface GitProxyConfirmation { proxyUrl: string; hasExistingProxy: boolean }

// Only configuration commands are allowed here. Never pass passwords to Git,
// invoke a credential helper, or return Git output (which may contain secrets).
const runGit: GitConfigRunner = args => new Promise(resolve => {
  execFile('git', args, { encoding: 'utf8', windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024, shell: false },
    (error, stdout) => resolve({ code: error ? error.code ?? 'FAILED' : 0, stdout }))
})

export function enterpriseGitProxyUrl(username: unknown): string {
  if (typeof username !== 'string' || !username.trim() || /[\r\n\0]/.test(username)) {
    throw new Error('请填写有效工号，不能包含换行或空字符。')
  }
  try {
    return `http://${encodeURIComponent(username).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}@proxy.huawei.com:8080`
  } catch { throw new Error('工号包含无法编码的字符。') }
}

function failure(stage: string, code: number | string): Error {
  const safeCode = typeof code === 'number' ? String(code) : /^[A-Z_]{1,40}$/.test(code) ? code : 'FAILED'
  return new Error(`${stage}失败（Git ${safeCode}）；请检查 Git 是否安装及当前用户配置文件的访问权限。`)
}

async function readProxy(runner: GitConfigRunner): Promise<string | undefined> {
  const result = await runner(['config', '--global', '--no-includes', '--null', '--get-all', 'http.proxy'])
  if (result.code === 1 && !result.stdout) return undefined
  if (result.code !== 0) throw failure('读取全局代理配置', result.code)
  const values = result.stdout.split('\0')
  if (values.at(-1) === '') values.pop()
  if (values.length !== 1) throw new Error('全局 http.proxy 存在多个配置值，请先整理重复配置；未修改 Git。')
  return values[0]
}

let configuring = false
export async function configureGlobalGitProxy(
  username: unknown,
  confirm: (details: GitProxyConfirmation) => Promise<boolean>,
  runner: GitConfigRunner = runGit
): Promise<{ configured: boolean; proxyUrl?: string }> {
  const proxyUrl = enterpriseGitProxyUrl(username)
  if (configuring) throw new Error('正在配置 Git 代理，请等待当前操作结束。')
  configuring = true
  try {
    const previous = await readProxy(runner)
    if (!await confirm({ proxyUrl, hasExistingProxy: previous !== undefined })) return { configured: false }
    if (await readProxy(runner) !== previous) throw new Error('确认期间 Git 全局代理已被其他程序更改，未覆盖；请重新确认。')
    const result = await runner(['config', '--global', '--replace-all', 'http.proxy', proxyUrl])
    if (result.code !== 0) throw failure('写入全局代理配置', result.code)
    try {
      if (await readProxy(runner) !== proxyUrl) throw new Error('回读值不一致。')
    } catch {
      throw new Error('Git 全局代理已写入，但回读验证失败；配置可能已改变，请检查后重试。未验证 Git 网络连接。')
    }
    return { configured: true, proxyUrl }
  } finally { configuring = false }
}
