import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

it('accepts matching staging metadata and rejects a stale Agent lock or missing OpenCode tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'semantic-staging-'))
  const project = path.resolve(import.meta.dirname, '..')
  const write = async (file: string, value: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), value)
  }
  try {
    await mkdir(path.join(root, 'scripts'))
    await cp(path.join(project, 'scripts/verify-pangea-staging.mjs'), path.join(root, 'scripts/verify-pangea-staging.mjs'))
    const components = JSON.parse(await readFile(path.join(project, 'pangea.components.json'), 'utf8'))
    await write('pangea.components.json', JSON.stringify(components))
    const manifest = { components: {
      dsh_pangea: { commit: components.dshPangea.commit },
      pangea_agent: { commit: components.pangeaAgent.commit },
    } }
    await write('.pangea-build/manifest.json', JSON.stringify(manifest))
    await write('.pangea-build/plugins/dsh-pangea/package.json', '{"version":"fixture"}')
    await write('.pangea-build/plugins/dsh-pangea-companion/package.json', '{"exports":{"./report-policy":"./src/report-policy.js"}}')
    await write('.pangea-build/plugins/dsh-pangea-asset-catalog/package.json', '{}')
    await write('.pangea-build/plugins/dsh-pangea/cordis.patch.yml', '- id: pangea-report-policy\n')
    const runtime = '.pangea-build/runtime/pangea-runtime/'
    await write(runtime + 'src/pangea_agent/cli/main.py', '# adapter fixture\n')
    await write(runtime + 'src/pangea_agent/cli/adapter_api.py', '# source-first-v1 next_actions fixture\n')
    await write(runtime + '.agents/pangea/dsh.md', '# source-first-v1 fixture\n')
    for (const file of [
      runtime + '.opencode/agents/pangea-agent.md',
      runtime + '.opencode/plugins/pangea.ts',
      runtime + '.opencode/skills/product-blackbox-test-case/SKILL.md',
      '.pangea-build/runtime/python/python.exe',
      '.pangea-build/update/pangea-update.json',
      'build/apply-portable-update.ps1',
      'node_modules/dsh-pangea-product/cordis.patch.yml',
    ]) await write(file, 'metadata test fixture')
    const verify = () => execFileSync(process.execPath, [path.join(root, 'scripts/verify-pangea-staging.mjs')], { encoding: 'utf8', stdio: 'pipe' })
    expect(verify()).toContain('staging verified')
    manifest.components.pangea_agent.commit = '0'.repeat(40)
    await write('.pangea-build/manifest.json', JSON.stringify(manifest))
    expect(verify).toThrow(/does not match the locked pangea-agent commit/)
    manifest.components.pangea_agent.commit = components.pangeaAgent.commit
    await write('.pangea-build/manifest.json', JSON.stringify(manifest))
    await rm(path.join(root, runtime + '.opencode/plugins/pangea.ts'))
    expect(verify).toThrow(/staging is incomplete/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
