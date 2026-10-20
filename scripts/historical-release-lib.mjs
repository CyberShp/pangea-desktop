import { execFileSync } from 'node:child_process'
import upgradePolicy from '../build/portable-update-policy.json' with { type: 'json' }
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from './release-package-trust.mjs'

export function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
}
export function repository() {
  const value = process.env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(value ?? '')) throw new Error('GITHUB_REPOSITORY must identify owner/repository')
  return value
}
export async function paginate(endpoint, request = (url) => JSON.parse(gh(['api', url]))) {
  const result = []
  for (let page = 1; ; page++) {
    const items = await request(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
    if (!Array.isArray(items)) throw new Error('Expected a GitHub API page array')
    result.push(...items)
    if (items.length < 100) return result
  }
}
export function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-test\.(0|[1-9]\d*)\.([0-9a-f]{7}))?$/.exec(value ?? '')
  return match && { channel: match[4] === undefined ? 'stable' : 'test', parts: match.slice(1, 4).map(BigInt), run: BigInt(match[4] ?? 0) }
}
export function olderVersion(source, target) {
  const a = parseVersion(source), b = parseVersion(target)
  if (!a || !b || a.channel !== b.channel) return false
  for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] < b.parts[i]
  return a.run < b.run
}
export const MINIMUM_PATCH_BASE_VERSION = upgradePolicy.minimum_source_version
export function isSupportedPatchBase(version) {
  const parsed = parseVersion(version)
  const minimum = parseVersion(MINIMUM_PATCH_BASE_VERSION)
  if (!parsed || !minimum) return false
  for (let index = 0; index < 3; index++) {
    if (parsed.parts[index] !== minimum.parts[index]) return parsed.parts[index] > minimum.parts[index]
  }
  return true
}
export function classifyRelease(release, target, channel) {
  const version = release.tag_name?.replace(/^v/, '')
  if (!release.tag_name?.startsWith('v')) return { version, status: 'unsupported', reason: 'noncanonical release tag (expected v<version>)' }
  if (release.draft) return { version, status: 'unsupported', reason: 'draft release' }
  const parsed = parseVersion(version)
  if (!parsed) return { version, status: 'unsupported', reason: 'unsupported version format' }
  if (!isSupportedPatchBase(version)) return { version, status: 'unsupported', reason: `below minimum supported patch baseline ${MINIMUM_PATCH_BASE_VERSION}; older upgrade paths are retired` }
  if (parsed.channel !== channel) return { version, status: 'unsupported', reason: 'different channel' }
  if (!olderVersion(version, target)) return { version, status: 'unsupported', reason: 'not older than target' }
  return { version, status: 'pending' }
}
export const fullName = (version) => `pangea-desktop-${version}-windows-x64-portable.zip`
export const patchName = (target, base) => `pangea-desktop-${target}-from-${base}-windows-x64.patch.zip`
export function assetPair(assets, name) {
  const names = new Set(assets.map((asset) => asset.name))
  return names.has(name) && names.has(`${name}.sha256`)
}
export async function downloadAsset(repo, tag, name, directory) {
  await mkdir(directory, { recursive: true })
  gh(['release', 'download', tag, '--repo', repo, '--pattern', name, '--dir', directory])
  return path.join(directory, name)
}
export async function checkChecksum(file, checksumFile) {
  const name = path.basename(file)
  const text = (await readFile(checksumFile, 'utf8')).trim()
  const match = /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(text)
  if (!match || match[2] !== name) throw new Error(`Invalid checksum sidecar: ${name}`)
  const actual = await sha256(file)
  if (actual !== match[1].toLowerCase()) throw new Error(`Checksum mismatch: ${name}`)
  return actual
}
export async function downloadPair(repo, release, name, directory) {
  const file = await downloadAsset(repo, release.tag_name, name, directory)
  await downloadAsset(repo, release.tag_name, `${name}.sha256`, directory)
  return { file, sha256: await checkChecksum(file, `${file}.sha256`) }
}
export function args(argv = process.argv.slice(2)) {
  const result = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error('Expected --option value')
    if (result[argv[i].slice(2)] !== undefined) throw new Error(`Duplicate ${argv[i]}`)
    result[argv[i].slice(2)] = argv[i + 1]
  }
  return result
}

export function uniqueReleases(releases) {
  const ids = new Map(), tags = new Map()
  for (const release of releases) {
    if (!Number.isSafeInteger(release.id) || release.id <= 0 || typeof release.tag_name !== 'string') throw new Error('Invalid release identity')
    if (ids.has(release.id) && ids.get(release.id).tag_name !== release.tag_name || tags.has(release.tag_name) && tags.get(release.tag_name) !== release.id) throw new Error('Ambiguous release identity during discovery')
    ids.set(release.id, release); tags.set(release.tag_name, release.id)
  }
  return [...ids.values()]
}
