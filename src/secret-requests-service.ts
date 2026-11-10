import {Application} from './application.ts';
import {DomainError,hash} from './domain.ts';
import type {Mission} from './domain.ts';
import {withAdmissionFeed} from './storage.ts';
import type {Store} from './storage.ts';
import {callTool} from './tool-call.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import {checkSlot} from './secret-slots.ts';
import type {SecretSlots,SecretSlot} from './secret-slots.ts';
import {SecretSourceError,validateSecretValue} from './secret-sources.ts';
import type {ExternalVault} from './secret-sources.ts';
import {SECRET_REQUEST_HOST,secretRequestHash,requestSecretSlot,validateSecretSelections} from './secret-requests.ts';
import type {SecretDeclaration,SecretRequest,SecretSelection} from './secret-requests.ts';
const exact=(v:unknown,keys:string[],optional:string[]=[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>keys.includes(k)||optional.includes(k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
function ensure(v:unknown):asserts v {if(!v)throw new DomainError('Invalid or stale secret request');}
type Outcome={status:'provided'|'declined'|'unavailable'};
const outcome=(request:SecretRequest|undefined):Outcome=>({status:request?.state==='provided'?'provided':request?.state==='declined'?'declined':'unavailable'});

/** Construct with the drain-aware owner store. The model-facing outcome has exactly one safe status. */
export class SecretRequestsService {
 readonly #store:Store<Mission>;readonly #own:SecretSlots;readonly #vaults:Partial<Record<'onepassword',ExternalVault>>;readonly #app:Application;readonly #stop=new AbortController();readonly #active=new Set<Promise<unknown>>();
 readonly #writes=new Set<Promise<void>>();readonly #provisions=new Set<string>();#uncertainWrite=false;
 constructor(ownerStore:Store<Mission>,own:SecretSlots,vaults:Partial<Record<'onepassword',ExternalVault>>={}){this.#store=ownerStore;this.#own=own;this.#vaults={...vaults};this.#app=new Application(ownerStore,[{id:'local-owner',roles:['owner']},{id:SECRET_REQUEST_HOST,roles:['representative']}]);}
 #admit(){if(this.#stop.signal.aborted)throw new HostDrainError();}
 async offer(input:{commandId:string;missionId:string;workId:string;expectedRevision:number;requestId:string;declaration:SecretDeclaration}){
  ensure(exact(input,['commandId','missionId','workId','expectedRevision','requestId','declaration'])&&id(input.commandId)&&input.commandId.startsWith('assistant-secret-'));secretRequestHash(input.declaration);this.#admit();
  const {commandId,missionId,expectedRevision,...request}=structuredClone(input);
  return this.#app.dispatch({commandId,missionId,expectedRevision,actorId:SECRET_REQUEST_HOST,command:{type:'request-secret',...request}});
 }
 async read(missionId:string,workId:string){
  const read=await this.#store.readState(missionId),work=read.snapshot?.value.works.find(w=>w.id===workId);ensure(work);
  return {feedId:read.feedId,revision:read.snapshot!.revision,requests:(work.secretRequests??[]).map(r=>({id:r.id,requestHash:r.requestHash,...structuredClone(r.declaration),state:r.state==='providing'?'unavailable':r.state,at:r.at}))};
 }
 answer(input:unknown){const run=this.#answer(input);this.#active.add(run);void run.then(()=>this.#active.delete(run),()=>this.#active.delete(run));return run;}
 async #answer(raw:unknown):Promise<Outcome>{
  ensure(exact(raw,['commandId','missionId','workId','expectedRevision','requestId','requestHash','answer'],['selections','values'])&&['provide','decline'].includes(raw.answer)&&id(raw.commandId)&&!raw.commandId.startsWith('assistant-')&&id(raw.missionId)&&id(raw.workId)&&id(raw.requestId));
  const input=structuredClone(raw),values=input.values??{},provisionKey=JSON.stringify([input.missionId,input.commandId]);ensure(exact(values,Object.keys(values)));
  try{
   this.#admit();const read=await this.#store.readState(input.missionId),work=read.snapshot?.value.works.find(w=>w.id===input.workId),request=work?.secretRequests?.find(r=>r.id===input.requestId);ensure(request&&request.requestHash===input.requestHash);
   const selections:SecretSelection[]=input.answer==='provide'?input.selections:[];
   if(input.answer==='provide'){
    validateSecretSelections(request,selections);const own=selections.filter(s=>s.source.kind==='own');ensure(Object.keys(values).length===own.length&&own.every(s=>Object.hasOwn(values,s.slot)));for(const s of own)validateSecretValue(values[s.slot]);
   }else ensure(input.selections===undefined&&input.values===undefined);
   const claimed=await withAdmissionFeed(read.feedId,()=>this.#app.dispatch({missionId:input.missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'answer-secret-request',workId:input.workId,requestId:input.requestId,requestHash:input.requestHash,provisionId:input.commandId,answer:input.answer,selections}}));
   ensure(claimed.status!=='conflict');
   const current=await this.#store.readState(input.missionId),saved=current.snapshot?.value.works.find(w=>w.id===input.workId)?.secretRequests?.find(r=>r.id===input.requestId);
   ensure(current.feedId===read.feedId&&saved?.requestHash===input.requestHash&&saved.provisionId===input.commandId);
   if(['provided','declined','unavailable'].includes(saved.state)){this.#provisions.delete(provisionKey);return outcome(saved);}
   if(claimed.status!=='committed')return {status:'unavailable'};
   this.#provisions.add(provisionKey);
   let status:'provided'|'unavailable'='unavailable';
   try{await callTool(async signal=>{
    for(const selection of selections){
     await this.#pending(input,read.feedId);signal.throwIfAborted();const source=selection.source;
     if(source.kind==='external-ref')continue;
     let value:string;if(source.kind==='own')value=values[selection.slot];else {const adapter=this.#vaults[source.vendor];if(!adapter)throw new SecretSourceError('cli-missing');value=await adapter.read(source.reference,signal);}
     validateSecretValue(value);await this.#pending(input,read.feedId);signal.throwIfAborted();const write=this.#own.set(requestSecretSlot(input.missionId,input.workId,input.requestId,selection.slot),value);this.#writes.add(write);
     try{await write;}catch{this.#uncertainWrite=true;throw new SecretSourceError('unavailable');}finally{this.#writes.delete(write);}
    }
    await this.#pending(input,read.feedId);signal.throwIfAborted();
   },{signal:this.#stop.signal,timeoutMs:5000});status='provided';}catch{}
   let result:Outcome={status:'unavailable'},confirmed=false;
   try{const snapshot=await this.#store.load(input.missionId);ensure(snapshot);this.#admit();const settled=await withAdmissionFeed(read.feedId,()=>this.#app.dispatch({missionId:input.missionId,commandId:'assistant-secret-settle-'+hash(input.commandId).slice(0,32),expectedRevision:snapshot.revision,actorId:SECRET_REQUEST_HOST,command:{type:'settle-secret-request',workId:input.workId,requestId:input.requestId,requestHash:input.requestHash,provisionId:input.commandId,status}}));if(settled.status!=='conflict'){confirmed=true;result=outcome(settled.value.works.find(w=>w.id===input.workId)?.secretRequests?.find(r=>r.id===input.requestId));}}catch{}
   finally{
    if(!confirmed)try{const latest=await this.#store.readState(input.missionId),saved=latest.snapshot?.value.works.find(w=>w.id===input.workId)?.secretRequests?.find(r=>r.id===input.requestId);if(latest.feedId===read.feedId&&saved?.requestHash===input.requestHash&&saved.provisionId===input.commandId&&['provided','declined','unavailable'].includes(saved.state)){confirmed=true;result=outcome(saved);}}catch{}
    // An unconfirmed durable claim must still make drain report unsettled.
    if(confirmed)this.#provisions.delete(provisionKey);
   }
   return result;
  }finally{for(const key of Object.keys(values))delete values[key];}
 }
 async #pending(input:Record<string,any>,feedId:string){
  this.#admit();const read=await this.#store.readState(input.missionId),work=read.snapshot?.value.works.find(w=>w.id===input.workId),request=work?.secretRequests?.find(r=>r.id===input.requestId);
  ensure(read.feedId===feedId&&work&&work.execution!=='cancelled'&&!work.runtimeInterruption&&!work.runtimeRecovery&&request?.state==='providing'&&request.provisionId===input.commandId&&request.requestHash===input.requestHash);this.#admit();
 }
 /** Pass this read-only capability to the existing trusted launcher, never to a renderer or model. */
 slots(missionId:string,workId:string,requestId:string,memberId:string,purpose:string):SecretSlots {
  const authorize=async(secret:SecretSlot,expected?:{feedId:string;requestHash:string;provisionId:string})=>{
   this.#admit();checkSlot(secret);const read=await this.#store.readState(missionId),work=read.snapshot?.value.works.find(w=>w.id===workId),request=work?.secretRequests?.find(r=>r.id===requestId);
   if(!work||!['queued','active'].includes(work.execution)||work.blocker||work.monthlyBudgetDecision||work.secretRequests?.some(r=>r.state!=='provided')||work.acceptance==='accepted'||work.runtimeInterruption||work.runtimeRecovery||request?.state!=='provided'||request.declaration.memberId!==memberId||request.declaration.purpose!==purpose||secret.owner!==requestSecretSlot(missionId,workId,requestId,secret.slot).owner)throw new SecretSourceError('grant-required');
   const selection=request.selections?.find(s=>s.slot===secret.slot);if(!selection||expected&&(read.feedId!==expected.feedId||request.requestHash!==expected.requestHash||request.provisionId!==expected.provisionId))throw new SecretSourceError('grant-required');
   return {feedId:read.feedId,requestHash:request.requestHash,provisionId:request.provisionId!,selection};
  };
  return {read:async(secret,signal)=>{try{return await callTool(async bounded=>{
   const binding=await authorize(secret),source=binding.selection.source;let value:string|undefined;
   if(source.kind==='external-ref'){const adapter=this.#vaults[source.vendor];if(!adapter)throw new SecretSourceError('cli-missing');value=await adapter.read(source.reference,bounded);}else value=await this.#own.read(secret,bounded);
   await authorize(secret,binding);bounded.throwIfAborted();validateSecretValue(value);return value;
  },{readOnly:true,signal:AbortSignal.any([this.#stop.signal,...(signal?[signal]:[])]),timeoutMs:5000});}catch(error){throw error instanceof SecretSourceError?error:new SecretSourceError('unavailable');}},set:async()=>{throw new SecretSourceError('permission-denied');},delete:async()=>{throw new SecretSourceError('permission-denied');}};
 }
 beginDrain(){this.#stop.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active]);if(this.#writes.size||this.#provisions.size||this.#uncertainWrite)throw new Error('Secret provision is unsettled');}
}
