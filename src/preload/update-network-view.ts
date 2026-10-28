import { ipcRenderer } from 'electron'

let panel: HTMLElement | undefined
export async function openUpdateNetworkSettings(): Promise<void> {
  if (panel) return
  const previousFocus = document.activeElement as HTMLElement | null
  const host = document.createElement('div')
  panel = host
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#0007;display:grid;place-items:center;font-family:system-ui,sans-serif'
  const root = host.attachShadow({ mode: 'closed' })
  root.innerHTML = `<style>
    *{box-sizing:border-box}form{color:CanvasText;background:Canvas;color-scheme:light dark;width:min(480px,94vw);max-height:90vh;overflow:auto;padding:26px;border-radius:16px;box-shadow:0 16px 64px #0005}
    h2{margin:0 0 12px;font-size:20px}p{font-size:13px;line-height:1.6;opacity:.8}label{display:block;margin:14px 0;font-size:14px}input:not([type=checkbox]){display:block;width:100%;margin-top:6px;padding:10px;border:1px solid #8887;border-radius:7px;background:Field;color:FieldText}button{padding:9px 15px;border:1px solid #8887;border-radius:8px;cursor:pointer}button[type=submit]{background:#2563eb;color:white;border-color:transparent}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:20px}.error{color:#dc4545;white-space:pre-wrap}input:focus-visible,button:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
  </style><form role="dialog" aria-modal="true" aria-labelledby="network-title">
    <h2 id="network-title">在线更新网络设置</h2>
    <p>默认使用系统网络配置，通常无需填写代理或密码。仅在系统网络无法连接或明确要求代理认证时配置下列内容。</p>
    <label>代理地址<input name="proxyUrl" type="password" autocomplete="off" placeholder="http://主机:端口 或 http://工号:密码@主机:端口"></label>
    <label>代理账号<input name="username" autocomplete="off"></label>
    <label>代理密码<input name="password" type="password" autocomplete="off"></label>
    <p id="password-note">也可在代理地址中填写账号密码；特殊字符需百分号编码。密码仅用于本次运行，重启后需重新填写。</p>
    <label><input name="skipCertificateCheck" type="checkbox"> 本次运行跳过更新服务器证书校验（排障）</label>
    <p>默认验证证书。跳过校验会降低连接安全性，但仍强制校验更新清单签名和安装包完整性；重启后恢复证书校验。</p>
    <p class="error" role="alert"></p>
    <div class="actions"><button type="button">取消</button><button type="submit">保存并检查（不下载）</button></div>
  </form>`
  const form = root.querySelector('form')!
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement
  const error = root.querySelector<HTMLElement>('.error')!
  const save = root.querySelector<HTMLButtonElement>('[type=submit]')!
  save.disabled = true
  const close = () => { host.remove(); panel = undefined; previousFocus?.focus() }
  root.querySelector('button[type=button]')!.addEventListener('click', close)
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); close() }
    if (event.key === 'Tab') {
      const controls = [...form.querySelectorAll<HTMLElement>('input,button:not(:disabled)')]
      const first = controls[0], last = controls[controls.length - 1]
      if (event.shiftKey && root.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && root.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  })
  document.documentElement.append(host)
  field('proxyUrl').focus()
  try {
    const value = await ipcRenderer.invoke('updates:network-get')
    if (panel !== host) return
    field('proxyUrl').value = value.proxyUrl
    field('username').value = value.username
    field('skipCertificateCheck').checked = value.skipCertificateCheck
    if (value.hasPassword) root.querySelector('#password-note')!.textContent = '本次运行已配置密码。保存时请重新填写密码，留空将清除现有密码。'
    save.disabled = false
  } catch { error.textContent = '无法读取网络设置，请关闭后重试。' }
  form.addEventListener('submit', async event => {
    event.preventDefault(); save.disabled = true; error.textContent = ''
    try {
      await ipcRenderer.invoke('updates:network-save', {
        proxyUrl: field('proxyUrl').value, username: field('username').value,
        password: field('password').value, skipCertificateCheck: field('skipCertificateCheck').checked
      })
      field('proxyUrl').value = ''; field('password').value = ''
      close()
      await ipcRenderer.invoke('updates:check')
    } catch {
      if (panel === host) { error.textContent = '保存失败：请检查代理 URL 格式，并等待当前更新操作结束后再试。'; save.disabled = false }
    }
  })
}
