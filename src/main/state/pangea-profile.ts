import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { prunePatchLayer } from './patch-layer'

export const PANGEA_CORE_BUNDLE = 'dsh-pangea-product'
const WEB_CORE_BUNDLES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  PANGEA_CORE_BUNDLE
]
const LEGACY_PANGEA_BUNDLES = [
  'dsh-pangea',
  'dsh-pangea-companion',
  'dsh-pangea-asset-catalog'
] as const
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

function migrateLegacyPangeaPatch(patchText: string): string {
  return LEGACY_PANGEA_BUNDLES.reduce(
    (text, bundle) => prunePatchLayer(text, bundle, []).text,
    patchText
  )
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
  for (const bundle of LEGACY_PANGEA_BUNDLES) delete manifest.dependencies[bundle]
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = (manifest.dsh.profile.bundles ?? []).filter(
    (bundle) => !LEGACY_PANGEA_BUNDLES.includes(bundle as typeof LEGACY_PANGEA_BUNDLES[number])
  )
  if (!bundles.includes(PANGEA_CORE_BUNDLE)) bundles.push(PANGEA_CORE_BUNDLE)
  manifest.dsh.profile.bundles = bundles

  const patchPath = join(directory, 'cordis.patch.yml')
  let patchText = PROFILE_PATCH
  try {
    patchText = migrateLegacyPangeaPatch(await readFile(patchPath, 'utf8'))
  } catch {
    // A missing user layer starts empty; an unreadable layer is recreated by
    // the same first-launch behavior this profile already used.
  }

  await Promise.all([
    writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8'),
    writeFile(patchPath, patchText, 'utf8'),
    writeIfMissing(join(directory, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)
  ])
  return directory
}
