import {randomUUID} from 'node:crypto';
import {hash} from './domain.ts';
import {boundedPlainJson} from './bounded-json.ts';
import {withAdmissionFeed} from './storage.ts';
import type {Store,Operation,CommitResult} from './storage.ts';
import {callTool,ToolCallError,TOOL_TIMEOUT_MS} from './tool-call.ts';
import {environmentFields as exact,requireEnvironment as ensure,environmentId as id,environmentInteger as integer,validateBinding,validateActionInput,validateObservation,validateAction,validateOwnerWait} from './environment.ts';
import type {EnvironmentAction,EnvironmentAdapter,EnvironmentBinding,EnvironmentObservation,ActionInput,OwnerWait} from './environment.ts';

type Request={type:'action';action:EnvironmentAction}|{type:'wait';binding:EnvironmentBinding;wait:OwnerWait};
type Status='waiting'|'ready'|'unknown'|'delivered'|'completed'|'declined'|'cancelled'|'timed-out'|'invalidated';
export interface EnvironmentEntry {id:string;hash:string;request:Request;status:Status;at:number;deadline:number;polls:number;nextPoll:number;updatedAt:number}
export interface EnvironmentState {kind:'environment-actions';id:string;owner:string;environment:string;feedId:string;tainted:boolean;at:number;entries:EnvironmentEntry[]}
export interface HostEnvironmentObservation {observationId:string;binding:EnvironmentBinding;facts:Record<string,boolean>;available:Array<{id:string;operations:ActionInput['kind'][]}>}
interface Context {owner:string;environment:string;feedId:string}
type Command=
 |{type:'observe';binding:EnvironmentBinding}
 |{type:'propose';stepId:string;request:Request}
 |{type:'answer';stepId:string;hash:string;answer:'approve'|'decline'|'cancel'}
 |{type:'claim'|'invalidate'|'delivered'|'acknowledge-payment';stepId:string;hash:string}
 |{type:'reserve-poll';stepId:string}
 |{type:'poll-result';stepId:string;poll:number;proof:{binding:EnvironmentBinding;fact:boolean|null}|null};
const prefix='assistant-environment:',pending=(e:EnvironmentEntry)=>['waiting','ready','unknown'].includes(e.status);
type FactWait=Extract<OwnerWait,{kind:'confirm-on-device'|'human-check'|'enter-value'}>;
const factWait=(w:OwnerWait):w is FactWait=>w.kind==='confirm-on-device'||w.kind==='human-check'||w.kind==='enter-value';
function assertFactWait(w:OwnerWait):asserts w is FactWait{ensure(factWait(w),'Only fact waits can poll','conflict');}
const environmentOperations=new Map<string,{tail:Promise<void>;blocked:boolean}>();
const stateId=(c:Pick<Context,'owner'|'environment'>)=>'assistant-conversation:environment:'+hash([c.owner,c.environment]);
const binding=(r:Request)=>r.type==='action'?r.action.binding:r.binding;
const sameSurface=(a:EnvironmentBinding,b:EnvironmentBinding)=>a.environment===b.environment&&a.surface===b.surface&&a.origin===b.origin&&a.generation===b.generation;
const actor=(c:Command)=>c.type==='answer'?'local-owner':'environment-host';
const fingerprint=(c:Context,command:Command)=>hash({context:c,actor:actor(command),command});
const hostCommand=(c:Context,command:Command)=>command.type==='observe'?prefix+randomUUID():prefix+hash([stateId(c),command.type,command.stepId,command.type==='poll-result'?command.poll:command.type==='reserve-poll'?command:0]);
function empty(c:Context):EnvironmentState{return {kind:'environment-actions',id:stateId(c),...c,tainted:false,at:0,entries:[]};}
function validateRequest(r:Request,owner:string,environment:string){
 exact(r,r?.type==='action'?['type','action']:['type','binding','wait']);
 if(r.type==='action'){validateAction(r.action);ensure(r.action.input.kind!=='type'||r.action.input.secret.owner===owner,'Secret owner mismatch','denied');}
 else{ensure(r.type==='wait','Invalid environment request');validateBinding(r.binding);validateOwnerWait(r.wait);}
 ensure(binding(r).environment===environment,'Environment identity mismatch','denied');
}
function validateState(s:EnvironmentState){
 exact(s,['kind','id','owner','environment','feedId','tainted','at','entries']);ensure(s.kind==='environment-actions'&&id(s.owner)&&id(s.environment)&&id(s.feedId)&&s.id===stateId(s)&&typeof s.tainted==='boolean'&&integer(s.at)&&Array.isArray(s.entries)&&s.entries.length<=32,'Invalid environment state');
 for(const e of s.entries){exact(e,['id','hash','request','status','at','deadline','polls','nextPoll','updatedAt']);validateRequest(e.request,s.owner,s.environment);ensure(id(e.id)&&e.hash===hash(e.request)&&['waiting','ready','unknown','delivered','completed','declined','cancelled','timed-out','invalidated'].includes(e.status)&&[e.at,e.deadline,e.polls,e.nextPoll,e.updatedAt].every(integer)&&e.deadline>e.at&&e.updatedAt>=e.at&&e.updatedAt<=s.at&&e.polls<=120,'Invalid environment entry');}
 ensure(new Set(s.entries.map(e=>e.id)).size===s.entries.length&&s.entries.filter(pending).length<=1,'Invalid pending environment steps');
}
export function isEnvironmentState(value:unknown):value is EnvironmentState{return !!value&&typeof value==='object'&&(value as EnvironmentState).kind==='environment-actions';}
function apply(current:EnvironmentState,command:Command,at:number):EnvironmentState {
 validateState(current);boundedPlainJson(command);ensure(integer(at)&&at>=current.at,'Environment clock moved backwards');const s=structuredClone(current);s.at=at;
 if(command.type==='observe'){
  exact(command,['type','binding']);validateBinding(command.binding);
  for(const e of s.entries)if((e.status==='waiting'||e.status==='ready')&&!sameSurface(binding(e.request),command.binding)){e.status='invalidated';e.updatedAt=at;}
  validateState(s);return s;
 }
 ensure(id(command.stepId),'Invalid step identity');
 if(command.type==='propose'){
  for(const e of s.entries)if(['waiting','ready'].includes(e.status)&&at>=e.deadline){e.status='timed-out';e.updatedAt=at;}
  exact(command,['type','stepId','request']);validateRequest(command.request,s.owner,s.environment);ensure(!s.entries.some(e=>e.id===command.stepId)&&!s.entries.some(pending),'An earlier step is unresolved or this step already exists','conflict');ensure(s.entries.length<32,'Environment history bound reached');
  const r=command.request,deadline=at+(r.type==='wait'?r.wait.timeoutMs:300000);ensure(Number.isSafeInteger(deadline),'Invalid environment deadline');
  s.entries.push({id:command.stepId,hash:hash(r),request:structuredClone(r),status:r.type==='action'&&r.action.gates.length===0?'ready':'waiting',at,deadline,polls:0,nextPoll:at,updatedAt:at});
 }else{
  const e=s.entries.find(e=>e.id===command.stepId);ensure(e,'Unknown environment step');
  if('hash' in command)ensure(command.hash===e.hash,'Action hash mismatch','conflict');
  switch(command.type){
   case 'answer':{
    exact(command,['type','stepId','hash','answer']);ensure(['approve','decline','cancel'].includes(command.answer),'Invalid owner answer');ensure(e.status==='waiting'||command.answer==='cancel'&&e.status==='ready','Step no longer awaits this owner answer','conflict');
    if(at>=e.deadline){e.status='timed-out';break;}
    if(command.answer==='approve'){ensure(e.request.type==='action'||['approve','takeover'].includes(e.request.wait.kind),'A host-observed transition is required','denied');e.status=e.request.type==='action'?'ready':'completed';}else e.status=command.answer==='decline'?'declined':'cancelled';break;
   }
   case 'claim':{
    exact(command,['type','stepId','hash']);ensure(e.request.type==='action'&&e.status==='ready','Action is waiting for approval or already claimed','conflict');ensure(!e.request.action.gates.some(g=>g.kind==='payment'),'Payment intents are non-executable','denied');
    if(at>=e.deadline){e.status='timed-out';break;}e.status='unknown';if(e.request.action.input.kind==='type')s.tainted=true;break;
   }
   case 'acknowledge-payment':{
    exact(command,['type','stepId','hash']);ensure(e.request.type==='action'&&e.request.action.gates.some(g=>g.kind==='payment'),'Only payment intents can be acknowledged','denied');ensure(e.status==='ready','Payment intent requires owner approval','conflict');
    e.status=at>=e.deadline?'timed-out':'completed';break;
   }
   case 'invalidate':exact(command,['type','stepId','hash']);if(e.status==='ready'||e.status==='waiting')e.status='invalidated';break;
   case 'delivered':exact(command,['type','stepId','hash']);ensure(e.request.type==='action'&&e.status==='unknown','Only an original claim can record delivery','conflict');e.status='delivered';break;
   case 'reserve-poll':{
    exact(command,['type','stepId']);ensure(e.status==='waiting'&&e.request.type==='wait'&&e.request.wait.kind!=='approve','Only observation waits can poll; approval needs the owner','conflict');assertFactWait(e.request.wait);const w=e.request.wait;
    if(at>=e.deadline||e.polls>=w.maxPolls){e.status='timed-out';break;}ensure(at>=e.nextPoll,'Poll interval has not elapsed','conflict');e.polls++;e.nextPoll=at+w.intervalMs;break;
   }
   case 'poll-result':{
    exact(command,['type','stepId','poll','proof']);ensure(e.status==='waiting'&&e.request.type==='wait'&&e.request.wait.kind!=='approve'&&command.poll===e.polls&&integer(command.poll)&&command.poll>0,'Stale poll result','conflict');assertFactWait(e.request.wait);
    if(at>=e.deadline){e.status='timed-out';break;}
    const p=command.proof;if(p!==null){exact(p,['binding','fact']);validateBinding(p.binding);ensure(p.fact===null||typeof p.fact==='boolean','Invalid host fact');if(!sameSurface(binding(e.request),p.binding))e.status='invalidated';else if(p.binding.revision>binding(e.request).revision&&p.fact===e.request.wait.to)e.status='completed';}break;
   }
   default:ensure(false,'Invalid environment command');
  }
  e.updatedAt=at;
 }
 validateState(s);return s;
}
export function replayEnvironment(operation:Operation<EnvironmentState>,prior?:Operation<EnvironmentState>){
 validateState(operation.value);ensure(operation.events.length===1&&operation.outbox.length===0,'Invalid environment journal');const event=operation.events[0];exact(event,['type','actor','context','at','command']);exact(event.context,['owner','environment','feedId']);const c=event.context as Context;
 ensure(event.type==='environment-action'&&event.actor===actor(event.command)&&operation.aggregateId===stateId(c)&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Environment journal identity mismatch');
 ensure(event.command.type==='answer'?!operation.commandId.startsWith('assistant-'):operation.commandId.startsWith(prefix),'Environment command authority mismatch');
 ensure(operation.fingerprint===fingerprint(c,event.command),'Environment command fingerprint mismatch');
 const previous=prior?.value??empty(c);ensure(previous.owner===c.owner&&previous.environment===c.environment&&previous.feedId===c.feedId,'Environment context changed');ensure(hash(apply(previous,event.command,event.at))===hash(operation.value),'Environment transition mismatch');
}
interface Options {owner:string;environment:string;clock?:()=>number;callTimeoutMs?:number;resolveSecret?:(reference:{owner:string;slot:string},signal:AbortSignal)=>Promise<Uint8Array>}
/** Host-only library. Bind authenticated Work/owner authority before exposing any method to a client. */
export class EnvironmentActions {
 readonly #store:Store<any>;readonly #owner:Store<any>;readonly #adapter:EnvironmentAdapter|undefined;readonly #options:Options;readonly #clock:()=>number;readonly #timeout:number;#readGeneration=0;#feedId?:string;#settled=Promise.resolve();
 constructor(store:Store<any>,ownerStore:Store<any>,adapter:EnvironmentAdapter|undefined,options:Options){ensure(id(options.owner)&&id(options.environment),'Invalid environment owner');this.#store=store;this.#owner=ownerStore;this.#adapter=adapter;this.#options={...options};this.#clock=options.clock??Date.now;this.#timeout=options.callTimeoutMs??5000;ensure(integer(this.#timeout)&&this.#timeout>0&&this.#timeout<=TOOL_TIMEOUT_MS,'Invalid environment call timeout');}
 async #serialize<T>(run:()=>Promise<T>):Promise<T>{
  const key=this.#options.environment,lane=environmentOperations.get(key)??{tail:Promise.resolve(),blocked:false},previous=lane.tail;let release!:()=>void;const held=new Promise<void>(r=>release=r);lane.tail=held;environmentOperations.set(key,lane);
  await previous;
  try{ensure(!lane.blocked,'Environment observation unresolved','conflict');return await run();}finally{
   // Settlement includes late observation reconciliation; timeout only requests abort.
   void this.#settled.then(()=>{release();if(lane.tail===held&&!lane.blocked)environmentOperations.delete(key);});
  }
 }
 #call<T>(invoke:(signal:AbortSignal)=>Promise<T>,readOnly=false,timeoutMs=this.#timeout):Promise<T>{
  return callTool(signal=>{const operation=invoke(signal);this.#settled=operation.then(()=>{},()=>{});return operation;},{readOnly,timeoutMs});
 }
 async #load(){const read=await this.#store.readState(stateId(this.#options));this.#feedId??=read.feedId;ensure(read.feedId===this.#feedId,'Environment database feed changed','conflict');const context:Context={owner:this.#options.owner,environment:this.#options.environment,feedId:read.feedId};const value:EnvironmentState=read.snapshot?.value??empty(context);validateState(value);ensure(value.feedId===read.feedId&&value.id===stateId(context),'Environment database feed changed','conflict');return {context,value,revision:read.snapshot?.revision??0};}
 async state(){const {value}=await this.#load(),at=this.#clock();for(const e of value.entries)if(['waiting','ready'].includes(e.status)&&at>=e.deadline)e.status='timed-out';return value;}
 async #observe(timeoutMs=this.#timeout,commandId?:string):Promise<EnvironmentObservation>{
  const adapter=this.#adapter;ensure(adapter,'Environment adapter unavailable');await this.#load();
  try{return await this.#call(async signal=>{
   try{
    let observation:EnvironmentObservation;try{observation=await adapter.observe(signal);}catch{throw new Error('Environment observation unavailable');}
    validateObservation(observation);observation=structuredClone(observation);
    const reconciled=await this.#dispatch({type:'observe',binding:observation.binding},commandId);ensure(reconciled.status!=='conflict','Environment observation conflict','conflict');
    ensure(observation.binding.environment===this.#options.environment,'Environment observation identity changed');return observation;
   }catch(error){
    try{
     const {value}=await this.#load(),e=value.entries.find(e=>e.status==='ready'||e.status==='waiting');
     if(e)this.#entry(await this.#dispatch({type:'invalidate',stepId:e.id,hash:e.hash}),e.id);
    }catch{environmentOperations.get(this.#options.environment)!.blocked=true;}
    throw error;
   }
  },true,timeoutMs);}catch(error){if(error instanceof ToolCallError)throw new Error('Environment observation unavailable');throw error;}
 }
 async observe(){const generation=++this.#readGeneration;return this.#serialize(async()=>{const {context}=await this.#load(),observation=await this.#observe(),{value}=await this.#load();ensure(generation===this.#readGeneration&&context.feedId===value.feedId,'Stale environment observation','conflict');return value.tainted?{...observation,structure:[],facts:{},image:null}:{...observation,image:observation.image&&observation.image.expiresAt>this.#clock()?observation.image:null};});}
 /** HOST ONLY: the owner manifest must filter available IDs before model use. */
 async observeForHost(factIds:string[]):Promise<HostEnvironmentObservation>{
  boundedPlainJson(factIds);ensure(Array.isArray(factIds)&&factIds.length<=64&&factIds.every(id)&&new Set(factIds).size===factIds.length,'Invalid host fact identities or bound');factIds=[...factIds];
  return this.#serialize(async()=>{const observationId=prefix+randomUUID(),o=await this.#observe(this.#timeout,observationId);await this.#load();return {observationId,binding:o.binding,facts:Object.fromEntries(factIds.filter(f=>Object.hasOwn(o.facts,f)&&typeof o.facts[f]==='boolean').map(f=>[f,o.facts[f]!])),available:o.structure.map(e=>({id:e.id,operations:e.operations}))};});
 }
 async #dispatch(command:Command,commandId?:string,hostReceipt=false):Promise<CommitResult<EnvironmentState>>{
  boundedPlainJson(command);command=structuredClone(command);const initial=await this.#load(),c=initial.context;commandId??=hostCommand(c,command);ensure(id(commandId)&& (command.type==='answer'?!commandId.startsWith('assistant-'):commandId.startsWith(prefix)),'Invalid environment command identity');
  const identity={id:stateId(c),commandId,fingerprint:fingerprint(c,command)},store=hostReceipt?this.#store:this.#owner;
  for(let retry=0;retry<3;retry++){
   const snapshot=retry===0?initial:await this.#load();ensure(snapshot.context.feedId===c.feedId,'Environment database feed changed','conflict');const prior=await store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const at=this.#clock(),value=apply(snapshot.value,command,at),events=[{type:'environment-action',actor:actor(command),context:c,at,command}];
   const result=await withAdmissionFeed(c.feedId,()=>store.commit({...identity,expectedRevision:snapshot.revision,value,events,outbox:[]}));
   if(result.status!=='conflict')return result;if(result.reason==='idempotency'){const stored=await store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}
  }
  throw new Error('Environment command conflict');
 }
 #entry(result:CommitResult<EnvironmentState>,stepId:string){ensure(result.status!=='conflict','Environment command identity conflict','conflict');return structuredClone(result.value.entries.find(e=>e.id===stepId)!);}
 async propose(stepId:string,element:string,input:ActionInput){
  validateActionInput(input);input=structuredClone(input);ensure(id(stepId)&&id(element),'Invalid action identity');if(input.kind==='type')ensure(input.secret.owner===this.#options.owner,'Secret owner mismatch','denied');
  return this.#serialize(async()=>{
  const o=await this.#observe(),node=o.structure.find(e=>e.id===element);ensure(node&&node.operations.includes(input.kind),'Action unavailable on this element');const gates=structuredClone(node.gates);if(input.kind==='submit'&&!gates.length)gates.push({kind:'irreversible-submit'});
  return this.#entry(await this.#dispatch({type:'propose',stepId,request:{type:'action',action:{binding:o.binding,element,input,gates}}}),stepId);
  });
 }
 async wait(stepId:string,wait:OwnerWait){
  validateOwnerWait(wait);wait=structuredClone(wait);return this.#serialize(async()=>{const o=await this.#observe();ensure(wait.kind==='approve'||wait.kind==='takeover'||factWait(wait)&&Object.hasOwn(o.facts,wait.fact)&&o.facts[wait.fact]===wait.from,'Wait requires its initial host-observed fact');
  return this.#entry(await this.#dispatch({type:'propose',stepId,request:{type:'wait',binding:o.binding,wait}}),stepId);
  });
 }
 async answer(commandId:string,stepId:string,actionHash:string,answer:'approve'|'decline'|'cancel'){return this.#entry(await this.#dispatch({type:'answer',stepId,hash:actionHash,answer},commandId),stepId);}
 /** HOST ONLY: retires an approved intent without performing or receipting payment. */
 async acknowledgePayment(stepId:string,actionHash:string):Promise<EnvironmentEntry>{return this.#serialize(async()=>this.#entry(await this.#dispatch({type:'acknowledge-payment',stepId,hash:actionHash}),stepId));}
 async execute(stepId:string,actionHash:string){
  return this.#serialize(async()=>{
  const {value,context}=await this.#load(),e=value.entries.find(e=>e.id===stepId);ensure(e&&e.hash===actionHash,'Action hash mismatch','conflict');ensure(e.request.type!=='action'||!e.request.action.gates.some(g=>g.kind==='payment'),'Payment intents are non-executable, including after owner approval','denied');if(!['ready','waiting'].includes(e.status))return structuredClone(e);ensure(e.request.type==='action'&&e.status==='ready','Action is waiting for owner approval','conflict');const action=e.request.action;
  const adapter=this.#adapter;ensure(adapter,'Environment adapter unavailable');ensure(action.input.kind!=='type'||this.#options.resolveSecret,'Secret resolver unavailable');
  const o=await this.#observe(),node=o.structure.find(n=>n.id===action.element),gates=node?structuredClone(node.gates):[];if(action.input.kind==='submit'&&node&&!gates.length)gates.push({kind:'irreversible-submit'});
  if(hash(o.binding)!==hash(action.binding)||!node||!node.operations.includes(action.input.kind)||hash(gates)!==hash(action.gates))return this.#entry(await this.#dispatch({type:'invalidate',stepId,hash:actionHash}),stepId);
  const claim=await this.#dispatch({type:'claim',stepId,hash:actionHash}),claimed=this.#entry(claim,stepId);if(claim.status!=='committed'||claimed.status!=='unknown')return claimed;
  ensure((await this.#load()).context.feedId===context.feedId,'Environment database feed changed','conflict');let secretUsed=false;
  try{
   await this.#call(signal=>adapter.act(structuredClone(action),{signal,...(action.input.kind==='type'?{secret:async()=>{ensure(!secretUsed&&!signal.aborted,'Secret reference already consumed');secretUsed=true;return this.#options.resolveSecret!(structuredClone((action.input as Extract<ActionInput,{kind:'type'}>).secret),signal);}}:{})}));
  }catch{return claimed;}
  return this.#entry(await this.#dispatch({type:'delivered',stepId,hash:actionHash},undefined,true),stepId);
  });
 }
 async poll(stepId:string){
  const {value}=await this.#load(),e=value.entries.find(e=>e.id===stepId);ensure(e,'Unknown owner wait');if(e.status!=='waiting')return structuredClone(e);ensure(e.request.type==='wait'&&e.request.wait.kind!=='approve','Approval requires an owner answer');assertFactWait(e.request.wait);const wait=e.request.wait;
  ensure(this.#adapter,'Environment adapter unavailable');const command:Command={type:'reserve-poll',stepId},reservation=await this.#dispatch(command,prefix+hash([value.id,stepId,'poll',e.polls+1])),reserved=this.#entry(reservation,stepId);if(reservation.status!=='committed'||reserved.status!=='waiting')return reserved;
  return this.#serialize(async()=>{
  let proof:Extract<Command,{type:'poll-result'}>['proof']=null;
  try{const remaining=reserved.deadline-this.#clock();if(remaining>0){const o=await this.#observe(Math.min(this.#timeout,remaining));proof={binding:o.binding,fact:Object.hasOwn(o.facts,wait.fact)?o.facts[wait.fact]!:null};}}catch{}
  const latest=(await this.#load()).value.entries.find(x=>x.id===stepId)!;if(latest.status!=='waiting'||latest.polls!==reserved.polls)return structuredClone(latest);
  return this.#entry(await this.#dispatch({type:'poll-result',stepId,poll:reserved.polls,proof},undefined,true),stepId);
  });
 }
}
