import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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

async function writeAtomicText(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    try { await unlink(tempPath) } catch {}
    throw error
  }
}

/** Keep the installation-owned PANGEA bundle in the normal web profile. */
export async function ensurePangeaWebProfile(dshHome: string): Promise<string> {
  const directory = join(dshHome, 'profiles', 'web')
  const manifestPath = join(directory, 'package.json')
  await mkdir(directory, { recursive: true })

  let manifestMissing = false
  let rawManifest = ''
  let manifest: ProfileManifest | null = null
  try {
    rawManifest = await readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(rawManifest) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      manifest = parsed as ProfileManifest
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      manifestMissing = true
      manifest = {
        name: 'dsh-profile-web',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: [...WEB_CORE_BUNDLES] } }
      }
    }
  }

  let nextManifestText: string | null = null
  if (manifest) {
    manifest.dependencies ??= {}
    for (const bundle of LEGACY_PANGEA_BUNDLES) delete manifest.dependencies[bundle]
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    const bundles = (manifest.dsh.profile.bundles ?? []).filter(
      (bundle) => !LEGACY_PANGEA_BUNDLES.includes(bundle as typeof LEGACY_PANGEA_BUNDLES[number])
    )
    if (!bundles.includes(PANGEA_CORE_BUNDLE)) bundles.push(PANGEA_CORE_BUNDLE)
    manifest.dsh.profile.bundles = bundles
    const serialized = `${JSON.stringify(manifest, undefined, 2)}\n`
    if (manifestMissing || serialized !== rawManifest) nextManifestText = serialized
  }

  const patchPath = join(directory, 'cordis.patch.yml')
  let nextPatchText: string | null = null
  try {
    const rawPatch = await readFile(patchPath, 'utf8')
    const migrated = migrateLegacyPangeaPatch(rawPatch)
    if (migrated !== rawPatch) nextPatchText = migrated
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      nextPatchText = PROFILE_PATCH
    }
  }

  const writes: Promise<unknown>[] = [writeIfMissing(join(directory, 'pnpm-workspace.yaml'), PROFILE_WORKSPACE)]
  if (nextManifestText !== null) writes.push(writeAtomicText(manifestPath, nextManifestText))
  if (nextPatchText !== null) writes.push(writeAtomicText(patchPath, nextPatchText))
  await Promise.all(writes)
  return directory
}
