import { ipcRenderer } from 'electron'

let panel: HTMLElement | undefined
const COMPANY_PROXY_URL = 'http://proxy.huawei.com:8080'
export async function openUpdateNetworkSettings(): Promise<void> {
  if (panel) return
  const previousFocus = document.activeElement as HTMLElement | null
  const host = document.createElement('div')
  host.id = 'dsh-desktop-update-network-root'
  panel = host
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0007;display:grid;place-items:center;font-family:system-ui,sans-serif'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    *{box-sizing:border-box}form{color:CanvasText;background:Canvas;color-scheme:light dark;width:min(480px,94vw);max-height:90vh;overflow:auto;padding:26px;border-radius:16px;box-shadow:0 16px 64px #0005}
    h2{margin:0 0 12px;font-size:20px}p{font-size:13px;line-height:1.6;opacity:.8}label{display:block;margin:14px 0;font-size:14px}input:not([type=checkbox]),select{display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #8887;border-radius:7px;background:Field;color:FieldText}button{padding:9px 15px;border:1px solid #8887;border-radius:8px;cursor:pointer}button[type=submit]{background:#2563eb;color:white;border-color:transparent}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.error{color:#dc4545;white-space:pre-wrap}input:focus-visible,button:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
  </style><form role="dialog" aria-modal="true" aria-labelledby="network-title">
    <h2 id="network-title">在线更新网络设置</h2>
    <label>更新源<select name="updateSource"><option value="github">GitHub</option><option value="intranet">内网</option></select></label>
    <label id="index-label" hidden>内网索引地址<input name="indexUrl" type="url" placeholder="https://更新服务/api/tools/工具ID/files/download?path=stable/windows/x64/latest.json" autocomplete="off"></label>
    <p id="source-note">选择内网后，版本检查和制品下载均使用内网服务。</p>
    <p>华为代理只需填写工号和密码，地址由程序配置。也可保留系统网络或已有自定义代理。</p>
    <label>网络模式<select name="mode"><option value="system">系统网络</option><option value="company">华为代理</option><option value="custom" hidden>保留已有自定义代理</option></select></label>
    <p id="proxy-summary"></p>
    <label>工号 / 代理账号<input name="username" autocomplete="off"></label>
    <label>代理密码<input name="password" type="password" autocomplete="off"></label>
    <p id="password-note">密码直接填写，无需手动转义。密码仅用于本次运行，重启后需重新填写。</p>
    <label><input name="skipCertificateCheck" type="checkbox"> 本次运行跳过更新服务器证书校验（排障）</label>
    <p>默认验证证书。跳过校验会降低连接安全性，但仍强制校验更新清单签名和安装包完整性；重启后恢复证书校验。</p>
    <button id="git-proxy" type="button">配置 Git 全局代理…</button>
    <p>Git 配置影响当前用户所有仓库，仅保存代理地址和工号；密码另由现有凭据管理器获取。在线更新连接成功不代表 Git 已连接。</p>
    <p id="git-result" role="status"></p><p class="error" role="alert"></p>
    <div class="actions"><button type="button">取消</button><button type="submit">保存并检查（不下载）</button></div>
  </form>`
  const form = root.querySelector('form')!
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  const error = root.querySelector<HTMLElement>('.error')!
  const save = root.querySelector<HTMLButtonElement>('[type=submit]')!
  save.disabled = true
  const close = () => { host.remove(); if (panel === host) { panel = undefined; previousFocus?.focus() } }
  root.querySelector('.actions button[type=button]')!.addEventListener('click', close)
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') {
      const controls = [...form.querySelectorAll<HTMLElement>('input:not(:disabled),select,button:not(:disabled)')]
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  })
  document.documentElement.append(host)
  let savedProxyUrl = ''
  let busy = false
  let loaded = false
  const mode = form.elements.namedItem('mode') as HTMLSelectElement
  const gitButton = root.querySelector<HTMLButtonElement>('#git-proxy')!
  const renderMode = () => {
    const system = mode.value === 'system'
    field('username').disabled = system; field('password').disabled = system
    gitButton.disabled = !loaded || busy || mode.value !== 'company'
    mode.disabled = !loaded || busy
    renderSource()
    root.querySelector('#proxy-summary')!.textContent = mode.value === 'company' ? `代理：${COMPANY_PROXY_URL}` : mode.value === 'custom' ? `保留已有代理：${savedProxyUrl}` : '沿用系统代理/PAC；不修改系统设置。'
  }
  const source = form.elements.namedItem('updateSource') as HTMLSelectElement
  const renderSource = () => {
    const intranet = source.value === 'intranet'
    root.querySelector<HTMLElement>('#index-label')!.hidden = !intranet
    field('indexUrl').required = intranet
    source.disabled = !loaded || busy
    field('indexUrl').disabled = !loaded || busy || !intranet
  }
  source.addEventListener('change', renderSource)
  mode.addEventListener('change', renderMode)
  gitButton.disabled = true
  gitButton.addEventListener('click', async () => {
    if (!loaded || busy || mode.value !== 'company') return
    busy = true; save.disabled = true; renderMode()
    const result = root.querySelector('#git-result')!
    result.textContent = ''
    try {
      const response = await ipcRenderer.invoke('updates:git-proxy', field('username').value)
      if (panel === host) result.textContent = response.configured ? 'Git 代理配置已写入并核对；连接与密码认证尚未验证。' : '已取消，未修改 Git 配置。'
    } catch (cause) {
      if (panel === host) result.textContent = cause instanceof Error ? cause.message : 'Git 配置失败。'
    } finally { busy = false; if (panel === host) { save.disabled = false; renderMode() } }
  })
  renderMode()
  mode.focus()
  try {
    const value = await ipcRenderer.invoke('updates:network-get')
    if (panel !== host) return
    loaded = true
    source.value = value.updateSource ?? 'github'
    field('indexUrl').value = value.indexUrl ?? ''
    savedProxyUrl = value.proxyUrl
    mode.value = !savedProxyUrl ? 'system' : savedProxyUrl === COMPANY_PROXY_URL ? 'company' : 'custom'
    if (mode.value === 'custom') mode.querySelector<HTMLOptionElement>('[value=custom]')!.hidden = false
    renderMode()
    field('username').value = value.username
    field('skipCertificateCheck').checked = value.skipCertificateCheck
    if (value.hasPassword) root.querySelector('#password-note')!.textContent = '本次运行已配置密码。保存时请重新填写密码，留空将清除现有密码。'
    save.disabled = false
  } catch { error.textContent = '无法读取网络设置，请关闭后重试。' }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (!loaded || busy) return
    busy = true; save.disabled = true; renderMode(); error.textContent = ''
    try {
      await ipcRenderer.invoke('updates:network-save', {
        updateSource: source.value, indexUrl: field('indexUrl').value,
        mode: mode.value, proxyUrl: mode.value === 'custom' ? savedProxyUrl : '', username: field('username').value,
        password: field('password').value, skipCertificateCheck: field('skipCertificateCheck').checked
      })
      field('password').value = ''
      close()
      await ipcRenderer.invoke('updates:check')
    } catch (cause) {
      busy = false
      if (panel === host) { renderMode(); error.textContent = cause instanceof Error ? cause.message : '保存失败：请检查更新源、工号，并等待当前更新操作结束后再试。'; save.disabled = false }
    }
  })
}
