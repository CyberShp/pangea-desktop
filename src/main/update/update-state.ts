import type { UpdateStatus } from '../../shared/contracts'

export type UpdateStateEvent =
  | { type: 'check'; manual: boolean; packageName?: string; source?: 'intranet' }
  | { type: 'up-to-date' }
  | { type: 'available'; version: string; packageSize: number; releaseNotes?: UpdateStatus['releaseNotes']; publishedAt?: string }
  | { type: 'release-info'; releaseNotes?: UpdateStatus['releaseNotes']; publishedAt?: string }
  | { type: 'network'; summary: string }
  | { type: 'online-download'; version: string; packageName: string }
  | { type: 'verify' }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string; packageType?: 'full' | 'patch'; baseVersion?: string }
  | { type: 'install-error'; message: string; canForceStop?: boolean }
  | { type: 'restore-error'; version: string; message: string }
  | { type: 'error'; message: string; packageType?: 'patch'; baseVersion?: string; availableVersion?: string }
  | { type: 'unsupported'; message: string }
  | { type: 'reset' }

export function initialUpdateStatus(currentVersion: string): UpdateStatus {
  return { phase: 'idle', currentVersion, manual: false }
}

export function reduceUpdateStatus(
  current: UpdateStatus,
  event: UpdateStateEvent
): UpdateStatus {
  const base = { currentVersion: current.currentVersion, manual: current.manual, ...(current.source ? { source: current.source } : {}), ...(current.networkSummary ? { networkSummary: current.networkSummary } : {}) }

  switch (event.type) {
    case 'check':
      return { ...base, phase: 'checking', manual: event.manual, source: event.source, networkSummary: undefined, ...(event.packageName ? { packageName: event.packageName } : {}) }
    case 'release-info':
      return { ...current, releaseNotes: event.releaseNotes, publishedAt: event.publishedAt }
    case 'network':
      return { ...current, networkSummary: event.summary }
    case 'available':
      return { ...base, phase: 'available', availableVersion: event.version, packageSize: event.packageSize, releaseNotes: event.releaseNotes, publishedAt: event.publishedAt }
    case 'up-to-date':
      return { ...base, phase: 'up-to-date' }
    case 'online-download':
      return { ...current, phase: 'downloading', activity: 'download', percent: 0, availableVersion: event.version, packageName: event.packageName }
    case 'verify':
      return { ...current, phase: 'downloading', activity: 'verify', percent: 0 }
    case 'progress':
      return { ...current, phase: 'downloading', percent: clampPercent(event.percent) }
    case 'downloaded':
      return {
        ...base,
        phase: 'downloaded',
        releaseNotes: current.releaseNotes, publishedAt: current.publishedAt,
        ...(current.packageName ? { packageName: current.packageName } : {}),
        availableVersion: event.version,
        ...(event.packageType ? { packageType: event.packageType } : {}),
        ...(event.baseVersion ? { baseVersion: event.baseVersion } : {})
      }
    case 'install-error':
      return { ...current, phase: 'downloaded', message: event.message, canForceStop: event.canForceStop === true }
    case 'restore-error':
      return {
        ...base,
        phase: 'install-error',
        manual: true,
        availableVersion: event.version,
        message: event.message
      }
    case 'error':
      return {
        ...base,
        phase: 'error',
        ...(current.packageName ? { packageName: current.packageName } : {}),
        message: event.message,
        ...(event.packageType ? { packageType: event.packageType } : {}),
        ...(event.baseVersion ? { baseVersion: event.baseVersion } : {}),
        ...(event.availableVersion ? { availableVersion: event.availableVersion } : {})
      }
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
