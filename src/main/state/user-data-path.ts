import { join, resolve } from 'node:path'

interface UserDataPathOptions {
  configuredPath?: string
  appDataPath: string
  developmentBuild: boolean
}

export function resolveUserDataPath(options: UserDataPathOptions): string {
  const configuredPath = options.configuredPath?.trim()
  if (configuredPath) return resolve(configuredPath)
  return join(options.appDataPath, options.developmentBuild ? 'pangea-desktop-dev' : 'pangea-desktop')
}
