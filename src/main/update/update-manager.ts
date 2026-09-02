import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { copyFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import type { UpdateStatus } from '../../shared/contracts'
import { stagePortablePackage, type StagedPortablePackage } from './portable-package-validator'
import { isPortablePatchArchive, stagePortablePatch, type StagedPortablePatch } from './portable-patch-validator'
import type { PortableUpdateConfig } from './portable-update'
import { initialUpdateStatus, reduceUpdateStatus, type UpdateStateEvent } from './update-state'

interface LoadedUpdateConfig {
  publicKeyPem: string
}

interface PortableUpdateResult {
  schema_version: 1
  status: 'success' | 'failed'
  version: string
  message?: string
}

const LAST_UPDATE_RESULT = 'last-update-result.json'

let status = initialUpdateStatus(app.getVersion())
let prepareToInstall: (() => Promise<void>) | undefined
let handlersRegistered = false
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
  ipcMain.handle('updates:import', () => importPortableUpdatePackage())
  ipcMain.handle('updates:install', () => installImportedUpdate())
}

export function startUpdateManager(options: { prepareToInstall: () => Promise<void> }): void {
  prepareToInstall = options.prepareToInstall
  loadedConfig = loadUpdateConfig()
  restoreLastUpdateFailure()
}

export async function importPortableUpdatePackage(): Promise<UpdateStatus> {
  if (importing || installing) return getUpdateStatus()
  if (!app.isPackaged || process.platform !== 'win32') {
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
  const result = window
    ? await dialog.showOpenDialog(window, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions)
  const sourcePath = result.filePaths[0]
  if (result.canceled || !sourcePath) return getUpdateStatus()

  importing = true
  transition({ type: 'check', manual: true })
  await clearStagedPackage()
  const root = join(app.getPath('userData'), 'updates', `import-${randomUUID()}`)
  const destination = join(root, 'pangea-desktop.zip')
  stagedRoot = root
  try {
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
    transition({ type: 'error', message: errorMessage(error) }, true)
  } finally {
    importing = false
  }
  return getUpdateStatus()
}

export async function installImportedUpdate(): Promise<void> {
  const imported = stagedPackage
  if (status.phase !== 'downloaded' || !imported || installing) return
  installing = true
  try {
    await prepareToInstall?.()
    await launchPortableUpdateHelper(imported)
    app.quit()
  } catch (error) {
    installing = false
    transition({ type: 'install-error', message: errorMessage(error) }, true)
  }
}

async function launchPortableUpdateHelper(imported: StagedImport): Promise<void> {
  const patch = imported.kind === 'patch'
  const version = imported.kind === 'patch' ? imported.manifest.to_version : imported.manifest.version
  const baseVersion = imported.kind === 'patch' ? imported.manifest.from_version : undefined
  const updateRoot = dirname(imported.packagePath)
  const helperPath = join(updateRoot, 'apply-portable-update.ps1')
  const planPath = join(updateRoot, 'update-plan.json')
  const healthMarker = join(updateRoot, `healthy-${randomUUID()}.json`)
  const resultPath = join(app.getPath('userData'), 'updates', LAST_UPDATE_RESULT)
  const helperSource = join(process.resourcesPath, 'update', 'apply-portable-update.ps1')
  if (!existsSync(helperSource)) throw new Error('升级助手缺失。')
  await copyFile(helperSource, helperPath)
  await rm(resultPath, { force: true })
  await writeFile(planPath, JSON.stringify({
    schema_version: 2,
    package_type: patch ? 'patch' : 'full',
    parent_pid: process.pid,
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
    log_path: join(updateRoot, 'apply-update.log')
  }, null, 2), 'utf8')

  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', helperPath, '-PlanPath', planPath
  ], {
    cwd: updateRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  child.unref()
}

function restoreLastUpdateFailure(): void {
  try {
    const resultPath = join(app.getPath('userData'), 'updates', LAST_UPDATE_RESULT)
    const serialized = readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '')
    rmSync(resultPath, { force: true })
    const result = JSON.parse(serialized) as PortableUpdateResult
    if (
      result.schema_version !== 1
      || result.status !== 'failed'
      || typeof result.version !== 'string'
      || typeof result.message !== 'string'
    ) return
    transition({
      type: 'restore-error',
      version: result.version,
      message: `升级到 v${result.version} 失败：${result.message}`
    }, true)
  } catch {
    // A missing result means there is no previous update outcome to report.
  }
}

export function stopUpdateManager(): void {
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
