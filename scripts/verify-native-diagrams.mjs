// Run with the installed Node and companion; no model, renderer process, or network call.
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { writeNativeDiagramFixture, verifyNativeDiagrams } from './native-diagram-smoke.mjs'
const companionRoot = process.argv[2]
if (!companionRoot) throw new Error('Usage: verify-native-diagrams.mjs <companion-root>')
const folder = await mkdtemp(path.join(os.tmpdir(), 'pangea-native-diagrams-'))
try {
  const fixture = await writeNativeDiagramFixture(folder)
  const result = await verifyNativeDiagrams(path.resolve(companionRoot), fixture, path.join(folder, 'exports'))
  process.stdout.write(JSON.stringify(result) + '\n')
} finally {
  await rm(folder, { recursive: true, force: true })
}
