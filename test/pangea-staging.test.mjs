import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

for (const platform of ['win32', 'darwin']) {
test(`${platform} staging requires the selected review rubric and all worker instructions`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pangea-staging-check-'))
  const put = async (file, body = '') => { const target = path.join(root, file); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, body) }
  const runtime = '.pangea-build/runtime/pangea-runtime'
  try {
    await mkdir(path.join(root, 'scripts'))
    await copyFile(new URL('../scripts/verify-pangea-staging.mjs', import.meta.url), path.join(root, 'scripts/verify-pangea-staging.mjs'))
    const components = { dshPangea: { commit: 'dsh' }, pangeaAgent: { commit: 'agent' } }
    await put('pangea.components.json', JSON.stringify(components))
    const manifest = { components: { dsh_pangea: { commit: 'dsh' }, pangea_agent: { commit: 'agent' } } }
    if (platform === 'darwin') manifest.target = { platform, arch: 'arm64' }
    await put('.pangea-build/manifest.json', JSON.stringify(manifest))
    for (const name of ['dsh-pangea', 'dsh-pangea-companion', 'dsh-pangea-asset-catalog']) await put(`.pangea-build/plugins/${name}/package.json`, JSON.stringify({ version: 'test', exports: { './report-policy': './src/report-policy.js' } }))
    await put('.pangea-build/plugins/dsh-pangea/cordis.patch.yml', 'id: pangea-report-policy')
    await put(`${runtime}/.agents/pangea/dsh.md`, 'source-first-v1')
    await put(`${runtime}/src/pangea_agent/cli/main.py`, 'adapter')
    await put(`${runtime}/src/pangea_agent/cli/adapter_api.py`, 'source-first-v1 next_actions')
    for (const role of ['planning', 'analysis', 'review']) for (const dir of ['.agents/pangea', '.opencode/agents']) await put(`${runtime}/${dir}/${role}-worker.md`, 'worker instructions')
    for (const file of ['.opencode/agents/pangea-agent.md', '.opencode/plugins/pangea.ts', '.opencode/skills/product-blackbox-test-case/SKILL.md', 'src/pangea_agent/rubrics/builtin/behavior_test_generation.md']) await put(`${runtime}/${file}`, 'content')
    for (const file of ['docs/source-first-cli-worker.md', 'src/pangea_agent/analysis_scenarios.py', ...['common_generation', 'common_review', 'flow', 'planning', 'module', 'risk', 'risk_review', 'branch', 'coverage'].map(name => `src/pangea_agent/rubrics/builtin/scene_${name}.md`)]) await put(`${runtime}/${file}`, 'content')
    for (const name of ['c_cpp_risk_methods', 'lua_risk_methods']) await put(`${runtime}/src/pangea_agent/rubrics/builtin/${name}.md`, 'content')
    const platformFiles = platform === 'darwin'
      ? ['.pangea-build/runtime/python/bin/python3', 'node_modules/node/bin/node']
      : ['.pangea-build/runtime/python/python.exe', '.pangea-build/update/pangea-update.json', 'build/apply-portable-update.ps1']
    for (const file of [...platformFiles, 'node_modules/dsh-pangea-product/cordis.patch.yml']) await put(file)
    const targetArgs = platform === 'darwin' ? ['--platform', 'darwin', '--arch', 'arm64'] : []
    const run = () => spawnSync(process.execPath, [path.join(root, 'scripts/verify-pangea-staging.mjs'), ...targetArgs], { encoding: 'utf8' })
    const graph = `${runtime}/src/pangea_agent/graph/nodes/source_first.py`
    await put(graph, 'old frozen generation method')
    assert.equal(run().status, 0)
    if (platform === 'darwin') {
      manifest.target.arch = 'x64'
      await put('.pangea-build/manifest.json', JSON.stringify(manifest))
      assert.match(run().stderr, /does not match target darwin\/arm64/)
      manifest.target.arch = 'arm64'
      await put('.pangea-build/manifest.json', JSON.stringify(manifest))
      await rm(path.join(root, '.pangea-build/runtime/python/bin/python3'))
      assert.match(run().stderr, /runtime\/python\/bin\/python3/)
      await put('.pangea-build/runtime/python/bin/python3')
    }
    await put(graph, 'select behavior_test_review')
    const missing = run()
    assert.notEqual(missing.status, 0)
    assert.match(missing.stderr, /frozen review rubric is missing/)
    await put(`${runtime}/src/pangea_agent/rubrics/builtin/behavior_test_review.md`, 'review method')
    assert.equal(run().status, 0)
    await rm(path.join(root, `${runtime}/.agents/pangea/analysis-worker.md`))
    const worker = run()
    assert.notEqual(worker.status, 0)
    assert.match(worker.stderr, /analysis-worker.md/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
}

test('staging rejects unsupported targets before inspecting product files', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/verify-pangea-staging.mjs', import.meta.url)),
    '--platform', 'darwin', '--arch', 'x64'], { encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Unsupported PANGEA staging target: darwin\/x64/)
})
