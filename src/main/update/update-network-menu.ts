interface UpdateNetworkWindow {
  isDestroyed(): boolean
  webContents: { send(channel: string): void }
}

/** This focused-window shortcut only opens the dialog; it never checks updates. */
export function createUpdateNetworkMenuItem(
  isChinese: boolean,
  getWindow: () => UpdateNetworkWindow | undefined
) {
  return {
    label: isChinese ? '在线更新网络设置…' : 'Update Network Settings…',
    accelerator: 'CmdOrCtrl+Alt+N',
    click: (): void => {
      const window = getWindow()
      if (window && !window.isDestroyed()) window.webContents.send('updates:network-open')
    }
  }
}
