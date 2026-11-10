// Cross-repository test using the real companion API and Python CLI; no model provider.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

if (!process.env.PANGEA_COMPANION_ROOT || !process.env.PANGEA_PYTHON) {
  throw new Error('PANGEA_COMPANION_ROOT and PANGEA_PYTHON must identify the isolated test components')
}
const base = process.env.PANGEA_COMPANION_ROOT
const { createRun, runPangea } = await import(pathToFileURL(path.join(base, 'src/pangea-api.js')))
const { previewScope, confirmScope } = await import(pathToFileURL(path.join(base, 'src/repositories/scope.js')))

test('companion previews, confirms and starts Python+C+sh/Bash as one Run', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pangea-mixed-plugin-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, '.agents/pangea'), { recursive: true })
  await writeFile(path.join(root, '.agents/pangea/dsh.md'), '# Isolated integration fixture')
  const dataRoot = path.join(root, 'pangea-data')
  const repo = path.join(dataRoot, 'repositories/demo')
  await mkdir(path.join(repo, 'src'), { recursive: true })
  for (const [name, body] of Object.entries({
    'worker.c': 'int main(void) { return 0; }\n',
    'bridge.py': 'import subprocess\nsubprocess.run(["./worker"], check=True)\n',
    launch: '#!/bin/sh\npython3 bridge.py "$@"\n',
  })) await writeFile(path.join(repo, 'src', name), body)
  const capabilities = await runPangea({ cwd: root, args: ['system', 'capabilities', '--data-root', dataRoot] })
  assert.equal(capabilities.mixed_language_analysis, true)
  assert.deepEqual(capabilities.shell_dialects, ['sh', 'bash'])
  const input = { cwd: root, dataRoot, repository: 'demo', source_scope: ['src'] }
  const preview = await previewScope(input, runPangea)
  assert.equal(preview.matched_file_count, 3)
  assert.deepEqual(preview.analysis_languages, ['c_cpp', 'python', 'shell'])
  const confirmed = await confirmScope({ ...input, scope_preview_id: preview.preview_id,
    expected_scope_revision: preview.scope_revision }, runPangea)
  const run = await createRun(root, { repository: 'demo', data_root: dataRoot,
    target: 'Follow launch through Python to the C executable', source_scope: confirmed.normalized_scope,
    expected_scope_revision: confirmed.scope_revision, analysis_profile: 'behavior-test-v2',
    scenario: 'module-analysis', mode: 'speed' })
  const runRoot = path.join(dataRoot, 'runs', run.run_id)
  const manifest = JSON.parse(await readFile(path.join(runRoot, 'inputs/source-manifest.json')))
  assert.equal(manifest.analysis_language, 'mixed')
  assert.deepEqual(manifest.analysis_languages, ['c_cpp', 'python', 'shell'])
  assert.equal(manifest.file_languages.length, 3)
  const progress = JSON.parse(await readFile(path.join(runRoot, 'progress.json')))
  assert.equal(progress.stage, 'planning')
  assert.notEqual(progress.lifecycle_status, 'complete')
})
