/** Stage-1 durable run queue: a run request that meets a busy host waits, and the host continues it by itself. One taker, one slot. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {DomainError,hash} from './domain.ts';
import type {Actor,Mission} from './domain.ts';
import type {SequenceWork} from './run-sequence.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import type {RuntimeResult} from './configured-runtime.ts';
import type {Operation,Snapshot,Store} from './storage.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';

export const RUN_QUEUE_ID=ASSISTANT_CONVERSATION_PREFIX+'run-queue',RUN_QUEUE_HOST='runtime-representative';
/** A proposal without a measurement: the lead picked a small bound so a stuck host cannot accumulate unbounded requests. */
export const MAX_RUN_QUEUE_ENTRIES=16;
export const RUN_QUEUE_JOINED_MESSAGE='At request admission this local host already owned another Work. The run joined the durable local run queue and starts in its turn without a further request.';
export const RUN_QUEUE_ALREADY_MESSAGE='This Work is already queued on this local host; the request changed nothing.';
export const RUN_QUEUE_FULL_MESSAGE='The local run queue is full (queue_full); this request was refused and nothing changed. Retry when the queue drains.';
const exact=(v:unknown,keys:string[],optional:string[]=[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>Object.hasOwn(v,k))&&Object.keys(v).every(k=>[...keys,...optional].includes(k));
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function ensure(v:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
function validChoice(v:unknown):v is ExecutionChoice {return exact(v,['executorProfileId','verifierProfileId','authorizationId','outputTokenCap'])&&[v.executorProfileId,v.verifierProfileId,v.authorizationId].every(identifier)&&count(v.outputTokenCap)&&v.outputTokenCap>0;}
function validWork(v:unknown):v is SequenceWork {return exact(v,['workId','inputHash','criteriaHash'])&&identifier(v.workId)&&digest(v.inputHash)&&digest(v.criteriaHash);}
export interface RunQueueJoinInput {missionId:string;work:SequenceWork;runId:string;requestedBy:'owner'|'assistant';choice?:ExecutionChoice}
export interface RunQueueEntry extends RunQueueJoinInput {joinedAt:number;seq:number}
export interface RunQueueState {kind:'run-queue';id:string;entries:RunQueueEntry[]}
export type RunQueueCommand={type:'enqueue-run';input:RunQueueJoinInput}|{type:'remove-run';missionId:string;workId:string};
export const isRunQueueState=(value:unknown):value is RunQueueState=>!!value&&typeof value==='object'&&(value as RunQueueState).kind==='run-queue';
const queuedUnder=(entry:{missionId:string;work:SequenceWork})=>(e:RunQueueEntry)=>e.missionId===entry.missionId&&e.work.workId===entry.work.workId;
function validJoinInput(input:unknown):asserts input is RunQueueJoinInput {
 ensure(exact(input,['missionId','work','runId','requestedBy'],['choice'])&&identifier(input.missionId)&&validWork(input.work)&&identifier(input.runId)&&['owner','assistant'].includes(input.requestedBy)&&(input.choice===undefined||validChoice(input.choice)),'Exact run queue entry required');
}
export function applyRunQueue(current:RunQueueState|null,command:RunQueueCommand,actor:Actor,at:number):{value:RunQueueState;events:unknown[]} {
 ensure(actor.id===RUN_QUEUE_HOST&&actor.roles.includes('representative'),'Run queue authority denied','denied');
 ensure(count(at),'Invalid run queue clock');
 const state:RunQueueState=current?structuredClone(current):{kind:'run-queue',id:RUN_QUEUE_ID,entries:[]};
 if(command.type==='enqueue-run'){
  validJoinInput(command.input);
  // The decision lives inside the transition: room and duplication are judged against this commit's state.
  ensure(!state.entries.some(queuedUnder(command.input)),'Work already queued','conflict');
  ensure(state.entries.length<MAX_RUN_QUEUE_ENTRIES,'Run queue limit reached','conflict');
  state.entries.push({...structuredClone(command.input),joinedAt:at,seq:state.entries.reduce((max,e)=>Math.max(max,e.seq),0)+1});
 }else{
  ensure(exact(command,['type','missionId','workId'])&&identifier(command.missionId)&&identifier(command.workId),'Exact run queue removal required');
  const at2=state.entries.findIndex(e=>e.missionId===command.missionId&&e.work.workId===command.workId);
  ensure(at2>=0,'Unknown queued run','conflict');
  state.entries.splice(at2,1);
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:{observedAt:at}}]};
}
const fingerprint=(command:RunQueueCommand)=>hash({actorId:RUN_QUEUE_HOST,command});
/** Backup lineage: every operation is one host command whose state the reducer reproduces exactly. */
export function replayRunQueue(operation:Operation<RunQueueState>,prior:Operation<RunQueueState>|undefined):void {
 ensure(operation.aggregateId===RUN_QUEUE_ID&&operation.value.id===RUN_QUEUE_ID&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'run queue lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:RunQueueCommand;time:{observedAt:number}}|undefined;
 ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&exact(event.time,['observedAt'])&&event.type===event.command?.type,'run queue operation requires one typed event');
 ensure(event.actor===RUN_QUEUE_HOST&&operation.fingerprint===fingerprint(event.command),'run queue fingerprint mismatch');
 const next=applyRunQueue(prior?.value??null,event.command,{id:RUN_QUEUE_HOST,roles:['representative']},event.time.observedAt);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'run queue transition mismatch');
}
export type RunQueueJoinOutcome={joined:true;duplicate:boolean}|{joined:false;reason:'full'};
export class RunQueueService {
 readonly #store:Store<any>;readonly #clock:()=>number;#count=0;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 count(){return this.#count;}
 async load(){const snapshot=await this.#store.load(RUN_QUEUE_ID) as Snapshot<RunQueueState>|null;this.#count=snapshot?.value.entries.length??0;return snapshot;}
 async snapshot(){const snapshot=await this.load();return [...snapshot?.value.entries??[]].sort((a,b)=>a.seq-b.seq);}
 async join(input:RunQueueJoinInput):Promise<RunQueueJoinOutcome>{
  input=structuredClone(input);validJoinInput(input);
  const commandId='run-queue-join:'+hash(input).slice(0,48);
  for(let attempt=0;attempt<5;attempt++){
   const snapshot=await this.load();
   if(snapshot?.value.entries.some(queuedUnder(input)))return {joined:true,duplicate:true};
   if((snapshot?.value.entries.length??0)>=MAX_RUN_QUEUE_ENTRIES)return {joined:false,reason:'full'};
   const {value,events}=applyRunQueue(snapshot?.value??null,{type:'enqueue-run',input},{id:RUN_QUEUE_HOST,roles:['representative']},this.#clock());
   const result=await this.#store.commit({id:RUN_QUEUE_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:fingerprint({type:'enqueue-run',input}),value,events,outbox:[]});
   if(result.status==='conflict'&&result.reason==='revision')continue;
   if(result.status==='conflict'&&result.reason==='idempotency'){this.#count=(await this.load())?.value.entries.length??this.#count;return {joined:true,duplicate:false};}
   this.#count=value.entries.length;return {joined:true,duplicate:false};
  }
  throw new DomainError('Run queue join contention');
 }
 /** Removes one entry. An entry already absent is success; a refused commit throws, so no caller can mistake it for done. */
 async remove(entry:RunQueueEntry):Promise<void>{
  const command:RunQueueCommand={type:'remove-run',missionId:entry.missionId,workId:entry.work.workId},commandId='run-queue-remove:'+hash({missionId:entry.missionId,workId:entry.work.workId,seq:entry.seq,joinedAt:entry.joinedAt}).slice(0,48);
  for(let attempt=0;attempt<5;attempt++){
   const snapshot=await this.load(),current=snapshot?.value.entries.find(e=>e.seq===entry.seq&&e.joinedAt===entry.joinedAt&&e.missionId===entry.missionId&&e.work.workId===entry.work.workId);
   if(!current)return;
   const {value,events}=applyRunQueue(snapshot!.value,command,{id:RUN_QUEUE_HOST,roles:['representative']},this.#clock());
   const result=await this.#store.commit({id:RUN_QUEUE_ID,expectedRevision:snapshot!.revision,commandId,fingerprint:fingerprint(command),value,events,outbox:[]});
   if(result.status==='conflict'&&result.reason==='revision')continue;
   if(result.status==='conflict')throw new DomainError('Run queue removal refused: '+result.reason);
   this.#count=value.entries.length;return;
  }
  throw new DomainError('Run queue remove contention');
 }
}
const queueTake=new AsyncLocalStorage<boolean>();
/** The drain pass runs its candidate through the normal run path; only the queue-join decision is suspended for it. */
export function withQueueTake<T>(action:()=>T):T{return queueTake.run(true,action);}
export const inQueueTake=()=>queueTake.getStore()===true;
/** The slot was handed to another dispatch while the drain pass was between its checks and its reservation. */
export class QueueSlotLostError extends Error {constructor(){super('The run queue lost the slot before reserving the next entry');this.name='QueueSlotLostError';}}
export interface RunQueueHost {
 /** Occupied slot, hand-over mark or waiting entries: a new request joins the queue and never takes the slot. */
 busy():boolean;
 hostDraining():boolean;
 join(input:RunQueueJoinInput,snapshot:Snapshot<Mission>):Promise<RuntimeResult>;
 entries():Promise<RunQueueEntry[]>;
 remove(entry:RunQueueEntry):Promise<void>;
 halt?(code:RunQueueHaltCode,entry:{missionId:string;workId:string}):void;
}
/** The two closed halt codes: a queued entry could not be removed, or its refusal reason could not be recorded. */
export type RunQueueHaltCode='queue_removal_failed'|'queue_record_failed';
