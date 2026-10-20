import { readdir, readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { args, repository, gh, paginate, parseVersion, fullName, patchName, downloadAsset, downloadPair, checkChecksum, isSupportedPatchBase, olderVersion } from './historical-release-lib.mjs'
import { sha256 } from './release-package-trust.mjs'

export function publicationNames(version, report) {
  if (!parseVersion(version) || report.target !== version || !report.discovery_complete || report.error || !Array.isArray(report.bases)) throw new Error('Invalid or unfinished coverage report')
  if (report.bases.some(row => !['verified', 'unsupported', 'missing'].includes(row.status))) throw new Error('Coverage contains unverified or failed baselines')
  const names = new Set()
  for (const row of report.bases) {
    if (row.status !== 'verified') continue
    if (!isSupportedPatchBase(row.version) || !olderVersion(row.version, version) || row.patch !== patchName(version, row.version) || !/^[a-f0-9]{64}$/.test(row.patch_sha256)) throw new Error('Invalid verified patch record')
    names.add(row.patch); names.add(`${row.patch}.sha256`)
  }
  return [...names].sort()
}
export async function localPublication(version, directory) {
  if (!parseVersion(version)) throw new Error('--version must be an exact supported version')
  const reports = (await readdir(directory)).filter(name => new RegExp(`^pangea-desktop-${version.replaceAll('.', '\\.')}-patch-report-[a-f0-9]{12}\\.json$`).test(name))
  if (reports.length !== 1) throw new Error('Expected exactly one final content-addressed coverage report')
  const reportName = reports[0], report = JSON.parse(await readFile(path.join(directory, reportName), 'utf8'))
  const names = publicationNames(version, report)
  const reportDigest = await sha256(path.join(directory, reportName))
  if (!reportName.endsWith(`-${reportDigest.slice(0, 12)}.json`)) throw new Error('Report filename digest mismatch')
  names.push(reportName)
  for (const row of report.bases.filter(row => row.status === 'verified')) {
    if (await checkChecksum(path.join(directory, row.patch), path.join(directory, `${row.patch}.sha256`)) !== row.patch_sha256) throw new Error('Patch differs from verified report')
  }
  return { report, names }
}
export async function main() {
  const options = args(), version = options.version
  const directory = path.resolve(options.directory ?? 'dist')
  const { report, names } = await localPublication(version, directory)
  const repo = repository()
  const release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/v${version}`]))
  if (release.draft || release.tag_name !== `v${version}`) throw new Error('Target must be the exact published release')
  const assets = await paginate(`repos/${repo}/releases/${release.id}/assets`)
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'pangea-publish-'))
  try {
    // Recheck the immutable target at action time, before adding anything.
    const full = await downloadPair(repo, release, fullName(version), path.join(scratch, 'target'))
    if (report.full_fallback?.sha256 !== full.sha256 || report.full_fallback?.name !== fullName(version)) throw new Error('Published target differs from the verified patch target')
    const missing = []
    for (const name of names) {
      if (!assets.some(asset => asset.name === name)) { missing.push(name); continue }
      const existing = await downloadAsset(repo, release.tag_name, name, path.join(scratch, 'existing'))
      if (await sha256(existing) !== await sha256(path.join(directory, name))) throw new Error(`Immutable asset conflict: ${name}`)
    }
    // Preflight every collision before any mutation. Concurrent uploads fail safely without --clobber.
    for (const name of missing) gh(['release', 'upload', release.tag_name, path.join(directory, name), '--repo', repo])
    console.log(`Added ${missing.length} assets; ${names.length - missing.length} identical assets already present.`)
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
