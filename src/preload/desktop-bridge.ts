import type { UpdateStatus } from '../shared/contracts'

interface DesktopBridgeIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (...args: unknown[]) => void): unknown
}

export interface DshDesktopBridge {
  productWorkspace(): Promise<string>
  productWorkspaceReady(): Promise<{ ok: boolean }>
  restartHarness(): Promise<{ ok: boolean }>
  getUpdateStatus(): Promise<UpdateStatus>
  importUpdatePackage(): Promise<UpdateStatus>
  installUpdate(): Promise<void>
  subscribeUpdateStatus(listener: (status: UpdateStatus) => void): number
  unsubscribeUpdateStatus(subscriptionId: number): void
}

export function createDesktopBridge(ipc: DesktopBridgeIpc): Readonly<DshDesktopBridge> {
  let subscriptionSequence = 0
  const subscriptions = new Map<number, (...args: unknown[]) => void>()

  return Object.freeze({
    productWorkspace: (): Promise<string> =>
      ipc.invoke('pangea:product-workspace') as Promise<string>,
    productWorkspaceReady: (): Promise<{ ok: boolean }> =>
      ipc.invoke('pangea:product-workspace-ready') as Promise<{ ok: boolean }>,
    restartHarness: (): Promise<{ ok: boolean }> =>
      ipc.invoke('harness:restart') as Promise<{ ok: boolean }>,
    getUpdateStatus: (): Promise<UpdateStatus> =>
      ipc.invoke('updates:status') as Promise<UpdateStatus>,
    importUpdatePackage: (): Promise<UpdateStatus> =>
      ipc.invoke('updates:import') as Promise<UpdateStatus>,
    installUpdate: (): Promise<void> => ipc.invoke('updates:install') as Promise<void>,
    subscribeUpdateStatus: (listener: (status: UpdateStatus) => void): number => {
      if (typeof listener !== 'function') throw new TypeError('Update status listener must be a function.')
      const subscriptionId = ++subscriptionSequence
      const handleStatus = (_event: unknown, status: unknown): void => listener(status as UpdateStatus)
      subscriptions.set(subscriptionId, handleStatus)
      ipc.on('updates:status-changed', handleStatus)
      return subscriptionId
    },
    unsubscribeUpdateStatus: (subscriptionId: number): void => {
      const handleStatus = subscriptions.get(subscriptionId)
      if (!handleStatus) return
      subscriptions.delete(subscriptionId)
      ipc.removeListener('updates:status-changed', handleStatus)
    }
  })
}
