export type RuntimePhase =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'failed'

export interface RuntimeSnapshot {
  phase: RuntimePhase
  message: string
  launchDirectory?: string
  logs: string[]
  url?: string
}

export type UpdatePhase =
  | 'idle'
  | 'up-to-date'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'install-error'
  | 'error'
  | 'unsupported'

export interface UpdateReleaseNotes {
  features: string[]
  fixes: string[]
  notices: string[]
}

export interface UpdateStatus {
  releaseNotes?: UpdateReleaseNotes
  publishedAt?: string
  phase: UpdatePhase
  currentVersion: string
  source?: 'intranet'
  activity?: 'download' | 'verify'
  availableVersion?: string
  packageType?: 'full' | 'patch'
  packageName?: string
  baseVersion?: string
  networkSummary?: string
  packageSize?: number
  percent?: number
  message?: string
  manual: boolean
  canForceStop?: boolean
}

export interface UpdateInstallResult {
  helperLaunched: boolean
}
