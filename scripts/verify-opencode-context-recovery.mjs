// Resume a preserved isolated regression Run after a real context-limit pause.
// Semantic records remain exclusively authored by the real OpenCode workers.
import assert from 'node:assert/strict'
import {randomBytes,createHash} from 'node:crypto'
import {readFileSync,writeFileSync,appendFileSync,readdirSync} from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LocalSubprocessRuntime} from '@deepseek-ai/dsh-subprocess-local'
import {apply,Config} from '@deepseek-ai/dsh-subagent-acp'
const cwd=process.env.PANGEA_TEST_ACP_CWD,model=process.env.PANGEA_TEST_ACP_MODEL,runtime=process.env.PANGEA_INTEGRATION_RUNTIME,python=process.env.PANGEA_PYTHON,companion=process.env.PANGEA_TEST_COMPANION_ROOT
assert.ok([cwd,model,runtime,python,companion].every(Boolean));assert.ok(path.isAbsolute(cwd))
const read=f=>JSON.parse(readFileSync(f,'utf8')),created=read(path.join(cwd,'created.json')),root=path.join(created.data_root,'runs',created.run_id)
const tag=process.env.PANGEA_TEST_RECOVERY_TAG??'natural-overflow';assert.match(tag,/^[a-z0-9-]+$/)
const eventFile=path.join(cwd,`events-${tag}.jsonl`);writeFileSync(eventFile,'',{flag:'wx'})
const save=(name,v)=>writeFileSync(path.join(cwd,`${tag}-${name}.json`),JSON.stringify(v,null,2))
const sha=f=>createHash('sha256').update(readFileSync(f)).digest('hex')
const hashes=dir=>Object.fromEntries(readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?Object.entries(hashes(path.join(dir,e.name))):[[path.join(dir,e.name),sha(path.join(dir,e.name))]]))
const {runPangea,resumeRun}=await import(pathToFileURL(path.join(companion,'src/pangea-api.js')))
const {createSourceFirstAcpRun}=await import(pathToFileURL(path.join(companion,'src/source-first-acp.js')))
const {companionSnapshot}=await import(pathToFileURL(path.join(companion,'src/reader.js')))
process.env.PYTHONPATH=path.join(runtime,'src')
const context=new Context(),subprocess=new LocalSubprocessRuntime(context),workers=[],events=[],actionByWorker=new Map(),cycles=[]
const controller=new AbortController(),parent={id:`isolated-${tag}`,session:{header:{cwd}}};let host,phase='prepare'
const record=e=>{const row={at:new Date().toISOString(),phase,...e};events.push(row);appendFileSync(eventFile,JSON.stringify(row)+'\n')}
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
async function start(request,purpose='host'){
 const listenPort=await port(),password=randomBytes(24).toString('hex'),env={PYTHONPATH:path.join(runtime,'src'),OPENCODE_SERVER_PASSWORD:password}
 for(const k of ['OPENCODE_CONFIG_CONTENT',...(process.env.PANGEA_TEST_ACP_FORWARD_ENV??'').split(',').filter(Boolean)])if(process.env[k]!==undefined)env[k]=process.env[k]
 for(const k of ['XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[k]=path.join(cwd,'opencode',k.toLowerCase())
 let provider
 apply({logger:{warn:message=>record({type:'provider_warning',message})},subprocess,subagents:{registerProvider:p=>{provider=p}}},Config({providerName:'pangea-opencode',command:'opencode',args:['acp','--port',String(listenPort),'--hostname','127.0.0.1'],cwd,env,permission:'allow',disposeEofGraceMs:3000,disposeGraceMs:1000}))
 const worker=await provider.start({...request,onSessionEvent:e=>{record({...e,purpose,actionId:actionByWorker.get(e.agent_session_id)??null});request.onSessionEvent?.(e)}});workers.push(worker)
 worker.api=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${listenPort}${route}?directory=${encodeURIComponent(cwd)}`,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal});assert.ok(res.ok,`OpenCode HTTP ${res.status}`);return res.json()}
 if(request.resume)record({type:'loaded_context_usage',taskId:worker.id,remoteSessionId:worker.remoteSessionId,purpose,usage:worker.readDiagnostics().contextUsage??null})
 return worker
}
const stop=()=>controller.abort(new Error('Isolated context recovery stopped'))
process.once('SIGTERM',stop);process.once('SIGINT',stop)
const timeout=setTimeout(()=>controller.abort(new Error('Isolated context recovery timed out')),Number(process.env.PANGEA_TEST_TIMEOUT_MS??3600000))
try{
 const frozen=hashes(path.join(root,'inputs'));save('frozen-before',frozen)
 for(let cycle=1;cycle<=4;cycle++){
  const progress=read(path.join(root,'progress.json')),paused=Object.values(progress.actions).filter(a=>a.status==='paused')
  assert.ok(paused.length>0);assert.ok(paused.every(a=>/context window|input.*limit|context.*limit|insufficient context/i.test(a.error??'')))
  const preserved=Object.fromEntries(readdirSync(path.join(root,'agent-results/source-first')).filter(n=>n.endsWith('.json')).map(n=>[n,read(path.join(root,'agent-results/source-first',n))]));save(`cycle-${cycle}-results-before`,preserved);save(`cycle-${cycle}-progress-before`,progress)
  const bindings=read(path.join(root,'acp-workers.json')),targets=[];phase=`manual-${cycle}`
  for(const a of paused){
   const bound=bindings.workers[a.task_id];assert.ok(bound?.remoteSessionId);const result=read(read(a.task_path).result_path);const savedComplete=result.completion?.complete===true&&result.completion.declared_revision===result.revision
   assert.ok(result.completion===null||savedComplete)
   const target={actionId:a.action_id,taskId:a.task_id,remoteSessionId:bound.remoteSessionId,records:result.records.length,savedComplete};targets.push(target)
   const manual=await start({parent,signal:controller.signal,resume:{taskId:target.taskId,remoteSessionId:target.remoteSessionId},prompt:[],agentOptions:{model}},'manual_compact')
   const route=`/session/${target.remoteSessionId}`,before=await manual.api(route+'/message');save(`cycle-${cycle}-${target.taskId}-messages-before`,before)
   if(savedComplete){assert.equal(bound.quiescent,true);assert.notEqual(bound.blocked,true);await manual.dispose();continue}
   const [providerID,...rest]=model.split('/');assert.equal(await manual.api(route+'/summarize',{providerID,modelID:rest.join('/'),auto:false}),true)
   const after=await manual.api(route+'/message');save(`cycle-${cycle}-${target.taskId}-messages-after`,after)
   const ids=new Set(after.map(m=>m.info.id));assert.ok(before.every(m=>ids.has(m.info.id)))
   const old=new Set(before.map(m=>m.info.id)),added=after.filter(m=>!old.has(m.info.id));assert.ok(added.some(m=>m.info.summary&&m.info.finish==='stop'&&!m.info.error));assert.equal(added.flatMap(m=>m.parts??[]).filter(p=>p.type==='compaction'&&p.auto===false).length,1)
   assert.deepEqual(read(read(a.task_path).result_path),result);await manual.dispose()
  }
  phase=`resume-${cycle}`;save(`cycle-${cycle}-resume-request`,await resumeRun(cwd,{dataRoot:created.data_root,runId:created.run_id,hostQuiescent:true}))
  host=createSourceFirstAcpRun({providerId:'pangea-opencode',agentModel:model,parent,cwd,dataRoot:created.data_root,runId:created.run_id,signal:controller.signal,runner:runPangea,python,mode:'speed',subagents:{start:(_,request)=>start(request)},onEvent:e=>{if(e.stage==='source_first_worker_bound')actionByWorker.set(e.agent_session_id,e.action_id);record({type:'host_event',...e});if(['source_first_worker_started','source_first_worker_paused','source_first_action_settled'].includes(e.stage))console.log(JSON.stringify(e))}})
  const outcome=await host.result;save(`cycle-${cycle}-host`,outcome);await host.dispose()
  for(const [name,original] of Object.entries(preserved)){const current=read(path.join(root,'agent-results/source-first',name));if(original.binding.task_id==='pending'){
    // Graph creates an empty shell before the worker's first result write.
    assert.equal(original.revision,0);assert.equal(original.records.length,0);assert.equal(original.completion,null);assert.equal(Object.keys(original.receipts).length,0)
    const action=progress.actions[original.binding.action_id];assert.ok(action?.task_id&&action.task_id!=='pending')
    assert.deepEqual(current.binding,{...original.binding,task_id:current.binding.task_id==='pending'?'pending':action.task_id})
   }else assert.deepEqual(current.binding,original.binding);for(const rec of original.records)assert.deepEqual(current.records.find(x=>x.record_id===rec.record_id),rec)}
  for(const t of targets){assert.equal(events.filter(e=>e.phase===phase&&e.type==='prompt'&&e.actionId===t.actionId).length,t.savedComplete?0:1);assert.equal(read(path.join(root,'acp-workers.json')).workers[t.taskId].remoteSessionId,t.remoteSessionId)}
  for(const a of Object.values(progress.actions).filter(a=>a.status==='accepted'))assert.equal(events.filter(e=>e.phase===phase&&e.type==='prompt'&&e.actionId===a.action_id).length,0)
  cycles.push({cycle,targets,recordsPreserved:true,hostAttention:outcome.attentionRequired});save('cycles',cycles)
  if(!outcome.attentionRequired)break
 }
 const progress=read(path.join(root,'progress.json'));assert.equal(progress.lifecycle_status,'complete')
 for(const [file,digest] of Object.entries(frozen))assert.equal(sha(file),digest)
 const manifest=read(path.join(root,'report-complete.json'));assert.deepEqual(manifest.accepted_revisions,progress.accepted_revisions);for(const file of manifest.files)assert.ok(readFileSync(path.join(root,file)).length)
 const snapshot=await companionSnapshot({dataRoot:created.data_root,runId:created.run_id});assert.equal(snapshot.current.report_available,true);assert.equal(snapshot.current.reader_health.trusted,true);save('snapshot-final',snapshot)
 save('verified-summary',{passed:true,model,cycles,qualityStatus:progress.quality_status,reportAvailable:true,reportRoot:root});console.log(JSON.stringify({passed:true,cycles,reportRoot:root}))
}catch(error){save('failure',{name:error.name,message:error.message,stack:error.stack});console.error(error);process.exitCode=1}
finally{clearTimeout(timeout);process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);await host?.dispose();for(const w of workers)await w.dispose();await context.fiber.dispose();save('process-cleanup',workers.map(w=>({taskId:w.id,remoteSessionId:w.remoteSessionId,processExited:w.readDiagnostics().processExited})))}
