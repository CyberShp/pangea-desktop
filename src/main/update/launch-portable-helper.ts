import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const psString = (value: string): string => `'${value.replaceAll("'", "''")}'`
const encoded = (value: string): string => Buffer.from(value, 'utf16le').toString('base64')

export interface PortableHelperLaunchOptions {
  requireUiReady?: boolean
  timeoutMs?: number
}

export async function launchPortableHelper(
  helperPath: string,
  planPath: string,
  options: PortableHelperLaunchOptions = {}
): Promise<void> {
  const root = dirname(planPath)
  // Check the signed, staged script before executing it. An older helper does
  // not honor cancellation and may close Desktop after our handshake times out.
  if (options.requireUiReady && !(await readFile(helperPath, 'utf8')).includes('# PANGEA_UPDATE_MONITOR_PROTOCOL=1')) {
    throw new Error('升级包中的更新器不支持可跟踪升级，请使用包含新版更新器的升级包。')
  }
  const invocation = encoded(`& ${psString(helperPath)} -PlanPath ${psString(planPath)}`)
  // Start-Process gives PowerShell an independent hidden console. Node's Windows
  // DETACHED_PROCESS skips the script; an attached console dies with Electron.
  const launcher = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -WorkingDirectory ${psString(root)} -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${invocation}') -RedirectStandardOutput ${psString(join(root, 'helper-launch.log'))} -RedirectStandardError ${psString(join(root, 'helper-launch-error.log'))}`
  try {
    await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(launcher)], {
      cwd: root,
      // Do not load PowerShell 7 modules into Windows PowerShell 5.1.
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
      windowsHide: true,
      timeout: 15_000
    })
    const deadline = Date.now() + (options.timeoutMs ?? 60_000)
    while (true) {
      for (const suffix of ['.ui-error', '.startup-error']) {
        if (existsSync(`${planPath}${suffix}`)) {
          throw new Error((await readFile(`${planPath}${suffix}`, 'utf8')).replace(/^\uFEFF/, '').trim())
        }
      }
      if (existsSync(`${planPath}.ready`)) {
        if (options.requireUiReady) {
          const ready = JSON.parse((await readFile(`${planPath}.ready`, 'utf8')).replace(/^\uFEFF/, ''))
          if (ready.schema_version !== 1 || ready.ui_ready !== true
            || !Number.isSafeInteger(ready.worker_pid) || ready.worker_pid <= 0
            || !Number.isSafeInteger(ready.monitor_pid) || ready.monitor_pid <= 0) {
            throw new Error('升级窗口未确认就绪，已取消交接。')
          }
          // The worker cannot stop Desktop or change files until it receives
          // this acknowledgement. Timed-out attempts never get permission.
          const pending = `${planPath}.continue.tmp`
          try {
            await writeFile(pending, 'continue', { flag: 'wx' })
            await rename(pending, `${planPath}.continue`)
          } finally {
            await rm(pending, { force: true }).catch(() => {})
          }
        }
        return
      }
      if (Date.now() >= deadline) throw new Error('升级窗口启动超时，当前程序将保持打开。')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  } catch (error) {
    await writeFile(`${planPath}.cancel`, 'cancel').catch(() => {})
    const details = error instanceof Error ? error.message : String(error)
    const launchError = await readFile(join(root, 'helper-launch-error.log'), 'utf8').catch(() => '')
    throw new Error(`${details}${launchError.trim() ? `\n${launchError.trim().slice(-4000)}` : ''}\n升级日志目录：${root}`)
  }
}
