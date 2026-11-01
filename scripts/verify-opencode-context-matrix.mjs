import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { apply, Config } from '@deepseek-ai/dsh-subagent-acp'

const cwd = process.env.PANGEA_TEST_ACP_CWD, scenario = process.env.PANGEA_TEST_SCENARIO
const runtime = process.env.PANGEA_INTEGRATION_RUNTIME, python = process.env.PANGEA_PYTHON
const targetStage = process.env.PANGEA_TEST_TARGET_STAGE ?? 'unit_analysis'
assert.ok(['unit_analysis', 'unit_planning'].includes(targetStage))
const fixtureRoot = process.env.PANGEA_TEST_FIXTURE_ROOT
const fixture = fixtureRoot ? JSON.parse(readFileSync(path.join(fixtureRoot, 'fixture.json'), 'utf8')) : null
const companion = process.env.PANGEA_TEST_COMPANION_ROOT, model = process.env.PANGEA_TEST_ACP_MODEL
assert.ok([cwd, runtime, python, companion, model].every(Boolean))
assert.ok(['gate', 'tool-exhaustion', 'missing-usage', 'post-delivery-exhaustion'].includes(scenario)); assert.ok(path.isAbsolute(cwd))
mkdirSync(cwd) // Fresh workspace and isolated OpenCode database for every run.
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const save = (name, value) => writeFileSync(path.join(cwd, name), JSON.stringify(value, null, 2))
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
const hashes = root => Object.fromEntries(readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? Object.entries(hashes(path.join(root, e.name))) : [[path.join(root, e.name), sha(path.join(root, e.name))]]))
for (const dir of ['.agents', 'docs']) cpSync(path.join(runtime, dir), path.join(cwd, dir), { recursive: true })
process.env.PYTHONPATH = path.join(runtime, 'src')
writeFileSync(path.join(cwd, 'AGENTS.md'), `This is an isolated PANGEA regression workspace on macOS. Use bash/zsh syntax for the specified Python CLI (omit PowerShell's leading &). Python: ${python}. Author semantic records through the real CLI. Do not edit frozen inputs, progress, task identities or result envelopes. Do not create worker agents. Follow the frozen rubric. probe-stress files are opaque transport test data, not analysis source or report evidence.\n`)
const repo = path.join(cwd, 'pangea-data/repositories/sample'); mkdirSync(repo, { recursive: true })
if (fixture) cpSync(path.join(fixtureRoot, 'source'), repo, { recursive: true })
else writeFileSync(path.join(repo, 'quota.c'), `#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
/* Build: cc quota.c -o quota; usage: ./quota LIMIT USED AMOUNT. Stateless. */
static int number(const char *s, long *v) {
    char *end; errno = 0; *v = strtol(s, &end, 10);
    return s[0] != '\\0' && *end == '\\0' && errno != ERANGE && *v >= 0;
}
int main(int argc, char **argv) {
    long limit, used, amount;
    if (argc != 4 || !number(argv[1], &limit) || !number(argv[2], &used) ||
        !number(argv[3], &amount) || amount == 0 || used > limit) {
        puts("invalid quota input"); return 2;
    }
    if (amount > limit - used) {
        printf("denied remaining=%ld\\n", limit - used); return 1;
    }
    printf("accepted remaining=%ld\\n", limit - used - amount); return 0;
}
`)
const stressFiles = []
if (['tool-exhaustion', 'post-delivery-exhaustion'].includes(scenario)) {
  mkdirSync(path.join(cwd, 'probe-stress'))
  for (let i = 0; i < 16; i++) {
    const file = path.join(cwd, 'probe-stress', `chunk-${String(i).padStart(2, '0')}.txt`)
    writeFileSync(file, Array.from({ length: 600 }, () => randomBytes(20).toString('hex')).join('\n') + '\n'); stressFiles.push(file)
  }
  save('stress-manifest.json', stressFiles.map(file => ({ file, bytes: readFileSync(file).length, sha256: sha(file) })))
}
const { createRun, runPangea, resumeRun } = await import(pathToFileURL(path.join(companion, 'src/pangea-api.js')))
const { createSourceFirstAcpRun } = await import(pathToFileURL(path.join(companion, 'src/source-first-acp.js')))
const { companionSnapshot } = await import(pathToFileURL(path.join(companion, 'src/reader.js')))
const context = new Context(), subprocess = new LocalSubprocessRuntime(context), workers = [], events = [], actionByWorker = new Map()
let controller = new AbortController(), host, created, target, beforeResult, resultPath, pendingPrompt, phase = 'initial', stoppedIntentionally = false, frozenBefore
const record = e => { const row = { at: new Date().toISOString(), phase, ...e }; events.push(row); appendFileSync(path.join(cwd, 'events.jsonl'), JSON.stringify(row) + '\n') }
const port = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const root = () => path.join(created.data_root, 'runs', created.run_id)
function captureSaved(worker) {
  const progress = read(path.join(root(), 'progress.json'))
  const entry = Object.entries(progress.actions).find(([, a]) => a.task_id === worker.id && a.stage === targetStage); assert.ok(entry)
  target.actionId = entry[0]; resultPath = read(entry[1].task_path).result_path
  beforeResult = read(resultPath); assert.ok(beforeResult.records.length > 0, 'real model must save semantic records before pressure'); if (scenario === 'post-delivery-exhaustion') { assert.equal(beforeResult.completion?.complete, true); assert.equal(beforeResult.completion.declared_revision, beforeResult.revision) } else assert.equal(beforeResult.completion, null)
  frozenBefore = hashes(path.join(root(), 'inputs'))
  // Graph materializes this derived plan only after accepting Planning; its change is expected.
  if (targetStage === 'unit_planning') delete frozenBefore[path.join(root(), 'inputs/source-first-plan.json')]
  save('target.json', target); save('result-before-recovery.json', beforeResult); save('frozen-before.json', frozenBefore)
  record({ type: 'saved_before_recovery', target, records: beforeResult.records.length, revision: beforeResult.revision, usage: worker.readDiagnostics().contextUsage })
  const calls = new Map()
  for (const event of events) {
    const update = event.update
    if (event.type !== 'session_update' || event.phase !== 'initial' || event.replay || event.agent_session_id !== worker.id || !update?.toolCallId) continue
    const previous = calls.get(update.toolCallId) ?? { at: event.at }
    calls.set(update.toolCallId, { ...previous, ...update })
  }
  const tools = [...calls.values()]
  const frameworkReads = tools.filter(t => JSON.stringify(Object.fromEntries(Object.entries(t.rawInput ?? {}).filter(([key]) => key !== 'content' && key !== 'cwd' && key !== 'workdir'))).includes(path.join(runtime, 'src')))
  const successfulWrites = tools.filter(t => /\bresult-write\b/.test(t.rawInput?.command ?? '') && /"ok"\s*:\s*true/.test(t.rawOutput?.output ?? ''))
  const successfulPlanWrites = tools.filter(t => /\bplan-write\b/.test(t.rawInput?.command ?? '') && /"ok"\s*:\s*true/.test(t.rawOutput?.output ?? ''))
  const formalPrompt = events.filter(e => e.type === 'prompt' && e.agent_session_id === worker.id)[1]
  const metrics = { analysisToolCalls: tools.length, frameworkReadCount: frameworkReads.length,
    frameworkReads: frameworkReads.map(t => ({ at: t.at, input: t.rawInput })), successfulWriteCalls: successfulWrites.length,
    firstWriteCallAfterMs: successfulWrites.length ? Date.parse(successfulWrites[0].at) - Date.parse(formalPrompt.at) : null }
  if (targetStage === 'unit_analysis') save('analysis-delivery-metrics.json', metrics)
  if (targetStage === 'unit_planning') {
    save('planning-delivery-metrics.json', { stage: targetStage, frameworkReadCount: frameworkReads.length, frameworkReads: metrics.frameworkReads, planningToolCalls: tools.length, successfulPlanWrites: successfulPlanWrites.length, firstPlanWriteCallAfterMs: successfulPlanWrites.length ? Date.parse(successfulPlanWrites[0].at) - Date.parse(formalPrompt.at) : null })
    save('plan-before-recovery.json', read(path.join(root(), 'inputs/source-first-plan.json')))
  }
  if (targetStage === 'unit_analysis' && process.env.PANGEA_TEST_ASSERT_ANALYSIS_DELIVERY === '1') {
    assert.equal(frameworkReads.length, 0, 'Analysis must use frozen contracts without searching framework implementation')
    assert.ok(successfulWrites.length >= 2, 'Analysis must incrementally save actual records through the CLI')
  }
}
async function start(request, purpose = 'host') {
  const listenPort = await port(), password = randomBytes(24).toString('hex')
  const env = { OPENCODE_SERVER_PASSWORD: password, PYTHONPATH: path.join(runtime, 'src') }
  for (const key of ['OPENCODE_CONFIG_CONTENT', ...(process.env.PANGEA_TEST_ACP_FORWARD_ENV || '').split(',').filter(Boolean)]) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = path.join(cwd, 'opencode', key.toLowerCase())
  let provider
  apply({ logger: { warn: message => record({ type: 'provider_warning', message }) }, subprocess, subagents: { registerProvider: p => { provider = p } } }, Config({ providerName: 'pangea-opencode', command: 'opencode', args: ['acp', '--port', String(listenPort), '--hostname', '127.0.0.1'], cwd, env, permission: 'allow', disposeEofGraceMs: 3000, disposeGraceMs: 1000 }))
  const worker = await provider.start({ ...request, onSessionEvent: e => { record({ ...e, purpose, actionId: actionByWorker.get(e.agent_session_id) ?? null }); request.onSessionEvent?.(e) } }); workers.push(worker)
  worker.api = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${listenPort}${route}?directory=${encodeURIComponent(cwd)}`, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64'), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: request.signal })
    if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${(await response.text()).slice(0, 1000)}`)
    return response.json()
  }
  if (request.resume) record({ type: 'loaded_context_usage', taskId: worker.id, remoteSessionId: worker.remoteSessionId, purpose, usage: worker.readDiagnostics().contextUsage ?? null })
  if (purpose !== 'host') return worker
  const original = worker.continuePrompt.bind(worker)
  worker.continuePrompt = async content => {
    const message = content.map(b => b.text ?? '').join('\n')
    if (!target && message.includes('身份绑定已完成') && message.includes(`阶段：${targetStage}`)) {
      target = { taskId: worker.id, remoteSessionId: worker.remoteSessionId }
      let instruction = '隔离回归分回合要求：本回合按全部冻结规则完成并通过当前阶段 CLI 保存全部语义结果，但暂不调用 work-finish。不要改变审查标准或删减交付。'
      if (scenario === 'post-delivery-exhaustion') instruction = `隔离交付后容量回归：先按全部冻结标准完成本阶段语义工作，通过真实 CLI 保存结果并成功 work-finish；不得省略内容或伪造完成。work-finish 成功后，本回合继续用原生 read 工具按顺序完整读取这些无语义压力文件，每次一个、等待返回再读下一个，不并行、不摘要或截断，不再修改已交付结果；文件不是业务证据，不写入报告。首次容量异常即停止压力阶段。文件：${JSON.stringify(stressFiles)}`
      else if (scenario === 'tool-exhaustion') instruction += `保存成功后，在同一个回合用原生 read 工具按顺序完整读取以下容量测试文件；每次读取一个文件并等待返回再读下一个，不能并行、不能使用摘要/head/截断代替读取。每个文件600行、约24KB。文件只是无语义的随机测试数据，不应进入分析结论或报告。本次首回合全部读取结束前不调用 work-finish，不主动结束回合。首次容量异常即结束压力注入阶段，容量异常由测试宿主处理；compact 后恢复时不再读取剩余压力文件，只恢复原语义任务并交付。文件：${JSON.stringify(stressFiles)}`
      else instruction += '保存成功后结束本回合；宿主将通过原 action 接续完成声明。'
      try { return await original([...content, { type: 'text', text: instruction }]) }
      finally {
        captureSaved(worker)
        if (scenario === 'missing-usage') { stoppedIntentionally = true; record({ type: 'intentional_host_stop', reason: 'reload original session without compaction to observe missing usage' }); controller.abort(new Error('Intentional isolated host stop after saved records')) }
      }
    }
    if (scenario === 'gate' && phase === 'initial' && actionByWorker.get(worker.id) === target?.actionId) {
      const usage = worker.readDiagnostics().contextUsage; assert.ok(usage?.used > 0)
      pendingPrompt = [...content, { type: 'text', text: 'Opaque regression data; ignore and do not echo.\n' + randomBytes(Math.ceil((usage.size - usage.used) / 2)).toString('hex') }]
      save('gate-input.json', { usage, bytes: Buffer.byteLength(pendingPrompt.map(b => b.text ?? '').join('\n')), sha256: createHash('sha256').update(JSON.stringify(pendingPrompt)).digest('hex') })
      return original(pendingPrompt)
    }
    if (phase === 'resume' && actionByWorker.get(worker.id) === target?.actionId) {
      record({ type: 'resume_admission', taskId: worker.id, usage: worker.readDiagnostics().contextUsage ?? null })
      const resumed = pendingPrompt ?? content
      return original(scenario === 'tool-exhaustion' ? [...resumed, { type: 'text', text: '隔离容量回归阶段已在首次真实超限时结束。不要继续或重读 probe-stress 压力文件；它们不是业务工作或审查证据。按原冻结标准核对已保存结果，只补实际缺失的语义工作并通过原 CLI 交付；不降低标准，不伪造 completion。' }] : resumed)
    }
    return original(content)
  }
  return worker
}
const parent = { id: `isolated-context-${scenario}`, session: { header: { cwd } } }
const options = () => ({ providerId: 'pangea-opencode', agentModel: model, parent, cwd, dataRoot: created.data_root, runId: created.run_id, signal: controller.signal, runner: runPangea, python, mode: 'speed', subagents: { start: (_, request) => start(request) }, onEvent: e => {
  if (e.stage === 'source_first_worker_bound') actionByWorker.set(e.agent_session_id, e.action_id)
  record({ type: 'host_event', ...e })
  if (['source_first_worker_started', 'source_first_worker_finished', 'source_first_action_settled', 'source_first_worker_paused'].includes(e.stage)) console.log(JSON.stringify(e))
} })
const timeout = setTimeout(() => controller.abort(new Error('Fresh context matrix case timed out')), Number(process.env.PANGEA_TEST_TIMEOUT_MS ?? 3600000))
const stop = () => controller.abort(new Error('Fresh context matrix case explicitly stopped'))
process.once('SIGINT', stop); process.once('SIGTERM', stop)
try {
  created = await createRun(cwd, { repository: 'sample', target: fixture?.target ?? '分析 quota.c 的命令行配额准入行为，仅该文件一个分析单元。覆盖允许、超限拒绝、非法输入及退出码；这是无状态检查，不推测持久化或并发。', source_scope: fixture?.source_scope ?? ['quota.c'], mode: 'speed', effective_context_budget: 196608 })
  save('created.json', created); save('provenance.json', { scenario, targetStage, fixtureRoot, model, runtime, companion, companionSha256: sha(path.join(companion, 'src/source-first-acp.js')) })
  host = createSourceFirstAcpRun(options())
  let initial
  try { initial = await host.result; save('initial-host.json', initial) }
  catch (error) { save('initial-host-error.json', { name: error.name, message: error.message }); if (!(scenario === 'missing-usage' && stoppedIntentionally)) throw error }
  assert.ok(target?.actionId && beforeResult)
  if (scenario === 'post-delivery-exhaustion') {
    assert.equal(initial.attentionRequired, false)
    await host.dispose()
    const progress = read(path.join(root(), 'progress.json')), result = read(resultPath)
    assert.equal(progress.lifecycle_status, 'complete'); assert.deepEqual(result, beforeResult)
    assert.equal(progress.accepted_revisions[target.actionId], beforeResult.revision)
    const reconciled = events.filter(e => e.stage === 'source_first_saved_delivery_reconciled' && e.action_id === target.actionId)
    assert.equal(reconciled.length, 1); assert.equal(reconciled[0].process_tree_stopped, true)
    assert.equal(events.filter(e => e.stage === 'source_first_worker_paused').length, 0)
    assert.equal(events.filter(e => e.type === 'prompt' && e.agent_session_id === target.taskId).length, 2)
    const evidence = await start({ parent, signal: controller.signal, resume: { taskId: target.taskId, remoteSessionId: target.remoteSessionId }, prompt: [], agentOptions: { model } }, 'post_delivery_evidence')
    const messages = await evidence.api(`/session/${target.remoteSessionId}/message`); save('post-delivery-messages.json', messages)
    assert.match(JSON.stringify(messages.filter(m => m.info.role === 'assistant').at(-1)?.info.error), /context window exceeds limit/)
    await evidence.dispose()
    for (const [file, digest] of Object.entries(frozenBefore)) assert.equal(sha(file), digest)
    const snapshot = await companionSnapshot({ dataRoot: created.data_root, runId: created.run_id }); save('snapshot-final.json', snapshot)
    assert.equal(snapshot.current.report_available, true); assert.equal(snapshot.current.reader_health.trusted, true)
    const manifest = read(path.join(root(), 'report-complete.json')); assert.deepEqual(manifest.accepted_revisions, progress.accepted_revisions)
    for (const file of manifest.files) assert.ok(readFileSync(path.join(root(), file)).length)
    save('verified-summary.json', { passed: true, scenario, model, targetStage, target, reportRoot: root(), qualityStatus: progress.quality_status,
      originalRecordsPreserved: beforeResult.records.length, savedCompletionRevision: beforeResult.revision, recoveryPrompts: 0, pauses: 0, reconciledAfterOwnedTreeFence: true })
    console.log(JSON.stringify({ stage: 'verified', scenario, reportRoot: root() }))
  } else {
  if (scenario !== 'missing-usage') assert.equal(initial.attentionRequired, true)
  await host.dispose()
  const paused = read(path.join(root(), 'progress.json')); save('progress-before-recovery.json', paused)
  assert.notEqual(paused.actions[target.actionId].status, 'accepted'); assert.equal(paused.accepted_revisions[target.actionId], undefined)
  const initialTargetPrompts = events.filter(e => e.type === 'prompt' && e.agent_session_id === target.taskId)
  assert.equal(initialTargetPrompts.length, 2, 'handshake and one formal analysis only before recovery')
  const pauses = events.filter(e => e.stage === 'source_first_worker_paused')
  assert.equal(pauses.length, scenario === 'missing-usage' ? 0 : 1)
  if (scenario === 'gate') assert.equal(events.filter(e => e.type === 'continuation_rejected').length, 1)
  if (scenario === 'tool-exhaustion') {
    assert.equal(events.filter(e => e.type === 'continuation_rejected').length, 0)
    assert.equal(events.filter(e => e.stage === 'source_first_worker_finished' && e.action_id === target.actionId).length, 0)
    assert.match(pauses[0].reason, /context window|input too long|context.*limit|input.*limit/i)
    assert.ok(events.some(e => !e.replay && e.type === 'session_update' && JSON.stringify(e.update?.rawInput ?? {}).includes('probe-stress')))
  }
  controller = new AbortController(); phase = 'manual'
  if (scenario !== 'missing-usage') {
    const manual = await start({ parent, signal: controller.signal, resume: { taskId: target.taskId, remoteSessionId: target.remoteSessionId }, prompt: [], agentOptions: { model } }, 'manual_compact')
    const route = `/session/${target.remoteSessionId}`, before = await manual.api(route + '/message'); save('messages-before-compact.json', before)
    if (scenario === 'tool-exhaustion') assert.ok(before.some(m => /context window|input too long|context.*limit|input.*limit/i.test(JSON.stringify(m.info.error ?? ''))), 'exported real provider error required')
    const [providerID, ...rest] = model.split('/')
    assert.equal(await manual.api(route + '/summarize', { providerID, modelID: rest.join('/'), auto: false }), true)
    const after = await manual.api(route + '/message'); save('messages-after-compact.json', after)
    const ids = new Set(after.map(m => m.info.id)); assert.ok(before.every(m => ids.has(m.info.id)))
    const newMessages = after.filter(m => !before.some(old => old.info.id === m.info.id))
    assert.ok(newMessages.some(m => m.info.summary === true && m.info.finish === 'stop' && !m.info.error))
    assert.equal(newMessages.flatMap(m => m.parts ?? []).filter(p => p.type === 'compaction' && p.auto === false).length, 1)
    assert.deepEqual(read(resultPath), beforeResult); await manual.dispose()
    console.log(JSON.stringify({ stage: 'manual_compact_complete', scenario, target }))
  }
  phase = 'resume'
  save('resume-request.json', await resumeRun(cwd, { dataRoot: created.data_root, runId: created.run_id, hostQuiescent: true }))
  host = createSourceFirstAcpRun(options()); const final = await host.result; save('final-host.json', final); assert.equal(final.attentionRequired, false)
  const finalProgress = read(path.join(root(), 'progress.json')); save('final-progress.json', finalProgress); assert.equal(finalProgress.lifecycle_status, 'complete')
  if (targetStage === 'unit_planning') {
    const plan = read(path.join(root(), 'inputs/source-first-plan.json'))
    const savedUnits = [...new Map(beforeResult.records.filter(r => r.kind === 'unit_plan').map(r => [r.body.unit_id, r.body])).values()]
    assert.ok(savedUnits.length > 0)
    for (const unit of savedUnits) assert.ok(plan.units.some(u => u.unit_id === unit.unit_id && u.title === unit.title && u.purpose === unit.purpose), 'Graph must materialize saved Planning identities and intent')
    save('plan-final.json', plan)
  }
  const result = read(resultPath); save('result-final.json', result); assert.deepEqual(result.binding, beforeResult.binding)
  for (const record of beforeResult.records) assert.deepEqual(result.records.find(r => r.record_id === record.record_id), record)
  assert.equal(result.completion.complete, true)
  for (const [file, digest] of Object.entries(frozenBefore)) assert.equal(sha(file), digest)
  const bindings = read(path.join(root(), 'acp-workers.json')); save('bindings-final.json', bindings); assert.equal(bindings.workers[target.taskId].remoteSessionId, target.remoteSessionId)
  const admissions = events.filter(e => e.type === 'resume_admission'); assert.equal(admissions.length, 1); assert.equal(admissions[0].usage, null, 'genuine session/load without fresh usage')
  assert.equal(events.filter(e => e.type === 'prompt' && e.phase === 'resume' && e.actionId === target.actionId).length, 1)
  assert.equal(events.filter(e => e.phase === 'resume' && e.stage === 'source_first_worker_paused').length, 0)
  assert.equal(events.filter(e => e.phase === 'resume' && ['source_first_recovering', 'source_first_zero_tool_turn', 'source_first_tool_recovery'].includes(e.stage)).length, 0)
  const snapshot = await companionSnapshot({ dataRoot: created.data_root, runId: created.run_id }); save('snapshot-final.json', snapshot)
  assert.equal(snapshot.current.report_available, true); assert.equal(snapshot.current.reader_health.trusted, true)
  const manifest = read(path.join(root(), 'report-complete.json')); assert.deepEqual(manifest.accepted_revisions, finalProgress.accepted_revisions)
  for (const file of manifest.files) assert.ok(readFileSync(path.join(root(), file)).length > 0)
  save('verified-summary.json', { passed: true, scenario, targetStage, model, runId: created.run_id, target, originalRecordsPreserved: beforeResult.records.length, initialRevision: beforeResult.revision, finalRevision: result.revision, missingUsageOnResume: true, resumePromptsForOriginalAction: 1, expectedPauses: pauses.length, unexpectedPausesAfterRecovery: 0, manualCompaction: scenario !== 'missing-usage', qualityStatus: finalProgress.quality_status, reportAvailable: true, reports: Object.fromEntries(['report.md', 'report.html', 'report-complete.json'].map(n => [n, sha(path.join(root(), n))])) })
  console.log(JSON.stringify({ stage: 'verified', scenario, reportRoot: root() }))
  }
} catch (error) { save('failure.json', { name: error.name, message: error.message, stack: error.stack }); console.error(error); process.exitCode = 1 }
finally { clearTimeout(timeout); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); await host?.dispose(); for (const worker of workers) await worker.dispose(); await context.fiber.dispose(); save('process-cleanup.json', workers.map(w => ({ taskId: w.id, remoteSessionId: w.remoteSessionId, processExited: w.readDiagnostics().processExited }))) }
