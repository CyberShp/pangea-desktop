// Model-free packaged regression: Agent facts are stored once; the host only reads and renders.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export async function directoryHashes(directory) {
  const result = {}
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await visit(file)
      else result[path.relative(directory, file)] = createHash('sha256').update(await readFile(file)).digest('hex')
    }
  }
  await visit(directory)
  return result
}

export async function writeNativeDiagramFixture(dataRoot) {
  const runId = 'native-diagram-upgrade-01', unit = 'tls', actionId = `${runId}:analysis:${unit}`
  const run = path.join(dataRoot, 'runs', runId)
  await assert.rejects(access(run), { code: 'ENOENT' })
  const taskPath = path.join(run, 'agent-tasks/analysis.json')
  const resultPath = path.join(run, 'agent-results/analysis.json')
  const json = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2)) }
  const sequence = {
    format_version: 'sequence-v1', title: '连接请求时序', status: 'ready',
    participants: [{ id: 'host', label: '主机' }, { id: 'target', label: '阵列' }],
    messages: [
      { id: 'request', from: 'host', to: 'target', label: '建立连接', kind: 'call', source_evidence: ['repo:tls.c:1'] },
      { id: 'accept', from: 'target', to: 'host', label: '接受连接', kind: 'return', source_evidence: ['repo:tls.c:2'] },
      { id: 'reject', from: 'target', to: 'host', label: '拒绝连接', kind: 'return', source_evidence: ['repo:tls.c:3'] },
    ],
    fragments: [{ id: 'decision', kind: 'alt', label: '协商结果', operands: [
      { condition: '条件满足', message_ids: ['accept'] }, { condition: '条件不满足', message_ids: ['reject'] },
    ] }], notes: ['合成验收数据，不代表真实协议实现。'],
  }
  const call_graph = {
    format_version: 'call-graph-v1', title: '连接函数与变量', status: 'ready', root: 'tls_open',
    functions: [
      { id: 'tls_open', kind: 'function', label: 'tls_open', signature: 'int tls_open(void)', file: 'tls.c', line: 1 },
      { id: 'tls_check', kind: 'function', label: 'tls_check', signature: 'int tls_check(void)', file: 'tls.c', line: 2 },
    ], calls: [{ from: 'tls_open', to: 'tls_check', file: 'tls.c', line: 1, args: [], returns: 'result' }],
    variables: [{ function: 'tls_open', name: 'result', reads: [], compute: 'tls_check()', writes: 'result', line: 1 }], notes: [],
  }
  const flow = {
    format_version: 'behavior-flow-v1', flow_id: 'tls-flow', title: '连接流程', role: 'main', attach_to: null,
    nodes: [ { id: 'A', kind: 'entry', label: '收到请求' }, { id: 'B', kind: 'exit', label: '处理完成' } ],
    edges: [{ source_step_key: 'A', target_step_key: 'B', condition: '' }],
    paths: [{ path_id: 'normal', node_ids: ['A', 'B'] }], source_evidence: ['repo:tls.c:1'], sequence, call_graph,
  }
  const records = [
    { record_id: 'flow', kind: 'flow', body: flow, evidence: ['repo:tls.c:1'] },
    { record_id: 'legacy', kind: 'flow', body: { ...flow, flow_id: 'legacy', title: '旧流程', sequence: undefined, call_graph: undefined }, evidence: [] },
  ]
  await json(path.join(run, 'inputs/task-contract.json'), { workflow_version: 'source-first-v1', target: 'TLS', repository: 'repo' })
  await json(path.join(run, 'inputs/source-manifest.json'), { workflow_version: 'source-first-v1', repositories: [{ repo_id: 'repo', source_root: path.join(run, 'inputs/repo') }], requested_scope: ['tls.c'] })
  await json(path.join(run, 'inputs/source-index.json'), { format_version: 'pangea-source-index-v1', files: [{ repo_id: 'repo', path: 'tls.c' }], file_count: 1 })
  await mkdir(path.join(run, 'inputs/repo'), { recursive: true })
  await writeFile(path.join(run, 'inputs/repo/tls.c'), 'int tls_open(void) { int result = tls_check(); return result; }\nint tls_check(void) { return 0; }\n/* synthetic refusal branch */\n')
  await json(taskPath, { unit_id: unit, result_path: resultPath, task_type: 'source_first_analysis' })
  await json(resultPath, { format_version: 'pangea-notes-v1', binding: { run_id: runId, action_id: actionId, task_id: 'worker' }, revision: 1, records })
  await json(path.join(run, 'progress.json'), { run_id: runId, workflow_version: 'source-first-v1', lifecycle_status: 'complete', stage: 'complete',
    actions: { [actionId]: { stage: 'unit_analysis', role: 'analysis', task_path: taskPath, task_id: 'worker', status: 'accepted' } }, accepted_revisions: { [actionId]: 1 } })
  await writeFile(path.join(run, 'report.md'), '# Existing analysis report\n')
  await writeFile(path.join(run, 'report.html'), '<h1>Existing analysis report</h1>')
  await json(path.join(run, 'report-complete.json'), { files: ['report.md', 'report.html'] })
  const historical = path.join(run, '派生视图/archify/historical-view')
  await mkdir(historical, { recursive: true })
  await writeFile(path.join(historical, 'diagram.html'), '<!doctype html><meta charset="utf-8"><h1>历史图表</h1><svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(path.join(historical, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>历史图表</title></svg>')
  return { task: { task_id: 'native-diagram-upgrade', run_id: runId, data_root: dataRoot, target: 'TLS' }, run, resultPath, actionId, flowId: `${unit}/flow`, sequence, call_graph }
}

export async function verifyNativeDiagrams(companionRoot, fixture, outputDirectory) {
  const load = file => import(pathToFileURL(path.join(companionRoot, 'src', file)).href)
  const [{ summarizeRun }, { layoutFlow, layoutCallGraph }, { renderFlowTree, renderCallGraphTree, toSvgString }, { validateCallGraph }, sequence] = await Promise.all([
    load('reader.js'), load('flow-graph/layout.js'), load('flow-graph/render.js'), load('call-graph.js'), load('sequence-diagram.js'),
  ])
  const before = await directoryHashes(fixture.run)
  const summary = await summarizeRun(fixture.task.data_root, fixture.task.run_id, { includeDetails: true })
  const flow = summary.details.business_flows.find(item => item.flow_id === fixture.flowId)
  assert.ok(flow, 'Published flow was not projected')
  assert.deepEqual(flow.sequence, fixture.sequence, 'Sequence facts changed during projection')
  assert.deepEqual(flow.call_graph, fixture.call_graph, 'Function facts changed during projection')
  const legacy = summary.details.business_flows.find(item => item.flow_id === 'tls/legacy')
  assert.ok(legacy, 'Legacy flow was lost')
  assert.equal(legacy.sequence, undefined, 'Legacy sequence facts must not be fabricated')
  assert.equal(legacy.call_graph, undefined, 'Legacy function facts must not be fabricated')
  const seq = sequence.normalizeSequence(flow.sequence)
  assert.deepEqual(seq.errors, [])
  const call = validateCallGraph(flow.call_graph)
  assert.equal(call.status, 'ok')
  const trees = {
    flow: renderFlowTree(layoutFlow(flow, { expandAll: true })),
    sequence: sequence.renderSequenceTree(sequence.layoutSequence(seq.graph)),
    functions: renderCallGraphTree(layoutCallGraph(call.graph)),
  }
  await mkdir(outputDirectory, { recursive: true })
  for (const [name, tree] of Object.entries(trees)) {
    const svg = toSvgString(tree)
    assert.match(svg, /<svg\b/)
    assert.doesNotMatch(svg, /NaN|undefined/)
    await writeFile(path.join(outputDirectory, `${name}.svg`), svg)
    await writeFile(path.join(outputDirectory, `${name}.html`), `<!doctype html><meta charset="utf-8"><title>${name}</title>${svg}`)
  }
  assert.match(toSvgString(trees.sequence), /接受连接/)
  assert.match(toSvgString(trees.sequence), /拒绝连接/)
  assert.match(toSvgString(trees.functions), /tls_open/)
  assert.deepEqual(await directoryHashes(fixture.run), before, 'Reading/rendering modified source Run or historical diagrams')
  return { status: 'ok', flowId: flow.flow_id, diagrams: Object.keys(trees), legacyFactsPreserved: true, runUnchanged: true }
}
