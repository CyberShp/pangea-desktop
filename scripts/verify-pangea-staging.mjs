import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  '.pangea-build/manifest.json',
  '.pangea-build/plugins/dsh-pangea/package.json',
  '.pangea-build/plugins/dsh-pangea-companion/package.json',
  '.pangea-build/plugins/dsh-pangea-asset-catalog/package.json',
  '.pangea-build/runtime/pangea-runtime/src/pangea_agent/cli/main.py',
  '.pangea-build/runtime/pangea-runtime/src/pangea_agent/cli/adapter_api.py',
  '.pangea-build/runtime/pangea-runtime/.agents/pangea/dsh.md',
  '.pangea-build/runtime/pangea-runtime/.opencode/agents/pangea-agent.md',
  '.pangea-build/runtime/pangea-runtime/.opencode/plugins/pangea.ts',
  '.pangea-build/runtime/pangea-runtime/.opencode/skills/product-blackbox-test-case/SKILL.md',
  '.pangea-build/runtime/python/python.exe',
  '.pangea-build/update/pangea-update.json',
  'build/apply-portable-update.ps1',
  'node_modules/dsh-pangea-product/cordis.patch.yml'
]

const missing = required.filter((file) => !existsSync(path.join(root, file)))
if (missing.length > 0) {
  console.error('PANGEA product staging is incomplete:')
  for (const file of missing) console.error(`- ${file}`)
  console.error('Run scripts/build-pangea-desktop.ps1 to assemble the locked components.')
  process.exit(1)
}

const staged = JSON.parse(
  readFileSync(path.join(root, '.pangea-build/plugins/dsh-pangea/package.json'), 'utf8')
)
const companion = JSON.parse(
  readFileSync(path.join(root, '.pangea-build/plugins/dsh-pangea-companion/package.json'), 'utf8')
)
const manifest = JSON.parse(readFileSync(path.join(root, '.pangea-build/manifest.json'), 'utf8'))
const components = JSON.parse(readFileSync(path.join(root, 'pangea.components.json'), 'utf8'))
const dshPatch = readFileSync(
  path.join(root, '.pangea-build/plugins/dsh-pangea/cordis.patch.yml'),
  'utf8'
)
const runtimeRules = readFileSync(
  path.join(root, '.pangea-build/runtime/pangea-runtime/.agents/pangea/dsh.md'),
  'utf8'
)
const runtimeCli = readFileSync(
  path.join(root, '.pangea-build/runtime/pangea-runtime/src/pangea_agent/cli/main.py'),
  'utf8'
)
const runtimeAdapter = readFileSync(
  path.join(root, '.pangea-build/runtime/pangea-runtime/src/pangea_agent/cli/adapter_api.py'),
  'utf8'
)
if (manifest.components?.dsh_pangea?.commit !== components.dshPangea.commit) {
  throw new Error('PANGEA staging manifest does not match the locked dsh-pangea commit.')
}
if (manifest.components?.pangea_agent?.commit !== components.pangeaAgent.commit) {
  throw new Error('PANGEA staging manifest does not match the locked pangea-agent commit.')
}
if (!companion.exports?.['./report-policy']) {
  throw new Error('The staged companion does not export the source-first report policy.')
}
if (!dshPatch.includes('id: pangea-report-policy')) {
  throw new Error('The staged DSH composition does not load the source-first report policy.')
}
if (!runtimeRules.includes('source-first-v1')) {
  throw new Error('The staged runtime does not contain source-first DSH rules.')
}
if (!runtimeCli.includes('adapter') || !runtimeAdapter.includes('source-first-v1') || !runtimeAdapter.includes('next_actions')) {
  throw new Error('The staged pangea-agent CLI does not expose source-first capabilities.')
}
console.log(`PANGEA source-first staging verified: dsh-pangea ${staged.version}`)
