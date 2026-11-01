import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'

const cwd = process.env.PANGEA_TEST_ACP_CWD, evidence = process.env.PANGEA_TEST_EVIDENCE_DIR
const companion = process.env.PANGEA_TEST_COMPANION_ROOT, runtime = process.env.PANGEA_INTEGRATION_RUNTIME
const python = process.env.PANGEA_PYTHON, model = process.env.PANGEA_TEST_ACP_MODEL
assert.ok([cwd, evidence, companion, runtime, python, model].every(Boolean))
assert.ok(path.isAbsolute(cwd) && path.isAbsolute(evidence))
mkdirSync(evidence) // A fresh evidence directory; never overwrite a previous attempt.
const json = file => JSON.parse(readFileSync(file, 'utf8'))
const save = (name, value) => writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2))
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const fileHashes = root => Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(root, entry.name)
  return entry.isDirectory() ? Object.entries(fileHashes(file)) : [[file, sha(file)]]
}))
const created = json(path.join(cwd, 'created.json')), runRoot = path.join(created.data_root, 'runs', created.run_id)
const progressBefore = json(path.join(runRoot, 'progress.json'))
const bindingsBefore = json(path.join(runRoot, 'acp-workers.json'))
const review = Object.values(progressBefore.actions).find(action => action.stage === 'comparison_review')
assert.ok(review?.task_id && review.status !== 'accepted')
const reviewer = bindingsBefore.workers[review.task_id]
assert.ok(reviewer?.remoteSessionId)
const frozenBefore = fileHashes(path.join(runRoot, 'inputs'))
const resultsBefore = Object.fromEntries(readdirSync(path.join(runRoot, 'agent-results/source-first')).filter(n => n.endsWith('.json')).map(n => [n, json(path.join(runRoot, 'agent-results/source-first', n))]))
save('progress-before.json', progressBefore); save('bindings-before.json', bindingsBefore); save('results-before.json', resultsBefore); save('frozen-input-hashes.json', frozenBefore)
save('code-provenance.json', { model, companionSource: path.join(companion, 'src/source-first-acp.js'), companionSha256: sha(path.join(companion, 'src/source-first-acp.js')), runtime })
process.env.PYTHONPATH = path.join(runtime, 'src')
const { runPangea, resumeRun } = await import(pathToFileURL(path.join(companion, 'src/pangea-api.js')))
const { createSourceFirstAcpRun } = await import(pathToFileURL(path.join(companion, 'src/source-first-acp.js')))
const { companionSnapshot } = await import(pathToFileURL(path.join(companion, 'src/reader.js')))
const context = new Context(), subprocess = new LocalSubprocessRuntime(context), controller = new AbortController()
const workers = [], events = []
const record = event => { const row = { at: new Date().toISOString(), ...event }; events.push(row); appendFileSync(path.join(evidence, 'events.jsonl'), JSON.stringify(row) + '\n') }
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const parent = { id: 'isolated-review-delivery-recovery', session: { header: { cwd } } }
async function start(request, phase = 'host') {
  const listenPort = await port(), password = randomBytes(24).toString('hex')
  const env = { OPENCODE_SERVER_PASSWORD: password, PYTHONPATH: path.join(runtime, 'src') }
  for (const key of ['OPENCODE_CONFIG_CONTENT', ...(process.env.PANGEA_TEST_ACP_FORWARD_ENV || '').split(',').filter(Boolean)]) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = path.join(cwd, 'opencode', key.toLowerCase())
  let provider
  apply({ logger: { warn: message => record({ type: 'provider_warning', message }) }, subprocess, subagents: { registerProvider: p => { provider = p } } }, Config({ providerName: 'pangea-opencode', command: 'opencode', args: ['acp', '--port', String(listenPort), '--hostname', '127.0.0.1'], cwd, env, permission: 'allow', disposeEofGraceMs: 3000, disposeGraceMs: 1000 }))
  const worker = await provider.start({ ...request, onSessionEvent: event => { record({ ...event, phase }); request.onSessionEvent?.(event) } })
  workers.push(worker)
  worker.api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listenPort}${route}?directory=${encodeURIComponent(cwd)}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal })
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    return response.json()
  }
  return worker
}
let host
const timer = setTimeout(() => controller.abort(new Error('Review recovery observation timed out')), Number(process.env.PANGEA_TEST_TIMEOUT_MS ?? 1800000))
const stop = () => controller.abort(new Error('Review recovery explicitly stopped'))
process.once('SIGTERM', stop); process.once('SIGINT', stop)
try {
  // Compact the same persisted reviewer. No task/result/semantic edits and no host prompt.
  const manual = await start({ parent, signal: controller.signal, resume: { taskId: review.task_id, remoteSessionId: reviewer.remoteSessionId }, prompt: [], agentOptions: { model } }, 'manual_compact')
  assert.equal(manual.id, review.task_id); assert.equal(manual.remoteSessionId, reviewer.remoteSessionId)
  const route = `/session/${reviewer.remoteSessionId}`
  const before = await manual.api(route + '/message'); save('messages-before-compact.json', before)
  const [providerID, ...modelParts] = model.split('/')
  assert.equal(await manual.api(route + '/summarize', { providerID, modelID: modelParts.join('/'), auto: false }), true)
  const after = await manual.api(route + '/message'); save('messages-after-compact.json', after)
  const oldIds = new Set(before.map(m => m.info.id)), newIds = new Set(after.map(m => m.info.id))
  assert.ok([...oldIds].every(id => newIds.has(id)))
  const newMessages = after.filter(m => !oldIds.has(m.info.id))
  assert.ok(newMessages.some(m => m.info.summary === true && m.info.finish === 'stop' && !m.info.error && m.info.modelID === modelParts.join('/')))
  const compactParts = newMessages.flatMap(m => m.parts ?? []).filter(p => p.type === 'compaction')
  assert.equal(compactParts.length, 1); assert.equal(compactParts[0].auto, false)
  for (const [name, result] of Object.entries(resultsBefore)) assert.deepEqual(json(path.join(runRoot, 'agent-results/source-first', name)), result)
  assert.equal(events.filter(e => e.type === 'prompt').length, 0)
  await manual.dispose()
  console.log(JSON.stringify({ stage: 'manual_compact_complete', taskId: review.task_id, remoteSessionId: reviewer.remoteSessionId }))
  const resumed = await resumeRun(cwd, { dataRoot: created.data_root, runId: created.run_id, hostQuiescent: true }); save('resume-request.json', resumed)
  assert.deepEqual(resumed.agent_actions.map(a => [a.action_id, a.task_id]), [[review.action_id, review.task_id]])
  host = createSourceFirstAcpRun({ providerId: 'pangea-opencode', agentModel: model, parent, cwd, dataRoot: created.data_root, runId: created.run_id, signal: controller.signal, runner: runPangea, python, mode: 'speed', subagents: { start: (_, request) => start(request) }, onEvent: event => { record({ type: 'host_event', ...event }); if (['source_first_worker_started', 'source_first_worker_finished', 'source_first_action_settled', 'source_first_worker_paused'].includes(event.stage)) console.log(JSON.stringify(event)) } })
  const outcome = await host.result; save('host-final.json', outcome); assert.equal(outcome.attentionRequired, false)
  const state = await runPangea({ cwd, args: ['runs', 'get', '--data-root', created.data_root, '--run-id', created.run_id] }); save('final-run.json', state)
  assert.equal(state.lifecycle_status, 'complete')
  for (const [name, beforeResult] of Object.entries(resultsBefore)) {
    const now = json(path.join(runRoot, 'agent-results/source-first', name))
    const expectedBinding = { ...beforeResult.binding }
    // Graph creates an empty skeleton before the first worker write binds it.
    // Only that unbound, empty review skeleton may acquire the already-known task.
    if (beforeResult.binding.action_id === review.action_id && beforeResult.binding.task_id === 'pending') {
      assert.equal(beforeResult.revision, 0); assert.equal(beforeResult.records.length, 0); assert.equal(beforeResult.completion, null)
      expectedBinding.task_id = review.task_id
    }
    assert.deepEqual(now.binding, expectedBinding)
    for (const record of beforeResult.records) assert.deepEqual(now.records.find(r => r.record_id === record.record_id), record)
    if (beforeResult.binding.action_id !== review.action_id) assert.deepEqual(now, beforeResult)
  }
  for (const [file, digest] of Object.entries(frozenBefore)) assert.equal(sha(file), digest)
  const bindings = json(path.join(runRoot, 'acp-workers.json')); save('bindings-final.json', bindings)
  for (const [id, old] of Object.entries(bindingsBefore.workers)) assert.equal(bindings.workers[id].remoteSessionId, old.remoteSessionId)
  assert.equal(events.filter(e => e.type === 'prompt' && e.agent_session_id === review.task_id).length, 1)
  assert.equal(events.filter(e => e.stage === 'source_first_worker_paused').length, 0)
  assert.equal(events.filter(e => ['source_first_recovering', 'source_first_tool_recovery', 'source_first_zero_tool_turn'].includes(e.stage)).length, 0)
  const snapshot = await companionSnapshot({ dataRoot: created.data_root, runId: created.run_id }); save('snapshot-final.json', snapshot)
  assert.equal(snapshot.current.report_available, true); assert.equal(snapshot.current.reader_health.trusted, true)
  const reports = Object.fromEntries(['report.md', 'report.html', 'report-complete.json'].map(name => [name, sha(path.join(runRoot, name))]))
  save('verified-summary.json', { passed: true, runId: created.run_id, model, reviewTaskId: review.task_id, reviewRemoteSessionId: reviewer.remoteSessionId, originalRecordsPreserved: true, frozenInputsUnchanged: true, reviewResumePrompts: 1, unexpectedPauses: 0, reportAvailable: true, qualityStatus: state.quality_status, reports })
  console.log(JSON.stringify({ stage: 'verified', reportRoot: runRoot, qualityStatus: state.quality_status }))
} catch (error) {
  save('failure.json', { name: error.name, message: error.message, stack: error.stack }); console.error(error); process.exitCode = 1
} finally {
  clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop)
  await host?.dispose(); for (const worker of workers) await worker.dispose(); await context.fiber.dispose()
  save('process-cleanup.json', workers.map(w => ({ taskId: w.id, remoteSessionId: w.remoteSessionId, processExited: w.readDiagnostics().processExited })))
}
