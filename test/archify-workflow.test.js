import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileWorkflow } from '../vendor/archify/renderers/workflow/workflow-compiler.mjs'

function workflow() {
  return {
    schema_version: 2, diagram_type: 'workflow',
    meta: { title: 'CPU load calculation', quality_profile: 'showcase' },
    lanes: [{ id: 'cpu', label: 'CPU' }],
    groups: [{ id: 'calc', label: 'Calculation', lane: 'cpu', fromCol: 1, toCol: 2 }],
    nodes: [
      { id: 'calculate', lane: 'cpu', col: 1, type: 'backend', label: 'calculate_cpu_load_percentage', sublabel: 'total = 100, work = 50' },
      { id: 'validate', lane: 'cpu', col: 2, type: 'backend', label: 'validate_cpu_load_result', tag: '检查除零及计数器回绕边界' },
    ],
    edges: [{ id: 'calculated', from: 'calculate', to: 'validate' }],
  }
}

it('fits unpinned v2 function text before solving adjacent columns and group geometry', () => {
  const candidate = workflow(), original = structuredClone(candidate)
  const result = compileWorkflow({ workflow: candidate })
  expect(result.ok, JSON.stringify(result.receipt)).toBe(true)
  expect(candidate).toEqual(original)
  const [first, second] = result.receipt.nodes
  expect(first.width).toBeGreaterThan(92)
  expect(second.width).toBeGreaterThan(92)
  expect(second.x - first.x - first.width).toBeGreaterThanOrEqual(28)
  expect(result.receipt.diagnostics).toEqual([])
  expect(result.svg).toContain('calculate_cpu_load_percentage')
  expect(result.svg).toContain('检查除零及计数器回绕边界')
  expect(compileWorkflow({ workflow: { ...candidate, nodes: [...candidate.nodes].reverse() } }).receipt).toEqual(result.receipt)
})

it('keeps explicit width constraints and v1 validation intact', () => {
  const explicit = workflow()
  explicit.nodes[0].width = 92
  const constrained = compileWorkflow({ workflow: explicit })
  expect(constrained.ok).toBe(false)
  expect(JSON.stringify(constrained.receipt.diagnostics)).toContain('wider than node')
  const legacy = workflow()
  legacy.schema_version = 1
  delete legacy.groups
  legacy.nodes[0].col = 0
  legacy.nodes[1].col = 5
  expect(compileWorkflow({ workflow: legacy }).ok).toBe(false)
  legacy.nodes = legacy.nodes.map(node => ({ ...node, label: node.id, sublabel: '', tag: '' }))
  const fixed = compileWorkflow({ workflow: legacy })
  expect(fixed.ok, JSON.stringify(fixed.receipt)).toBe(true)
  expect(fixed.receipt.contract).toBe('fixed-v1')
  expect(fixed.receipt.nodes.map(node => node.width)).toEqual([92, 92])
})

it('continues to reject an undeclared terminal instead of repairing semantics', () => {
  const candidate = workflow()
  candidate.semanticChecks = { allowedRoots: ['calculate'], allowedTerminals: ['calculate'] }
  const result = compileWorkflow({ workflow: candidate })
  expect(result.ok).toBe(false)
  expect(JSON.stringify(result.receipt.diagnostics)).toContain('validate')
})

it('delivers normal function text while preserving the desktop readability gate and last good artifact', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'archify-width-'))
  try {
    const candidate = workflow(), input = path.join(folder, 'candidate.json'), output = path.join(folder, 'diagram.html')
    const cli = fileURLToPath(new URL('../vendor/archify/bin/archify.mjs', import.meta.url))
    const deliver = () => spawnSync(process.execPath, [cli, 'deliver', 'workflow', input, output, '--quality', 'showcase', '--json'], { encoding: 'utf8', timeout: 15000 })
    await writeFile(input, JSON.stringify(candidate))
    const first = deliver()
    expect(first.status, first.stderr || first.stdout).toBe(0)
    expect(JSON.parse(first.stdout).validation).toMatchObject({ checksPassed: 9, checkCount: 9, errors: 0, warnings: 0 })
    const good = await readFile(output, 'utf8')
    candidate.nodes[0].label = `function_${'parameter_'.repeat(50)}`
    await writeFile(input, JSON.stringify(candidate))
    const oversized = deliver()
    expect(oversized.status).toBe(1)
    expect(JSON.parse(oversized.stdout).diagnostics.some(item => item.code === 'composition/desktop-readability')).toBe(true)
    expect(await readFile(output, 'utf8')).toBe(good)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

for (const example of ['agent-tool-call', 'incident-response', 'release-delivery']) {
  it(`preserves compilation of the bundled ${example} workflow`, async () => {
    const candidate = JSON.parse(await readFile(new URL(`../vendor/archify/examples/${example}.workflow.json`, import.meta.url), 'utf8'))
    const result = compileWorkflow({ workflow: candidate })
    expect(result.ok, JSON.stringify(result.receipt)).toBe(true)
    expect(result.receipt.diagnostics).toEqual([])
  })
}
