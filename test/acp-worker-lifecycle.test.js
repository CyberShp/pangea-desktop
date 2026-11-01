import {it, expect} from 'vitest'
import {SubagentRuntime} from '@deepseek-ai/dsh-subagent'

it('keeps readiness completion out of the one-shot lifecycle while preserving ordinary runs', async()=>{
 for (const managed of [false,true]) {
 const events=[]
 const run={id:'worker',result:Promise.resolve({stopReason:'completed',output:[]})}
 const host={expectProvider:()=>({start:async()=>run}),assertCapabilities(){},emitLifecycle:(...event)=>events.push(event)}
 const published=await SubagentRuntime.prototype.start.call(host,'fixture',{parent:{},prompt:[],pangeaCliWorker:managed})
 await Promise.resolve()
 expect(published).toBe(run)
 expect(events.map(e=>e[0])).toEqual(managed?[]:['subagent/start','subagent/end'])
 }
})
