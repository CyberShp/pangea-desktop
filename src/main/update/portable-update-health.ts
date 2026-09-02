import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'

const HEALTH_ARGUMENT = '--pangea-update-health='

export function portableUpdateHealthMarker(
  argv: readonly string[],
  userDataPath: string
): string | undefined {
  const raw = argv.find((argument) => argument.startsWith(HEALTH_ARGUMENT))?.slice(HEALTH_ARGUMENT.length)
  if (!raw) return undefined
  const updatesRoot = resolve(join(userDataPath, 'updates'))
  const marker = resolve(raw)
  if (!marker.startsWith(`${updatesRoot}${sep}`)) return undefined
  return marker
}

export async function markPortableUpdateHealthy(
  marker: string | undefined,
  version: string
): Promise<boolean> {
  if (!marker) return false
  await mkdir(dirname(marker), { recursive: true })
  await writeFile(marker, JSON.stringify({
    schema_version: 1,
    version,
    healthy_at: new Date().toISOString(),
    pid: process.pid
  }), { encoding: 'utf8', flag: 'wx' })
  return true
}
