// Browser-only PANGEA Desktop product affordances. Keep model configuration
// owned by DSH; this client only exposes the product entry point.
window.__ModuleLoader__.load({
  id: 'dsh-pangea-product',
  factory: () => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const BUTTON_ATTR = 'data-pangea-model-settings'
    const OPEN_EVENT = 'pangea:open-model-settings'

    function settingsIcon() {
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('width', '23')
      svg.setAttribute('height', '23')
      svg.setAttribute('fill', 'none')
      svg.setAttribute('stroke', 'currentColor')
      svg.setAttribute('stroke-width', '1.8')
      svg.setAttribute('stroke-linecap', 'round')
      svg.setAttribute('stroke-linejoin', 'round')
      svg.setAttribute('aria-hidden', 'true')
      const circle = document.createElementNS(ns, 'circle')
      circle.setAttribute('cx', '12')
      circle.setAttribute('cy', '12')
      circle.setAttribute('r', '3')
      const path = document.createElementNS(ns, 'path')
      path.setAttribute('d', 'M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.86 2.86-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.86-2.86.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06L7.06 3.8l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.86 2.86-.06.06A1.7 1.7 0 0 0 19.4 9c.12.39.33.74.6 1 .3.3.68.5 1.1.6h.1v4h-.1a1.7 1.7 0 0 0-1.7.4Z')
      svg.append(circle, path)
      return svg
    }

    function createSettingsButton() {
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute(BUTTON_ATTR, 'true')
      button.setAttribute('data-pangea-tool-button', 'true')
      button.setAttribute('aria-label', '设置')
      button.setAttribute('aria-haspopup', 'dialog')
      button.title = '设置'
      button.style.marginTop = '8px'

      const icon = document.createElement('span')
      icon.setAttribute('data-pangea-nav-icon', 'true')
      icon.appendChild(settingsIcon())
      const label = document.createElement('span')
      label.setAttribute('data-pangea-nav-label', 'true')
      label.textContent = '设置'
      button.append(icon, label)
      button.addEventListener('click', () => {
        window.dispatchEvent(new CustomEvent(OPEN_EVENT))
      })
      return button
    }

    function ensureSettingsButton() {
      const toolLists = document.querySelectorAll('[data-pangea-tool-list]')
      for (const toolList of toolLists) {
        if (toolList.querySelector(`[${BUTTON_ATTR}]`)) continue
        toolList.appendChild(createSettingsButton())
      }
    }

    function installSettingsEntry() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
      ensureSettingsButton()
      const observer = new MutationObserver(ensureSettingsButton)
      observer.observe(document.documentElement, { childList: true, subtree: true })
      return () => {
        observer.disconnect()
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) button.remove()
      }
    }

    function apply(ctx) {
      ctx.effect(installSettingsEntry, 'dsh-pangea-product: model settings entry')
    }

    exports.OPEN_EVENT = OPEN_EVENT
    exports.ensureSettingsButton = ensureSettingsButton
    exports.installSettingsEntry = installSettingsEntry
    exports.apply = apply
    return module.exports
  },
})
