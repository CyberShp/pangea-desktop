import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const psString = (value: string): string => `'${value.replaceAll("'", "''")}'`
const encoded = (value: string): string => Buffer.from(value, 'utf16le').toString('base64')

export async function launchPortableHelper(helperPath: string, planPath: string): Promise<void> {
  const root = dirname(planPath)
  const invocation = encoded(`& ${psString(helperPath)} -PlanPath ${psString(planPath)}`)
  // Start-Process gives PowerShell an independent hidden console. Node's Windows
  // DETACHED_PROCESS skips the script; an attached console dies with Electron.
  const launcher = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue';
Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -WorkingDirectory ${psString(root)} -ArgumentList @('-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '${invocation}') -RedirectStandardOutput ${psString(join(root, 'helper-launch.log'))} -RedirectStandardError ${psString(join(root, 'helper-launch-error.log'))}`
  await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(launcher)], {
    cwd: root,
    // Do not load PowerShell 7 modules into Windows PowerShell 5.1.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
    windowsHide: true,
    timeout: 15_000
  })
  const deadline = Date.now() + 15_000
  while (!existsSync(`${planPath}.ready`)) {
    if (Date.now() >= deadline) throw new Error('升级助手启动超时，请查看 helper-launch-error.log。')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
