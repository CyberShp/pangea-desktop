import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

it('separates unpinned nodes sharing a v2 lane and rank without changing topology', () => {
  const candidate = workflow()
  delete candidate.groups
  candidate.nodes[1].col = candidate.nodes[0].col
  candidate.edges = []
  const original = structuredClone(candidate)
  const result = compileWorkflow({ workflow: candidate })
  expect(result.ok, JSON.stringify(result.receipt)).toBe(true)
  expect(candidate).toEqual(original)
  const rows = [...result.receipt.nodes].sort((a, b) => a.y - b.y)
  expect(rows[1].y - rows[0].y - rows[0].height).toBeGreaterThanOrEqual(28)
  expect(result.receipt.edges).toHaveLength(0)
  expect(compileWorkflow({ workflow: { ...candidate, nodes: [...candidate.nodes].reverse() } }).receipt).toEqual(result.receipt)
  candidate.nodes.forEach(node => { node.yOffset = 0 })
  expect(compileWorkflow({ workflow: candidate }).ok).toBe(false)
  candidate.schema_version = 1
  candidate.nodes.forEach(node => { delete node.yOffset })
  expect(compileWorkflow({ workflow: candidate }).ok).toBe(false)
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

it('routes a real v2 self-call outside its node without a retraced segment', () => {
  const candidate = workflow()
  delete candidate.groups
  candidate.nodes = [candidate.nodes[0]]
  candidate.edges = [{ id: 'retry', from: 'calculate', to: 'calculate', label: 'retry' }]
  const original = structuredClone(candidate)
  const result = compileWorkflow({ workflow: candidate })
  expect(result.ok, JSON.stringify(result.receipt)).toBe(true)
  expect(candidate).toEqual(original)
  expect(result.receipt.edges).toHaveLength(1)
  const points = result.receipt.edges[0].points
  expect(points.length).toBeGreaterThanOrEqual(4)
  expect(points[0]).not.toEqual(points.at(-1))
  for (let i = 1; i < points.length - 1; i++) expect(points[i - 1]).not.toEqual(points[i + 1])
})

it('reports precise phase and node text fields while retaining complete failed-layout geometry', () => {
  const candidate = workflow()
  candidate.phases = [
    { id: 'first', label: 'First', fromCol: 0, toCol: 1 },
    { id: 'next', label: 'Next', fromCol: 1, toCol: 2 },
  ]
  candidate.nodes[0].width = 92
  candidate.nodes[0].sublabel = 'a long explanation that belongs in a card instead of this constrained node'
  const result = compileWorkflow({ workflow: candidate })
  expect(result.ok).toBe(false)
  expect(result.svg).toContain('<svg')
  expect(result.receipt.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'workflow/phase-overlap',
      subject: expect.objectContaining({ phase: 'next', path: '/phases/1/fromCol', conflictingPath: '/phases/0/toCol' }),
      evidence: expect.objectContaining({ minimumFromCol: 2, maximumEarlierToCol: 0 }) }),
    expect.objectContaining({ code: 'workflow/node-text-width',
      subject: expect.objectContaining({ node: 'calculate', field: 'sublabel', path: '/nodes/0/sublabel' }) }),
  ]))
})

it('preserves the verified artifact and marks failed-layout drafts in HTML and exported SVG', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'archify-draft-'))
  try {
    const candidate = workflow(), input = path.join(folder, 'candidate.json')
    const output = path.join(folder, 'diagram.html'), draft = path.join(folder, 'draft.html')
    const cli = fileURLToPath(new URL('../vendor/archify/bin/archify.mjs', import.meta.url))
    const deliver = (draftOutput = draft) => spawnSync(process.execPath,
      [cli, 'deliver', 'workflow', input, output, '--draft-output', draftOutput, '--quality', 'showcase', '--json'],
      { encoding: 'utf8', timeout: 15000 })
    await writeFile(input, JSON.stringify(candidate))
    const good = deliver()
    expect(good.status, good.stderr || good.stdout).toBe(0)
    expect(JSON.parse(good.stdout).draft).toBeUndefined()
    const verified = await readFile(output, 'utf8')
    candidate.phases = [{ id: 'first', label: 'First', fromCol: 0, toCol: 1 }, { id: 'next', label: 'Next', fromCol: 1, toCol: 2 }]
    await writeFile(input, JSON.stringify(candidate))
    const failed = deliver(), receipt = JSON.parse(failed.stdout)
    expect(failed.status).toBe(1)
    expect(receipt).toMatchObject({ ok: false, draft: { output: draft } })
    expect(receipt.draft.bytes).toBeGreaterThan(0)
    expect(receipt.draft.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(await readFile(output, 'utf8')).toBe(verified)
    const preview = await readFile(draft, 'utf8')
    expect(preview).toContain('<title>草稿 / DRAFT')
    expect(preview.match(/<svg\b[\s\S]*?<\/svg>/)?.[0]).toContain('data-draft-warning="true"')
    expect(preview).toContain('data-quality-profile="showcase"')
    const unsolved = structuredClone(candidate)
    unsolved.nodes = [unsolved.nodes[0]]
    delete unsolved.groups
    delete unsolved.phases
    unsolved.edges = [{ id: 'loop', from: 'calculate', to: 'calculate', fromSide: 'right', toSide: 'right' }]
    await writeFile(input, JSON.stringify(unsolved))
    const unsolvedDraft = path.join(folder, 'unsolved.html')
    const noRoute = deliver(unsolvedDraft)
    expect(noRoute.status).toBe(1)
    expect(JSON.parse(noRoute.stdout).draft).toBeUndefined()
    await expect(readFile(unsolvedDraft)).rejects.toMatchObject({ code: 'ENOENT' })
    candidate.edges[0].to = 'missing'
    await writeFile(input, JSON.stringify(candidate))
    const unrenderableDraft = path.join(folder, 'unrenderable.html')
    const invalid = deliver(unrenderableDraft)
    expect(invalid.status).toBe(1)
    expect(JSON.parse(invalid.stdout).draft).toBeUndefined()
    await expect(readFile(unrenderableDraft)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(output, 'utf8')).toBe(verified)
    const alias = deliver(output)
    expect(alias.status).toBe(1)
    expect(JSON.parse(alias.stdout).draft).toBeUndefined()
    expect(await readFile(output, 'utf8')).toBe(verified)
  } finally { await rm(folder, { recursive: true, force: true }) }
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
    const draft = path.join(folder, 'oversized-draft.html')
    const preview = spawnSync(process.execPath,
      [cli, 'deliver', 'workflow', input, output, '--quality', 'showcase', '--draft-output', draft, '--json'],
      { encoding: 'utf8', timeout: 15000 })
    expect(preview.status).toBe(1)
    expect(JSON.parse(preview.stdout)).toMatchObject({ ok: false, stage: 'check', draft: { output: draft } })
    expect(await readFile(output, 'utf8')).toBe(good)
    // Oversized text is not a layout problem: no column change passes the check.
    expect(JSON.parse(preview.stdout).diagnostics.some(item => item.evidence?.verifiedLayoutAlternative)).toBe(false)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 30000)

// Real round-2/3 business candidates: the only offered fixes (route/via/channel,
// "reduce the viewBox width", or none) could not converge, although a column
// change with measured sizing delivers the same lanes, nodes, edges and labels.
for (const [fixture, code] of [
  ['crossing-column-move', 'composition/proper-crossing'],
  ['viewbox-dead-end', 'workflow/viewbox-capacity'],
]) {
  it(`offers a render- and check-verified layout-only alternative for ${fixture}`, async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'archify-layout-'))
    try {
      const candidate = JSON.parse(await readFile(new URL(`./fixtures/archify-layout-alternative/${fixture}.workflow.json`, import.meta.url), 'utf8'))
      const input = path.join(folder, 'candidate.json'), output = path.join(folder, 'diagram.html')
      const cli = fileURLToPath(new URL('../vendor/archify/bin/archify.mjs', import.meta.url))
      const deliver = () => spawnSync(process.execPath, [cli, 'deliver', 'workflow', input, output, '--quality', 'showcase', '--json'], { encoding: 'utf8', timeout: 60000 })
      await writeFile(input, JSON.stringify(candidate))
      const failed = deliver(), receipt = JSON.parse(failed.stdout)
      expect(failed.status).toBe(1)
      const layout = receipt.diagnostics.find(item => item.code === code)
      const alternative = layout?.evidence.verifiedLayoutAlternative
      expect(alternative, failed.stdout).toBeDefined()
      expect(layout.supportedFixes[0]).toMatch(/^verified layout alternative: .*this exact candidate passed render and the final check\)$/)
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })

      const target = new Map(alternative.moves.map(move => [move.node, move.toCol]))
      const { viewBox, ...meta } = candidate.meta
      const repaired = {
        ...candidate,
        meta: alternative.omitViewBox ? meta : candidate.meta,
        nodes: candidate.nodes.map(({ width, ...node }) => ({
          ...node,
          ...(width !== undefined && !alternative.removeWidth?.includes(node.id) ? { width } : {}),
          col: target.get(node.id) ?? node.col,
        })),
      }
      const semantic = document => JSON.stringify({ ...document, meta: { ...document.meta, viewBox: undefined },
        nodes: document.nodes.map(({ col, width, ...node }) => node) })
      expect(semantic(repaired)).toBe(semantic(candidate))
      await writeFile(input, JSON.stringify(repaired))
      const delivered = deliver()
      expect(delivered.status, delivered.stdout).toBe(0)
      expect(JSON.parse(delivered.stdout).ok).toBe(true)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  }, 120000)
}

for (const mode of ['count', 'timeout']) it(`bounds layout alternative ${mode} without publishing an unaccepted candidate`, async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'archify-search-budget-'))
  try {
    const input = path.join(folder, 'candidate.json'), output = path.join(folder, 'diagram.html')
    const log = path.join(folder, 'probes.jsonl'), preload = path.join(folder, 'observe.mjs')
    const fixture = mode === 'count' ? 'viewbox-dead-end' : 'crossing-column-move'
    await writeFile(input, await readFile(new URL(`./fixtures/archify-layout-alternative/${fixture}.workflow.json`, import.meta.url)))
    // Exercise the real CLI and compiler. Only the external alternative renderer
    // is made unsuccessful or slow, so this tests its process/count boundary.
    await writeFile(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      import { appendFileSync } from 'node:fs';
      const original = cp.spawnSync;
      cp.spawnSync = (executable, args, options) => {
        if(args[1]?.endsWith('layout-alternative.json')) {
          appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, timeout: options.timeout })+'\\n');
          if(${JSON.stringify(mode)}==='timeout') return original(executable,['-e','setTimeout(()=>{},60000)'],options);
          return {status:1,stdout:'',stderr:'test renderer rejection'};
        }
        return original(executable,args,options);
      };
      syncBuiltinESMExports();
    `)
    const cli = fileURLToPath(new URL('../vendor/archify/bin/archify.mjs', import.meta.url))
    const started = Date.now()
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, cli, 'deliver', 'workflow', input, output, '--quality', 'showcase', '--json'], { encoding: 'utf8', timeout: 15000 })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status).toBe(1)
    expect(result.stdout, result.stderr).not.toBe('')
    const receipt = JSON.parse(result.stdout)
    expect(receipt.ok).toBe(false)
    expect(receipt.diagnostics.some(item => item.evidence?.verifiedLayoutAlternative)).toBe(false)
    const probes = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
    expect(probes).toHaveLength(mode === 'count' ? 3 : 1)
    if(mode === 'timeout') {
      expect(probes[0].timeout).toBeGreaterThan(0)
      expect(probes[0].timeout).toBeLessThanOrEqual(10000)
      expect(Date.now()-started).toBeLessThan(14000)
    }
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}, 20000)

for (const example of ['agent-tool-call', 'incident-response', 'release-delivery']) {
  it(`preserves compilation of the bundled ${example} workflow`, async () => {
    const candidate = JSON.parse(await readFile(new URL(`../vendor/archify/examples/${example}.workflow.json`, import.meta.url), 'utf8'))
    const result = compileWorkflow({ workflow: candidate })
    expect(result.ok, JSON.stringify(result.receipt)).toBe(true)
    expect(result.receipt.diagnostics).toEqual([])
  })
}
