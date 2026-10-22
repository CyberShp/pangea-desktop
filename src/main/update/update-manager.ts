import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, net, type OpenDialogOptions } from 'electron'
import type { UpdateInstallResult, UpdateStatus } from '../../shared/contracts'
import { stagePortablePackage, type StagedPortablePackage } from './portable-package-validator'
import { isPortablePatchArchive, PortablePatchBaseVersionMismatch, stagePortablePatch, type StagedPortablePatch } from './portable-patch-validator'
import { GitHubUpdateClient } from './github-update'
import { assertSupportedPortableUpgradeSource } from './portable-update'
import type { PortableUpdateConfig } from './portable-update'
import { initialUpdateStatus, reduceUpdateStatus, type UpdateStateEvent } from './update-state'
import { launchPortableHelper } from './launch-portable-helper'
import { stageUpdateHelper } from './stage-update-helper'
import { canImportPortableUpdate } from './update-capability'
import { isAuthorizedPortableHealthLaunch, readPendingPortableTransaction } from './portable-update-recovery'

interface LoadedUpdateConfig {
  publicKeyPem: string
}

interface PortableUpdateResult {
  schema_version: 1
  status: 'success' | 'failed'
  version: string
  message?: string
  rollback?: 'restored' | 'not_needed' | 'failed' | 'unknown'
  log_path?: string
}

const LAST_UPDATE_RESULT = 'last-update-result.json'

let status = initialUpdateStatus(app.getVersion())
type ReleaseUpdateAdmission = () => Promise<void>
let prepareToInstall: (() => Promise<void | ReleaseUpdateAdmission>) | undefined
let handlersRegistered = false
let onlineController: AbortController | undefined
let startupTimer: ReturnType<typeof setTimeout> | undefined
let importing = false
let installing = false
let loadedConfig: LoadedUpdateConfig | undefined
type StagedImport = StagedPortablePackage | StagedPortablePatch

let stagedPackage: StagedImport | undefined
let stagedRoot: string | undefined

export function getUpdateStatus(): UpdateStatus {
  return { ...status }
}

export function registerUpdateHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle('updates:status', () => getUpdateStatus())
  ipcMain.handle('updates:check', () => checkForOnlineUpdate(true))
  ipcMain.handle('updates:import', () => importPortableUpdatePackage())
  ipcMain.handle('updates:install', () => installImportedUpdate())
}

export function startUpdateManager(options: { prepareToInstall: () => Promise<void | ReleaseUpdateAdmission> }): void {
  prepareToInstall = options.prepareToInstall
  loadedConfig = loadUpdateConfig()
  restoreLastUpdateFailure()
  if (startupTimer) clearTimeout(startupTimer)
  if (loadedConfig && app.isPackaged && process.platform === 'win32' && process.arch === 'x64' && status.phase !== 'install-error') {
    startupTimer = setTimeout(() => { void checkForOnlineUpdate(false) }, 15_000)
    startupTimer.unref()
  }
}

/** Download and local import share a single staging/install lock and trust boundary. */
export async function checkForOnlineUpdate(manual = true): Promise<UpdateStatus> {
  if (importing || installing) return getUpdateStatus()
  if (status.phase === 'downloaded' && stagedPackage) {
    // Explicit checking also reopens a previously dismissed ready card.
    const ready = getUpdateStatus()
    transition({ type: 'check', manual, source: 'github' })
    transition({ type: 'downloaded', version: ready.availableVersion!, packageType: ready.packageType, baseVersion: ready.baseVersion })
    return getUpdateStatus()
  }
  if (!canImportPortableUpdate(app.isPackaged, process.platform) || process.arch !== 'x64') {
    transition({ type: 'unsupported', message: '在线升级仅支持已打包的 Windows x64 版本。' }, manual)
    return getUpdateStatus()
  }
  const config = loadedConfig ?? loadUpdateConfig()
  if (!config) {
    transition({ type: 'unsupported', message: '当前版本未配置升级包校验密钥。' }, manual)
    return getUpdateStatus()
  }
  importing = true
  const controller = new AbortController()
  onlineController = controller
  transition({ type: 'check', manual, source: 'github' })
  try {
    assertSupportedPortableUpgradeSource(app.getVersion())
    const client = new GitHubUpdateClient((url, init) => net.fetch(url, init), controller.signal)
    const update = await client.check(app.getVersion(), config.publicKeyPem)
    if (!update) {
      transition({ type: 'up-to-date' })
      return getUpdateStatus()
    }
    await clearStagedPackage()
    const updatesRoot = join(app.getPath('userData'), 'updates')
    await mkdir(updatesRoot, { recursive: true })
    const root = await mkdtemp(join(updatesRoot, 'online-'))
    stagedRoot = root
    const sourcePath = join(root, 'download.zip')
    transition({ type: 'online-download', version: update.version, packageName: update.asset.name })
    await client.download(update, sourcePath, percent => transition({ type: 'progress', percent }))
    transition({ type: 'verify' })
    const staged = await stagePortablePackage({
      sourcePath, destinationPath: join(root, 'pangea-desktop.zip'),
      publicKeyPem: config.publicKeyPem, currentVersion: app.getVersion(),
      onProgress: percent => transition({ type: 'progress', percent })
    })
    if (staged.manifest.version !== update.version || staged.packageSha256 !== update.sha256 || staged.packageSize !== update.asset.size) {
      throw new Error('已验证的升级包与锁定的 Release 不一致。')
    }
    await rm(sourcePath, { force: true })
    stagedPackage = staged
    transition({ type: 'downloaded', version: staged.manifest.version, packageType: 'full' })
  } catch (error) {
    try { await clearStagedPackage() }
    catch (cleanupError) { console.warn('[portable-updater] staging cleanup failed', cleanupError) }
    transition({ type: 'error', message: controller.signal.aborted ? '在线更新已取消。' : errorMessage(error) }, manual)
  } finally {
    onlineController = undefined
    importing = false
  }
  return getUpdateStatus()
}

/** Run before profile/workspace migration, so a normal launch cannot alter an
 * interrupted transaction's shared data. Only the live updater's verified child
 * can proceed while a new version is awaiting its health confirmation. */
export async function handleInterruptedPortableUpdate(healthMarker?: string): Promise<boolean> {
  if (!app.isPackaged || process.platform !== 'win32') return false
  const pending = await readPendingPortableTransaction(dirname(process.execPath), app.getPath('userData'))
  if (!pending) return false
  if (await isAuthorizedPortableHealthLaunch(pending, healthMarker, app.getVersion())) return false
  const result = await dialog.showMessageBox({
    type: 'warning', title: '上次升级尚未完成',
    message: '检测到未完成的版本切换，需要先恢复工作台。',
    detail: '若升级窗口仍在运行，请等待它完成。恢复操作会先检查升级是否仍在进行，并保留原版本和用户数据。',
    buttons: ['恢复上次升级', '退出'], defaultId: 0, cancelId: 1, noLink: true
  })
  if (result.response === 0) {
    const updateRoot = await mkdtemp(join(app.getPath('userData'), 'updates', 'run-'))
    const helperPath = join(updateRoot, 'apply-update.ps1')
    const planPath = join(updateRoot, 'update-plan.json')
    await copyFile(join(process.resourcesPath, 'update', 'apply-portable-update.ps1'), helperPath)
    await writeFile(planPath, JSON.stringify({
      ...pending.plan, schema_version: 2, parent_pid: process.pid,
      handoff_required: true, allow_owned_process_cleanup: true,
      user_data_root: app.getPath('userData'),
      health_marker: join(updateRoot, 'healthy.json'),
      log_path: join(updateRoot, 'apply-update.log'),
      result_path: join(app.getPath('userData'), 'updates', LAST_UPDATE_RESULT)
    }, null, 2), 'utf8')
    await launchPortableHelper(helperPath, planPath, { requireUiReady: true, recoverOnly: true })
  }
  app.quit()
  return true
}

export async function importPortableUpdatePackage(): Promise<UpdateStatus> {
  if (importing || installing) return getUpdateStatus()
  if (!canImportPortableUpdate(app.isPackaged, process.platform)) {
    transition({ type: 'unsupported', message: 'ZIP 升级包只能在已打包的 Windows 版本中导入。' }, true)
    return getUpdateStatus()
  }
  const config = loadedConfig ?? loadUpdateConfig()
  if (!config) {
    transition({ type: 'unsupported', message: '当前版本未配置升级包校验密钥。' }, true)
    return getUpdateStatus()
  }

  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const dialogOptions: OpenDialogOptions = {
    title: '导入 PANGEA Desktop 升级包',
    properties: ['openFile'],
    filters: [{ name: 'PANGEA Desktop ZIP', extensions: ['zip'] }]
  }
  importing = true
  let result
  try {
    result = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions)
  } catch (error) {
    importing = false
    transition({ type: 'error', message: errorMessage(error) }, true)
    return getUpdateStatus()
  }
  const sourcePath = result.filePaths[0]
  if (result.canceled || !sourcePath) { importing = false; return getUpdateStatus() }

  transition({ type: 'check', manual: true, packageName: basename(sourcePath) })
  try {
    await clearStagedPackage()
    const updatesRoot = join(app.getPath('userData'), 'updates')
    await mkdir(updatesRoot, { recursive: true })
    const root = await mkdtemp(join(updatesRoot, 'import-'))
    const destination = join(root, 'pangea-desktop.zip')
    stagedRoot = root
    const patch = await isPortablePatchArchive(sourcePath)
    if (patch) {
      const staged = await stagePortablePatch({
        sourcePath,
        destinationPath: destination,
        publicKeyPem: config.publicKeyPem,
        currentVersion: app.getVersion(),
        onProgress: (percent) => transition({ type: 'progress', percent })
      })
      stagedPackage = staged
      transition({
        type: 'downloaded',
        version: staged.manifest.to_version,
        packageType: 'patch',
        baseVersion: staged.manifest.from_version
      })
    } else {
      const staged = await stagePortablePackage({
        sourcePath,
        destinationPath: destination,
        publicKeyPem: config.publicKeyPem,
        currentVersion: app.getVersion(),
        onProgress: (percent) => transition({ type: 'progress', percent })
      })
      stagedPackage = staged
      transition({ type: 'downloaded', version: staged.manifest.version, packageType: 'full' })
    }
  } catch (error) {
    await clearStagedPackage()
    transition(error instanceof PortablePatchBaseVersionMismatch
      ? { type: 'error', message: error.message, packageType: error.packageType, baseVersion: error.baseVersion, availableVersion: error.availableVersion }
      : { type: 'error', message: errorMessage(error) }, true)
  } finally {
    importing = false
  }
  return getUpdateStatus()
}

export async function installImportedUpdate(): Promise<UpdateInstallResult> {
  const imported = stagedPackage
  if (status.phase !== 'downloaded' || !imported || installing) return { helperLaunched: false }
  installing = true
  let releaseAdmission: void | ReleaseUpdateAdmission = undefined
  try {
    if (!prepareToInstall) throw new Error('升级安装保护尚未就绪，请稍后重试。')
    releaseAdmission = await prepareToInstall()
    await launchPortableUpdateHelper(imported)
    // Let the IPC reply render the confirmed handoff before Desktop exits.
    setTimeout(() => app.quit(), 1000)
    return { helperLaunched: true }
  } catch (error) {
    let message = errorMessage(error)
    if (releaseAdmission) {
      try { await releaseAdmission() }
      catch { message += ' 任务保护解除未确认，请重新启动工作台后继续使用。' }
    }
    installing = false
    transition({ type: 'install-error', message }, true)
    return { helperLaunched: false }
  }
}

async function launchPortableUpdateHelper(imported: StagedImport): Promise<void> {
  const patch = imported.kind === 'patch'
  const version = imported.kind === 'patch' ? imported.manifest.to_version : imported.manifest.version
  const baseVersion = imported.kind === 'patch' ? imported.manifest.from_version : undefined
  // A short, exclusively created directory isolates every launch attempt. Fixed
  // filenames remain readable and retries cannot consume earlier handoff markers.
  // Keep runs directly below updates so recovery also finds these update plans.
  const updateRoot = await mkdtemp(join(app.getPath('userData'), 'updates', 'run-'))
  const helperPath = join(updateRoot, 'apply-update.ps1')
  const planPath = join(updateRoot, 'update-plan.json')
  const healthMarker = join(updateRoot, 'healthy.json')
  const resultPath = join(app.getPath('userData'), 'updates', LAST_UPDATE_RESULT)
  const helperSource = join(process.resourcesPath, 'update', 'apply-portable-update.ps1')
  await stageUpdateHelper(imported, helperSource, helperPath)
  await rm(resultPath, { force: true })
  await writeFile(planPath, JSON.stringify({
    schema_version: 2,
    handoff_required: true,
    package_type: patch ? 'patch' : 'full',
    parent_pid: process.pid,
    // prepareToInstall has already rejected active analysis sessions. The helper
    // snapshots descendants while this exact Desktop process is still alive.
    allow_owned_process_cleanup: true,
    package_path: imported.packagePath,
    install_root: dirname(process.execPath),
    executable_name: basename(process.execPath),
    expected_version: version,
    expected_base_version: baseVersion,
    package_channel: imported.manifest.channel,
    expected_size: imported.packageSize,
    expected_sha256: imported.packageSha256,
    health_marker: healthMarker,
    result_path: resultPath,
    user_data_root: app.getPath('userData'),
    startup_health_timeout_seconds: 300,
    log_path: join(updateRoot, 'apply-update.log')
  }, null, 2), 'utf8')

  await launchPortableHelper(helperPath, planPath, { requireUiReady: true })
}

function restoreLastUpdateFailure(): void {
  try {
    const resultPath = join(app.getPath('userData'), 'updates', LAST_UPDATE_RESULT)
    const serialized = readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')
    const result = JSON.parse(serialized) as PortableUpdateResult
    if (
      result.schema_version !== 1
      || result.status !== 'failed'
      || typeof result.version !== 'string'
      || typeof result.message !== 'string'
    ) return
    const recovery = result.rollback === 'restored' ? '已恢复原版本。'
      : result.rollback === 'not_needed' ? '安装目录未切换，原版本仍保留。'
        : result.rollback === 'failed' ? '自动恢复未完成，请查看升级窗口中的恢复信息。' : ''
    transition({
      type: 'restore-error',
      version: result.version,
      message: `上次升级到 v${result.version} 失败：${result.message}${recovery ? `\n${recovery}` : ''}${typeof result.log_path === 'string' ? `\n升级日志：${result.log_path}` : ''}`
    }, true)
  } catch {
    // A missing result means there is no previous update outcome to report.
  }
}

export function stopUpdateManager(): void {
  if (startupTimer) clearTimeout(startupTimer)
  startupTimer = undefined
  onlineController?.abort()
}

async function clearStagedPackage(): Promise<void> {
  const root = stagedRoot
  stagedPackage = undefined
  stagedRoot = undefined
  if (root) await rm(root, { recursive: true, force: true })
}

function loadUpdateConfig(): LoadedUpdateConfig | undefined {
  try {
    const configPath = join(process.resourcesPath, 'update', 'pangea-update.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as PortableUpdateConfig
    if (config.schema_version !== 1 || config.enabled !== true || !config.public_key_file) {
      return undefined
    }
    if (basename(config.public_key_file) !== config.public_key_file) return undefined
    const publicKeyPem = readFileSync(
      join(process.resourcesPath, 'update', config.public_key_file),
      'utf8'
    )
    return { publicKeyPem }
  } catch (error) {
    console.warn('[portable-updater] package verification configuration is unavailable', error)
    return undefined
  }
}

function transition(event: UpdateStateEvent, manualOverride?: boolean): void {
  status = reduceUpdateStatus(status, event)
  if (manualOverride !== undefined) status.manual = manualOverride
  console.info('[portable-updater] status', status.phase, status.percent ?? '')
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('updates:status-changed', getUpdateStatus())
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
