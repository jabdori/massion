import {validCredentialFailure} from './provider-credentials.ts';
import {DomainError,workInputHash} from './domain.ts';
import type {Work,RuntimeOwnership,Effect} from './domain.ts';
import {validateRuntimeOwnership} from './runtime-lifetime.ts';

export const currentOwnership=(w:Work)=>w.runtimeRun?.resumptions?.at(-1)??w.runtimeRun?.ownership;
export function completedEffect(w:Work,e:Effect):Effect|undefined {
 if(e.status==='succeeded')return e;if(e.status!=='failed')return;
 let receipt;try{receipt=JSON.parse(e.receipt!);}catch{return;}
 if(validCredentialFailure(receipt.credentialFailure))return w.effects.find(next=>next.id===e.id+':repair'&&next.taskId===e.taskId&&next.status==='succeeded');
}
export function canResume(w:Work,at:number):boolean {
 const run=w.runtimeRun,o=currentOwnership(w);
 return !!(!w.tasks.some(t=>t.environment)&&!w.secretRequests?.some(r=>r.state!=='provided')&&run?.continuationVersion===1&&w.team&&o&&at>=o.startedAt&&at<o.deadlineAt&&!w.runtimeRecovery&&!w.monthlyBudgetDecision&&!['waiting','cancelled','budget-waiting'].includes(w.execution)&&w.acceptance!=='accepted'&&w.acceptance!=='failed'&&(!w.runtimeInterruption||w.runtimeInterruption.reason==='host-shutdown')&&(!w.blocker||w.runtimeInterruption?.reason==='host-shutdown')&&w.effects.every(e=>completedEffect(w,e)&&!e.ownerDecision));
}
export function validateContinuation(w:Work){
 const r=w.runtimeRun;if(!r)return;
 const fail=():never=>{throw new DomainError('Invalid runtime continuation lineage');};
 if(r.continuationVersion!==undefined&&(r.continuationVersion!==1||r.steeringVersion!==1||!w.team||!r.ownership||!r.continuationConfig||!/^[a-f0-9]{64}$/.test(r.continuationConfig)))fail();
 if(Object.hasOwn(r,'continuationConfig')&&r.continuationVersion!==1)fail();
 if(Object.hasOwn(r,'assembly')){if(!r.assembly||r.continuationVersion!==1||Object.keys(r.assembly).sort().join()!=='inputHash,version'||!Number.isSafeInteger(r.assembly.version)||r.assembly.version<1||r.assembly.version>4||!/^[a-f0-9]{64}$/.test(r.assembly.inputHash))fail();}
 if(Object.hasOwn(r,'resumptions')){if(!r.resumptions||r.continuationVersion!==1||!Array.isArray(r.resumptions)||r.resumptions.length>32)fail();const ids=new Set([r.ownership!.dispatchId]);for(const o of r.resumptions!){validateRuntimeOwnership(o);if(o.startedAt!==r.ownership!.startedAt||o.deadlineAt!==r.ownership!.deadlineAt||ids.has(o.dispatchId))fail();ids.add(o.dispatchId);}}
}
export function resumeRuntime(w:Work,previousDispatchId:string,ownership:RuntimeOwnership,at:number){
 if(!canResume(w,at)||currentOwnership(w)?.dispatchId!==previousDispatchId)throw new DomainError('Runtime checkpoint is not safely resumable');
 const r=w.runtimeRun!;validateRuntimeOwnership(ownership);
 if(ownership.startedAt!==r.ownership!.startedAt||ownership.deadlineAt!==r.ownership!.deadlineAt)throw new DomainError('Continuation cannot renew the original deadline');
 (r.resumptions??=[]).push(structuredClone(ownership));validateContinuation(w);delete w.runtimeInterruption;delete w.blocker;delete w.endedAt;w.execution=w.tasks.every(t=>t.status==='settled')?'settled':w.effects.length?'active':'queued';
}
export function beginAssembly(w:Work,inputHash:string){
 const r=w.runtimeRun!;
 if(r?.continuationVersion!==1||inputHash!==workInputHash(w)||w.acceptance==='accepted'||['waiting','cancelled','blocked','budget-waiting'].includes(w.execution)||w.effects.some(e=>!completedEffect(w,e))||w.tasks.some(t=>t.step&&t.status!=='settled'))throw new DomainError('Assembly requires current inputs and settled effects');
 if(r.assembly?.inputHash===inputHash)return;
 const version=(r.assembly?.version??0)+1;if(version>4)throw new DomainError('Assembly revision limit reached');
 if(version>1){
  const number=w.attempts.length+1;w.attempts.push({id:w.id+':attempt:'+number,number,criteria:structuredClone(w.criteria),status:'active',modelVersions:w.assignments.map(a=>a.model.configVersion)});
  for(const t of w.tasks)if(!t.step&&t.id!==w.id+':planning'){t.status='queued';delete t.result;delete t.startedAt;delete t.endedAt;}
  delete w.room;delete w.verdict;delete w.endedAt;w.acceptance='pending';
 }
 r.assembly={version,inputHash};w.execution='active';
}
