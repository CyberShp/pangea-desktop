import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyPackage, extractPackage, sha256 } from './release-package-trust.mjs'
import { args, repository, paginate, gh, parseVersion, classifyRelease, fullName, patchName, assetPair, downloadPair, downloadAsset, uniqueReleases } from './historical-release-lib.mjs'

const options = args()
const version = options['target-version'], channel = options.channel, mode = options.mode
if (!['build', 'backfill'].includes(mode)) throw new Error('--mode must be build or backfill')
if (!parseVersion(version) || parseVersion(version).channel !== channel) throw new Error('Target version/channel mismatch')
if (!options['private-key']) throw new Error('--private-key is required')
const repo = repository()
const output = path.resolve(options['output-dir'] ?? 'dist')
const scripts = path.dirname(fileURLToPath(import.meta.url))
const key = createPrivateKey({ key: await readFile(options['private-key']), passphrase: process.env.PANGEA_UPDATE_KEY_PASSPHRASE })
const publicKey = createPublicKey(key)
const scratch = await mkdtemp(path.join(os.tmpdir(), 'pangea-history-'))
await mkdir(output, { recursive: true })
const report = { schema_version: 1, target: version, channel, platform: 'windows', arch: 'x64', mode, complete: false, discovery_complete: false, bases: [] }
let reportPath
async function saveReport(final = false) {
  const bytes = `${JSON.stringify(report, null, 2)}\n`
  const suffix = final ? createHash('sha256').update(bytes).digest('hex').slice(0, 12) : 'in-progress'
  reportPath = path.join(output, `pangea-desktop-${version}-patch-report-${suffix}.json`)
  await writeFile(reportPath, bytes)
  if (final) await rm(path.join(output, `pangea-desktop-${version}-patch-report-in-progress.json`), { force: true })
}
function run(command, arguments_) { execFileSync(command, arguments_, { stdio: 'inherit' }) }
try {
  await saveReport()
  const discovered = await paginate(`repos/${repo}/releases`)
  // Offset pagination can repeat a release when another job publishes between pages.
  const releases = uniqueReleases(discovered)
  report.bases = releases.map(release => {
    const classification = classifyRelease(release, version, channel)
    return { release_id: release.id, tag: release.tag_name, eligible: classification.status === 'pending', ...classification }
  })
  report.discovery_complete = true
  await saveReport()
  const targetRelease = releases.find(release => release.tag_name === `v${version}`)
  let targetDirectory
  let targetArchive
  if (mode === 'backfill') {
    if (!targetRelease || targetRelease.draft) throw new Error('Backfill requires an existing published target release')
    const assets = await paginate(`repos/${repo}/releases/${targetRelease.id}/assets`)
    if (!assetPair(assets, fullName(version))) throw new Error('Target full package/checksum missing')
    targetArchive = await downloadPair(repo, targetRelease, fullName(version), path.join(scratch, 'target-download'))
    targetDirectory = path.join(scratch, 'target')
    await extractPackage(targetArchive.file, targetDirectory)
  } else {
    if (targetRelease) throw new Error('Build target release already exists; use backfill')
    targetArchive = { file: path.join(output, fullName(version)) }
    const { checkChecksum } = await import('./historical-release-lib.mjs')
    targetArchive.sha256 = await checkChecksum(targetArchive.file, `${targetArchive.file}.sha256`)
    // Verify and use the actual shipped ZIP, not a directory that runtime smoke tests may have mutated.
    targetDirectory = path.join(scratch, 'target')
    await extractPackage(targetArchive.file, targetDirectory)
  }
  await verifyPackage(targetDirectory, { version, channel, publicKey })
  report.full_fallback = { name: fullName(version), sha256: targetArchive.sha256 }
  const existingAssets = targetRelease ? await paginate(`repos/${repo}/releases/${targetRelease.id}/assets`) : []
  for (let index = 0; index < releases.length; index++) {
    const release = releases[index], row = report.bases[index]
    if (row.status !== 'pending') continue
    const baseScratch = path.join(scratch, `base-${release.id}`)
    const name = patchName(version, row.version)
    const patch = path.join(output, name)
    try {
      const assets = await paginate(`repos/${repo}/releases/${release.id}/assets`)
      if (!assetPair(assets, fullName(row.version))) {
        row.status = 'missing'; row.reason = 'windows-x64 full package or checksum unavailable'; continue
      }
      const base = await downloadPair(repo, release, fullName(row.version), path.join(baseScratch, 'download'))
      const directory = path.join(baseScratch, 'unpacked')
      await extractPackage(base.file, directory)
      await verifyPackage(directory, { version: row.version, channel, publicKey })
      row.base_sha256 = base.sha256
      const updaterPath = path.join(directory, 'resources/update/apply-portable-update.ps1')
      let updater = ''
      try { updater = await readFile(updaterPath, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!/function\s+Apply-VerifiedPatch\b/i.test(updater)) {
        row.status = 'unsupported'; row.reason = 'legacy updater lacks Apply-VerifiedPatch; install the complete ZIP'; continue
      }
      if (existingAssets.some(asset => asset.name === name)) {
        if (assetPair(existingAssets, name)) await downloadPair(repo, targetRelease, name, output)
        else {
          // A prior upload may have stopped between the ZIP and its checksum.
          // Reuse the immutable ZIP, verify it below, and restore only its sidecar.
          await downloadAsset(repo, targetRelease.tag_name, name, output)
          await writeFile(`${patch}.sha256`, `${await sha256(patch)}  ${name}\n`)
        }
        row.reused = true
      } else {
        run(process.execPath, [path.join(scripts, 'create-signed-portable-patch.mjs'), '--base-dir', directory, '--target-dir', targetDirectory, '--private-key', path.resolve(options['private-key']), '--from-version', row.version, '--to-version', version, '--channel', channel, '--output', patch])
        await writeFile(`${patch}.sha256`, `${await sha256(patch)}  ${name}\n`)
      }
      run('pwsh', ['-NoProfile', '-File', path.join(scripts, 'verify-release-patch.ps1'), '-BaseDirectory', directory, '-TargetDirectory', targetDirectory, '-PatchPath', patch])
      row.status = 'verified'; row.patch = name; row.patch_sha256 = await sha256(patch); row.patch_bytes = (await stat(patch)).size
    } catch (error) {
      row.status = error.code === 'UNSUPPORTED_PACKAGE' ? 'unsupported' : 'failed'; row.reason = error.message
      // Never leave an unverified patch in the publish directory.
      await rm(patch, { force: true }); await rm(`${patch}.sha256`, { force: true })
    } finally {
      await rm(baseScratch, { recursive: true, force: true })
      await saveReport()
    }
  }
  report.complete = report.bases.filter(row => row.eligible).every(row => row.status === 'verified')
  if (report.bases.some(row => row.status === 'failed')) process.exitCode = 1
} catch (error) {
  report.error = error.message; process.exitCode = 1
} finally {
  await saveReport(true)
  await rm(scratch, { recursive: true, force: true })
  console.log(`Historical patch coverage: ${reportPath}`)
}
