/** Schedules and the morning briefing (docs/architecture/results-and-schedules.md, ADR 0002 §1 and §8, ADR 0003 §1). A host function, not a person: the host scheduler runs, the owner decides. */
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {ASSISTANT_ACTOR_ID,ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';
import {representativeName} from './surface-shell.ts';

/** Under the reserved conversation prefix, so no Mission can take this ID and Mission readers refuse it. */
export const SCHEDULES_ID=ASSISTANT_CONVERSATION_PREFIX+'schedules',DAY_MS=86400000,RUN_MS=60000,MAX_RUNS=30,MAX_BUDGET=366,BRIEFING_TURNS=12;
export const BRIEFING={title:'Morning briefing',request:'Sum up yesterday\'s work: what finished, what was handed back, what has an unknown result.'};
export interface ScheduleRun {id:string;slot:number;manual:boolean;state:'started'|'done'|'failed'|'closed';startedAt:number;deadlineAt:number;endedAt?:number;turnIds?:string[];segment?:number;reason?:string}
export interface Schedule {id:string;kind:'briefing';minute:number;offset:number;active:boolean;nextAt:number;budget:{runs:number};used:number;runs:ScheduleRun[]}
export interface SchedulesState {kind:'schedules';id:string;schedules:Schedule[]}
export type SchedulesCommand =
 | {type:'create-schedule';scheduleId:string;kind:'briefing';minute:number;offset:number;budget:{runs:number}}
 | {type:'pause-schedule'|'resume-schedule';scheduleId:string}
 | {type:'start-run';scheduleId:string;runId:string;slot:number;manual:false}
 /** Run now: its slot is the time the reducer observes; `retryOf` closes the failed run it retries in the same step. */
 | {type:'start-run';scheduleId:string;runId:string;manual:true;retryOf?:string}
 /** `segment` is the conversation segment the turns were read from (0 when none), so a briefing keeps its Work after the segment rolls over. */
 | {type:'finish-run';scheduleId:string;runId:string;turnIds:string[];segment:number}
 | {type:'fail-run';scheduleId:string;runId:string;reason:string}
 | {type:'skip-run';scheduleId:string;runId:string;slot:number}
 | {type:'close-run';scheduleId:string;runId:string};
const HOST_STEPS:Record<string,string>={'start-run':'assistant-schedule-run:','finish-run':'assistant-schedule-finish:','fail-run':'assistant-schedule-fail:','skip-run':'assistant-schedule-skip:'};
export const isSchedulesState=(value:unknown):value is SchedulesState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='schedules';
/** A scheduled run's ID follows from its schedule and slot, so a second tick for the same slot replays the same start. */
export const scheduledRunId=(scheduleId:string,slot:number)=>'run-'+hash({scheduleId,slot}).slice(0,16),manualRunId=(commandId:string)=>'run-now-'+hash(commandId).slice(0,16);
/** The next owner-local `minute` strictly after `after`, with the owner's UTC offset in minutes. */
// ponytail: a fixed offset, so a daylight-saving change moves the slot by an hour; store an IANA zone if owners need it.
export function nextSlot(minute:number,offset:number,after:number):number {const shift=offset*60000,slot=Math.floor((after+shift)/DAY_MS)*DAY_MS+minute*60000-shift;return slot>after?slot:slot+DAY_MS;}
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const int=(v:unknown,min:number,max:number):v is number=>Number.isSafeInteger(v)&&(v as number)>=min&&(v as number)<=max;
const unknownRun=(r:ScheduleRun,at:number)=>r.state==='started'&&at>=r.deadlineAt;

/** Reducer for the one schedules aggregate. `current` is null only before the first schedule. */
export function applySchedules(current:SchedulesState|null,command:SchedulesCommand,actor:Actor,time:TimeObservation):{value:SchedulesState;events:unknown[]} {
 ensure(actor&&id(actor.id),'Invalid actor');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');const at=time.observedAt;
 const state:SchedulesState=current?structuredClone(current):{kind:'schedules',id:SCHEDULES_ID,schedules:[]};
 const role=(needed:'owner'|'assistant')=>ensure(actor.roles.includes(needed),'Actor lacks required role','denied');
 ensure(command&&typeof command==='object'&&typeof command.type==='string','Unknown command');role(Object.hasOwn(HOST_STEPS,command.type)?'assistant':'owner');
 ensure(current!==null||command.type==='create-schedule','Only creating a schedule starts the schedules record');
 const schedule=()=>{const found=state.schedules.find(s=>s.id===command.scheduleId);ensure(found,'Unknown schedule');return found;};
 const run=(s:Schedule)=>{const found=s.runs.find(r=>r.id===(command as {runId:string}).runId);ensure(found,'Unknown run');return found;};
 /** Keeps the newest runs; done and closed ones go first, an open exception stays until the owner closes it. */
 const keep=(s:Schedule)=>{while(s.runs.length>MAX_RUNS){const old=s.runs.findIndex(r=>r.state==='done'||r.state==='closed');ensure(old>=0,'Close earlier runs first','conflict');s.runs.splice(old,1);}};
 switch(command.type){
  case 'create-schedule': {
   ensure(exact(command,['type','scheduleId','kind','minute','offset','budget'])&&id(command.scheduleId)&&command.kind==='briefing'&&int(command.minute,0,1439)&&int(command.offset,-840,840),'Exact schedule fields required');
   ensure(exact(command.budget,['runs'])&&int(command.budget.runs,1,MAX_BUDGET),'A cumulative budget of 1 to '+MAX_BUDGET+' runs is required');
   // ponytail: one kind, so one schedule; scheduled Work brings more kinds and a bound on their count.
   ensure(state.schedules.length===0,'Only one schedule exists','conflict');
   state.schedules.push({id:command.scheduleId,kind:'briefing',minute:command.minute,offset:command.offset,active:true,nextAt:nextSlot(command.minute,command.offset,at),budget:{runs:command.budget.runs},used:0,runs:[]});break;
  }
  case 'pause-schedule': {ensure(exact(command,['type','scheduleId']),'Exact pause fields required');const s=schedule();ensure(s.active,'Already paused','conflict');s.active=false;break;}
  case 'resume-schedule': {ensure(exact(command,['type','scheduleId']),'Exact resume fields required');const s=schedule();ensure(!s.active,'Already active','conflict');ensure(s.used<s.budget.runs,'Budget reached','conflict');s.active=true;s.nextAt=nextSlot(s.minute,s.offset,at);break;}
  case 'start-run': {
   ensure(id(command.runId)&&(command.manual===true?exact(command,['type','scheduleId','runId','manual',...Object.hasOwn(command,'retryOf')?['retryOf']:[]]):command.manual===false&&exact(command,['type','scheduleId','runId','slot','manual'])&&Number.isSafeInteger(command.slot)),'Exact run fields required');const s=schedule();
   ensure(!s.runs.some(r=>r.id===command.runId),'Run already exists','conflict');ensure(s.used<s.budget.runs,'Budget reached','conflict');
   ensure(!s.runs.some(r=>r.state==='started'&&at<r.deadlineAt),'A run is already started','conflict');
   if(!command.manual)ensure(s.active&&command.slot===s.nextAt&&command.slot<=at,'The slot is not due','conflict');
   else if(command.retryOf!==undefined){const failed=s.runs.find(r=>r.id===command.retryOf);ensure(failed&&failed.state==='failed','Only a failed run is retried','conflict');failed.state='closed';}
   s.used++;s.runs.push({id:command.runId,slot:command.manual?at:command.slot,manual:command.manual,state:'started',startedAt:at,deadlineAt:at+RUN_MS});if(!command.manual)s.nextAt=nextSlot(s.minute,s.offset,at);keep(s);break;
  }
  case 'finish-run': {
   ensure(exact(command,['type','scheduleId','runId','turnIds','segment'])&&int(command.segment,0,Number.MAX_SAFE_INTEGER)&&Array.isArray(command.turnIds)&&command.turnIds.length<=BRIEFING_TURNS&&command.turnIds.every(t=>typeof t==='string'&&t.length>0&&t.length<=256),'Exact finish fields required');
   const r=run(schedule());ensure(r.state==='started'&&at<r.deadlineAt,'Only a started run in time finishes','conflict');Object.assign(r,{state:'done',endedAt:at,turnIds:[...command.turnIds],segment:command.segment});break;
  }
  case 'fail-run': {ensure(exact(command,['type','scheduleId','runId','reason'])&&typeof command.reason==='string'&&command.reason.length>0&&command.reason.length<=64,'Exact fail fields required');const r=run(schedule());ensure(r.state==='started','Only a started run fails','conflict');Object.assign(r,{state:'failed',endedAt:at,reason:command.reason});break;}
  case 'skip-run': {
   ensure(exact(command,['type','scheduleId','runId','slot'])&&id(command.runId)&&Number.isSafeInteger(command.slot),'Exact skip fields required');const s=schedule();
   ensure(s.active&&command.slot===s.nextAt&&command.slot<=at,'The slot is not due','conflict');ensure(s.used>=s.budget.runs,'Budget left','conflict');ensure(!s.runs.some(r=>r.id===command.runId),'Run already exists','conflict');
   s.runs.push({id:command.runId,slot:command.slot,manual:false,state:'failed',startedAt:at,deadlineAt:at,endedAt:at,reason:'Budget reached'});s.active=false;s.nextAt=nextSlot(s.minute,s.offset,at);keep(s);break;
  }
  case 'close-run': {ensure(exact(command,['type','scheduleId','runId']),'Exact close fields required');const r=run(schedule());ensure(r.state==='failed'||unknownRun(r,at),'Only a failed or unknown run can close','conflict');r.state='closed';break;}
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const fingerprint=(actorId:string,command:SchedulesCommand)=>hash({actorId,command});
/** Backup lineage: each operation replays from the one before it with the recorded time; host steps carry host command IDs, owner commands never do. */
export function replaySchedules(operation:Operation<SchedulesState>,prior:Operation<SchedulesState>|undefined):void {
 ensure(operation.aggregateId===SCHEDULES_ID&&operation.value.id===SCHEDULES_ID,'schedules aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:SchedulesCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'schedules operation requires one typed event');
 const c=event.command,step=Object.hasOwn(HOST_STEPS,c.type);ensure((event.actor===ASSISTANT_ACTOR_ID)===step,'schedules step actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,c),'command fingerprint mismatch');
 const runId=(c as {runId?:string}).runId??'',derived=c.type==='skip-run'||c.type==='start-run'&&!c.manual?runId===scheduledRunId(c.scheduleId,(c as {slot:number}).slot):c.type!=='start-run'||runId.startsWith('run-now-');
 ensure(step?operation.commandId===HOST_STEPS[c.type]+runId&&derived:!operation.commandId.startsWith('assistant-'),'schedules command identity mismatch');
 const next=applySchedules(prior?prior.value:null,c,{id:event.actor,roles:[step?'assistant':'owner']},event.time);
 ensure(hash(next.value)===hash(operation.value)&&hash(next.events)===hash(operation.events)&&operation.outbox.length===0,'schedules command/state transition');
}

type Turn={id:string;at?:number;work?:unknown};type Turns={segment?:{number:number}|null;turns:Turn[]};
const OWNER='local-owner',host:Actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']},owner:Actor={id:OWNER,roles:['owner']};
const display=(r:ScheduleRun,at:number)=>unknownRun(r,at)?'unknown':r.state==='started'?'running':r.state;
const fact=(r:ScheduleRun,at:number)=>r.state==='done'?r.turnIds!.length+(r.turnIds!.length===1?' Work item':' Work items'):unknownRun(r,at)?'Not resent':r.reason??'';
export class SchedulesService {
 readonly #store:Store<any>;readonly #ownerStore:Store<any>;readonly #read:(segment?:number)=>Promise<Turns>;readonly #clock:()=>number;#ticking=false;#unsettled=false;
 /** `read` is the Representative's conversation read (head when no segment is named); the briefing lists its Work turns, so no model is called. `ownerStore` takes the owner's own commit (the host passes its drain-aware store); a run's later host steps use `store`, so a run already started still finishes during drain. */
 constructor(store:Store<any>,read:(segment?:number)=>Promise<Turns>,clock:()=>number=Date.now,ownerStore:Store<any>=store){this.#store=store;this.#ownerStore=ownerStore;this.#read=read;this.#clock=clock;}
 /** True once any schedule write met an unknown commit outcome, so the host drain reports `unsettled`. */
 get unsettled(){return this.#unsettled;}
 async #state(){return await this.#store.load(SCHEDULES_ID) as Snapshot<SchedulesState>|null;}
 async read(){
  const s=await this.#state(),now=this.#clock();
  return {revision:s?.revision??0,schedules:(s?.value.schedules??[]).map(x=>({id:x.id,...BRIEFING,assignee:representativeName,destination:'Conversation with '+representativeName,active:x.active,nextAt:x.nextAt,minute:x.minute,offset:x.offset,budget:{runs:x.budget.runs,used:x.used},
   runs:[...x.runs].reverse().map(r=>({id:r.id,at:r.endedAt??r.startedAt,state:display(r,now),fact:fact(r,now),turnIds:[...r.turnIds??[]]}))}))};
 }
 /** What the Representative's conversation shows: one briefing per done run, one exception card per failed or unknown run not closed, and `runDeadlineAt` while a run is still in time, so the page reads again when it turns unknown. A briefing read from a segment other than `current` carries its turns, read from that segment, so rollover never empties it. */
 async conversation(current?:number){
  const s=await this.#state(),now=this.#clock(),briefings=[],exceptions=[],segments=new Map<number,Promise<Turn[]>>();let deadline=Infinity;
  const turnsOf=(n:number)=>{if(!segments.has(n))segments.set(n,this.#read(n).then(v=>v.turns,()=>[]));return segments.get(n)!;};
  for(const x of s?.value.schedules??[])for(const r of x.runs){
   if(r.state==='done'){const ids=r.turnIds!,other=r.segment&&r.segment!==current&&ids.length?(await turnsOf(r.segment)).filter(t=>ids.includes(t.id)):undefined;briefings.push({id:r.id,at:r.endedAt!,title:BRIEFING.title,turnIds:[...ids],...other?{turns:other}:{}});}
   else if(r.state==='started'&&!unknownRun(r,now))deadline=Math.min(deadline,r.deadlineAt);
   else if(r.state==='failed'||unknownRun(r,now)){const unknown=r.state==='started';exceptions.push({id:r.id,at:r.endedAt??r.deadlineAt,title:BRIEFING.title,state:unknown?'unknown':'failed',fact:fact(r,now),actions:unknown?['check','close']:x.used<x.budget.runs?['retry','close']:['close'],scheduleId:x.id,runId:r.id});}
  }
  return {briefings,exceptions,...deadline<Infinity?{runDeadlineAt:deadline}:{}};
 }
 /** The owner's actions. Run now writes the host's start for the owner, with a run ID from the owner's command ID and no caller time in the command, so a lost Run now replays and runs once; Retry is Run now that closes the failed run in the same step. */
 async act(input:unknown):Promise<CommitResult<SchedulesState>>{
  const action=(input as {action?:unknown})?.action,actions:Record<string,string[]>={create:['minute','offset','budget'],pause:['scheduleId'],resume:['scheduleId'],run:['scheduleId',...input&&typeof input==='object'&&Object.hasOwn(input,'retryOf')?['retryOf']:[]],close:['scheduleId','runId']};
  ensure(typeof action==='string'&&Object.hasOwn(actions,action),'Unknown schedule action');const keys=actions[action]!;ensure(exact(input,['commandId','action',...keys])&&id(input.commandId)&&(action==='create'||id(input.scheduleId)),'Exact schedule action fields required');
  const commandId=input.commandId as string;ensure(!commandId.startsWith('assistant-'),'assistant- command identities are reserved for host steps');const scheduleId=input.scheduleId as string;
  if(action==='create')return this.#dispatch(commandId,owner,{type:'create-schedule',scheduleId:'schedule-'+hash(commandId).slice(0,16),kind:'briefing',minute:input.minute as number,offset:input.offset as number,budget:input.budget as {runs:number}},this.#ownerStore);
  if(action==='close')return this.#dispatch(commandId,owner,{type:'close-run',scheduleId,runId:input.runId as string},this.#ownerStore);
  if(action!=='run')return this.#dispatch(commandId,owner,{type:action==='pause'?'pause-schedule':'resume-schedule',scheduleId},this.#ownerStore);
  ensure(!Object.hasOwn(input,'retryOf')||id(input.retryOf),'Exact schedule action fields required');
  const runId=manualRunId(commandId),started=await this.#dispatch(HOST_STEPS['start-run']+runId,host,{type:'start-run',scheduleId,runId,manual:true,...Object.hasOwn(input,'retryOf')?{retryOf:input.retryOf as string}:{}},this.#ownerStore);
  if(started.status==='committed')await this.#run(scheduleId,runId);return started;
 }
 /** The host scheduler: a due slot starts a run, or with no budget left records `Budget reached` and pauses. Returns the runs it started. */
 async tick():Promise<string[]>{
  if(this.#ticking)return [];this.#ticking=true;const ran:string[]=[];
  try{const now=this.#clock();for(const s of (await this.#state())?.value.schedules??[]){if(!s.active||s.nextAt>now)continue;const runId=scheduledRunId(s.id,s.nextAt);
   if(s.used>=s.budget.runs){await this.#dispatch(HOST_STEPS['skip-run']+runId,host,{type:'skip-run',scheduleId:s.id,runId,slot:s.nextAt});continue;}
   const started=await this.#dispatch(HOST_STEPS['start-run']+runId,host,{type:'start-run',scheduleId:s.id,runId,slot:s.nextAt,manual:false});if(started.status==='committed'){ran.push(runId);await this.#run(s.id,runId);}}}
  finally{this.#ticking=false;}return ran;
 }
 /** Reads the conversation once and finishes the run; a failed read fails it. An unknown commit is left as it is: the run reads as unknown after its deadline and is never run again. */
 async #run(scheduleId:string,runId:string){
  let turnIds:string[],segment=0;
  try{const view=await this.#read(),since=this.#clock()-DAY_MS;segment=view.segment?.number??0;turnIds=view.turns.filter(t=>t.work&&Number.isSafeInteger(t.at)&&t.at!>=since).slice(-BRIEFING_TURNS).map(t=>t.id);}
  catch{await this.#dispatch(HOST_STEPS['fail-run']+runId,host,{type:'fail-run',scheduleId,runId,reason:'Briefing unavailable'}).catch(()=>{});return;}
  await this.#dispatch(HOST_STEPS['finish-run']+runId,host,{type:'finish-run',scheduleId,runId,turnIds,segment}).catch(()=>{});
 }
 /** Every write goes here, so an unknown commit outcome is recorded once for the host drain, whether a request or the scheduler made it. */
 async #dispatch(commandId:string,actor:Actor,command:SchedulesCommand,store=this.#store):Promise<CommitResult<SchedulesState>>{
  try{return await this.#attempt(commandId,actor,command,store);}catch(error){if(error instanceof Error&&error.name==='CommitOutcomeUnknownError')this.#unsettled=true;throw error;}
 }
 /** Load, then look the receipt up, then reduce: an identical command committed concurrently replays instead of failing the reducer on its own applied state. CAS on the revision read. */
 async #attempt(commandId:string,actor:Actor,command:SchedulesCommand,store:Store<any>):Promise<CommitResult<SchedulesState>>{
  const identity={id:SCHEDULES_ID,commandId,fingerprint:fingerprint(actor.id,command)};
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await this.#state(),prior=await store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const {value,events}=applySchedules(snapshot?.value??null,command,actor,{observedAt:this.#clock()});
   const result=await store.commit({id:SCHEDULES_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});
   if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
