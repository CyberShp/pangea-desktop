import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

const PENDING_STATES = new Set([
  'preparing', 'candidate_ready', 'original_move_pending', 'original_moved',
  'activate_pending', 'activated', 'rollback_pending', 'rollback_displaced'
])

export interface PendingPortableTransaction {
  journalPath: string
  planPath: string
  installRoot: string
  state: string
  plan: Record<string, unknown>
  healthMarker?: string
  targetVersion: string
  newVersionStarted: boolean
  workerPid?: number
  workerStartedAt?: string
}

function equalPath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function portableTransactionLocation(installRoot: string): Promise<{ installRoot: string; journalPath: string }> {
  const supplied = resolve(installRoot)
  const parent = await realpath(dirname(supplied))
  const canonical = join(parent, basename(supplied))
  const hash = createHash('sha256').update(canonical.toLowerCase(), 'utf8').digest('hex')
  return { installRoot: canonical, journalPath: join(parent, `.pangea-update-${hash}.json`) }
}

/** Read only. The independent helper revalidates and locks before any mutation. */
export async function readPendingPortableTransaction(
  installRoot: string,
  userData: string
): Promise<PendingPortableTransaction | undefined> {
  const location = await portableTransactionLocation(installRoot)
  let serialized: string
  try {
    const info = await lstat(location.journalPath)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('升级事务记录类型或大小无效。')
    serialized = await readFile(location.journalPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const record = JSON.parse(serialized.replace(/^\uFEFF/, ''))
  if (record.schema_version !== 1 || typeof record.install_root !== 'string' || !isAbsolute(record.install_root)
    || !equalPath(resolve(record.install_root), location.installRoot)) throw new Error('升级事务记录与当前安装目录不匹配。')
  if (['committed', 'restored'].includes(record.state)) return undefined
  if (!PENDING_STATES.has(record.state) || typeof record.plan_path !== 'string' || !isAbsolute(record.plan_path)
    || typeof record.target_version !== 'string' || !record.target_version) throw new Error('无法识别未完成的升级事务，请保留备份并查看升级日志。')
  const updates = await realpath(join(userData, 'updates'))
  if ((await lstat(record.plan_path)).isSymbolicLink()) throw new Error('升级恢复计划不能是符号链接。')
  const planPath = await realpath(record.plan_path)
  const child = relative(updates, planPath)
  if (!child || child.startsWith('..') || isAbsolute(child)) throw new Error('升级恢复计划不在当前用户的升级目录中。')
  const info = await lstat(planPath)
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('升级恢复计划类型或大小无效。')
  const plan = JSON.parse((await readFile(planPath, 'utf8')).replace(/^\uFEFF/, ''))
  if (![1, 2].includes(plan.schema_version) || typeof plan.install_root !== 'string'
    || !equalPath(resolve(plan.install_root), location.installRoot)
    || plan.expected_version !== record.target_version) throw new Error('升级恢复计划与事务记录不匹配。')
  let healthMarker: string | undefined
  if (typeof plan.health_marker === 'string') {
    if (!isAbsolute(plan.health_marker)) throw new Error('升级健康标记必须是绝对路径。')
    const markerParent = await realpath(dirname(plan.health_marker))
    healthMarker = join(markerParent, basename(plan.health_marker))
    const markerChild = relative(updates, healthMarker)
    if (!markerChild || markerChild.startsWith('..') || isAbsolute(markerChild)) throw new Error('升级健康标记不在当前用户的升级目录中。')
  }
  return {
    ...location, planPath, state: record.state, plan, healthMarker,
    targetVersion: record.target_version,
    newVersionStarted: record.new_version_started === true,
    workerPid: Number.isSafeInteger(record.worker_pid) && record.worker_pid > 0 ? record.worker_pid : undefined,
    workerStartedAt: typeof record.worker_started_at === 'string' ? record.worker_started_at : undefined
  }
}

export interface PortableHealthLaunchIdentity {
  workerPid: number
  workerStartedAt: string
  parentPid: number
  executable: string
}

const execFileAsync = promisify(execFile)
async function inspectPortableHealthLaunch(workerPid: number): Promise<PortableHealthLaunchIdentity> {
  // The updater creates Desktop directly with CreateProcessW. Match both the
  // live worker's creation time and this child's actual parent, not a reused PID.
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); $worker=Get-Process -Id ${workerPid} -ErrorAction Stop; $child=Get-CimInstance Win32_Process -Filter 'ProcessId = ${process.pid}' -ErrorAction Stop; if (-not $child) { throw 'Desktop identity unavailable' }; @{workerPid=$worker.Id; workerStartedAt=$worker.StartTime.ToUniversalTime().ToString('o'); parentPid=[int]$child.ParentProcessId; executable=[string]$child.ExecutablePath} | ConvertTo-Json -Compress`
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
  ], { windowsHide: true, timeout: 10_000, maxBuffer: 64 * 1024,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')) })
  return JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as PortableHealthLaunchIdentity
}

/** A command-line marker alone never bypasses interrupted-transaction recovery. */
export async function isAuthorizedPortableHealthLaunch(
  pending: PendingPortableTransaction,
  marker: string | undefined,
  version: string,
  inspect: (workerPid: number) => Promise<PortableHealthLaunchIdentity> = inspectPortableHealthLaunch
): Promise<boolean> {
  if (!marker || !pending.healthMarker || pending.state !== 'activated' || !pending.newVersionStarted
    || version !== pending.targetVersion || !pending.workerPid || !pending.workerStartedAt
    || !equalPath(resolve(marker), pending.healthMarker)) return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/.test(pending.workerStartedAt)) return false
  try {
    const identity = await inspect(pending.workerPid)
    return identity.workerPid === pending.workerPid && identity.parentPid === pending.workerPid
      && identity.workerStartedAt === pending.workerStartedAt
      && typeof identity.executable === 'string' && equalPath(resolve(identity.executable), resolve(process.execPath))
  } catch { return false }
}
