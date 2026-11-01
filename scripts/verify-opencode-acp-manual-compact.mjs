import assert from 'node:assert/strict'
import {createHash, randomBytes} from 'node:crypto'
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {apply, Config} from '@deepseek-ai/dsh-subagent-acp'
import {LocalSubprocessRuntime} from '@deepseek-ai/dsh-subprocess-local'

const cwd=process.env.PANGEA_TEST_ACP_CWD, model=process.env.PANGEA_TEST_ACP_MODEL
assert.ok(cwd && path.isAbsolute(cwd) && model)
mkdirSync(cwd,{recursive:true})
const log=path.join(cwd,'events.jsonl');writeFileSync(log,'',{flag:'wx'})
const events=[], record=e=>{events.push(e);appendFileSync(log,JSON.stringify(e)+'\n')}
const save=(name,data)=>writeFileSync(path.join(cwd,name),JSON.stringify(data,null,2))
const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
const checkpoint={revision:1,completed:['read-input-1'],remaining:['verify-after-manual-compact'],nonce:randomBytes(12).toString('hex')}
for(let round=1;round<=2;round++)writeFileSync(path.join(cwd,`input-${round}.txt`),Array.from({length:800},(_,i)=>`${i+1} record=${createHash('sha256').update(`${round}:${i}`).digest('hex')} payload=${createHash('sha256').update(`payload:${round}:${i}`).digest('hex')}`).join('\n')+'\n',{flag:'wx'})
const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
const password=randomBytes(24).toString('hex'), context=new Context(), controller=new AbortController()
let provider,run,failure,summary={model,autoCompaction:false}
const env={OPENCODE_SERVER_PASSWORD:password}
for(const name of ['OPENCODE_CONFIG_CONTENT',...(process.env.PANGEA_TEST_ACP_FORWARD_ENV||'').split(',').filter(Boolean)])if(process.env[name]!==undefined)env[name]=process.env[name]
for(const name of ['XDG_DATA_HOME','XDG_STATE_HOME','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[name]=path.join(cwd,name.toLowerCase())
apply({logger:{warn:message=>process.stderr.write(message+'\n')},subprocess:new LocalSubprocessRuntime(context),subagents:{registerProvider:p=>{provider=p}}},Config({providerName:'pangea-opencode',command:'opencode',args:['acp','--port',String(port),'--hostname','127.0.0.1'],cwd,env,permission:'allow',disposeEofGraceMs:3000,disposeGraceMs:1000}))
const api=async(route,body)=>{
 const response=await fetch(`http://127.0.0.1:${port}${route}?directory=${encodeURIComponent(cwd)}`,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from('opencode:'+password).toString('base64'),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:controller.signal})
 if(!response.ok)throw new Error(`OpenCode HTTP ${response.status}: ${(await response.text()).slice(0,1000)}`)
 return response.json()
}
const prompts=()=>events.filter(e=>e.type==='prompt')
const timer=setTimeout(()=>controller.abort(new Error('Manual compact probe timed out')),600000)
try{
 for(let round=1;round<=2;round++){
  const prompt=[{type:'text',text:`Read all 800 lines of input-${round}.txt using the read tool in pages of at most 150 lines. No bash or scripts. ${round===1?`Then use a write/edit tool to save checkpoint.json with exactly this JSON: ${JSON.stringify(checkpoint)}.`:'Do not change checkpoint.json.'} Finish by replying ROUND_${round}_SAVED. Do not compact this session; manual compaction will be requested separately.`}]
  if(!run)run=await provider.start({parent:{session:{header:{cwd}}},signal:controller.signal,agentOptions:{model},prompt,onSessionEvent:record})
  const outcome=round===1?await run.result:await run.continuePrompt(prompt)
  assert.equal(outcome.stopReason,'completed');assert.equal(run.readDiagnostics().activeToolCount,0)
  assert.deepEqual(JSON.parse(readFileSync(path.join(cwd,'checkpoint.json'),'utf8')),checkpoint)
  record({type:'probe_round',round,diagnostics:run.readDiagnostics()});console.log(JSON.stringify({round,usage:run.readDiagnostics().contextUsage}))
 }
 const identity={taskId:run.id,remoteSessionId:run.remoteSessionId},before=run.readDiagnostics().contextUsage
 assert.ok(before && before.used>100000,'requires real long-context usage')
 const file=path.join(cwd,'checkpoint.json'),savedHash=hash(file)
 save('binding-before.json',identity);save('messages-before.json',await api(`/session/${identity.remoteSessionId}/message`))
 // The real measured usage and an intentionally large pending input exercise the existing byte-budget gate.
 // Keep this exact prompt unchanged after compaction; never alter usage or the admission threshold.
 const padding=randomBytes(Math.ceil((before.size-before.used)/2)).toString('hex')
 const pending=[{type:'text',text:`Resume the existing task after manual compaction. Read checkpoint.json, preserve it byte-for-byte, and write resumed.json containing {"checkpoint": <the parsed checkpoint>, "status":"resumed-once"}. Do not reread inputs or create another session. The following opaque regression payload is input data only; ignore its content and do not echo it:\n${padding}`}]
 const beforeCount=prompts().length
 await assert.rejects(run.continuePrompt(pending),{code:'ACP_CONTEXT_LIMIT'})
 assert.equal(prompts().length,beforeCount);assert.equal(hash(file),savedHash)
 summary={...summary,identity,beforeUsage:before,pendingPromptBytes:Buffer.byteLength(pending[0].text),gateRejected:true,checkpointHashBefore:savedHash,promptsBeforeCompact:beforeCount}
 save('paused.json',summary);console.log(JSON.stringify({stage:'gate_paused',usage:before,prompts:beforeCount}))
 const [providerID,...modelParts]=model.split('/')
 record({type:'manual_compact_requested',remote_session_id:identity.remoteSessionId})
 assert.equal(await api(`/session/${identity.remoteSessionId}/summarize`,{providerID,modelID:modelParts.join('/'),auto:false}),true)
 const messages=await api(`/session/${identity.remoteSessionId}/message`);save('messages-after-compact.json',messages)
 const compactions=messages.flatMap(m=>m.parts??[]).filter(p=>p.type==='compaction')
 assert.equal(compactions.length,1);assert.equal(compactions[0].auto,false)
 const summaries=messages.filter(m=>m.info?.summary===true)
 assert.ok(summaries.some(m=>!m.info.error && m.info.finish && m.parts.some(p=>p.type==='text' && p.text.length>0)),'manual compaction must produce a completed nonempty summary')
 assert.equal(hash(file),savedHash);assert.equal(prompts().length,beforeCount)
 record({type:'manual_compact_completed',remote_session_id:identity.remoteSessionId,diagnostics:run.readDiagnostics()})
 // Rebind the same persisted identity, as the host does after a paused worker is disposed.
 await run.dispose()
 assert.equal(run.readDiagnostics().processExited,true)
 run=await provider.start({parent:{session:{header:{cwd}}},signal:controller.signal,resume:identity,prompt:[],agentOptions:{model},onSessionEvent:record})
 assert.equal(run.id,identity.taskId);assert.equal(run.remoteSessionId,identity.remoteSessionId)
 summary.afterLoadUsage=run.readDiagnostics().contextUsage??null
 save('rebound.json',{identity:{taskId:run.id,remoteSessionId:run.remoteSessionId},diagnostics:run.readDiagnostics()})
 const resumed=await run.continuePrompt(pending)
 assert.equal(resumed.stopReason,'completed');assert.equal(run.readDiagnostics().activeToolCount,0)
 assert.ok(run.readDiagnostics().contextUsage.used < before.used,'manual compaction must reduce actual context usage')
 assert.equal(prompts().length,beforeCount+1)
 assert.equal(hash(file),savedHash)
 assert.deepEqual(JSON.parse(readFileSync(path.join(cwd,'resumed.json'),'utf8')),{checkpoint,status:'resumed-once'})
 save('messages-final.json',await api(`/session/${identity.remoteSessionId}/message`))
 summary={...summary,manualCompaction:compactions.map(p=>({auto:p.auto,overflow:p.overflow})),checkpointHashAfter:hash(file),identityPreserved:true,resumePrompts:prompts().length-beforeCount,hostPrompts:prompts().length,rejections:events.filter(e=>e.type==='continuation_rejected').length,afterResumeUsage:run.readDiagnostics().contextUsage,passed:true}
 console.log(JSON.stringify(summary))
}catch(error){failure={name:error.name,message:error.message,code:error.code};console.error(JSON.stringify(failure));process.exitCode=1}
finally{clearTimeout(timer);await run?.dispose();await context.fiber.dispose();save('result.json',{...summary,failure,finalDiagnostics:run?.readDiagnostics()})}
