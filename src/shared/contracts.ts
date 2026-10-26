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
  | 'downloading'
  | 'downloaded'
  | 'install-error'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  phase: UpdatePhase
  currentVersion: string
  source?: 'github'
  activity?: 'download' | 'verify'
  availableVersion?: string
  packageType?: 'full' | 'patch'
  packageName?: string
  baseVersion?: string
  percent?: number
  message?: string
  manual: boolean
  canForceStop?: boolean
}

export interface UpdateInstallResult {
  helperLaunched: boolean
}
