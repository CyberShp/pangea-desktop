// Run against a built unpacked product. Fixtures are synthetic and retained for inspection.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [packageDirectory, evidenceDirectory] = process.argv.slice(2)
if (!packageDirectory || !evidenceDirectory) throw new Error('Usage: verify-flow-runtime.mjs <package-directory> <new-evidence-directory>')
const resources = path.resolve(packageDirectory, 'resources')
const evidence = path.resolve(evidenceDirectory)
await mkdir(evidence) // Require a new directory; never replace existing Runs or evidence.
const python = path.join(resources, 'pangea-python/python.exe')
const node = path.join(resources, 'app/node_modules/node/bin/node.exe')
const companion = path.join(resources, 'app/node_modules/dsh-pangea-companion/src')
const archify = path.join(resources, 'archify')
function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', ARCHIFY_UPDATE_CHECK_DISABLED: '1' },
  })
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout)
  return result.stdout
}
const pythonProbe = String.raw`
import json, sys, unittest
from pathlib import Path
import openpyxl
import pangea_agent
from pangea_agent.documents.coverage_input import read_input, gap_records
root, resources, regression = map(Path, sys.argv[1:])
assert Path(pangea_agent.__file__).resolve().is_relative_to(resources.resolve())
# Execute existing synthetic regressions against this packaged import, without source checkout injection.
source = regression.read_text(encoding='utf-8')
source = source.replace('sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))', '')
namespace = {'__name__': 'packaged_regression', '__file__': str(regression)}
exec(compile(source, str(regression), 'exec'), namespace)
result = unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(namespace['CoverageTests']))
assert result.wasSuccessful()
combined = namespace['fixture']()
report = root / 'combined-bom.json'
report.write_text(json.dumps(combined, ensure_ascii=False), encoding='utf-8-sig')
assert len(gap_records(read_input(report))) == 5
book = openpyxl.Workbook()
book.active.append(['source','file_path','kind','count','function','line','block','branch'])
book.active.append(['合成来源','中文路径.c','function',0,'未命中',None,None,None])
book.active.append(['合成来源','中文路径.c','branch','-',None,1,'0','1'])
table = root / 'coverage.xlsx'
book.save(table)
parsed = read_input(table)
assert len(gap_records(parsed)) == 1
assert len(parsed['unknown_records']) == 1
skills = resources / 'pangea-runtime/src/pangea_agent/skill_packages'
for name in ['codetalks-skill', 'codetalks-coverage-skill']:
    assert (skills / name / 'SKILL.md').is_file(), name
print(json.dumps({'python':sys.version, 'module':pangea_agent.__file__, 'regression_tests':result.testsRun,'bom_json':'pass','xlsx':'pass','skills':'pass'},ensure_ascii=False))
`
const regression = path.resolve(import.meta.dirname, '../.pangea-build/sources/pangea-agent/scripts/verify_coverage_analysis.py')
const pythonResult = run(python, ['-c', pythonProbe, evidence, resources, regression])
await writeFile(path.join(evidence, 'python-result.json'), pythonResult)
console.log(pythonResult.trim())

const { createView, listViews, viewArtifact, updateView } = await import(pathToFileURL(path.join(companion, 'architecture-views.js')))
const task = { task_id: 'flow-runtime-check', run_id: 'synthetic-run', data_root: evidence, target: '中文架构验收' }
const index = path.join(evidence, 'runs', task.run_id, '内部索引')
await mkdir(index, { recursive: true })
const projection = JSON.stringify({ run_id: task.run_id, publication: { revision: 1 }, business_flows: [], risks: [], test_cases: [], evidence: [] })
await writeFile(path.join(index, '工作台投影.json'), projection)
await writeFile(path.join(index, '运行状态.json'), 'main-run-unchanged')
const prepared = await createView(task, { type: 'architecture' }, { PANGEA_ARCHIFY_ROOT: archify, PANGEA_NODE: node })
const viewFolder = path.join(evidence, 'runs', task.run_id, '派生视图/archify', prepared.view.view_id)
const candidate = JSON.parse(await readFile(path.join(archify, 'examples/web-app.architecture.json'), 'utf8'))
candidate.meta.title = '中文架构验收 · 合成示例'
await writeFile(path.join(viewFolder, 'candidate.json'), JSON.stringify(candidate))
const receipt = JSON.parse(run(node, [path.join(companion, 'architecture-render.mjs'), viewFolder, archify]))
assert.equal(receipt.ok, true)
assert.equal((await listViews(task))[0].status, 'ready')
const html = await viewArtifact(task, prepared.view.view_id, 'html')
assert.match(html.toString(), /中文架构验收/)
await writeFile(path.join(evidence, 'export.html'), html)
await writeFile(path.join(evidence, 'export.svg'), await viewArtifact(task, prepared.view.view_id, 'svg'))
run(python, ['-c', 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1]); print("SVG XML valid")', path.join(evidence, 'export.svg')])
const revision = await createView(task, { type: 'architecture', previous_view_id: prepared.view.view_id }, { PANGEA_ARCHIFY_ROOT: archify, PANGEA_NODE: node })
await updateView(task, revision.view.view_id, { status: 'failed', error: 'synthetic follow-up failure' })
assert.equal((await listViews(task)).find(view => view.view_id === prepared.view.view_id).status, 'ready')
assert.equal(await readFile(path.join(index, '工作台投影.json'), 'utf8'), projection)
assert.equal(await readFile(path.join(index, '运行状态.json'), 'utf8'), 'main-run-unchanged')
console.log('PASS: packaged Node/Archify renders Chinese HTML and valid SVG; failed revision preserves good view and main Run.')
