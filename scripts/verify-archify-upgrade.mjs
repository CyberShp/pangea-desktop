// Exercise the installed companion with an existing source-first Run, without a model.
// prepare runs before package replacement; verify never regenerates the input fixture.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const [mode, packageDirectory, dataDirectory] = process.argv.slice(2)
if (!['prepare', 'verify'].includes(mode) || !packageDirectory || !dataDirectory) throw new Error('Usage: verify-archify-upgrade.mjs prepare|verify <package> <data-root>')
const dataRoot = path.resolve(dataDirectory), resources = path.resolve(packageDirectory, 'resources')
const companionRoot = path.join(resources, 'app/node_modules/dsh-pangea-companion')
const receiptPath = path.join(dataRoot, 'archify-upgrade-fixture.json')
async function hashes(directory) {
  const result = {}
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name === '派生视图') continue
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await visit(file)
      else result[path.relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  await visit(directory)
  return result
}
if (mode === 'prepare') {
  await mkdir(dataRoot, { recursive: true })
  const { writeArchitectureRun } = await import(pathToFileURL(path.join(companionRoot, 'tests/architecture-source-first-fixture.mjs')))
  await assert.rejects(access(path.join(dataRoot, 'runs', 'tls-260917-01')))
  const fixture = await writeArchitectureRun(dataRoot)
  await writeFile(receiptPath, JSON.stringify({ ...fixture, hashes: await hashes(fixture.run) }))
} else {
  const fixture = JSON.parse(await readFile(receiptPath, 'utf8'))
  assert.equal(fixture.task.data_root, dataRoot, 'The installation path must remain stable during upgrade')
  await assert.rejects(access(path.join(fixture.run, '内部索引')))
  const { createView, listViews, viewArtifact } = await import(pathToFileURL(path.join(companionRoot, 'src/architecture-views.js')))
  const archify = path.join(resources, 'archify')
  const node = path.join(resources, 'app/node_modules/node/bin/node.exe')
  const created = await createView(fixture.task, { type: 'architecture', flow_id: fixture.flowId }, { PANGEA_ARCHIFY_ROOT: archify, PANGEA_NODE: node })
  const folder = path.join(fixture.run, '派生视图/archify', created.view.view_id)
  const context = JSON.parse(await readFile(path.join(folder, 'context.json'), 'utf8'))
  assert.equal(context.business_flows[0].nodes.length, 4)
  assert.equal(context.business_flows[0].paths.length, 2)
  const partial = await createView(fixture.task, { flow_id: fixture.flowId, branch_ids: ['reject'] }, { PANGEA_ARCHIFY_ROOT: archify })
  const partialContext = JSON.parse(await readFile(path.join(fixture.run, '派生视图/archify', partial.view.view_id, 'context.json'), 'utf8'))
  assert.deepEqual(partialContext.business_flows[0].nodes.map(n => n.id), ['A', 'C', 'D'])
  // Fixed candidate tests packaged rendering, not model reasoning quality.
  const candidate = JSON.parse(await readFile(path.join(archify, 'examples/web-app.architecture.json'), 'utf8'))
  candidate.meta.title = '补丁升级架构验收'
  await writeFile(path.join(folder, 'candidate.json'), JSON.stringify(candidate))
  const rendered = spawnSync(node, [path.join(companionRoot, 'src/architecture-render.mjs'), folder, archify], { encoding: 'utf8', timeout: 150000, env: { ...process.env, ARCHIFY_UPDATE_CHECK_DISABLED: '1' } })
  assert.equal(rendered.status, 0, rendered.error?.message || rendered.stderr || rendered.stdout)
  assert.equal(JSON.parse(rendered.stdout).ok, true)
  assert.match((await viewArtifact(fixture.task, created.view.view_id, 'html')).toString(), /补丁升级架构验收/)
  assert.match((await viewArtifact(fixture.task, created.view.view_id, 'svg')).toString(), /<svg/)
  assert.equal((await listViews(fixture.task)).find(v => v.view_id === created.view.view_id).status, 'ready')
  assert.deepEqual(await hashes(fixture.run), fixture.hashes, 'Main Run inputs/results changed')
  await assert.rejects(access(path.join(fixture.run, '内部索引')))
  console.log('PASS: patched companion reads existing source-first Run, scopes paths and renders HTML/SVG without legacy index; main Run unchanged. Model generation not exercised.')
}
