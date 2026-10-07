/** User choices bind to host-authorized immutable profiles before any runtime effect. */
import {ConfiguredTextRuntime,workAdmissionPreflight,rejectedRun,hostBusyPreflight,hasUnsettledRuns} from './configured-runtime.ts';
import type {WorkRuntime,RuntimeResult} from './configured-runtime.ts';
import type {Mission} from './domain.ts';
import type {Store,Snapshot} from './storage.ts';
import {ConnectionCatalog} from './provider-profiles.ts';
import type {ConnectionDiagnostic,ResolvedConnection} from './provider-profiles.ts';
import type {TextArtifactStore} from './text-artifacts.ts';
export interface ExecutionChoice {executorProfileId:string;verifierProfileId:string;authorizationId:string;outputTokenCap:number}
export interface ProfilePermission {profileId:string;configHash:string}
export interface ExecutionAuthorization {
 id:string;scope:string;mode:'mock-http'|'live';executor:readonly ProfilePermission[];verifier:readonly ProfilePermission[];maxOutputTokensPerCall:number;
}
export interface SelectionPreflight {missionId:string;workId:string;revision:number;expectedRevision:number;ready:boolean;diagnostics:ConnectionDiagnostic[]}
export class SelectableTextRuntime implements WorkRuntime {
 readonly #store:Store<Mission>;readonly #catalog:ConnectionCatalog;readonly #grants:readonly ExecutionAuthorization[];readonly #artifacts:TextArtifactStore;
 #draining=false;
 readonly #active=new Map<string,ConfiguredTextRuntime|undefined>();
 readonly #runs=new Set<Promise<RuntimeResult>>();
 constructor(store:Store<Mission>,catalog:ConnectionCatalog,authorizations:readonly ExecutionAuthorization[],artifacts:TextArtifactStore){
  this.#store=store;this.#catalog=catalog;this.#grants=structuredClone(authorizations);this.#artifacts=artifacts;
  for(const grant of this.#grants){if(!grant||typeof grant.id!=='string'||!grant.id||typeof grant.scope!=='string'||!grant.scope||!['mock-http','live'].includes(grant.mode)||!Number.isSafeInteger(grant.maxOutputTokensPerCall)||grant.maxOutputTokensPerCall<1||Object.keys(grant).some(k=>!['id','scope','mode','executor','verifier','maxOutputTokensPerCall'].includes(k))||![grant.executor,grant.verifier].every(list=>Array.isArray(list)&&list.every(p=>p&&typeof p.profileId==='string'&&/^[a-f0-9]{64}$/.test(p.configHash)&&Object.keys(p).every(k=>['profileId','configHash'].includes(k)))))throw new Error('Invalid execution authorization');}
  if(new Set(authorizations.map(a=>a.id)).size!==authorizations.length)throw new Error('Duplicate authorization identity');
 }
 configuration(){
  // Secret references stay server-side too. The UI only needs authentication method and readiness.
  return {connections:this.#catalog.list().map(p=>p.backend==='model-provider'&&!p.diagnostics.length?{id:p.id,label:p.label,backend:p.backend,providerKind:p.providerKind,protocol:p.protocol,model:p.model,endpoint:p.diagnostics.length?'Unavailable until profile validation succeeds':p.endpoint,revision:p.revision,enabled:p.enabled,auth:{method:p.auth?.method},capabilities:p.capabilities,usage:{inputTokens:p.usage.inputTokens,outputTokens:p.usage.outputTokens,cost:p.usage.cost},limits:{maxInputBytes:p.limits.maxInputBytes,maxOutputTokens:p.limits.maxOutputTokens,maxResponseBytes:p.limits.maxResponseBytes,timeoutMs:p.limits.timeoutMs},configHash:p.configHash,diagnostics:p.diagnostics}:{id:p.id,label:p.label,backend:p.backend,enabled:false,diagnostics:p.diagnostics}),authorizations:structuredClone(this.#grants),budgetUnit:'output-tokens',cost:'unknown',selectionRequired:true};
 }
 availability(_mission:Mission){return {ready:false,reason:'Choose executor and independent verifier connection profiles with a matching authorization before running this Work.'};}
 private prepare(mission:Mission,choice?:ExecutionChoice):{diagnostics:ConnectionDiagnostic[];runtime?:ConfiguredTextRuntime}{
  const diagnostics:ConnectionDiagnostic[]=[];
  const add=(code:string,message:string)=>diagnostics.push({code,message});
  if(!choice||typeof choice!=='object'||Object.keys(choice).some(k=>!['executorProfileId','verifierProfileId','authorizationId','outputTokenCap'].includes(k))||!['executorProfileId','verifierProfileId','authorizationId'].every(k=>typeof choice[k as keyof ExecutionChoice]==='string')||!Number.isSafeInteger(choice.outputTokenCap)||choice.outputTokenCap<1)return {diagnostics:[{code:'selection_required',message:'Choose both connection profiles, authorization and a positive output-token cap.'}]};
  const g=this.#grants.find(a=>a.id===choice.authorizationId);
  if(!g||g.scope!==mission.scope||!['mock-http','live'].includes(g.mode)||!Number.isSafeInteger(g.maxOutputTokensPerCall)||choice.outputTokenCap>g.maxOutputTokensPerCall)add('authorization_mismatch','Selected authorization does not permit this Mission scope or output cap.');
  const selected={} as Record<'executor'|'verifier',Extract<ResolvedConnection,{status:'selected'}>>;
  for(const role of ['executor','verifier'] as const){
   const result=this.#catalog.resolve(choice[`${role}ProfileId`],['text-output']);
   if(result.status==='unavailable'){diagnostics.push(...result.diagnostics.map(d=>({...d,message:`${role}: ${d.message}`})));continue;}
   selected[role]=result;
   if(!g?.[role].some(p=>p.profileId===result.profile.id&&p.configHash===result.configHash))add('profile_not_authorized',`${role}: This exact profile configuration is not authorized for this role.`);
   if(result.profile.limits.maxOutputTokens<choice.outputTokenCap)add('output_limit',`${role}: Output cap exceeds the selected profile limit.`);
   if(result.profile.usage.outputTokens!=='reported')add('usage_unsupported',`${role}: This bounded runtime requires reported output-token usage.`);
   if(g&&(g.mode==='mock-http')!==(result.adapter.descriptor.evidenceClass==='fixture'))add('evidence_mode_mismatch',`${role}: Mock and live authorization cannot be interchanged.`);
  }
  if(diagnostics.length)return {diagnostics};
  const runtime=new ConfiguredTextRuntime(this.#store,{enabled:true,authorization:{id:g!.id,scope:g!.scope,mode:g!.mode,executor:selected.executor.adapter.descriptor,verifier:selected.verifier.adapter.descriptor,maxOutputTokensPerCall:g!.maxOutputTokensPerCall},outputTokenCap:choice.outputTokenCap,executor:{identity:'selected-executor',adapter:selected.executor.adapter},verifier:{identity:'selected-verifier',adapter:selected.verifier.adapter},artifacts:this.#artifacts,connectionBindings:{executor:{profileId:selected.executor.profile.id,configHash:selected.executor.configHash},verifier:{profileId:selected.verifier.profile.id,configHash:selected.verifier.configHash}}});
  const available=runtime.availability(mission);if(!available.ready)add('runtime_unavailable',available.reason);
  return {diagnostics,...(diagnostics.length?{}:{runtime})};
 }
 preflight(snapshot:Snapshot<Mission>,workId:string,expectedRevision:number,choice?:ExecutionChoice):SelectionPreflight {
  const result=this.admission(snapshot,workId,expectedRevision,choice);if(!result.ready)return result;
  const work=snapshot.value.works.find(w=>w.id===workId)!;const prepared=this.prepare({...snapshot.value,criteria:work.criteria},choice);
  return {...result,ready:prepared.diagnostics.length===0,diagnostics:prepared.diagnostics};
 }
 private admission(snapshot:Snapshot<Mission>,workId:string,expectedRevision:number,choice?:ExecutionChoice,owned=false):SelectionPreflight {
  const cap=choice&&Number.isSafeInteger(choice.outputTokenCap)&&choice.outputTokenCap>0?choice.outputTokenCap:undefined;
  const result=workAdmissionPreflight(snapshot,workId,expectedRevision,cap);
  if(!owned&&this.#active.has(`${snapshot.value.id}\0${workId}`))result.diagnostics.push({code:'work_already_started',message:'This Work already has an active dispatch.'});
  const checked={...result,ready:result.diagnostics.length===0};return checked.ready&&[...this.#active.keys()].some(key=>key!==`${snapshot.value.id}\0${workId}`)?hostBusyPreflight(checked):checked;
 }
 hasActiveAdmission(){return this.#active.size>0;}
 beginDrain(){this.#draining=true;for(const runtime of this.#active.values())runtime?.beginDrain();}
 async drain(){this.beginDrain();const results=await Promise.allSettled([...this.#runs]);if(hasUnsettledRuns(results))throw new Error('Local Work admission did not settle during host drain');}
 run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice):Promise<RuntimeResult>{const key=`${missionId}\0${workId}`,owned=this.#active.size===0,busy=this.#active.size>0&&!this.#active.has(key);if(owned)this.#active.set(key,undefined);const task=this.runOwned(missionId,workId,runId,expectedRevision,choice,owned,busy);this.#runs.add(task);void task.finally(()=>{if(owned)this.#active.delete(key);this.#runs.delete(task);}).catch(()=>{});return task;}
 private async runOwned(missionId:string,workId:string,runId:string,expectedRevision:number,choice:ExecutionChoice|undefined,owned:boolean,busy:boolean):Promise<RuntimeResult>{
  const snapshot=await this.#store.load(missionId);if(!snapshot)throw new Error('Unknown Mission');const work=snapshot.value.works.find(w=>w.id===workId);if(!work)throw new Error('Unknown Work');
  if(this.#draining)return {status:'blocked',snapshot,reason:'Local host is draining; no new run is admitted.'};let admission=this.admission(snapshot,workId,expectedRevision,choice,owned);if(!owned&&admission.ready)admission=busy?hostBusyPreflight(admission):{...admission,ready:false,diagnostics:[{code:'work_already_started',message:'At request admission this Work already had a local dispatch.'}]};if(!admission.ready)return rejectedRun(admission,snapshot);
  const prepared=this.prepare({...snapshot.value,criteria:work.criteria},choice);
  if(!prepared.runtime)return {status:'blocked',snapshot,reason:prepared.diagnostics.map(d=>d.message).join(' ')};
  const key=`${missionId}\0${workId}`;this.#active.set(key,prepared.runtime);return prepared.runtime.run(missionId,workId,runId,expectedRevision);
 }
 owns(missionId:string,workId:string,runId:string){return this.#active.get(`${missionId}\0${workId}`)?.owns(missionId,workId,runId)??false;}
 interrupt(missionId:string,workId:string){this.#active.get(`${missionId}\0${workId}`)?.interrupt(missionId,workId);}
}
