import type { UpdateStatus } from '../../shared/contracts'

export type UpdateStateEvent =
  | { type: 'check'; manual: boolean }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string; packageType?: 'full' | 'patch'; baseVersion?: string }
  | { type: 'install-error'; message: string }
  | { type: 'restore-error'; version: string; message: string }
  | { type: 'error'; message: string }
  | { type: 'unsupported'; message: string }
  | { type: 'reset' }

export function initialUpdateStatus(currentVersion: string): UpdateStatus {
  return { phase: 'idle', currentVersion, manual: false }
}

export function reduceUpdateStatus(
  current: UpdateStatus,
  event: UpdateStateEvent
): UpdateStatus {
  const base = { currentVersion: current.currentVersion, manual: current.manual }

  switch (event.type) {
    case 'check':
      return { ...base, phase: 'checking', manual: event.manual }
    case 'progress':
      return { ...current, phase: 'downloading', percent: clampPercent(event.percent) }
    case 'downloaded':
      return {
        ...base,
        phase: 'downloaded',
        availableVersion: event.version,
        ...(event.packageType ? { packageType: event.packageType } : {}),
        ...(event.baseVersion ? { baseVersion: event.baseVersion } : {})
      }
    case 'install-error':
      return { ...current, phase: 'downloaded', message: event.message }
    case 'restore-error':
      return {
        ...base,
        phase: 'install-error',
        manual: true,
        availableVersion: event.version,
        message: event.message
      }
    case 'error':
      return { ...base, phase: 'error', message: event.message }
    case 'unsupported':
      return { ...base, phase: 'unsupported', message: event.message }
    case 'reset':
      return initialUpdateStatus(current.currentVersion)
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10
}
