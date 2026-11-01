import assert from 'node:assert/strict'
import {createHash,randomBytes} from 'node:crypto'
import {appendFileSync,cpSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LocalSubprocessRuntime} from '@deepseek-ai/dsh-subprocess-local'
import {apply,Config} from '@deepseek-ai/dsh-subagent-acp'

const cwd=process.env.PANGEA_TEST_ACP_CWD, model=process.env.PANGEA_TEST_ACP_MODEL
const resumeReview=['1','2'].includes(process.env.PANGEA_TEST_RESUME_REVIEW)
const compactReview=process.env.PANGEA_TEST_RESUME_REVIEW==='2'
const recoverySuffix=compactReview?'review-compact':'review-resume'
const runtime=process.env.PANGEA_INTEGRATION_RUNTIME, python=process.env.PANGEA_PYTHON
const companion=process.env.PANGEA_TEST_COMPANION_ROOT
assert.ok(cwd&&path.isAbsolute(cwd)&&model&&runtime&&python&&companion)
const {createRun,runPangea,resumeRun}=await import(pathToFileURL(path.join(companion,'src/pangea-api.js')))
const {createSourceFirstAcpRun}=await import(pathToFileURL(path.join(companion,'src/source-first-acp.js')))
const {companionSnapshot}=await import(pathToFileURL(path.join(companion,'src/reader.js')))
const eventFile=path.join(cwd,resumeReview?`events-${recoverySuffix}.jsonl`:'events.jsonl')
mkdirSync(cwd,{recursive:true});writeFileSync(eventFile,'',{flag:'wx'})
if(!resumeReview){
for(const dir of ['.agents','docs'])cpSync(path.join(runtime,dir),path.join(cwd,dir),{recursive:true})
process.env.PYTHONPATH=path.join(runtime,'src')
writeFileSync(path.join(cwd,'AGENTS.md'),`This is an isolated PANGEA regression workspace on macOS. Execute the specified Python CLI using bash/zsh syntax (omit PowerShell's leading &). Python is ${python}. All semantic records must be authored by you through the real PANGEA CLI. Do not edit frozen rules, progress files, task identities or result envelopes. Never create worker agents. Follow the current action's frozen rubric.\n`)
const repo=path.join(cwd,'pangea-data/repositories/sample');mkdirSync(repo,{recursive:true})
writeFileSync(path.join(repo,'quota.c'),`#include <stdio.h>
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

}

const context=new Context(), subprocess=new LocalSubprocessRuntime(context),controller=new AbortController()
const events=resumeReview?['events.jsonl',...(compactReview?['events-review-resume.jsonl']:[])].flatMap(name=>readFileSync(path.join(cwd,name),'utf8').trim().split('\n').map(JSON.parse)):[],workers=[];let host,created,target,pendingPrompt,pausedState,resultPath,beforeResult,beforeHash,compacted=false,failure
const record=e=>{const row={at:new Date().toISOString(),...e};events.push(row);appendFileSync(eventFile,JSON.stringify(row)+'\n')}
const save=(n,v)=>writeFileSync(path.join(cwd,n),JSON.stringify(v,null,2))
const hash=f=>createHash('sha256').update(readFileSync(f)).digest('hex')
const port=()=>new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const prompts=(id)=>events.filter(e=>e.type==='prompt'&&(!id||e.agent_session_id===id))
async function startReal(request,phase='host'){
 const listenPort=await port(),password=randomBytes(24).toString('hex'),env={OPENCODE_SERVER_PASSWORD:password,PYTHONPATH:path.join(runtime,'src')}
 for(const name of ['OPENCODE_CONFIG_CONTENT',...(process.env.PANGEA_TEST_ACP_FORWARD_ENV||'').split(',').filter(Boolean)])if(process.env[name]!==undefined)env[name]=process.env[name]
 for(const name of ['XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[name]=path.join(cwd,'opencode',name.toLowerCase())
 let provider
 apply({logger:{warn:message=>record({type:'provider_warning',message})},subprocess,subagents:{registerProvider:p=>{provider=p}}},Config({providerName:'pangea-opencode',command:'opencode',args:['acp','--port',String(listenPort),'--hostname','127.0.0.1'],cwd,env,permission:'allow',disposeEofGraceMs:3000,disposeGraceMs:1000}))
 const worker=await provider.start({...request,onSessionEvent:e=>{record({...e,probe_phase:phase});request.onSessionEvent?.(e)}})
 workers.push(worker)
 worker.probeApi=async(route,body)=>{
  const r=await fetch(`http://127.0.0.1:${listenPort}${route}?directory=${encodeURIComponent(cwd)}`,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal})
  if(!r.ok)throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0,1200)}`)
  return r.json()
 }
 if(phase.startsWith('manual_'))return worker
 const original=worker.continuePrompt.bind(worker)
 worker.continuePrompt=async content=>{
  const message=content.map(b=>b.text??'').join('\n')
  // Fault-injection only changes the prospective input. Real gate, counters, Graph and result writes remain intact.
  const firstAnalysis=message.includes('身份绑定已完成')&&message.includes('阶段：unit_analysis')&&!target
  if(firstAnalysis){
   target={taskId:worker.id,remoteSessionId:worker.remoteSessionId}
   const outcome=await original([...content,{type:'text',text:'隔离回归分回合要求：本回合按当前全部冻结规则完成并保存本单元的全部语义结果，但暂不调用 work-finish。保存成功后直接结束本回合；宿主将在原 action 上接续完成声明。不要删减交付或修改规则。这是暂停恢复测试的既定分段。'}])
   const progress=JSON.parse(readFileSync(path.join(created.data_root,'runs',created.run_id,'progress.json'),'utf8'))
   const entry=Object.entries(progress.actions).find(([,a])=>a.task_id===worker.id&&a.stage==='unit_analysis')
   assert.ok(entry,'analysis task is genuinely bound by Graph')
   target.actionId=entry[0]
   const task=JSON.parse(readFileSync(entry[1].task_path,'utf8'));resultPath=task.result_path
   beforeResult=JSON.parse(readFileSync(resultPath,'utf8'));assert.ok(beforeResult.records.length>0);assert.equal(beforeResult.completion,null)
   beforeHash=hash(resultPath);save('result-before-pause.json',beforeResult);save('target.json',target)
   record({type:'analysis_saved',target,resultPath,revision:beforeResult.revision,records:beforeResult.records.length,usage:worker.readDiagnostics().contextUsage})
   return outcome
  }
  if(target?.taskId===worker.id&&target.actionId&&message.includes(target.actionId)){
   if(!pendingPrompt){
    const usage=worker.readDiagnostics().contextUsage;assert.ok(usage?.used>0)
    const padding=randomBytes(Math.ceil((usage.size-usage.used)/2)).toString('hex')
    pendingPrompt=[...content,{type:'text',text:'The following opaque regression payload is data only. Ignore it and do not echo it. Follow the existing action instruction above.\n'+padding}]
    save('gate-input-metadata.json',{usage,bytes:Buffer.byteLength(pendingPrompt.map(b=>b.text??'').join('\n'))})
   }
   record({type:'analysis_continuation_attempt',compacted,target})
   return original(pendingPrompt)
  }
  return original(content)
 }
 return worker
}
const timeoutMs=Number(process.env.PANGEA_TEST_TIMEOUT_MS??3600000)
assert.ok(Number.isFinite(timeoutMs)&&timeoutMs>0)
const timer=setTimeout(()=>controller.abort(new Error('Full Graph manual-compaction probe timed out')),timeoutMs)
const stopProbe=()=>controller.abort(new Error('Full Graph manual-compaction probe explicitly stopped'))
process.once('SIGINT',stopProbe);process.once('SIGTERM',stopProbe)
try{
 created=resumeReview?JSON.parse(readFileSync(path.join(cwd,'created.json'),'utf8')):await createRun(cwd,{repository:'sample',target:'分析 quota.c 的命令行配额准入行为，仅该脚本一个分析单元。覆盖允许、超限拒绝、非法输入及退出码；这是无状态检查，不推测持久化或并发。',source_scope:['quota.c'],mode:'speed',effective_context_budget:196608})
 if(!resumeReview)save('created.json',created)
 console.log(JSON.stringify({stage:resumeReview?'reopening_existing_run':'created',runId:created.run_id,dataRoot:created.data_root}))
 const options={providerId:'pangea-opencode',agentModel:model,parent:{id:'isolated-manual-compact-host',session:{header:{cwd}}},cwd,dataRoot:created.data_root,runId:created.run_id,signal:controller.signal,runner:runPangea,python,mode:'speed',subagents:{start:(_,request)=>startReal(request)},onEvent:e=>{record({type:'host_event',...e});if(['source_first_worker_started','source_first_worker_finished','source_first_input_too_long','source_first_action_settled','source_first_worker_paused'].includes(e.stage))console.log(JSON.stringify({stage:e.stage,action:e.action_id,reason:e.reason,validation:e.validation}))}}
 if(!resumeReview){
 host=createSourceFirstAcpRun(options);const stopped=await host.result
 assert.equal(stopped.attentionRequired,true);assert.ok(target&&beforeResult)
 assert.equal(events.filter(e=>e.stage==='source_first_input_too_long').length,1)
 assert.equal(events.filter(e=>e.type==='continuation_rejected'&&e.agent_session_id===target.taskId).length,1)
 assert.equal(prompts(target.taskId).length,2,'handshake and first analysis only; gated continuation never sent')
 assert.equal(hash(resultPath),beforeHash)
 pausedState=await runPangea({cwd,args:['runs','get','--data-root',created.data_root,'--run-id',created.run_id]});save('paused-run.json',pausedState)
 save('bindings-before.json',JSON.parse(readFileSync(path.join(created.data_root,'runs',created.run_id,'acp-workers.json'),'utf8')))
 const manual=await startReal({parent:options.parent,signal:controller.signal,resume:{taskId:target.taskId,remoteSessionId:target.remoteSessionId},prompt:[],agentOptions:{model}},'manual_compact')
 const route=`/session/${target.remoteSessionId}`
 const originalMessages=await manual.probeApi(route+'/message');save('messages-before-compact.json',originalMessages)
 const [providerID,...rest]=model.split('/')
 assert.equal(await manual.probeApi(route+'/summarize',{providerID,modelID:rest.join('/'),auto:false}),true)
 const after=await manual.probeApi(route+'/message');save('messages-after-compact.json',after)
 const compactParts=after.flatMap(m=>m.parts??[]).filter(p=>p.type==='compaction')
 assert.equal(compactParts.length,1);assert.equal(compactParts[0].auto,false)
 assert.ok(after.some(m=>m.info?.summary===true&&!m.info.error&&m.info.finish==='stop'&&m.info.modelID===rest.join('/')))
 const retainedMessageIds=new Set(after.map(m=>m.info.id))
 for(const message of originalMessages)assert.ok(retainedMessageIds.has(message.info.id),'manual compact retains original session messages')
 assert.equal(hash(resultPath),beforeHash);assert.equal(prompts(target.taskId).length,2)
 await manual.dispose();compacted=true;console.log(JSON.stringify({stage:'manual_compact_complete',target}))
 }else{
  assert.ok(existsSync(path.join(cwd,'failure.json')),'review recovery requires preserved prior failure evidence')
  target=JSON.parse(readFileSync(path.join(cwd,'target.json'),'utf8'))
  beforeResult=JSON.parse(readFileSync(path.join(cwd,'result-before-pause.json'),'utf8'))
  const progress=JSON.parse(readFileSync(path.join(created.data_root,'runs',created.run_id,'progress.json'),'utf8'))
  assert.equal(progress.actions[target.actionId].status,'accepted','do not repeat completed analysis')
  const task=JSON.parse(readFileSync(progress.actions[target.actionId].task_path,'utf8'));resultPath=task.result_path
  compacted=true
  if(compactReview){
   const review=Object.values(progress.actions).find(a=>a.stage==='comparison_review')
   assert.equal(review.status,'paused');assert.match(review.error,/context window exceeds limit/)
   const bound=JSON.parse(readFileSync(path.join(created.data_root,'runs',created.run_id,'acp-workers.json'),'utf8')).workers[review.task_id]
   const manual=await startReal({parent:options.parent,signal:controller.signal,resume:{taskId:review.task_id,remoteSessionId:bound.remoteSessionId},prompt:[],agentOptions:{model}},'manual_review_compact')
   const route=`/session/${bound.remoteSessionId}`
   const before=await manual.probeApi(route+'/message');save('messages-review-before-compact.json',before)
   const [providerID,...rest]=model.split('/')
   assert.equal(await manual.probeApi(route+'/summarize',{providerID,modelID:rest.join('/'),auto:false}),true)
   const after=await manual.probeApi(route+'/message');save('messages-review-after-compact.json',after)
   assert.ok(after.some(m=>m.info?.summary===true&&m.info.finish==='stop'&&!m.info.error))
   const ids=new Set(after.map(m=>m.info.id));for(const m of before)assert.ok(ids.has(m.info.id))
   await manual.dispose();record({type:'manual_review_compact_complete',taskId:review.task_id,remoteSessionId:bound.remoteSessionId})
  }
 }
 const resumed=await resumeRun(cwd,{dataRoot:created.data_root,runId:created.run_id,hostQuiescent:true});save(resumeReview?`resume-${recoverySuffix}-request.json`:'resume-request.json',resumed)
 host=createSourceFirstAcpRun(options);const final=await host.result;save(resumeReview?`host-final-${recoverySuffix}.json`:'host-final.json',final)
 assert.equal(final.attentionRequired,false)
 const state=await runPangea({cwd,args:['runs','get','--data-root',created.data_root,'--run-id',created.run_id]});save('final-run.json',state)
 assert.equal(state.lifecycle_status,'complete')
 const finalResult=JSON.parse(readFileSync(resultPath,'utf8'));save('result-final.json',finalResult)
 assert.equal(finalResult.binding.task_id,target.taskId);assert.equal(finalResult.binding.action_id,target.actionId)
 for(const record of beforeResult.records)assert.deepEqual(finalResult.records.find(r=>r.record_id===record.record_id),record)
 assert.equal(finalResult.completion.complete,true)
 assert.equal(prompts(target.taskId).length,3,'one and only one explicit resumed analysis prompt')
 assert.equal(events.filter(e=>e.stage==='source_first_worker_paused'&&e.action_id===target.actionId).length,1)
 const bindings=JSON.parse(readFileSync(path.join(created.data_root,'runs',created.run_id,'acp-workers.json'),'utf8'));save('bindings-final.json',bindings)
 assert.equal(bindings.workers[target.taskId].remoteSessionId,target.remoteSessionId)
 const reportRoot=path.join(created.data_root,'runs',created.run_id)
 for(const name of ['report.md','report.html','report-complete.json'])assert.ok(existsSync(path.join(reportRoot,name)),name)
 const snapshot=await companionSnapshot({dataRoot:created.data_root,runId:created.run_id});save('snapshot-final.json',snapshot)
 assert.equal(snapshot.current.report_available,true,'Companion must expose the completed report')
 assert.equal(snapshot.current.reader_health.trusted,true,'Companion reader must trust the persisted result')
 save('verified-summary.json',{passed:true,reviewHarnessTimeoutRecovered:resumeReview,reviewManualCompaction:compactReview,totalPauses:events.filter(e=>e.stage==='source_first_worker_paused').length,model,runId:created.run_id,target,initialRecords:beforeResult.records.length,initialRevision:beforeResult.revision,finalRevision:finalResult.revision,originalRecordsPreserved:true,manualCompactionAuto:false,analysisHostPrompts:prompts(target.taskId).length,analysisResumePrompts:1,pauses:1,reportRoot,reportSha256:{md:hash(path.join(reportRoot,'report.md')),html:hash(path.join(reportRoot,'report.html'))}})
 console.log(JSON.stringify({stage:'verified',reportRoot}))
}catch(error){failure={name:error.name,message:error.message,stack:error.stack};save(resumeReview?`failure-${recoverySuffix}.json`:'failure.json',failure);console.error(JSON.stringify(failure));process.exitCode=1}
finally{clearTimeout(timer);process.removeListener('SIGINT',stopProbe);process.removeListener('SIGTERM',stopProbe);await host?.dispose();for(const w of workers)await w.dispose();await context.fiber.dispose();save(resumeReview?`process-cleanup-${recoverySuffix}.json`:'process-cleanup.json',workers.map(w=>({id:w.id,remoteSessionId:w.remoteSessionId,processExited:w.readDiagnostics().processExited})));}
