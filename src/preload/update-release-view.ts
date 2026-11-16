import type { UpdateStatus } from '../shared/contracts'
import { readReleaseNotes } from '../shared/update-release-notes'

type Actions = { claim(version: string): Promise<boolean>; download(): Promise<unknown> }
export function createUpdateReleaseView(actions: Actions) {
  let current: UpdateStatus | undefined
  let host: HTMLDivElement | undefined
  let modal: HTMLDialogElement | undefined
  let toast: HTMLDivElement | undefined
  let sequence = 0
  let previousFocus: HTMLElement | undefined
  const mounted = () => {
    if (host) return host.shadowRoot!
    host = document.createElement('div')
    host.id = 'pangea-update-release'
    const root = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
      :host {
        color-scheme: light;
        font: 14px/1.6 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
        color: #1d232a;
      }
      * { box-sizing: border-box; }
      button {
        font: inherit; font-size: 13px; font-weight: 500; line-height: 20px;
        min-height: 34px; cursor: pointer;
        border: 1px solid #d5dbe3; border-radius: 6px; padding: 6px 14px;
        background: #ffffff; color: #1d232a;
        transition: background .15s ease, border-color .15s ease, color .15s ease;
      }
      button:hover:not(:disabled) { background: #f3f5f8; border-color: #c1c9d4; }
      button:disabled { opacity: .55; cursor: default; }
      button:focus-visible { outline: 2px solid #b62836; outline-offset: 2px; }
      .primary { background: #b62836; border-color: #b62836; color: #ffffff; font-weight: 600; }
      .primary:hover:not(:disabled) { background: #981f2b; border-color: #981f2b; }
      dialog {
        width: min(560px, calc(100vw - 40px)); max-height: 80vh;
        border: 1px solid #e2e6ec; border-radius: 12px; padding: 24px 28px;
        color: #1d232a; background: #ffffff;
        box-shadow: 0 20px 64px rgba(15, 23, 42, .22);
      }
      dialog::backdrop { background: rgba(17, 27, 40, .32); backdrop-filter: blur(2px); }
      h2 { margin: 0 0 4px; font-size: 20px; font-weight: 650; line-height: 1.4; color: #1d232a; }
      .date { color: #5e6773; font-size: 12px; margin: 0 0 18px; }
      .notes {
        max-height: 48vh; overflow: auto; overflow-wrap: anywhere;
        padding: 4px 0; border-top: 1px solid #eef1f5;
      }
      h3 {
        font-size: 13px; font-weight: 650; color: #1d232a;
        margin: 16px 0 8px; display: flex; align-items: center; gap: 6px;
      }
      h3::before { content: ""; width: 3px; height: 13px; border-radius: 2px; background: #b62836; }
      ul { padding-left: 18px; margin: 0; color: #333b45; font-size: 13px; line-height: 1.7; }
      li { margin: 6px 0; white-space: pre-wrap; }
      footer {
        display: flex; justify-content: flex-end; align-items: center; gap: 10px;
        padding-top: 18px; margin-top: 18px; border-top: 1px solid #e2e6ec;
      }
      .error { color: #b62836; font-size: 12px; margin: 10px 0 0; }
      .error:empty { display: none; }
      .toast {
        position: fixed; top: 66px; right: 24px; z-index: 2147483646;
        max-width: calc(100vw - 48px);
        display: flex; align-items: center; gap: 10px;
        padding: 10px 14px; border: 1px solid #e2e6ec; border-left: 3px solid #b62836;
        border-radius: 10px; background: #ffffff; color: #1d232a;
        box-shadow: 0 10px 30px rgba(15, 23, 42, .12);
      }
      .toast > span { font-size: 13px; font-weight: 600; margin-right: 4px; }
      .toast button[aria-label="关闭更新提醒"] {
        min-height: 28px; width: 28px; padding: 0; border-color: transparent;
        background: transparent; color: #5e6773; font-size: 16px;
      }
      .toast button[aria-label="关闭更新提醒"]:hover { background: #f1f3f6; color: #1d232a; }
    `
    root.append(style)
    document.documentElement.append(host)
    return root
  }
  const close = () => {
    modal?.close(); modal?.remove(); modal = undefined
    if (previousFocus?.isConnected) previousFocus.focus()
    previousFocus = undefined
  }
  const clearToast = () => { toast?.remove(); toast = undefined }
  const button = (label: string, action: () => void, primary = false) => {
    const node = document.createElement('button'); node.type = 'button'; node.textContent = label
    if (primary) node.className = 'primary'
    node.addEventListener('click', action); return node
  }
  const open = (status = current) => {
    if (!status?.availableVersion || status.source !== 'intranet' || !['available', 'downloaded'].includes(status.phase)) return
    clearToast()
    if (modal?.open) { modal.focus(); return }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const dialog = document.createElement('dialog'); modal = dialog
    dialog.setAttribute('aria-labelledby', 'release-title')
    const title = document.createElement('h2'); title.id = 'release-title'; title.textContent = `发现新版本 v${status.availableVersion}`
    dialog.append(title)
    if (status.publishedAt && Number.isFinite(Date.parse(status.publishedAt))) {
      const date = document.createElement('p'); date.className = 'date'; date.textContent = `发布时间：${new Date(status.publishedAt).toLocaleDateString('zh-CN')}`; dialog.append(date)
    }
    const body = document.createElement('div'); body.className = 'notes'
    const notes = readReleaseNotes(status.releaseNotes)
    if (!notes) { const empty = document.createElement('p'); empty.textContent = '此版本未提供更新说明。'; body.append(empty) }
    for (const [key, label] of [['features', '新增功能'], ['fixes', '问题修复'], ['notices', '升级注意事项']] as const) {
      if (!notes?.[key].length) continue
      const heading = document.createElement('h3'); heading.textContent = label
      const list = document.createElement('ul')
      for (const text of notes[key]) { const item = document.createElement('li'); item.textContent = text; list.append(item) }
      body.append(heading, list)
    }
    const footer = document.createElement('footer')
    footer.append(button('稍后再说', close))
    if (status.phase === 'available') {
      const download = button('下载更新', () => {
        download.disabled = true
        void actions.download().then(close).catch(() => {
          download.disabled = false
          error.textContent = '下载未能开始，请重试。'
        })
      }, true)
      footer.append(download)
    }
    const error = document.createElement('p'); error.className = 'error'; error.setAttribute('role', 'alert')
    dialog.append(body, error, footer)
    dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
    mounted().append(dialog); dialog.showModal()
  }
  return {
    open,
    async update(status: UpdateStatus) {
      const prior = current; current = status
      if (status.phase === 'available' && prior?.phase === 'available' && prior.availableVersion === status.availableVersion && prior.manual === status.manual) return
      const request = ++sequence
      if (status.phase !== 'available') { clearToast(); close(); return }
      if (status.manual) {
        if (prior?.phase !== 'available' || prior.availableVersion !== status.availableVersion || !prior.manual) open(status)
        return
      }
      if (!status.availableVersion || !await actions.claim(status.availableVersion) || request !== sequence) return
      clearToast()
      toast = document.createElement('div'); toast.className = 'toast'; toast.setAttribute('role', 'status')
      const label = document.createElement('span'); label.textContent = `发现 v${status.availableVersion}`
      const dismiss = button('×', clearToast); dismiss.setAttribute('aria-label', '关闭更新提醒')
      toast.append(label, button('查看更新', () => open(status)), dismiss)
      mounted().append(toast)
    }
  }
}
