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

async function writeIfMissing(filePath: string, content: string): Promise<void> {
  try {
    await writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error
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
  let manifest: ProfileManifest | null = null
  try {
    const rawManifest = await readFile(manifestPath, 'utf8')
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
    let manifestChanged = manifestMissing
    if (!manifest.dependencies || typeof manifest.dependencies !== 'object' || Array.isArray(manifest.dependencies)) {
      manifest.dependencies = {}
      manifestChanged = true
    }
    for (const bundle of LEGACY_PANGEA_BUNDLES) {
      if (Object.hasOwn(manifest.dependencies, bundle)) {
        delete manifest.dependencies[bundle]
        manifestChanged = true
      }
    }
    if (!manifest.dsh || typeof manifest.dsh !== 'object' || Array.isArray(manifest.dsh)) {
      manifest.dsh = {}
      manifestChanged = true
    }
    if (!manifest.dsh.profile || typeof manifest.dsh.profile !== 'object' || Array.isArray(manifest.dsh.profile)) {
      manifest.dsh.profile = {}
      manifestChanged = true
    }
    const existingBundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : null
    if (!existingBundles) manifestChanged = true
    const bundles = (existingBundles ?? []).filter(
      (bundle) => !LEGACY_PANGEA_BUNDLES.includes(bundle as typeof LEGACY_PANGEA_BUNDLES[number])
    )
    if (existingBundles && bundles.length !== existingBundles.length) manifestChanged = true
    if (!bundles.includes(PANGEA_CORE_BUNDLE)) {
      bundles.push(PANGEA_CORE_BUNDLE)
      manifestChanged = true
    }
    if (manifestChanged) {
      manifest.dsh.profile.bundles = bundles
      nextManifestText = `${JSON.stringify(manifest, undefined, 2)}\n`
    }
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
