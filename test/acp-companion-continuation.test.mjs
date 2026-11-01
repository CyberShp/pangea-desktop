import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'

// Cross-repository integration: use the Companion checkout that is being shipped.
// The adapter is a deterministic Graph stand-in; the host, ACP provider, SDK and
// child process are real. No model or Python Graph claim is made by this test.
const companionRoot = process.env.PANGEA_TEST_COMPANION_ROOT
const providerModule = process.env.PANGEA_TEST_ACP_MODULE
const { apply, Config } = await import(providerModule
  ? pathToFileURL(path.resolve(providerModule)).href : '@deepseek-ai/dsh-subagent-acp')

for (const providerId of ['pangea-opencode', 'pangea-nga', 'pangea-codeagent']) {
  for (const sameAction of [false, true]) test(`${providerId}: late terminal metadata does not pause or reclaim the worker across three ${sameAction ? 'same-action turns' : 'actions'}`, {
    skip: !companionRoot && 'Set PANGEA_TEST_COMPANION_ROOT to the pinned Companion plugin directory', timeout: 15000,
  }, async () => {
    const { createSourceFirstAcpRun } = await import(pathToFileURL(path.join(companionRoot, 'src/source-first-acp.js')).href)
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'pangea-companion-terminal-'))
    const context = new Context(), events = [], transport = [], workers = []
    let provider, taskId, settled = 0, disposed = 0, reclaimed = 0
    apply({ logger: { warn() {} }, subprocess: new LocalSubprocessRuntime(context),
      subagents: { registerProvider(value) { provider = value } } }, Config({
      providerName: providerId, command: process.execPath,
      args: [path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
      env: { PANGEA_FIXTURE_MODE: 'lifecycle-companion' }, disposeEofGraceMs: 100, disposeGraceMs: 100,
    }))
    const run = createSourceFirstAcpRun({ dataRoot, cwd: dataRoot, runId: 'three-actions', providerId,
      parent: { session: { header: { cwd: dataRoot } } }, signal: new AbortController().signal,
      progressPolicy: { readyWarnMs: 3000, readyIdleMs: 10000, warnMs: 3000, idleMs: 10000, cancelMs: 1000, pollMs: 10 },
      onEvent: event => events.push(event),
      subagents: { start: async (_, request) => {
        const worker = await provider.start({ ...request, onSessionEvent: event => {
          transport.push(event); request.onSessionEvent?.(event)
        } })
        workers.push(worker)
        const dispose = worker.dispose.bind(worker), reclaim = worker.quiesceForRecovery.bind(worker)
        worker.dispose = async () => { disposed++; return dispose() }
        worker.quiesceForRecovery = async () => { reclaimed++; return reclaim() }
        return worker
      } },
      runner: async ({ args }) => {
        if (args[0] === 'task-open') return { task: {} }
        if (args[0] === 'result-read') return { revision: settled, completion_complete: false }
        if (args[1] === 'bind') taskId = args.at(-1)
        if (args[1] === 'settle') { settled++; return {} }
        if (args[1] === 'next') return { run_id: 'three-actions', lifecycle_status: settled === 3 ? 'complete' : 'running',
          actions: settled === 3 ? [] : [{ action_id: `action-${sameAction ? 0 : settled}`, action: taskId ? 'continue_agent' : 'dispatch_agent',
            task_id: taskId, role: 'planning', stage: 'unit_planning' }] }
        return {}
      },
    })
    try {
      assert.equal((await run.result).attentionRequired, false)
      assert.equal(settled, 3)
      assert.equal(workers.length, 1, 'all actions must reuse the original process and remote session')
      assert.equal(reclaimed, 0, 'no erroneous process-tree recovery')
      assert.equal(disposed, 0, 'no premature worker disposal')
      assert.equal(transport.filter(event => event.type === 'prompt').length, 4, 'one handshake and three tasks only')
      assert.deepEqual(events.filter(event => event.stage === 'source_first_prompt_ready').map(event => event.prompt_kind),
        ['initial', sameAction ? 'continuation' : 'action_transition', sameAction ? 'continuation' : 'action_transition'])
      assert.equal(events.some(event => ['source_first_worker_paused', 'source_first_continuation_rejected',
        'source_first_tool_recovery', 'source_first_zero_tool_turn'].includes(event.stage)), false)
      assert.equal(workers[0].readDiagnostics().activeToolCount, 0)
      const bindings = JSON.parse(await readFile(path.join(dataRoot, 'runs/three-actions/acp-workers.json'), 'utf8'))
      assert.equal(bindings.workers[taskId].blocked, false)
      assert.notEqual(bindings.workers[taskId].requires_process_tree_confirmation, true)
    } finally {
      // Explicit test teardown is separate from the premature-reclamation assertion.
      await run.dispose()
      for (const worker of workers) await worker.dispose()
      await context.fiber.dispose()
      await rm(dataRoot, { recursive: true, force: true })
    }
  })
}

for (const scenario of ['missing', 'safe', 'near']) test(`context ${scenario}: admission and explicit compact recovery preserve prompt identity`, {
  skip: !companionRoot && 'Requires Companion', timeout: 15000,
}, async () => {
  const { createSourceFirstAcpRun } = await import(pathToFileURL(path.join(companionRoot, 'src/source-first-acp.js')).href)
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'pangea-context-admission-'))
  const context = new Context(), events = [], transport = [], workers = []
  const subprocess = new LocalSubprocessRuntime(context)
  let taskId, settled = 0, compacted = false, run
  const options = { dataRoot, cwd:dataRoot, runId:'context',providerId:'pangea-opencode',parent:{session:{header:{cwd:dataRoot}}},signal:new AbortController().signal,
    onEvent:e=>events.push(e),
    subagents:{start:async(_,request)=>{
      let provider
      apply({logger:{warn(){}},subprocess,subagents:{registerProvider:p=>{provider=p}}},Config({
        providerName:'pangea-opencode',command:process.execPath,args:[path.resolve('scripts/fixtures/acp-diagnostic-agent.mjs')],
        env:{PANGEA_FIXTURE_MODE:'lifecycle-companion',PANGEA_FIXTURE_CONTEXT:compacted?'compacted':scenario},disposeEofGraceMs:100,disposeGraceMs:100,
      }))
      const worker=await provider.start({...request,onSessionEvent:e=>{transport.push(e);request.onSessionEvent?.(e)}})
      workers.push(worker)
      if(request.resume) assert.equal(worker.readDiagnostics().contextUsage?.used,10000,'session/load must expose compacted usage before dispatch')
      return worker
    }},
    runner:async({args})=>{
      if(args[0]==='task-open')return {task:{}}
      if(args[0]==='result-read')return {revision:settled,completion_complete:false}
      if(args[1]==='bind')taskId=args.at(-1)
      if(args[1]==='settle'){settled++;return {validation:{status:'valid'}}}
      if(args[1]==='next')return {run_id:'context',lifecycle_status:settled===2?'complete':'running',actions:settled===2?[]:[{action_id:`action-${settled}`,action:taskId?'continue_agent':'dispatch_agent',task_id:taskId,role:'planning',stage:'unit_planning'}]}
      return {}
    },
  }
  try {
    run=createSourceFirstAcpRun(options)
    const first=await run.result
    if(scenario==='near'){
      assert.equal(first.attentionRequired,true)
      assert.equal(settled,1)
      assert.equal(transport.filter(e=>e.type==='prompt').length,2,'handshake and first task only; rejected continuation never reaches transport')
      assert.equal(events.filter(e=>e.stage==='source_first_input_too_long').length,1)
      assert.equal(events.filter(e=>e.stage==='source_first_worker_paused').length,1)
      assert.equal(events.some(e=>e.stage==='source_first_zero_tool_turn'||e.stage==='source_first_recovering'),false)
      compacted=true // Protocol fixture simulates external compaction before session/load.
      run=createSourceFirstAcpRun(options)
      assert.equal((await run.result).attentionRequired,false)
      assert.equal(workers.length,2)
      assert.equal(workers[0].id,workers[1].id)
      assert.equal(workers[0].remoteSessionId,workers[1].remoteSessionId)
      assert.equal(workers[1].readDiagnostics().contextUsage.used,10000)
      assert.equal(events.filter(e=>e.stage==='source_first_worker_paused').length,1,'no repeated pause after compact')
    } else {
      assert.equal(first.attentionRequired,false)
      assert.equal(workers.length,1)
      assert.equal(events.some(e=>e.stage==='source_first_worker_paused'||e.stage==='source_first_zero_tool_turn'),false)
      if(scenario==='missing')assert.equal(workers[0].readDiagnostics().contextUsage,undefined)
    }
    assert.equal(settled,2)
    assert.equal(transport.filter(e=>e.type==='prompt').length,3,'exactly handshake and two accepted tasks')
    assert.equal(transport.filter(e=>e.type==='continuation_rejected').length,scenario==='near'?1:0)
  } finally {
    await run?.dispose()
    for(const worker of workers)await worker.dispose()
    await context.fiber.dispose()
    await rm(dataRoot,{recursive:true,force:true})
  }
})
