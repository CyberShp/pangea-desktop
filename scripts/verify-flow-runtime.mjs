// Run against a built unpacked product. Fixtures are synthetic and retained for inspection.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { writeNativeDiagramFixture, verifyNativeDiagrams } from './native-diagram-smoke.mjs'

const [packageDirectory, evidenceDirectory] = process.argv.slice(2)
if (!packageDirectory || !evidenceDirectory) throw new Error('Usage: verify-flow-runtime.mjs <package-directory> <new-evidence-directory>')
const resources = path.resolve(packageDirectory, 'resources')
const evidence = path.resolve(evidenceDirectory)
await mkdir(evidence) // Require a new directory; never replace existing Runs or evidence.
const python = path.join(resources, 'pangea-python/python.exe')
const companion = path.join(resources, 'app/node_modules/dsh-pangea-companion')
function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
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

const fixture = await writeNativeDiagramFixture(evidence)
const exports = path.join(evidence, 'native-diagrams')
const rendered = await verifyNativeDiagrams(companion, fixture, exports)
for (const name of rendered.diagrams) {
  run(python, ['-c', 'import sys,xml.etree.ElementTree as ET; ET.parse(sys.argv[1]); print("SVG XML valid")', path.join(exports, `${name}.svg`)])
}
console.log(`PASS: packaged companion renders native flow, sequence and function diagrams; main Run and historical artifacts unchanged. ${JSON.stringify(rendered)}`)
