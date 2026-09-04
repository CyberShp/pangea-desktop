import { describe, expect, it, vi } from 'vitest'
import type { UpdateStatus } from '../src/shared/contracts'
import { createDesktopBridge } from '../src/preload/desktop-bridge'

function fakeIpc() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'updates:status') {
      return { phase: 'idle', currentVersion: '0.1.9', manual: false } satisfies UpdateStatus
    }
    if (channel === 'updates:import') {
      return {
        phase: 'downloaded', currentVersion: '0.1.9', availableVersion: '0.1.10',
        packageType: 'patch', baseVersion: '0.1.9', manual: true
      } satisfies UpdateStatus
    }
    return { ok: true }
  })
  return {
    invoke,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const channelListeners = listeners.get(channel) ?? new Set()
      channelListeners.add(listener)
      listeners.set(channel, channelListeners)
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      listeners.get(channel)?.delete(listener)
    }),
    emit(channel: string, value: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener({}, value)
    }
  }
}

describe('PANGEA Desktop renderer bridge', () => {
  it('routes settings actions to the portable update handlers', async () => {
    const ipc = fakeIpc()
    const bridge = createDesktopBridge(ipc)

    await expect(bridge.getUpdateStatus()).resolves.toMatchObject({ currentVersion: '0.1.9' })
    await expect(bridge.importUpdatePackage()).resolves.toMatchObject({
      phase: 'downloaded', packageType: 'patch', baseVersion: '0.1.9'
    })
    await bridge.installUpdate()

    expect(ipc.invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'updates:status', 'updates:import', 'updates:install'
    ])
  })

  it('delivers update progress and removes the exact subscription', () => {
    const ipc = fakeIpc()
    const bridge = createDesktopBridge(ipc)
    const listener = vi.fn()
    const subscriptionId = bridge.subscribeUpdateStatus(listener)
    const progress: UpdateStatus = {
      phase: 'downloading', currentVersion: '0.1.9', availableVersion: '0.1.10',
      percent: 48, manual: true
    }

    ipc.emit('updates:status-changed', progress)
    expect(listener).toHaveBeenCalledWith(progress)
    bridge.unsubscribeUpdateStatus(subscriptionId)
    ipc.emit('updates:status-changed', { ...progress, percent: 80 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(ipc.removeListener).toHaveBeenCalledOnce()
  })
})
