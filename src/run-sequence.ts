/** A bounded explicit owner request, never a retained queue or recovery/replay worker. */
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Mission,Work} from './domain.ts';
import type {Store,Snapshot} from './storage.ts';
import {workAdmissionPreflight,rejectedRun,hostBusyPreflight} from './configured-runtime.ts';
import type {WorkRuntime,RuntimeResult} from './configured-runtime.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import {prerequisitePins,resolvedPrerequisites} from './work-prerequisites.ts';
import {keys} from './growth-evaluation.ts';
export interface SequenceWork {workId:string;inputHash:string;criteriaHash:string}
export interface RunSequenceInput {commandId:string;expectedRevision:number;works:SequenceWork[];selection?:ExecutionChoice}
export interface RunSequenceResult {status:'completed'|'stopped';snapshot:Snapshot<Mission>;completedWorkIds:string[];results:{workId:string;runId:string;status:RuntimeResult['status'];reason?:string}[];reason?:string}
export const sequenceRunId=(commandId:string,index:number)=>'sequence:'+hash({commandId,index});
const identifier=(value:unknown)=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const digest=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function bound(input:RunSequenceInput){
 keys(input,['commandId','expectedRevision','works','selection']);
 if(!identifier(input.commandId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||!Array.isArray(input.works)||input.works.length<1||input.works.length>3||Object.keys(input.works).length!==input.works.length)throw new DomainError('Exact sequence identity/revision and 1 to 3 Work required');
 const ids=new Set<string>();for(const entry of input.works){keys(entry,['workId','inputHash','criteriaHash']);if(Object.keys(entry).length!==3||!identifier(entry.workId)||!digest(entry.inputHash)||!digest(entry.criteriaHash)||ids.has(entry.workId))throw new DomainError('Unique exact Work input/criteria bindings required');ids.add(entry.workId);}
 if(input.selection!==undefined)keys(input.selection,['executorProfileId','verifierProfileId','authorizationId','outputTokenCap']);
}
function original(snapshot:Snapshot<Mission>,entry:SequenceWork):Work {
 const w=snapshot.value.works.find(w=>w.id===entry.workId);if(!w||workInputHash(w)!==entry.inputHash||hash(w.criteria)!==entry.criteriaHash)throw new DomainError('Sequence original Work input/criteria changed; no substitution or rebase');return w;
}
/** Future prerequisite exceptions are only reviewed earlier entries, never an acceptance claim. */
function plannedPrerequisites(snapshot:Snapshot<Mission>,w:Work,earlier:Set<string>,selected:Set<string>){
 const pins=prerequisitePins(snapshot.value,w);if(!pins)return;
 for(const pin of pins){const target=snapshot.value.works.find(t=>t.id===pin.workId)!;if(hash(target.criteria)!==pin.criteriaHash||workInputHash(target)!==pin.inputHash)throw new DomainError('Sequence original prerequisite binding changed');if(selected.has(pin.workId)&&!earlier.has(pin.workId))throw new DomainError('Sequence prerequisite must precede its consumer');}
 const external=pins.filter(pin=>!earlier.has(pin.workId)),view={...w};if(external.length)view.prerequisites=external;else delete view.prerequisites;
 resolvedPrerequisites(snapshot.value,view);
}
export async function runSequence(store:Store<Mission>,runtime:WorkRuntime,missionId:string,submitted:RunSequenceInput):Promise<RunSequenceResult>{
 const input=structuredClone(submitted);bound(input);const busyAtEntry=runtime.hasActiveAdmission?.()??false,configuration=hash(runtime.configuration?.()??null);
 let snapshot=await store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');
 const results:RunSequenceResult['results']=[],completedWorkIds:string[]=[],stop=(entry:SequenceWork,index:number,result:RuntimeResult):RunSequenceResult=>({status:'stopped',snapshot:result.snapshot,completedWorkIds,results:[...results,{workId:entry.workId,runId:sequenceRunId(input.commandId,index),status:result.status,reason:result.reason}],reason:result.reason});
 const earlier=new Set<string>(),selected=new Set(input.works.map(entry=>entry.workId));
 for(const [index,entry] of input.works.entries()){
  const w=original(snapshot,entry),checked=workAdmissionPreflight(snapshot,entry.workId,input.expectedRevision,input.selection?.outputTokenCap);
  // Check all original freshness first; the existing runtime still resolves all Records at dispatch.
  const definite=checked.diagnostics.filter(d=>d.code!=='prerequisite_unavailable');if(definite.length)return stop(entry,index,rejectedRun({...checked,ready:false,diagnostics:definite},snapshot));
  plannedPrerequisites(snapshot,w,earlier,selected);earlier.add(entry.workId);
 }
 if(busyAtEntry){const first=input.works[0]!,checked=workAdmissionPreflight(snapshot,first.workId,input.expectedRevision,input.selection?.outputTokenCap);return stop(first,0,rejectedRun(hostBusyPreflight(checked),snapshot));}
 const reviewed=new Map(input.works.map(entry=>[entry.workId,hash(original(snapshot!,entry))]));
 for(const [index,entry] of input.works.entries()){
  const expectedRevision=snapshot.revision,current=await store.load(missionId);if(!current)throw new DomainError('Unknown Mission');snapshot=current;
  original(snapshot,entry);
  if(hash(runtime.configuration?.()??null)!==configuration)return stop(entry,index,{status:'blocked',snapshot,reason:'Original sequence execution configuration changed; inspect and deliberately request again.'});
  const checked=runtime.preflight?.(snapshot,entry.workId,expectedRevision,input.selection)??{...workAdmissionPreflight(snapshot,entry.workId,expectedRevision),ready:false,diagnostics:[{code:'selection_unavailable',message:'Sequence requires the existing execution preflight.'}]};
  if(!checked.ready)return stop(entry,index,rejectedRun(checked,snapshot));
  if(hash(original(snapshot,entry))!==reviewed.get(entry.workId))return stop(entry,index,{status:'blocked',snapshot,reason:'Original reviewed unstarted Work changed during the sequence; no automatic rebase.'});
  const runId=sequenceRunId(input.commandId,index),result=await runtime.run(missionId,entry.workId,runId,expectedRevision,input.selection);snapshot=result.snapshot;
  const w=snapshot.value.works.find(w=>w.id===entry.workId)!;if(result.status!=='settled'||w.acceptance!=='accepted'||!w.record)return stop(entry,index,{...result,reason:result.reason??'Prior Work has no independently accepted Record; remaining Work was not requested.'});
  results.push({workId:entry.workId,runId,status:result.status});completedWorkIds.push(entry.workId);
 }
 return {status:'completed',snapshot,completedWorkIds,results};
}
