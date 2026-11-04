import {createHash} from 'node:crypto';
import {hash,workInputHash,pinnedWorkSources,pinnedOrganization} from './domain.ts';
import type {Artifact,Mission,Work} from './domain.ts';
import type {Store} from './storage.ts';
import type {ArtifactReader} from './record-artifact.ts';
import {RecordArtifactError} from './record-artifact.ts';
import {pinnedMemoryInput} from './memory-input.ts';
import {resolvedPrerequisites} from './work-prerequisites.ts';
import {validateProviderDispatchClaims} from './provider-dispatch.ts';
import {validateRuntimeOwnership} from './runtime-lifetime.ts';
export interface RejectedTextInput {binding:string;artifactVersion:number;artifactSha256:string;feedId?:string}
const digest=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const conflict=()=>{throw new RecordArtifactError(409,'The exact rejected candidate evidence changed or is not a settled failed Assurance. Choose the current Work deliberately.');};
function candidate(mission:Mission,w:Work,input:RejectedTextInput){
 if(w.execution!=='settled'||hash(w)!==input.binding||w.acceptance!=='failed'||w.verdict?.status!=='failed'||w.record||!w.artifact||!w.runtimeRun||w.runtimeRecovery||w.runtimeInterruption||w.effects.length<2||w.effects.some(e=>!['succeeded','failed'].includes(e.status)||!e.receipt?.trim())||w.budget.measured===null||w.tasks.some(t=>t.status!=='settled')||w.attempts.at(-1)?.status!=='settled'||w.runtimeRun.inputHash!==workInputHash(w)||w.runtimeRun.criteriaHash!==hash(w.criteria)||w.verdict.artifactSha256!==w.artifact.sha256||w.verdict.artifactVersion!==w.artifact.version||w.verdict.criteriaVersion!==w.criteria.version||w.artifact.version!==input.artifactVersion||w.artifact.sha256!==input.artifactSha256)conflict();
 const verifier=w.assignments.find(a=>a.id===w.verdict!.verifierAssignmentId&&a.role==='verifier');if(!verifier||!w.assignments.some(a=>a.role==='executor')||w.assignments.some(a=>a.role==='executor'&&a.actorId===verifier.actorId))conflict();
 try{validateProviderDispatchClaims(w);if(w.runtimeRun!.ownership)validateRuntimeOwnership(w.runtimeRun!.ownership);pinnedWorkSources(mission,w);pinnedMemoryInput(mission,w);pinnedOrganization(mission,w);resolvedPrerequisites(mission,w);}catch{conflict();}
 if(w.artifact!.kind!=='text')throw new RecordArtifactError(422,'Only bounded UTF-8 rejected candidate text is readable.');
 return {artifact:structuredClone(w.artifact!),verdict:structuredClone(w.verdict!),criteria:structuredClone(w.criteria),inputHash:w.runtimeRun!.inputHash,evidenceClass:w.assignments.some(a=>a.model.evidenceClass==='fixture')?'fixture' as const:'real-provider' as const};
}
/** Query only; does not upgrade a rejected artifact into an accepted Record. */
export async function readRejectedText(store:Store<Mission>,reader:ArtifactReader|undefined,missionId:string,workId:string,submitted:RejectedTextInput){
 const input=structuredClone(submitted);if(Object.keys(input).some(k=>!['binding','artifactVersion','artifactSha256','feedId'].includes(k))||!digest(input.binding)||!digest(input.artifactSha256)||!Number.isSafeInteger(input.artifactVersion)||input.artifactVersion<1)throw new TypeError('Exact rejected candidate binding and artifact required');
 const state=await store.readState(missionId);if(input.feedId!==undefined&&state.feedId!==input.feedId)conflict();const w=state.snapshot?.value.works.find(w=>w.id===workId);if(!w)return null;const pinned=candidate(state.snapshot!.value,w,input);if(!reader)throw new RecordArtifactError(503,'Rejected text access is not enabled; no filesystem fallback.');let content:string;
 try{content=await reader.read(pinned.artifact);}catch{throw new RecordArtifactError(503,'Exact rejected candidate bytes are unavailable or failed integrity checks.');}
 if(typeof content!=='string'||!content.length||!content.isWellFormed()||Buffer.byteLength(content,'utf8')>32768||createHash('sha256').update(content,'utf8').digest('hex')!==input.artifactSha256)throw new RecordArtifactError(503,'Rejected candidate UTF-8 bytes or SHA-256 did not match.');
 const current=await store.readState(missionId);if(current.feedId!==state.feedId)conflict();const latest=current.snapshot?.value.works.find(w=>w.id===workId);if(!latest)conflict();candidate(current.snapshot!.value,latest!,input);
 const {path,...artifact}=pinned.artifact;return {missionId,workId,binding:input.binding,acceptance:'failed' as const,recordId:null,artifact,verdict:{id:pinned.verdict.id,status:pinned.verdict.status,criteriaVersion:pinned.verdict.criteriaVersion,artifactVersion:pinned.verdict.artifactVersion,artifactSha256:pinned.verdict.artifactSha256,evidence:pinned.verdict.evidence.map(e=>({kind:e.kind,detail:e.detail,...(e.kind==='artifact-readback'?{}:{source:e.source})}))},criteria:pinned.criteria,inputHash:pinned.inputHash,evidenceClass:pinned.evidenceClass,feedId:state.feedId,revision:state.snapshot!.revision,byteLength:Buffer.byteLength(content,'utf8'),content};
}
