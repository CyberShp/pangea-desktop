import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const PANGEA_CORE_BUNDLE = 'dsh-pangea-product'
const WEB_CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  PANGEA_CORE_BUNDLE
]
const PROFILE_PATCH = `# User patch layer for the PANGEA Desktop web profile.
[]
`
const PROFILE_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await readFile(path, 'utf8')
  } catch {
    await writeFile(path, content, 'utf8')
  }
}

/** Keep the installation-owned PANGEA bundle in the normal web profile. */
export async function ensurePangeaWebProfile(dshHome: string): Promise<string> {
  const directory = join(dshHome, 'profiles', 'web')
  const manifestPath = join(directory, 'package.json')
  await mkdir(directory, { recursive: true })

  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ProfileManifest
  } catch {
    manifest = {
      name: 'dsh-profile-web',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...WEB_CORE_BUNDLES] } }
    }
  }

  manifest.dependencies ??= {}
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = manifest.dsh.profile.bundles ?? []
  if (!bundles.includes(PANGEA_CORE_BUNDLE)) bundles.push(PANGEA_CORE_BUNDLE)
  manifest.dsh.profile.bundles = bundles

  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8'),
    writeIfMissing(join(directory, 'cordis.patch.yml'), PROFILE_PATCH),
    writeIfMissing(join(directory, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)
  ])
  return directory
}
