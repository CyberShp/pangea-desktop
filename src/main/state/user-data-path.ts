import { join, resolve } from 'node:path'

interface UserDataPathOptions {
  configuredPath?: string
  appDataPath: string
  developmentBuild: boolean
  acceptanceBuild?: boolean
}

export function resolveUserDataPath(options: UserDataPathOptions): string {
  const configuredPath = options.configuredPath?.trim()
  if (configuredPath) return resolve(configuredPath)
  const directory = options.acceptanceBuild
    ? 'pangea-desktop-acceptance'
    : options.developmentBuild ? 'pangea-desktop-dev' : 'pangea-desktop'
  return join(options.appDataPath, directory)
}
