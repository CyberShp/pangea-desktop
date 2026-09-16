// The workbench owns navigation; browser history can return to its boot page.
export function installHistoryNavigationGuard(target: Window): void {
  const preventSideButton = (event: MouseEvent): void => {
    if (event.button === 3 || event.button === 4) event.preventDefault()
  }
  for (const type of ['mousedown', 'mouseup', 'auxclick'] as const) {
    target.addEventListener(type, preventSideButton, { capture: true, passive: false })
  }
}
