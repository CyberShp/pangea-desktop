import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface LaunchRootRuntime {
  defaultApp?: boolean
  resourcesPath?: string
}

function currentRuntime(): LaunchRootRuntime {
  const runtime = process as NodeJS.Process & LaunchRootRuntime
  return {
    defaultApp: runtime.defaultApp,
    resourcesPath: runtime.resourcesPath
  }
}

export function launchRootBasePath(
  userDataPath: string,
  runtime: LaunchRootRuntime = currentRuntime()
): string {
  if (runtime.defaultApp === true || !runtime.resourcesPath) return userDataPath
  return dirname(runtime.resourcesPath)
}

export function launchRootPath(
  userDataPath: string,
  runtime: LaunchRootRuntime = currentRuntime()
): string {
  return join(launchRootBasePath(userDataPath, runtime), 'launch-root')
}

export async function ensureLaunchRoot(
  userDataPath: string,
  runtime: LaunchRootRuntime = currentRuntime()
): Promise<string> {
  const launchRoot = launchRootPath(userDataPath, runtime)
  await mkdir(launchRoot, { recursive: true })
  return launchRoot
}
