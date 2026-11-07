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
      :host { font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color-scheme:light dark }
      * { box-sizing:border-box } button { font:inherit; cursor:pointer; border:1px solid #cbd5e1; border-radius:9px; padding:8px 16px; background:Canvas; color:CanvasText }
      button:focus-visible { outline:3px solid #818cf8; outline-offset:2px }
      .primary { background:#4f46e5; border-color:#4f46e5; color:white }
      dialog { width:min(560px,calc(100vw - 40px)); max-height:80vh; border:1px solid #94a3b866; border-radius:18px; padding:28px; color:CanvasText; background:Canvas; box-shadow:0 24px 80px #0004 }
      dialog::backdrop { background:#0f172a66 } h2 { margin:0 0 4px; font-size:22px } .date { opacity:.65; margin:0 0 20px }
      .notes { max-height:48vh; overflow:auto; overflow-wrap:anywhere } h3 { font-size:14px; margin:18px 0 8px } ul { padding-left:20px; margin:0 } li { margin:7px 0; white-space:pre-wrap }
      footer { display:flex; justify-content:flex-end; gap:10px; padding-top:24px } .error { color:#dc2626 }
      .toast { position:fixed; top:24px; right:24px; z-index:2147483646; max-width:calc(100vw - 48px); display:flex; align-items:center; gap:14px; padding:14px 18px; border:1px solid #94a3b866; border-radius:12px; background:Canvas; color:CanvasText; box-shadow:0 8px 32px #0002 }
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
