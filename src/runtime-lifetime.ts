import {randomUUID} from 'node:crypto';
import {DomainError} from './domain.ts';
import type {Mission,Work,RuntimeOwnership} from './domain.ts';
import type {Store} from './storage.ts';
import type {ProviderAdapter,ProviderOutcome,ProviderRequest} from './providers.ts';
export const HOST_SESSION_ID='host:'+randomUUID(),DEFAULT_RUN_TIMEOUT_MS=120000,MAX_RUN_TIMEOUT_MS=300000;
export class RunDeadlineError extends Error {constructor(){super('Host run deadline elapsed. Admitted external effects may remain unresolved; no remote stop or replay is inferred.');}}
export function validateRuntimeOwnership(value:RuntimeOwnership):void {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==4||!Object.keys(value).every(k=>['hostSessionId','dispatchId','startedAt','deadlineAt'].includes(k))||![value.hostSessionId,value.dispatchId].every(x=>typeof x==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(x))||!Number.isSafeInteger(value.startedAt)||value.startedAt<1||!Number.isSafeInteger(value.deadlineAt)||value.deadlineAt<=value.startedAt||value.deadlineAt-value.startedAt>MAX_RUN_TIMEOUT_MS)throw new DomainError('Invalid bounded runtime ownership');
}
const outcome=(status:'failed'|'unknown',reason:string):ProviderOutcome=>({status,output:null,usage:{inputTokens:status==='failed'?0:null,outputTokens:status==='failed'?0:null},reason});
/** An abort is a host boundary, never evidence that an already invoked adapter stopped. */
export async function invokeOwned(adapter:ProviderAdapter,request:ProviderRequest,ownership:RuntimeOwnership):Promise<ProviderOutcome>{
 const {signal}=request;if(Date.now()>=ownership.deadlineAt&&!signal.aborted)return outcome('failed','Host deadline reached before invocation; adapter was not called.');if(signal.aborted)return outcome('failed','Host interrupted before invocation; adapter was not called.');
 let abort!:()=>void;const interrupted=new Promise<ProviderOutcome>(resolve=>abort=()=>resolve(outcome('unknown',signal.reason instanceof RunDeadlineError?signal.reason.message:'Host interrupted an admitted invocation. External outcome remains unknown; no remote stop or replay is inferred.')));signal.addEventListener('abort',abort,{once:true});
 try{if(signal.aborted)return outcome('failed','Host interrupted before invocation; adapter was not called.');const result=await Promise.race([adapter.invoke(request),interrupted]);if(Date.now()>=ownership.deadlineAt)return outcome('unknown',new RunDeadlineError().message);return result;}finally{signal.removeEventListener('abort',abort);}
}
export function validateRuntimeInterruption(work:Work):void {
 const i=work.runtimeInterruption;if(!Object.hasOwn(work,'runtimeInterruption'))return;const o=work.runtimeRun?.ownership;const invalid=():never=>{throw new DomainError('Invalid retained runtime interruption');};if(!o||!i||typeof i!=='object'||Array.isArray(i)||Object.keys(i).length!==6||!Object.keys(i).every(k=>['runId','dispatchId','reason','observedAt','pendingEffectIds','unknownEffectIds'].includes(k))||i.runId!==work.runtimeRun!.id||i.dispatchId!==o.dispatchId||i.reason!=='deadline'||!Number.isSafeInteger(i.observedAt)||i.observedAt<o.deadlineAt||!['blocked','cancelled'].includes(work.execution)||work.acceptance==='accepted')return invalid();validateRuntimeOwnership(o);if(!Array.isArray(i.pendingEffectIds)||!Array.isArray(i.unknownEffectIds))invalid();const ids=[...i.pendingEffectIds,...i.unknownEffectIds];if(new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!id||work.effects.filter(e=>e.id===id&&e.status==='unknown').length!==1)||i.pendingEffectIds.length&&work.budget.measured!==null)invalid();
}
export class RuntimeOwnershipError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
export async function readRuntimeOwnership(store:Store<Mission>,missionId:string,workId:string,feedId:string|undefined,owns:(runId:string)=>boolean){
 const state=await store.readState(missionId);if(feedId!==undefined&&state.feedId!==feedId)throw new RuntimeOwnershipError(409,'Database feed changed before exact run ownership read');const work=state.snapshot?.value.works.find(w=>w.id===workId);if(!work)return null;
 const ownership=work.runtimeRun?.ownership;try{if(Object.hasOwn(work.runtimeRun??{},'ownership'))validateRuntimeOwnership(ownership!);validateRuntimeInterruption(work);}catch{throw new RuntimeOwnershipError(503,'Stored run ownership failed integrity checks');}
 return {missionId,workId,revision:state.snapshot!.revision,feedId:state.feedId,cursor:state.cursor,runId:work.runtimeRun?.id??null,ownership:ownership?structuredClone(ownership):null,currentHostSessionId:HOST_SESSION_ID,localDispatchActive:!!work.runtimeRun&&owns(work.runtimeRun.id),deadlineHasPassed:ownership?Date.now()>=ownership.deadlineAt:null,interruption:work.runtimeInterruption?structuredClone(work.runtimeInterruption):null,execution:work.execution,acceptance:work.acceptance,unresolvedEffectIds:work.effects.filter(e=>['pending','unknown'].includes(e.status)).map(e=>e.id),replayPermitted:false};
}
