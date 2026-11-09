import {Application} from './application.ts';
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Actor,Mission,Work} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import {withAdmissionFeed} from './storage.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import {discriminatorPolicy} from './discriminator.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';
import {teamCallCount} from './internal-teams.ts';
import {copy} from './ui-copy.ts';

export const MONTHLY_BUDGET_ID=ASSISTANT_CONVERSATION_PREFIX+'monthly-budget',BUDGET_DECISION_PREFIX='monthly-budget:';
const OWNER='local-owner',HOST='runtime-representative';
export const monthlyRunId=(decisionId:string,missionId:string,workId:string)=>'monthly-run:'+hash([decisionId,missionId,workId]).slice(0,48);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
export function accountingPeriod(at:number,timezone:string):string {
 ensure(count(at),'Invalid accounting time');const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,calendar:'gregory',year:'numeric',month:'2-digit'}).formatToParts(at);
 return parts.find(p=>p.type==='year')!.value+'-'+parts.find(p=>p.type==='month')!.value;
}
export interface Reservation {missionId:string;workId:string;runId:string;amount:number;inputHash:string;revision:number;title:string;period:string;at:number;state:'reserved'|'waiting'|'released'|'settled';decisionId?:string;selection?:ExecutionChoice;feedId?:string;usage?:number}
interface BudgetDecision {id:string;period:string;at:number;state:'open'|'later'|'done';limit:number;nextLimit:number;actorId?:string}
export interface MonthlyBudgetState {kind:'monthly-budget';id:string;limit:number|null;timezone:string;actorId:string;reservations:Reservation[];decisions:BudgetDecision[]}
function proposalLimit(state:MonthlyBudgetState,d:BudgetDecision):number {return d.state!=='done'&&state.limit!==d.limit?Math.max(d.nextLimit,(state.limit??0)+Math.max(1,state.reservations.filter(r=>r.decisionId===d.id&&r.state==='waiting').reduce((sum,r)=>sum+r.amount,0))):d.nextLimit;}
type BudgetCommand={type:'reconcile-monthly-budget';missionId:string;workId:string;runId:string;workRevision:number;state:'released'|'settled';usage?:number}|{type:'release-monthly-budget';missionId:string;workId:string;runId:string;workRevision?:number}|{type:'configure-monthly-budget';limit:number;timezone:string}|{type:'reserve-monthly-budget';entry:Omit<Reservation,'state'>;used:number;available:boolean;timezone?:string}|{type:'decide-monthly-budget';decisionId:string;answer:'act'|'later'|'ask';limit?:number};
export const isMonthlyBudgetState=(v:unknown):v is MonthlyBudgetState=>!!v&&typeof v==='object'&&(v as MonthlyBudgetState).kind==='monthly-budget';
export function applyMonthlyBudget(current:MonthlyBudgetState|null,command:BudgetCommand,actor:Actor,at:number,reconcileVersion?:1){
 ensure(count(at)&&id(actor.id),'Invalid budget actor/time');const host=command.type==='reserve-monthly-budget'||command.type==='release-monthly-budget'||command.type==='reconcile-monthly-budget';ensure(actor.id===(host?HOST:OWNER)&&actor.roles.includes(host?'representative':'owner'),'Budget authority denied');
 ensure(current!==null||command.type==='configure-monthly-budget'||command.type==='reserve-monthly-budget'&&typeof command.timezone==='string','Monthly reservation needs its original timezone');
 let state:MonthlyBudgetState|null=current?structuredClone(current):command.type==='reserve-monthly-budget'?{kind:'monthly-budget',id:MONTHLY_BUDGET_ID,limit:null,timezone:command.timezone!,actorId:actor.id,reservations:[],decisions:[]}:null;
 if(command.type==='configure-monthly-budget'){
  ensure(exact(command,['type','limit','timezone'])&&count(command.limit)&&typeof command.timezone==='string'&&command.timezone.length<=100,'Invalid monthly budget fields');try{accountingPeriod(at,command.timezone);}catch{throw new DomainError('Invalid accounting timezone');}
  ensure(!state||state.limit===null||state.timezone===command.timezone,'Accounting timezone is already pinned');
  if(state){state.timezone=command.timezone;state.limit=command.limit;state.actorId=actor.id;for(const d of state.decisions)if(d.state!=='done'){d.limit=command.limit;d.nextLimit=Math.max(command.limit+1,command.limit+state.reservations.filter(r=>r.decisionId===d.id&&r.state==='waiting').reduce((sum,r)=>sum+r.amount,0));}}else state={kind:'monthly-budget',id:MONTHLY_BUDGET_ID,limit:command.limit,timezone:command.timezone,actorId:actor.id,reservations:[],decisions:[]};
 }else if(command.type==='reconcile-monthly-budget'){
  ensure(exact(command,['type','missionId','workId','runId','workRevision','state',...(command.state==='settled'?['usage']:[])])&&[command.missionId,command.workId,command.runId].every(id)&&count(command.workRevision)&&['released','settled'].includes(command.state)&&(command.state!=='settled'||count(command.usage)),'Invalid monthly reconciliation');const r=state!.reservations.find(r=>r.missionId===command.missionId&&r.workId===command.workId&&r.runId===command.runId&&r.revision===command.workRevision);ensure(r,'Reservation generation changed');r.state=command.state;if(command.state==='settled')r.usage=command.usage;else delete r.usage;
 }else if(command.type==='release-monthly-budget'){
  ensure(exact(command,['type','missionId','workId','runId',...(command.workRevision!==undefined?['workRevision']:[])])&&(command.workRevision===undefined||count(command.workRevision)&&command.workRevision>0)&&[command.missionId,command.workId,command.runId].every(id),'Invalid reservation release');const r=state!.reservations.find(r=>r.missionId===command.missionId&&r.workId===command.workId&&r.runId===command.runId);ensure(r?.state==='reserved'&&(command.workRevision===undefined||r.revision===command.workRevision),'Exact unused reservation required');r.state='released';
 }else if(command.type==='reserve-monthly-budget'){
  const e=command.entry;ensure(exact(command,['type','entry','used','available',...(command.timezone!==undefined?['timezone']:[])])&&exact(e,['missionId','workId','runId','amount','inputHash','revision','title','period','at',...['selection','feedId','decisionId'].filter(k=>Object.hasOwn(e,k))])&&(e.selection===undefined||validSelection(e.selection))&&(e.feedId===undefined||id(e.feedId))&&(e.decisionId===undefined||id(e.decisionId)&&state!.decisions.some(d=>d.id===e.decisionId&&d.state==='done'))&&[e.missionId,e.workId,e.runId].every(id)&&count(e.amount)&&e.amount>0&&/^[a-f0-9]{64}$/.test(e.inputHash)&&count(e.revision)&&e.revision>0&&typeof e.title==='string'&&e.title.length<=16000&&e.period===accountingPeriod(at,state!.timezone)&&e.at===at&&count(command.used)&&typeof command.available==='boolean','Invalid run reservation');
  const previous=state!.reservations.find(r=>r.missionId===e.missionId&&r.workId===e.workId);ensure(!previous||previous.state==='released','Work already has a monthly admission');ensure(state!.reservations.length<10000,'Monthly reservation bound reached');
  const limit=state!.limit,ready=limit===null||command.available&&command.used+e.amount<=limit;
  const entry:Reservation={...structuredClone(e),state:ready?'reserved':'waiting'};
  if(!ready){ensure(limit!==null,'Missing owner limit');let d=state!.decisions.find(d=>d.period===e.period&&d.state!=='done');if(!d){d={id:BUDGET_DECISION_PREFIX+e.period+':'+state!.decisions.length,period:e.period,at,state:'open',limit,nextLimit:limit};state!.decisions.push(d);}entry.decisionId=d.id;d.nextLimit=Math.max(limit+1,command.used+e.amount+state!.reservations.filter(r=>r.decisionId===d!.id&&r.state==='waiting').reduce((sum,r)=>sum+r.amount,0));}
  if(previous)state!.reservations[state!.reservations.indexOf(previous)]=entry;else state!.reservations.push(entry);
 }else{
  ensure(exact(command,['type','decisionId','answer',...(command.limit!==undefined?['limit']:[])])&&id(command.decisionId)&&['act','later','ask'].includes(command.answer),'Invalid budget decision');
  const d=state!.decisions.find(d=>d.id===command.decisionId);ensure(d,'Unknown budget decision');
  if(command.answer==='ask'){ensure(d.state==='later','Only a deferred budget decision can reopen');d.state='open';}
  else{ensure(d.state==='open','Only an open budget decision can be answered');if(command.answer==='later')d.state='later';else{ensure(state!.limit!==null&&count(command.limit)&&(command.limit===d.nextLimit||command.limit===proposalLimit(state!,d))&&command.limit>state!.limit,'Monthly limit must increase to the reviewed limit');d.nextLimit=command.limit;state!.limit=command.limit;state!.actorId=actor.id;d.state='done';if(reconcileVersion===undefined)for(const r of state!.reservations)if(r.decisionId===d.id&&r.state==='waiting')r.state='released';}d.actorId=actor.id;}
 }
 return {value:state!,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:{observedAt:at,...(reconcileVersion?{reconcileVersion}:{})}}]};
}
export function replayMonthlyBudget(operation:Operation<MonthlyBudgetState>,prior?:Operation<MonthlyBudgetState>){
 const event=operation.events[0] as any;ensure(operation.aggregateId===MONTHLY_BUDGET_ID&&operation.value.id===MONTHLY_BUDGET_ID&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Monthly budget lineage mismatch');
 ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&exact(event.time,['observedAt',...(Object.hasOwn(event.time,'reconcileVersion')?['reconcileVersion']:[])])&&(event.time.reconcileVersion===undefined||event.time.reconcileVersion===1)&&event.type===event.command?.type,'Invalid monthly budget event');
 ensure(operation.fingerprint===hash({actorId:event.actor,command:event.command,expectedRevision:operation.expectedRevision}),'Monthly budget fingerprint mismatch');
 const derived=applyMonthlyBudget(prior?.value??null,event.command,{id:event.actor,roles:[event.actor===HOST?'representative':'owner']},event.time.observedAt,event.time.reconcileVersion);ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Monthly budget transition mismatch');
}
function validSelection(v:unknown):v is ExecutionChoice {return exact(v,['executorProfileId','verifierProfileId','authorizationId','outputTokenCap'])&&[v.executorProfileId,v.verifierProfileId,v.authorizationId].every(id)&&count(v.outputTokenCap)&&v.outputTokenCap>0;}
export interface MonthlySnapshot {feedId:string;budget:Snapshot<MonthlyBudgetState>|null;missions:Map<string,Snapshot<Mission>|null>;admitting:boolean}
export interface MonthlyAction {kind:'hold'|'release'|'pause'|'prepare'|'run'|'settle';reservation:Reservation;mission:Snapshot<Mission>|null;decisionId?:string;usage?:number}
export interface BudgetAdmission {status:'reserved'|'waiting'|'replayed'|'conflict';reservation:Reservation|null}
function sent(w:Work):boolean {return !!w.runtimeRun||w.effects.length>0;}
function pristine(w:Work):boolean {return !sent(w)&&!w.runtimeRecovery&&!w.runtimeInterruption&&!w.assignments.length&&!w.artifact&&!w.verdict&&!w.record&&w.acceptance==='pending'&&w.tasks.length===1&&w.tasks[0]?.status==='queued'&&['queued','blocked','waiting','budget-waiting'].includes(w.execution);}
function recordedSettlement(w:Work):number|undefined {
 const closed=['settled','cancelled'].includes(w.execution)||!!w.blocker||!!w.runtimeInterruption||!!w.runtimeRecovery||w.execution==='waiting'&&w.endedAt!==undefined;
 return closed&&count(w.budget.measured)&&w.effects.every(e=>e.status==='succeeded'||e.status==='failed')&&(w.moderation??[]).every(e=>e.result?.usage!==null&&e.result!==null)?w.budget.measured:undefined;
}
/** The only reservation recovery policy. The executor below supplies CAS, not a second policy. */
export function reconcileMonthly(snapshot:MonthlySnapshot):MonthlyAction[]{
 const state=snapshot.budget?.value;if(!state)return [];
 return state.reservations.map(r=>{
  const mission=snapshot.missions.get(r.missionId)??null,w=mission?.value.works.find(w=>w.id===r.workId),d=state.decisions.find(d=>d.id===r.decisionId)||state.decisions.find(d=>d.state==='done'&&r.runId===monthlyRunId(d.id,r.missionId,r.workId));
  const action=(kind:MonthlyAction['kind'],usage?:number):MonthlyAction=>({kind,reservation:r,mission,...(d?{decisionId:d.id}:{}),...(usage!==undefined?{usage}:{})});
  if(!w||r.feedId!==undefined&&r.feedId!==snapshot.feedId)return action('hold');
  if(sent(w)){const usage=recordedSettlement(w);return usage!==undefined&&(r.state!=='settled'||r.usage!==usage)?action('settle',usage):action('hold');}
  if(w.execution==='cancelled'||w.execution==='settled')return action(r.state==='released'?'hold':'release');
  if(!pristine(w))return action('hold');
  if(r.state==='reserved')return action(snapshot.admitting?'hold':'release');
  if(workInputHash(w)!==r.inputHash)return action(r.state==='released'?'hold':'release');
  if(r.state==='waiting'&&(d?.state==='done'||!d))return action('release');
  if(r.state==='waiting')return action(w.execution==='budget-waiting'&&w.monthlyBudgetDecision===d?.id?'hold':'pause');
  if(r.state==='released'&&d?.state==='done'){
   if(w.execution==='budget-waiting'&&w.monthlyBudgetDecision===d.id)return action('prepare');
   if(!w.monthlyBudgetDecision&&r.selection&&r.feedId===snapshot.feedId)return action('run');
  }
  return action('hold');
 });
}
interface AccountWork {missionId:string;workId:string;title:string;memberId:string|null;runId?:string;at?:number;cap:number;roomCalls:number;consumed:number}
export class MonthlyBudgetService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(MONTHLY_BUDGET_ID) as Snapshot<MonthlyBudgetState>|null;}
 async #account(timezone:string,period:string){
  const position=await this.#store.readState(),works=new Map<string,AccountWork>(),turns=new Map<string,any>(),callTimes=new Map<string,number>(),calls=new Set<string>(),members=new Map<string|null,{inputTokens:number;outputTokens:number;unknown:boolean}>();let cursor=0,inputTokens=0,outputTokens=0,unknown=false,inputUnknown=false,usageBounded=true;
  const add=(key:string,at:number|undefined,usage:any,memberId:string|null,covered:boolean)=>{if(calls.has(key))return;calls.add(key);if((at===undefined||!count(usage?.outputTokens))&&!covered)usageBounded=false;if(at===undefined){unknown=true;inputUnknown=true;return;}if(accountingPeriod(at,timezone)!==period)return;const member=members.get(memberId)??{inputTokens:0,outputTokens:0,unknown:false};for(const unit of ['inputTokens','outputTokens'] as const){if(count(usage?.[unit])){if(unit==='inputTokens')inputTokens+=usage[unit];else outputTokens+=usage[unit];member[unit]+=usage[unit];}else{member.unknown=true;if(unit==='outputTokens')unknown=true;else inputUnknown=true;}}members.set(memberId,member);};
  // shortcut: scan the retained feed; add a durable usage index when the journal exceeds the bounded local workload.
  while(cursor<position.cursor){const page=await this.#store.readCatchup(cursor,position.feedId,1000);ensure(page.events.length>0,'Incomplete accounting feed');for(const batch of page.events){if(batch.cursor>position.cursor)break;cursor=batch.cursor;for(const raw of batch.events){const e=raw as any,c=e?.command;if(!c)continue;const key=batch.aggregateId+'\0'+c.workId;
   if(c.type==='admit-work')works.set(key,{missionId:batch.aggregateId,workId:c.workId,title:c.title,memberId:c.assistantSource?.memberId??null,cap:teamCallCount(c.team),roomCalls:teamCallCount(c.team,true),consumed:0});
   const w=works.get(key);
   if(c.type==='activate-runtime'&&w){w.runId=c.run.id;w.at=c.run.ownership?.startedAt;w.cap=(c.run.roomVersion===1?w.roomCalls:w.cap)*c.run.outputTokenCap;}
   if(c.type==='claim-provider-dispatch'&&count(c.claim?.claimedAt))callTimes.set(key+'\0'+c.effectId,c.claim.claimedAt);
   if(c.type==='receipt'&&w){let receipt;try{receipt=JSON.parse(c.receipt);}catch{}if(receipt?.provider&&receipt?.usage&&receipt.binding?.runId===w.runId){const at=callTimes.get(key+'\0'+c.effectId)??w.at;add(key+'\0'+c.effectId,at,receipt.usage,w.memberId,!!w.runId&&count(w.cap));if(at!==undefined&&count(receipt.usage.outputTokens))w.consumed+=receipt.usage.outputTokens;} }
   if(c.type==='record-moderation'&&w){const mission=await this.#store.load(batch.aggregateId) as Snapshot<Mission>|null,entry=mission?.value.works.find(work=>work.id===c.workId)?.moderation?.find(entry=>entry.questionId===c.questionId);add(key+'\0moderation:'+c.questionId,entry?.startedAt,c.result?.usage,w.memberId,!!w.runId);if(count(c.result?.usage?.outputTokens))w.consumed+=c.result.usage.outputTokens;}
   if(['append-assistant-message','open-assistant-segment'].includes(c.type)&&c.turn?.ownership)turns.set(batch.aggregateId+'\0'+c.turn.id,c.turn);
   if(c.type==='settle-assistant-turn'){const t=turns.get(batch.aggregateId+'\0'+c.turnId);if(t){t.status=c.status;t.usage=c.usage;}add(batch.aggregateId+'\0'+c.turnId,t?.ownership?.startedAt,c.usage,batch.aggregateId.includes(':member:')?batch.aggregateId.slice((ASSISTANT_CONVERSATION_PREFIX+'member:').length,batch.aggregateId.lastIndexOf(':')):null,!!t?.route&&count(t.route.outputTokenCap));}
  }} }
  const end=await this.#store.readState();ensure(end.feedId===position.feedId,'Accounting database changed');return {...position,inputTokens,outputTokens,unknown,inputUnknown,usageBounded,members,works,turns};
 }
 async read(){
  for(let attempt=0;attempt<5;attempt++){
  const before=await this.#store.readState(),s=await this.#state(),timezone=s?.value.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,period=accountingPeriod(this.#clock(),timezone),a=await this.#account(timezone,period);
  ensure(before.feedId===a.feedId,'Accounting database changed');if(before.cursor!==a.cursor)continue;
  const missions=new Map<string,Snapshot<Mission>|null>();await Promise.all([...new Set([...a.works.values()].map(w=>w.missionId))].map(async id=>missions.set(id,await this.#store.load(id) as Snapshot<Mission>|null)));
  const fact=(missionId:string,workId:string)=>missions.get(missionId)?.value.works.find(w=>w.id===workId);
  let reserved=0;for(const r of s?.value.reservations??[]){if(r.state!=='reserved')continue;const w=a.works.get(r.missionId+'\0'+r.workId),actual=fact(r.missionId,r.workId);if(actual&&sent(actual)&&recordedSettlement(actual)!==undefined)continue;reserved+=Math.max(0,r.amount-(w?.consumed??0));}
  for(const w of a.works.values()){const actual=fact(w.missionId,w.workId);if(w.runId&&(!actual||recordedSettlement(actual)===undefined)&&!s?.value.reservations.some(r=>r.missionId===w.missionId&&r.workId===w.workId&&r.state==='reserved'))reserved+=Math.max(0,w.cap-w.consumed);
   for(const entry of actual?.moderation??[])if(!entry.result?.usage)reserved+=discriminatorPolicy(entry.thresholdVersion).outputTokenReserve;
  }
  for(const t of a.turns.values())if(t.route&&(!t.usage||t.status==='unknown'||!count(t.usage.outputTokens)))reserved+=Math.max(0,t.route.outputTokenCap-(count(t.usage?.outputTokens)?t.usage.outputTokens:0));
  const decisions=(s?.value.decisions??[]).map(d=>({id:d.id,at:d.at,title:copy('ui.budget.title'),question:copy('ui.budget.question'),rows:[[copy('ui.budget.now'),this.#amount(d.state==='done'?d.limit:s!.value.limit??0)],[copy('ui.budget.after'),this.#amount(proposalLimit(s!.value,d))],[copy('ui.budget.paused'),s!.value.reservations.filter(r=>r.decisionId===d.id&&r.state==='waiting').map(r=>r.title).join(' · ')]],action:copy('ui.budget.raise'),state:d.state,...(d.state==='done'?{line:copy('ui.budget.changed')}:{}),budget:{revision:s!.revision,limit:proposalLimit(s!.value,d)}}));
  const end=await this.#store.readState();ensure(end.feedId===a.feedId,'Accounting database changed');if(end.cursor!==a.cursor)continue;
  return {feedId:a.feedId,cursor:a.cursor,revision:s?.revision??0,period,timezone,unit:'output-tokens' as const,limit:s?.value.limit??null,spent:a.unknown?null:a.outputTokens,usageBounded:a.usageBounded,knownOutputTokens:a.outputTokens,inputTokens:a.inputUnknown?null:a.inputTokens,cost:null,reserved,members:[...a.members].map(([memberId,v])=>({memberId,...v})),decisions};
  }throw new DomainError('Monthly accounting read contention');
 }
 #amount(n:number){return n.toLocaleString('ko-KR');}
 async configure(input:unknown){ensure(exact(input,['commandId','expectedRevision','limit','timezone'])&&id(input.commandId)&&count(input.expectedRevision),'Exact monthly budget fields required');return this.#dispatch(input.commandId,input.expectedRevision,{type:'configure-monthly-budget',limit:input.limit,timezone:input.timezone},OWNER);}
 async decide(input:unknown){ensure(exact(input,['commandId','expectedRevision','decisionId','answer',...((input as any)?.answer==='act'?['limit']:[])])&&id(input.commandId)&&count(input.expectedRevision),'Exact monthly budget answer fields required');return this.#dispatch(input.commandId,input.expectedRevision,{type:'decide-monthly-budget',decisionId:input.decisionId,answer:input.answer,...(input.answer==='act'?{limit:input.limit}:{})},OWNER);}
 async snapshot(admitting:()=>boolean=()=>false):Promise<MonthlySnapshot>{
  const before=await this.#store.readState(),budget=await this.#state(),ids=[...new Set(budget?.value.reservations.map(r=>r.missionId)??[])],missions=new Map<string,Snapshot<Mission>|null>();
  await Promise.all(ids.map(async id=>{missions.set(id,await this.#store.load(id) as Snapshot<Mission>|null);}));ensure((await this.#store.readState()).feedId===before.feedId,'Monthly snapshot database changed');return {feedId:before.feedId,budget,missions,admitting:admitting()};
 }
 async admit(input:{missionId:string;workId:string;runId:string;amount:number;expectedRevision?:number;selection?:ExecutionChoice}):Promise<BudgetAdmission>{
  input=structuredClone(input);
  for(let attempt=0;attempt<5;attempt++){
   const state=await this.#state(),old=state?.value.reservations.find(r=>r.missionId===input.missionId&&r.workId===input.workId);
   if(old&&['waiting','reserved'].includes(old.state)){if(old.state==='waiting')await this.reconcile(await this.snapshot(()=>true));return {status:old.state==='waiting'?'waiting':'replayed',reservation:old};}
   const snapshot=await this.#store.load(input.missionId) as Snapshot<Mission>|null,w=snapshot?.value.works.find(w=>w.id===input.workId);ensure(snapshot&&w&&pristine(w)&&w.execution!=='budget-waiting','Only fresh Work can reserve monthly budget');if(input.expectedRevision!==undefined&&snapshot.revision!==input.expectedRevision)return {status:'conflict',reservation:null};
   const view=state&&state.value.limit!==null?await this.read():{knownOutputTokens:0,reserved:0,usageBounded:true},feed=await this.#store.readState(),at=this.#clock(),timezone=state?.value.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone;
   const inherited=old?.runId===input.runId&&old.inputHash===workInputHash(w)?old.decisionId:undefined;
   const entry:Omit<Reservation,'state'>={missionId:input.missionId,workId:input.workId,runId:input.runId,amount:input.amount,inputHash:workInputHash(w),revision:snapshot.revision,title:w.title,period:accountingPeriod(at,timezone),at,feedId:feed.feedId,...(input.selection?{selection:input.selection}:{}),...(inherited&&state?.value.decisions.some(d=>d.id===inherited&&d.state==='done')?{decisionId:inherited}:{})};
   const result=await this.#dispatch('monthly-reserve:'+hash([input,snapshot.revision]).slice(0,48),state?.revision??0,{type:'reserve-monthly-budget',entry,used:view.knownOutputTokens+view.reserved,available:view.usageBounded,...(!state?{timezone}:{})},HOST,at);
   if(result.status==='conflict')continue;const reservation=result.value.reservations.find(r=>r.missionId===input.missionId&&r.workId===input.workId)!;if(reservation.state==='waiting')await this.reconcile(await this.snapshot(()=>true));return {status:result.status==='replayed'?'replayed':reservation.state==='waiting'?'waiting':'reserved',reservation};
  }throw new DomainError('Monthly budget admission contention');
 }
 async reconcile(initial?:MonthlySnapshot,run?:(r:Reservation,revision:number)=>Promise<unknown>,ready?:(r:Reservation,revision:number)=>Promise<boolean>,admitting:()=>boolean=()=>initial?.admitting??false,only?:Pick<Reservation,'missionId'|'workId'|'runId'|'revision'>){
  let snapshot=initial??await this.snapshot(admitting);const attempted=new Set<string>(),errors:unknown[]=[];
  for(let step=0;step<8*((snapshot.budget?.value.reservations.length??0)+1);step++){
   const plans=reconcileMonthly(snapshot).filter(p=>p.kind!=='hold'&&(!only||p.reservation.missionId===only.missionId&&p.reservation.workId===only.workId&&p.reservation.runId===only.runId&&p.reservation.revision===only.revision)),plan=plans.find(p=>p.kind!=='run'||run&&!attempted.has(hash([p.reservation.missionId,p.reservation.workId,p.reservation.runId])));if(!plan)break;
   const r=plan.reservation,mission=plan.mission!,w=mission?.value.works.find(w=>w.id===r.workId);if(!w||!snapshot.budget)break;
   const observed=snapshot;
   try{if(plan.kind==='run'&&ready&&!await ready(r,mission.revision)){attempted.add(hash([r.missionId,r.workId,r.runId]));continue;}await withAdmissionFeed(snapshot.feedId,async()=>{
    if(plan.kind==='run'){attempted.add(hash([r.missionId,r.workId,r.runId]));await run!(r,mission.revision);return;}
    if(plan.kind==='pause'||plan.kind==='prepare'){
     await new Application(this.#store,[{id:plan.kind==='pause'?HOST:OWNER,roles:[plan.kind==='pause'?'representative':'owner']}]).dispatch({missionId:r.missionId,expectedRevision:mission.revision,commandId:'monthly-'+plan.kind+':'+hash([r,mission.revision,snapshot.budget!.revision]).slice(0,48),actorId:plan.kind==='pause'?HOST:OWNER,command:{type:plan.kind==='pause'?'wait-monthly-budget':'resume-monthly-budget',workId:r.workId,decisionId:plan.decisionId!}});return;
    }
    if(plan.kind==='release'&&pristine(w)){
     const fence=await new Application(this.#store,[{id:HOST,roles:['representative']}]).dispatch({missionId:r.missionId,expectedRevision:mission.revision,commandId:'monthly-fence:'+hash([r,mission.revision,snapshot.budget!.revision]).slice(0,48),actorId:HOST,command:{type:'fence-monthly-admission',workId:r.workId,inputHash:workInputHash(w)}});if(fence.status!=='committed')return;
    }
    await this.#dispatch('monthly-reconcile:'+hash([r,plan.kind,plan.usage??null,snapshot.budget!.revision]).slice(0,48),snapshot.budget!.revision,{type:'reconcile-monthly-budget',missionId:r.missionId,workId:r.workId,runId:r.runId,workRevision:r.revision,state:plan.kind==='settle'?'settled':'released',...(plan.kind==='settle'?{usage:plan.usage!}:{})},HOST);
   });}catch(error){errors.push(error);if(plan.kind==='run')attempted.add(hash([r.missionId,r.workId,r.runId]));}
   snapshot=await this.snapshot(admitting);
   if(snapshot.budget?.revision===observed.budget?.revision&&snapshot.missions.get(r.missionId)?.revision===mission.revision&&plan.kind!=='run'){if(errors.length)break;}
  }
  if(errors.length)throw errors[0];return snapshot;
 }
 async #dispatch(commandId:string,expectedRevision:number,command:BudgetCommand,actorId:string,at=this.#clock()):Promise<CommitResult<MonthlyBudgetState>>{
  const identity={id:MONTHLY_BUDGET_ID,commandId,fingerprint:hash({actorId,command,expectedRevision})},s=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
  if((s?.revision??0)!==expectedRevision)return {status:'conflict',revision:s?.revision??0,reason:'revision'};
  if(command.type==='decide-monthly-budget'&&command.answer==='act'){const d=s?.value.decisions.find(d=>d.id===command.decisionId);if(d&&command.limit!==proposalLimit(s!.value,d))throw new DomainError('Monthly limit must match the current reviewed proposal');}
  const {value,events}=applyMonthlyBudget(s?.value??null,command,{id:actorId,roles:[actorId===OWNER?'owner':'representative']},at,1),result=await this.#store.commit({...identity,expectedRevision,value,events,outbox:[]});
  if(result.status==='conflict'&&result.reason==='idempotency'){const saved=await this.#store.lookupOperation(identity);if(saved.status!=='unknown')return saved;}return result;
 }
}
