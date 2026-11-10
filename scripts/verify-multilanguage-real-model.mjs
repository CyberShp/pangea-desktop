import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Each invocation owns a new workspace. No continuation, fault injection,
// semantic record writing, or result-state repair is performed by this driver.
const opt = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  assert.ok(key.startsWith('--'), `Unexpected argument ${key}`)
  if (key === '--preflight') opt.preflight = true
  else { assert.ok(process.argv[i + 1], `Missing ${key}`); opt[key.slice(2)] = process.argv[++i] }
}
const required = (key, env) => { const value = opt[key] || process.env[env]; assert.ok(value, `Missing --${key} / ${env}`); return value }
const cwd = path.resolve(required('workspace', 'PANGEA_TEST_ACP_CWD'))
const runtime = path.resolve(required('runtime', 'PANGEA_INTEGRATION_RUNTIME'))
const companion = path.resolve(required('companion', 'PANGEA_TEST_COMPANION_ROOT'))
const desktop = path.resolve(opt.desktop || process.env.PANGEA_TEST_DESKTOP_ROOT || '/Volumes/Media/pangea-desktop')
const python = path.resolve(required('python', 'PANGEA_PYTHON'))
const fixture = 'multilanguage-quota'
const fixtureRoot = path.resolve(opt['fixture-root'] || path.join(desktop, 'scripts/fixtures/multilanguage-quota'))
const mode = opt.mode || 'speed'
assert.ok(['speed', 'depth'].includes(mode))
const arm = opt.arm || 'unspecified'
const profile = opt.profile || 'behavior-test-v2'
assert.ok(['behavior-test-v1', 'behavior-test-v2'].includes(profile))
const model = 'minimax-ab/MiniMax-M2.7'
const modelLimit = { context: 204800, output: 131072 }
const timeoutMs = Number(opt['timeout-ms'] || process.env.PANGEA_TEST_TIMEOUT_MS || 7200000)
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0)
assert.ok(existsSync(python) && existsSync(path.join(runtime, 'src/pangea_agent/cli/main.py')))
assert.ok(!existsSync(cwd), `Refusing existing workspace: ${cwd}`)
mkdirSync(cwd, { recursive: true })
const evidenceRoot = path.join(cwd, '.harness'); mkdirSync(evidenceRoot)
const dataRoot = path.join(cwd, 'pangea-data')
for (const dir of ['.agents', 'docs']) cpSync(path.join(runtime, dir), path.join(cwd, dir), { recursive: true })
writeFileSync(path.join(cwd, 'AGENTS.md'), `This is an isolated PANGEA acceptance workspace on macOS. Use bash/zsh for the specified Python CLI, omitting PowerShell's leading &. Python: ${python}. All semantic records must be authored by the current model through the real PANGEA CLI under the current frozen task contract. Do not edit frozen inputs, progress files, task identities, or result envelopes. Do not create worker agents. Use worker-scratch for executable probes; do not modify frozen source files.\n`, { flag: 'wx' })
const repo = path.join(dataRoot, 'repositories', 'sample')
const selectedModule = path.join(repo, 'module'); mkdirSync(selectedModule, { recursive: true })
cpSync(path.join(fixtureRoot, 'source'), selectedModule, { recursive: true })
const fixtureRequest = JSON.parse(readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8'))
const request = { repository: 'sample', ...fixtureRequest, source_scope: ['module'], data_root: dataRoot, mode, effective_context_budget: 196608,
  analysis_profile: profile, ...(profile === 'behavior-test-v2' ? { scenario: 'module-analysis', objective: 'product-behavior' } : {}) }
Object.assign(process.env, { PANGEA_PYTHON: python, PANGEA_RUNTIME_ROOT: runtime, PANGEA_WORKSPACE_ROOT: cwd,
  PANGEA_DATA_ROOT: dataRoot, PANGEA_WORKER_TRANSPORT: 'desktop-cli', PYTHONPATH: path.join(runtime, 'src'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' })
const requireDesktop = createRequire(path.join(desktop, 'package.json'))
const providerModule = requireDesktop.resolve('@deepseek-ai/dsh-subagent-acp')
const { Context } = await import(requireDesktop.resolve('@deepseek-ai/cordis'))
const { LocalSubprocessRuntime } = await import(requireDesktop.resolve('@deepseek-ai/dsh-subprocess-local'))
const { apply, Config } = await import(providerModule)
const { createRun, runPangea } = await import(pathToFileURL(path.join(companion, 'src/pangea-api.js')))
const { createSourceFirstAcpRun } = await import(pathToFileURL(path.join(companion, 'src/source-first-acp.js')))
const { companionSnapshot } = await import(pathToFileURL(path.join(companion, 'src/reader.js')))
const sha = data => createHash('sha256').update(data).digest('hex')
const fileSha = f => sha(readFileSync(f))
const sourceHashes = (root, prefix = '') => Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory()
  ? Object.entries(sourceHashes(path.join(root, e.name), `${prefix}${e.name}/`)) : [[`${prefix}${e.name}`, fileSha(path.join(root, e.name))]]))
const save = (name, value) => writeFileSync(path.join(evidenceRoot, name), JSON.stringify(value, null, 2))
const fingerprints = Object.fromEntries([providerModule, path.join(companion, 'src/source-first-acp.js'), path.join(companion, 'src/pangea-api.js'), path.join(runtime, 'src/pangea_agent/graph/nodes/source_first.py'), path.join(runtime, 'docs/source-first-cli-worker.md')].map(f => [f, fileSha(f)]))
const capabilities = await runPangea({ cwd, args: ['system', 'capabilities', '--data-root', dataRoot] })
const provenance = { arm, fixture, mode, profile, model, model_limit: modelLimit, cwd, runtime, companion, desktop, python, timeout_ms: timeoutMs,
  request, fixture_source_sha256: sourceHashes(repo), fingerprints, provider_module: providerModule,
  isolation: 'new cwd/data/XDG; no fault injection; no global profile mutation; not an OS sandbox', semantic_acceptance: 'requires independent result review' }
save('provenance.json', provenance); save('capabilities.json', capabilities)
if (opt.preflight) {
  const created = await createRun(cwd, request)
  save('preflight-created.json', created)
  assert.ok(created.run_id && created.workflow_version === 'source-first-v1', 'createRun must allocate a real source-first Run')
  const runRoot = path.join(created.data_root, 'runs', created.run_id)
  const frozenManifest = JSON.parse(readFileSync(path.join(runRoot, 'inputs/source-manifest.json'), 'utf8'))
  assert.equal(frozenManifest.analysis_profile, profile, 'createRun must freeze the requested profile')
  if (profile === 'behavior-test-v2') {
    const scene = JSON.parse(readFileSync(path.join(runRoot, 'inputs/analysis-scene.json'), 'utf8'))
    save('preflight-analysis-scene.json', scene)
    assert.equal(scene.id, 'module-analysis')
    assert.equal(scene.objective, 'product-behavior')
    const progress = JSON.parse(readFileSync(path.join(runRoot, 'progress.json'), 'utf8'))
    const planning = Object.values(progress.actions).find(action => action.stage === 'unit_planning')
    const task = JSON.parse(readFileSync(planning.task_path, 'utf8'))
    assert.deepEqual(task.analysis_settings, { scenario: 'module-analysis', mode, objective: 'product-behavior' })
    save('preflight-profile-policy.json', { profile: frozenManifest.analysis_profile, scenario: scene.id, objective: scene.objective,
      planning_policy: task.planning_policy ?? null, planning_io_policy: task.planning_io_policy ?? null,
      task_path: planning.task_path, planning_rubric_paths: task.rubric_paths })
  }
  console.log(JSON.stringify({ preflight: 'ok', cwd, model, run_id: created.run_id, create_run_verified: true, real_provider_started: false }))
  process.exit(0)
}

let apiKey = process.env.MINIMAX_AB_API_KEY
if (!apiKey) apiKey = JSON.parse(readFileSync(path.join(os.homedir(), '.local/share/opencode/auth.json'), 'utf8'))['minimax-cn-coding-plan']?.key
assert.ok(typeof apiKey === 'string' && apiKey.length, 'MiniMax credential unavailable')
const passwords = []
const safe = value => JSON.parse(JSON.stringify(value, (key, item) => {
  if (/^(api[_-]?key|authorization|access[_-]?token|refresh[_-]?token|password)$/i.test(key)) return '[redacted]'
  if (typeof item !== 'string') return item
  let text = item.split(apiKey).join('[redacted]')
  for (const password of passwords) text = text.split(password).join('[redacted]')
  return text.replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
}))
const events = [], providerEvents = [], workers = []
const hostEventPath = path.join(evidenceRoot, 'host-events.jsonl'), providerEventPath = path.join(evidenceRoot, 'provider-events.jsonl')
writeFileSync(hostEventPath, '', { flag: 'wx' }); writeFileSync(providerEventPath, '', { flag: 'wx' })
function record(event) {
  const row = safe({ at: new Date().toISOString(), ...event }); events.push(row); appendFileSync(hostEventPath, JSON.stringify(row) + '\n')
  if (['harness_created', 'source_first_worker_started', 'source_first_worker_finished', 'source_first_action_settled', 'source_first_worker_paused', 'harness_error', 'harness_final'].includes(row.stage)) console.log(JSON.stringify(row))
}
function recordProvider(event) { const row = safe({ at: new Date().toISOString(), ...event }); providerEvents.push(row); appendFileSync(providerEventPath, JSON.stringify(row) + '\n') }
const context = new Context(), subprocess = new LocalSubprocessRuntime(context), controller = new AbortController()
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)) }) })
const runner = async input => { const start = performance.now(); try { const result = await runPangea(input); record({ stage: 'harness_cli', operation: input.args.slice(0, 2).join('/'), status: 'ok', duration_ms: performance.now() - start }); return result } catch (error) { record({ stage: 'harness_cli', operation: input.args.slice(0, 2).join('/'), status: 'error', duration_ms: performance.now() - start, error: error.message }); throw error } }
const childEnv = { PANGEA_PYTHON: python, PANGEA_RUNTIME_ROOT: runtime, PANGEA_WORKSPACE_ROOT: cwd, PANGEA_DATA_ROOT: dataRoot,
  PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH || ''}`,
  PYTHONPATH: path.join(runtime, 'src'), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PANGEA_WORKER_TRANSPORT: 'desktop-cli',
  MINIMAX_AB_API_KEY: apiKey, OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
  OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { 'minimax-ab': { npm: '@ai-sdk/anthropic', name: 'MiniMax AB acceptance',
    options: { baseURL: 'https://api.minimax.cn/anthropic/v1', apiKey: '{env:MINIMAX_AB_API_KEY}' }, models: { 'MiniMax-M2.7': { name: 'MiniMax M2.7', limit: modelLimit } } } } }) }
for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) childEnv[key] = path.join(cwd, 'opencode', key.toLowerCase())
async function startWorker(request) {
  const listenPort = await port(), password = randomBytes(24).toString('hex'); passwords.push(password)
  let provider
  apply({ logger: { warn: message => record({ stage: 'provider_warning', message }) }, subprocess, subagents: { registerProvider: value => { provider = value } } },
    Config({ providerName: 'pangea-opencode', command: opt['opencode-command'] || '/opt/homebrew/bin/opencode', args: ['acp', '--port', String(listenPort), '--hostname', '127.0.0.1'], cwd,
      env: { ...childEnv, OPENCODE_SERVER_PASSWORD: password }, permission: 'allow', disposeEofGraceMs: 3000, disposeGraceMs: 1000 }))
  const worker = await provider.start({ ...request, onSessionEvent: event => { recordProvider(event); request.onSessionEvent?.(event) } })
  workers.push(worker)
  const originalDispose = worker.dispose.bind(worker)
  worker.dispose = async (...args) => { save(`worker-${worker.id}-diagnostics.json`, safe(worker.readDiagnostics())); return originalDispose(...args) }
  return worker
}
const startedAt = Date.now(), attemptId = `ab-${arm}-${fixture}-${randomUUID()}`
let host, created, finalState, finalProgress, finalSnapshot, outcome, failure, timedOut = false
const cleanupErrors = []
const timer = setTimeout(() => { timedOut = true; controller.abort(new Error(`Isolated AB execution timeout after ${timeoutMs} ms`)) }, timeoutMs)
const stop = () => controller.abort(new Error('Isolated AB execution explicitly interrupted'))
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  created = await createRun(cwd, request, input => runner({ ...input, signal: controller.signal }))
  save('created.json', created); record({ stage: 'harness_created', run_id: created.run_id })
  host = createSourceFirstAcpRun({ subagents: { start: (_, request) => startWorker(request) }, parent: { id: attemptId, session: { header: { cwd } } },
    providerId: 'pangea-opencode', agentModel: model, cwd, dataRoot: created.data_root, runId: created.run_id, runner, signal: controller.signal,
    onEvent: record, python, mode, attemptId, executionIds: capabilities.source_first?.execution_recovery?.execution_ids === true })
  outcome = await host.result; save('host-outcome.json', safe(outcome))
} catch (error) { failure = safe({ name: error.name, message: error.message, stack: error.stack }); save('failure.json', failure); record({ stage: 'harness_error', error: failure }) }
finally {
  clearTimeout(timer)
  try { await host?.dispose() } catch (error) { cleanupErrors.push(error.message) }
  for (const worker of workers) { try { await worker.dispose() } catch (error) { cleanupErrors.push(error.message) } }
  try { await context.fiber.dispose() } catch (error) { cleanupErrors.push(error.message) }
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop)
  if (created) {
    try { finalState = await runPangea({ cwd, args: ['runs', 'get', '--data-root', created.data_root, '--run-id', created.run_id] }); save('final-run.json', finalState) } catch (error) { cleanupErrors.push(`final read: ${error.message}`) }
    try { finalSnapshot = await companionSnapshot({ cwd, dataRoot: created.data_root, runId: created.run_id }); save('final-snapshot.json', finalSnapshot) } catch (error) { cleanupErrors.push(`source-first reader: ${error.message}`) }
    const progressPath = path.join(created.data_root, 'runs', created.run_id, 'progress.json')
    if (existsSync(progressPath)) { finalProgress = JSON.parse(readFileSync(progressPath, 'utf8')); save('final-progress.json', finalProgress) }
  }
  const stageTimings = {}
  for (const event of events) {
    if (event.stage !== 'source_first_acp_request' || !Number.isFinite(event.duration_ms)) continue
    const stage = event.action_stage || 'unknown', row = stageTimings[stage] ||= { prompt_count: 0, prompt_wall_ms_sum: 0, tool_calls: 0, first_started_at_ms: null, last_finished_at_ms: null }
    row.prompt_count++; row.prompt_wall_ms_sum += event.duration_ms; row.tool_calls += event.tool_calls || 0
    if (Number.isFinite(event.started_at_ms)) row.first_started_at_ms = row.first_started_at_ms == null ? event.started_at_ms : Math.min(row.first_started_at_ms, event.started_at_ms)
    if (Number.isFinite(event.finished_at_ms)) row.last_finished_at_ms = Math.max(row.last_finished_at_ms || 0, event.finished_at_ms)
    row.elapsed_window_ms = row.last_finished_at_ms - row.first_started_at_ms
  }
  const actionMap = new Map(events.filter(e => e.stage === 'source_first_worker_bound').map(e => [e.agent_session_id, e.action_id]))
  const tools = new Map()
  for (const event of providerEvents) {
    const update = event.update
    if (event.type !== 'session_update' || event.replay || !update?.toolCallId) continue
    const key = `${event.agent_session_id}:${update.toolCallId}`, previous = tools.get(key) || { at: event.at, task_id: event.agent_session_id, action_id: actionMap.get(event.agent_session_id) || null }
    tools.set(key, { ...previous, ...update, last_at: event.at })
  }
  const toolRows = [...tools.values()]; save('tools.json', toolRows)
  const actionResults = []
  for (const [actionId, action] of Object.entries(finalProgress?.actions || {})) {
    let task, result
    if (action.task_path && existsSync(action.task_path)) { task = JSON.parse(readFileSync(action.task_path, 'utf8')); if (task.result_path && existsSync(task.result_path)) result = JSON.parse(readFileSync(task.result_path, 'utf8')) }
    const actionTools = toolRows.filter(t => t.action_id === actionId)
    actionResults.push({ action_id: actionId, stage: action.stage, status: action.status, task_id: action.task_id, task_path: action.task_path,
      result_path: task?.result_path, result_sha256: task?.result_path && existsSync(task.result_path) ? fileSha(task.result_path) : null,
      revision: result?.revision, completion: result?.completion, records: result?.records?.length, tool_calls: actionTools.length,
      first_plan_write_at: actionTools.find(t => /\bplan-write(?:-batch)?\b/.test(t.rawInput?.command || ''))?.at || null,
      first_result_write_at: actionTools.find(t => /\bresult-write(?:-batch)?\b/.test(t.rawInput?.command || ''))?.at || null })
  }
  const runRoot = created && path.join(created.data_root, 'runs', created.run_id)
  const artifactPaths = runRoot ? ['report.md', 'report.html', 'report-complete.json', 'inputs/source-first-plan.json'].filter(f => existsSync(path.join(runRoot, f))).map(f => ({ file: path.join(runRoot, f), sha256: fileSha(path.join(runRoot, f)) })) : []
  const cleanup = workers.map(w => ({ id: w.id, remoteSessionId: w.remoteSessionId, diagnostics: safe(w.readDiagnostics()) })); save('process-cleanup.json', cleanup)
  const current = finalSnapshot?.current
  const summary = safe({ arm, fixture, mode, profile, model, attempt_id: attemptId, run_id: created?.run_id, started_at_ms: startedAt, finished_at_ms: Date.now(), elapsed_ms: Date.now() - startedAt,
    timed_out: timedOut, outcome, failure, cleanup_errors: cleanupErrors, lifecycle_status: current?.lifecycle_status ?? finalState?.lifecycle_status, quality_status: current?.quality_status ?? finalState?.quality_status,
    workflow_complete: current?.run_id === created?.run_id && current?.lifecycle_status === 'complete' && current?.report_available === true && current?.reader_health?.trusted === true,
    report_available: current?.report_available === true, reader_health: current?.reader_health, legacy_cli_report_available: finalState?.report_available,
    completion_evidence: 'source-first companionSnapshot current lifecycle/report availability and trusted reader; legacy runs get report_available is not authoritative',
    stage_timings: stageTimings, action_results: actionResults, artifacts: artifactPaths,
    provider_prompt_count: providerEvents.filter(e => e.type === 'prompt').length, unique_tool_calls: toolRows.length,
    context_events: providerEvents.filter(e => /usage|context/i.test(e.type || '') || /usage|context/i.test(e.update?.sessionUpdate || '')),
    semantic_acceptance: 'not_evaluated_by_harness', timing_caveat: 'Summed concurrent ACP prompt time is not whole-Run wall time; this is native macOS CLI/ACP, not Windows packaged UI.' })
  save('summary.json', summary); record({ stage: 'harness_final', run_id: created?.run_id, workflow_complete: summary.workflow_complete, failure: failure?.message, summary_path: path.join(evidenceRoot, 'summary.json') })
  if (!summary.workflow_complete || failure || timedOut || cleanupErrors.length) process.exitCode = 1
}
