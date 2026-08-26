import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions } from 'electron'
import type { UpdateStatus } from '../../shared/contracts'
import { stagePortablePackage, type StagedPortablePackage } from './portable-package-validator'
import type { PortableUpdateConfig } from './portable-update'
import { initialUpdateStatus, reduceUpdateStatus, type UpdateStateEvent } from './update-state'

interface LoadedUpdateConfig {
  publicKeyPem: string
}

let status = initialUpdateStatus(app.getVersion())
let prepareToInstall: (() => Promise<void>) | undefined
let handlersRegistered = false
let importing = false
let installing = false
let loadedConfig: LoadedUpdateConfig | undefined
let stagedPackage: StagedPortablePackage | undefined
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
    stagedPackage = await stagePortablePackage({
      sourcePath,
      destinationPath: destination,
      publicKeyPem: config.publicKeyPem,
      currentVersion: app.getVersion(),
      onProgress: (percent) => transition({ type: 'progress', percent })
    })
    transition({ type: 'downloaded', version: stagedPackage.manifest.version })
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

async function launchPortableUpdateHelper(imported: StagedPortablePackage): Promise<void> {
  const version = imported.manifest.version
  const updateRoot = dirname(imported.packagePath)
  const helperPath = join(updateRoot, 'apply-portable-update.ps1')
  const planPath = join(updateRoot, 'update-plan.json')
  const healthMarker = join(updateRoot, `healthy-${randomUUID()}.json`)
  const helperSource = join(process.resourcesPath, 'update', 'apply-portable-update.ps1')
  if (!existsSync(helperSource)) throw new Error('升级助手缺失。')
  await copyFile(helperSource, helperPath)
  await writeFile(planPath, JSON.stringify({
    schema_version: 1,
    parent_pid: process.pid,
    package_path: imported.packagePath,
    install_root: dirname(process.execPath),
    executable_name: basename(process.execPath),
    expected_version: version,
    expected_size: imported.packageSize,
    expected_sha256: imported.packageSha256,
    health_marker: healthMarker,
    log_path: join(updateRoot, 'apply-update.log')
  }, null, 2), 'utf8')

  const child = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
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
