// Verify that a running Desktop serves the exact local plugin build under review.
// This is a resource-integrity check; interactive acceptance is performed in CUA.
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'

const option = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const host = new URL(option('--host') || 'http://127.0.0.1:50420')
const plugins = path.resolve(option('--plugins') || '.pangea-build/plugins')
if (host.hostname !== '127.0.0.1' || host.protocol !== 'http:') throw new Error('Only a local isolated Desktop may be verified')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const bundles = await Promise.all(['dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog'].map(async name => {
  const file = path.join(plugins, name, 'lib/client.js')
  const url = new URL(`/plugins/${name}/client.js`, host).href
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
  const local = digest(await readFile(file))
  const served = digest(Buffer.from(await response.arrayBuffer()))
  return { name, file, url, local, served, matches: local === served }
}))
const result = { checkedAt: new Date().toISOString(), host: host.origin, plugins, bundles, passed: bundles.every(bundle => bundle.matches), scope: 'Local build and served bundle parity only; no UI or provider assertion' }
if (option('--out')) await writeFile(option('--out'), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (!result.passed) process.exitCode = 1
