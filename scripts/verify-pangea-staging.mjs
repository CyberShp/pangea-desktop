import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const required = [
  '.pangea-build/manifest.json',
  '.pangea-build/plugins/dsh-pangea/package.json',
  '.pangea-build/plugins/dsh-pangea-companion/package.json',
  '.pangea-build/plugins/dsh-pangea-asset-catalog/package.json',
  '.pangea-build/plugins/dsh-pangea-run-ui/package.json',
  '.pangea-build/runtime/pangea-runtime/src/pangea_agent/cli/main.py',
  '.pangea-build/runtime/pangea-runtime/.agents/pangea/dsh.md',
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
console.log(`PANGEA product staging verified: dsh-pangea ${staged.version}`)
