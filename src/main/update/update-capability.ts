export function canImportPortableUpdate(isPackaged: boolean, platform: NodeJS.Platform): boolean {
  return isPackaged && platform === 'win32'
}
