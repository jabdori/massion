import {workFileInputs} from './github-review.ts';
import {DomainError,hash} from './domain.ts';
import type {Effect,ProviderDispatchClaim,Work} from './domain.ts';
import {validateRuntimeOwnership} from './runtime-lifetime.ts';
import type {ProviderRequest} from './providers.ts';
/** Hash task data and bounded call identity, never the ephemeral signal or credentials. */
export function providerRequestHash(request:ProviderRequest):string {
 return hash({invocationId:request.invocationId,workId:request.workId,instruction:request.instruction,inputReferences:request.inputReferences,maxOutputTokens:request.maxOutputTokens});
}
const fields=['id','runId','hostSessionId','dispatchId','actorId','assignmentId','provider','model','configVersion','requestHash','claimedAt'];
export function validateProviderDispatch(work:Work,effect:Effect,claim:ProviderDispatchClaim):void {
 const invalid=()=>{throw new DomainError('Provider dispatch claim does not match the original owned run, effect and assignment');};
 if(!claim||typeof claim!=='object'||Array.isArray(claim)||Object.keys(claim).length!==fields.length+(Object.hasOwn(claim,'fileInputs')?1:0)||!Object.keys(claim).every(k=>fields.includes(k)||k==='fileInputs'))return invalid();
 for(const key of fields.filter(k=>!['requestHash','claimedAt'].includes(k))){const value=claim[key as keyof ProviderDispatchClaim];if(typeof value!=='string'||!value.trim()||value.length>4096||!value.isWellFormed())return invalid();}
 if(!/^[a-zA-Z0-9:_-]{1,128}$/.test(claim.id)||!/^[a-f0-9]{64}$/.test(claim.requestHash)||!Number.isSafeInteger(claim.claimedAt))return invalid();
 if(Object.hasOwn(claim,'fileInputs')){const inputs=claim.fileInputs,known=workFileInputs(work);if(!Array.isArray(inputs)||!inputs.length||inputs.length>33||!inputs.every(f=>f&&typeof f==='object'&&Object.keys(f).length===3&&known.some(k=>hash(k)===hash(f)))||new Set(inputs.map(f=>f.documentId+'\0'+f.path)).size!==inputs.length||!work.tasks.some(t=>t.id===effect.taskId&&t.step&&!t.step.skipReason&&(!t.step.sourceFiles||inputs.every(f=>t.step!.sourceFiles!.includes(f.path)))))return invalid();}
 const run=work.runtimeRun,owner=run?.ownership;if(!run||!owner)return invalid();validateRuntimeOwnership(owner);
 const assignment=work.assignments.find(a=>a.id===claim.assignmentId);
 if(claim.runId!==run.id||claim.hostSessionId!==owner.hostSessionId||claim.dispatchId!==owner.dispatchId||claim.claimedAt<owner.startedAt||claim.claimedAt>=owner.deadlineAt||effect.authority!==run.authorizationId||!assignment||assignment.actorId!==claim.actorId||assignment.taskId!==effect.taskId||assignment.model.provider!==claim.provider||assignment.model.model!==claim.model||assignment.model.configVersion!==claim.configVersion||effect.target!==`${claim.provider}/${claim.model}`)return invalid();
}
export function validateProviderDispatchClaims(work:Work):void {
 const ids=new Set<string>();for(const effect of work.effects)if(Object.hasOwn(effect,'providerDispatch')){validateProviderDispatch(work,effect,effect.providerDispatch!);if(ids.has(effect.providerDispatch!.id))throw new DomainError('Provider dispatch claim identity is duplicated');ids.add(effect.providerDispatch!.id);}
}
