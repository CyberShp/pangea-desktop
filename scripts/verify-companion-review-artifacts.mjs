import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Read-only acceptance of an existing run; writes evidence only, never task state.
export async function verifyReviewArtifacts({ cwd, evidence, companion }) {
  const json = file => JSON.parse(readFileSync(file, 'utf8'))
  const saved = name => json(path.join(evidence, name))
  const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex')
  const created = json(path.join(cwd, 'created.json')), root = path.join(created.data_root, 'runs', created.run_id)
  const oldProgress = saved('progress-before.json'), oldBindings = saved('bindings-before.json')
  const review = Object.values(oldProgress.actions).find(a => a.stage === 'comparison_review')
  const progress = json(path.join(root, 'progress.json')), bindings = json(path.join(root, 'acp-workers.json'))
  assert.equal(progress.run_id, created.run_id); assert.equal(progress.lifecycle_status, 'complete')
  assert.equal(progress.actions[review.action_id].task_id, review.task_id)
  for (const [name, previous] of Object.entries(saved('results-before.json'))) {
    const current = json(path.join(root, 'agent-results/source-first', name)), expected = { ...previous.binding }
    if (previous.binding.action_id === review.action_id && previous.binding.task_id === 'pending') {
      assert.equal(previous.revision, 0); assert.equal(previous.records.length, 0); assert.equal(previous.completion, null)
      expected.task_id = review.task_id
    }
    assert.deepEqual(current.binding, expected)
    for (const record of previous.records) assert.deepEqual(current.records.find(r => r.record_id === record.record_id), record)
    if (previous.binding.action_id !== review.action_id) assert.deepEqual(current, previous)
  }
  for (const [file, digest] of Object.entries(saved('frozen-input-hashes.json'))) assert.equal(sha(file), digest)
  for (const [id, previous] of Object.entries(oldBindings.workers)) assert.equal(bindings.workers[id].remoteSessionId, previous.remoteSessionId)
  const events = readFileSync(path.join(evidence, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const prompts = events.filter(e => e.type === 'prompt')
  assert.equal(prompts.filter(e => e.agent_session_id === review.task_id).length, 1)
  assert.equal(events.filter(e => e.stage === 'source_first_worker_paused').length, 0)
  assert.equal(events.filter(e => ['source_first_recovering', 'source_first_tool_recovery', 'source_first_zero_tool_turn'].includes(e.stage)).length, 0)
  const formalActions = events.filter(e => e.stage === 'source_first_worker_started')
  assert.equal(formalActions.filter(e => e.action_id === review.action_id).length, 1)
  assert.ok(formalActions.every(e => e.action_id === review.action_id || e.action_stage === 'targeted_closure'))
  assert.equal(prompts.length, formalActions.length, 'exactly one prompt per Graph action, no duplicate continuation')
  const before = saved('messages-before-compact.json'), after = saved('messages-after-compact.json')
  const oldIds = new Set(before.map(m => m.info.id)), newIds = new Set(after.map(m => m.info.id))
  assert.ok([...oldIds].every(id => newIds.has(id)))
  const additions = after.filter(m => !oldIds.has(m.info.id))
  assert.ok(additions.some(m => m.info.summary === true && m.info.finish === 'stop' && !m.info.error && m.info.modelID === 'MiniMax-M2.7'))
  const compactions = additions.flatMap(m => m.parts ?? []).filter(p => p.type === 'compaction')
  assert.equal(compactions.length, 1); assert.equal(compactions[0].auto, false)
  const manifest = json(path.join(root, 'report-complete.json'))
  assert.equal(manifest.run_id, created.run_id); assert.equal(manifest.lifecycle_status, 'complete')
  assert.equal(manifest.quality_status, progress.quality_status)
  assert.deepEqual(manifest.accepted_revisions, progress.accepted_revisions)
  for (const name of manifest.files) assert.ok(readFileSync(path.join(root, name)).length > 0)
  const markdown = readFileSync(path.join(root, 'report.md'), 'utf8')
  assert.ok(markdown.includes(created.run_id)); assert.ok(markdown.includes(progress.quality_status))
  for (let n = 1; n <= 8; n++) assert.ok(markdown.includes(`TC-${String(n).padStart(3, '0')}`))
  assert.ok(markdown.includes('U-001')); assert.ok(markdown.includes('finding'))
  const { companionSnapshot } = await import(pathToFileURL(path.join(companion, 'src/reader.js')))
  const snapshot = await companionSnapshot({ dataRoot: created.data_root, runId: created.run_id })
  writeFileSync(path.join(evidence, 'snapshot-final.json'), JSON.stringify(snapshot, null, 2))
  assert.equal(snapshot.current.report_available, true); assert.equal(snapshot.current.reader_health.trusted, true)
  assert.ok(saved('process-cleanup.json').every(worker => worker.processExited === true))
  const reviewFinish = events.find(e => e.stage === 'source_first_worker_finished' && e.action_id === review.action_id)
  const summary = { passed: true, runId: created.run_id, model: 'MiniMax-M2.7', reviewTaskId: review.task_id,
    reviewRemoteSessionId: bindings.workers[review.task_id].remoteSessionId, originalRecordsPreserved: true, frozenInputsUnchanged: true,
    reviewResumePrompts: 1, totalPrompts: prompts.length, graphActions: formalActions.map(e => ({ actionId: e.action_id, stage: e.action_stage })),
    unexpectedPauses: 0, reportAvailable: true, qualityStatus: progress.quality_status, reviewTurnMs: reviewFinish.turn_duration_ms,
    reviewToolCalls: reviewFinish.tool_calls, historicalMessagesRetained: before.length,
    reports: Object.fromEntries(['report.md', 'report.html', 'report-complete.json'].map(n => [n, { path: path.join(root, n), sha256: sha(path.join(root, n)) }])) }
  writeFileSync(path.join(evidence, 'verified-summary.json'), JSON.stringify(summary, null, 2))
  return summary
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [cwd, evidence, companion] = process.argv.slice(2)
  assert.ok(cwd && evidence && companion)
  console.log(JSON.stringify(await verifyReviewArtifacts({ cwd, evidence, companion }), null, 2))
}
