import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Read-only preflight. A published version or even a reserved tag is never replaced.
export async function assertReleaseVersionAvailable({
  repository, version, token, apiUrl = 'https://api.github.com', request = fetch,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) {
    throw new Error('A valid GITHUB_REPOSITORY (owner/repo) is required.')
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '')) {
    throw new Error('Release version must be an exact SemVer such as 2.0.1.')
  }
  if (!token) throw new Error('GH_TOKEN is required to check release availability.')
  const base = new URL(apiUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('GITHUB_API_URL must be a credential-free HTTPS API URL.')
  }
  const root = `${base.href.replace(/\/$/, '')}/repos/${repository}`
  const tag = `v${version}`
  async function exists(suffix, allowMissing = true) {
    let response
    try {
      response = await request(`${root}${suffix}`, {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      })
    } catch {
      // Never expose headers, tokens, or an untrusted error response in build logs.
      throw new Error(`Could not verify ${repository}${suffix}: network failure or timeout. No release was authorized.`)
    }
    const status = response.status
    await response.body?.cancel()
    if (status === 200) return true
    if (allowMissing && status === 404) return false
    throw new Error(`Could not verify ${repository}${suffix}: HTTP ${status}. Check repository access, authentication, rate limits, or GitHub availability.`)
  }
  // A hidden/inaccessible repository can also return 404; establish access first.
  await exists('', false)
  const releaseExists = await exists(`/releases/tags/${encodeURIComponent(tag)}`)
  const tagExists = await exists(`/git/ref/tags/${encodeURIComponent(tag)}`)
  if (releaseExists || tagExists) {
    const occupied = [releaseExists && 'Release', tagExists && 'Git tag'].filter(Boolean).join(' and ')
    throw new Error(`Release version already exists: ${tag} (${occupied}). Choose a new unused version; existing releases and tags will not be overwritten.`)
  }
  return { repository, tag, available: true }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await assertReleaseVersionAvailable({
      repository: process.env.GITHUB_REPOSITORY,
      version: process.env.REQUESTED_VERSION,
      token: process.env.GH_TOKEN,
      apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    })
    console.log(`Release preflight passed: ${result.tag} is unused in ${result.repository}.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
