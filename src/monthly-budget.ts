import {Application} from './application.ts';
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Actor,Mission} from './domain.ts';
import {ASSISTANT_CONVERSATION_PREFIX} from './assistant-conversation.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';
import {teamCallCount} from './internal-teams.ts';
import {copy} from './ui-copy.ts';

export const MONTHLY_BUDGET_ID=ASSISTANT_CONVERSATION_PREFIX+'monthly-budget',BUDGET_DECISION_PREFIX='monthly-budget:';
const OWNER='local-owner',HOST='runtime-representative';
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const count=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
export function accountingPeriod(at:number,timezone:string):string {
 ensure(count(at),'Invalid accounting time');const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,calendar:'gregory',year:'numeric',month:'2-digit'}).formatToParts(at);
 return parts.find(p=>p.type==='year')!.value+'-'+parts.find(p=>p.type==='month')!.value;
}
interface Reservation {missionId:string;workId:string;runId:string;amount:number;inputHash:string;revision:number;title:string;period:string;at:number;state:'reserved'|'waiting'|'released';decisionId?:string}
interface BudgetDecision {id:string;period:string;at:number;state:'open'|'later'|'done';limit:number;nextLimit:number;actorId?:string}
export interface MonthlyBudgetState {kind:'monthly-budget';id:string;limit:number;timezone:string;actorId:string;reservations:Reservation[];decisions:BudgetDecision[]}
type BudgetCommand={type:'configure-monthly-budget';limit:number;timezone:string}|{type:'reserve-monthly-budget';entry:Omit<Reservation,'state'|'decisionId'>;used:number;available:boolean}|{type:'decide-monthly-budget';decisionId:string;answer:'act'|'later'|'ask';limit?:number};
export const isMonthlyBudgetState=(v:unknown):v is MonthlyBudgetState=>!!v&&typeof v==='object'&&(v as MonthlyBudgetState).kind==='monthly-budget';
export function applyMonthlyBudget(current:MonthlyBudgetState|null,command:BudgetCommand,actor:Actor,at:number){
 ensure(count(at)&&id(actor.id),'Invalid budget actor/time');const host=command.type==='reserve-monthly-budget';ensure(actor.id===(host?HOST:OWNER)&&actor.roles.includes(host?'representative':'owner'),'Budget authority denied');
 ensure(current!==null||command.type==='configure-monthly-budget','Configure a monthly budget first');
 let state=current?structuredClone(current):null;
 if(command.type==='configure-monthly-budget'){
  ensure(exact(command,['type','limit','timezone'])&&count(command.limit)&&typeof command.timezone==='string'&&command.timezone.length<=100,'Invalid monthly budget fields');try{accountingPeriod(at,command.timezone);}catch{throw new DomainError('Invalid accounting timezone');}
  ensure(!state||state.timezone===command.timezone,'Accounting timezone is already pinned');
  if(state){state.limit=command.limit;state.actorId=actor.id;for(const d of state.decisions)if(d.state!=='done'){d.limit=command.limit;d.nextLimit=Math.max(command.limit+1,command.limit+state.reservations.filter(r=>r.decisionId===d.id&&r.state==='waiting').reduce((sum,r)=>sum+r.amount,0));}}else state={kind:'monthly-budget',id:MONTHLY_BUDGET_ID,limit:command.limit,timezone:command.timezone,actorId:actor.id,reservations:[],decisions:[]};
 }else if(command.type==='reserve-monthly-budget'){
  const e=command.entry;ensure(exact(command,['type','entry','used','available'])&&exact(e,['missionId','workId','runId','amount','inputHash','revision','title','period','at'])&&[e.missionId,e.workId,e.runId].every(id)&&count(e.amount)&&e.amount>0&&/^[a-f0-9]{64}$/.test(e.inputHash)&&count(e.revision)&&e.revision>0&&typeof e.title==='string'&&e.title.length<=16000&&e.period===accountingPeriod(at,state!.timezone)&&e.at===at&&count(command.used)&&typeof command.available==='boolean','Invalid run reservation');
  const previous=state!.reservations.find(r=>r.missionId===e.missionId&&r.workId===e.workId);ensure(!previous||previous.state==='released','Work already has a monthly admission');ensure(state!.reservations.length<10000,'Monthly reservation bound reached');
  const ready=command.available&&command.used+e.amount<=state!.limit;
  const entry:Reservation={...structuredClone(e),state:ready?'reserved':'waiting'};
  if(!ready){let d=state!.decisions.find(d=>d.period===e.period&&d.state!=='done');if(!d){d={id:BUDGET_DECISION_PREFIX+e.period+':'+state!.decisions.length,period:e.period,at,state:'open',limit:state!.limit,nextLimit:state!.limit};state!.decisions.push(d);}entry.decisionId=d.id;d.nextLimit=Math.max(state!.limit+1,command.used+e.amount+state!.reservations.filter(r=>r.decisionId===d!.id&&r.state==='waiting').reduce((sum,r)=>sum+r.amount,0));}
  if(previous)state!.reservations[state!.reservations.indexOf(previous)]=entry;else state!.reservations.push(entry);
 }else{
  ensure(exact(command,['type','decisionId','answer',...(command.limit!==undefined?['limit']:[])])&&id(command.decisionId)&&['act','later','ask'].includes(command.answer),'Invalid budget decision');
  const d=state!.decisions.find(d=>d.id===command.decisionId);ensure(d,'Unknown budget decision');
  if(command.answer==='ask'){ensure(d.state==='later','Only a deferred budget decision can reopen');d.state='open';}
  else{ensure(d.state==='open','Only an open budget decision can be answered');if(command.answer==='later')d.state='later';else{ensure(count(command.limit)&&command.limit===d.nextLimit&&command.limit>state!.limit,'Monthly limit must increase to the reviewed limit');state!.limit=command.limit;state!.actorId=actor.id;d.state='done';for(const r of state!.reservations)if(r.decisionId===d.id&&r.state==='waiting')r.state='released';}d.actorId=actor.id;}
 }
 return {value:state!,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:{observedAt:at}}]};
}
export function replayMonthlyBudget(operation:Operation<MonthlyBudgetState>,prior?:Operation<MonthlyBudgetState>){
 const event=operation.events[0] as any;ensure(operation.aggregateId===MONTHLY_BUDGET_ID&&operation.value.id===MONTHLY_BUDGET_ID&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Monthly budget lineage mismatch');
 ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&exact(event.time,['observedAt'])&&event.type===event.command?.type,'Invalid monthly budget event');
 ensure(operation.fingerprint===hash({actorId:event.actor,command:event.command,expectedRevision:operation.expectedRevision}),'Monthly budget fingerprint mismatch');
 const derived=applyMonthlyBudget(prior?.value??null,event.command,{id:event.actor,roles:[event.actor===HOST?'representative':'owner']},event.time.observedAt);ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Monthly budget transition mismatch');
}
interface AccountWork {missionId:string;workId:string;title:string;memberId:string|null;runId?:string;at?:number;cap:number;consumed:number;unknown:boolean;terminal:boolean;pending:Set<string>}
export class MonthlyBudgetService {
 readonly #store:Store<any>;readonly #clock:()=>number;
 constructor(store:Store<any>,clock:()=>number=Date.now){this.#store=store;this.#clock=clock;}
 async #state(){return await this.#store.load(MONTHLY_BUDGET_ID) as Snapshot<MonthlyBudgetState>|null;}
 async #account(timezone:string,period:string){
  const position=await this.#store.readState(),works=new Map<string,AccountWork>(),turns=new Map<string,any>(),callTimes=new Map<string,number>(),calls=new Set<string>(),members=new Map<string|null,{inputTokens:number;outputTokens:number;unknown:boolean}>();let cursor=0,inputTokens=0,outputTokens=0,unknown=false;
  const add=(key:string,at:number|undefined,usage:any,memberId:string|null)=>{if(calls.has(key))return;calls.add(key);if(at===undefined){unknown=true;return;}if(accountingPeriod(at,timezone)!==period)return;const member=members.get(memberId)??{inputTokens:0,outputTokens:0,unknown:false};for(const unit of ['inputTokens','outputTokens'] as const){if(count(usage?.[unit])){if(unit==='inputTokens')inputTokens+=usage[unit];else outputTokens+=usage[unit];member[unit]+=usage[unit];}else{member.unknown=true;if(unit==='outputTokens')unknown=true;}}members.set(memberId,member);};
  // shortcut: scan the retained feed; add a durable usage index when the journal exceeds the bounded local workload.
  while(cursor<position.cursor){const page=await this.#store.readCatchup(cursor,position.feedId,1000);ensure(page.events.length>0,'Incomplete accounting feed');for(const batch of page.events){if(batch.cursor>position.cursor)break;cursor=batch.cursor;for(const raw of batch.events){const e=raw as any,c=e?.command;if(!c)continue;const key=batch.aggregateId+'\0'+c.workId;
   if(c.type==='admit-work')works.set(key,{missionId:batch.aggregateId,workId:c.workId,title:c.title,memberId:c.assistantSource?.memberId??null,cap:teamCallCount(c.team),consumed:0,unknown:false,terminal:false,pending:new Set()});
   const w=works.get(key);
   if(c.type==='activate-runtime'&&w){w.runId=c.run.id;w.at=c.run.ownership?.startedAt;w.cap*=c.run.outputTokenCap;}
   if(c.type==='claim-provider-dispatch'&&count(c.claim?.claimedAt))callTimes.set(key+'\0'+c.effectId,c.claim.claimedAt);
   if(c.type==='admit-effect'&&w)w.pending.add(c.effect.id);
   if(c.type==='receipt'&&w){w.pending.delete(c.effectId);let receipt;try{receipt=JSON.parse(c.receipt);}catch{}if(receipt?.provider&&receipt?.usage&&receipt.binding?.runId===w.runId){add(key+'\0'+c.effectId,callTimes.get(key+'\0'+c.effectId)??w.at,receipt.usage,w.memberId);if(count(receipt.usage.outputTokens))w.consumed+=receipt.usage.outputTokens;else w.unknown=true;}else if(c.outcome==='unknown')w.unknown=true;}
   if(w&&['accept','verify','cancel','block-work','expire-runtime','stop-owned-runtime','quarantine-runtime'].includes(c.type))w.terminal=true;
   if(['append-assistant-message','open-assistant-segment'].includes(c.type)&&c.turn?.ownership)turns.set(batch.aggregateId+'\0'+c.turn.id,c.turn);
   if(c.type==='settle-assistant-turn'){const t=turns.get(batch.aggregateId+'\0'+c.turnId);add(batch.aggregateId+'\0'+c.turnId,t?.ownership?.startedAt,c.usage,batch.aggregateId.includes(':member:')?batch.aggregateId.slice((ASSISTANT_CONVERSATION_PREFIX+'member:').length,batch.aggregateId.lastIndexOf(':')):null);}
  }} }
  const end=await this.#store.readState();ensure(end.feedId===position.feedId,'Accounting database changed');return {...position,inputTokens,outputTokens,unknown,members,works};
 }
 async read(){
  const before=await this.#store.readState(),s=await this.#state(),timezone=s?.value.timezone??Intl.DateTimeFormat().resolvedOptions().timeZone,period=accountingPeriod(this.#clock(),timezone),a=await this.#account(timezone,period);
  ensure(before.feedId===a.feedId,'Accounting database changed');
  let reserved=0;for(const r of s?.value.reservations??[]){if(r.state!=='reserved')continue;const w=a.works.get(r.missionId+'\0'+r.workId);if(w?.terminal&&!w.unknown&&!w.pending.size)continue;reserved+=Math.max(0,r.amount-(w?.consumed??0));}
  for(const w of a.works.values())if(w.runId&&(!w.terminal||w.unknown||w.pending.size)&&!s?.value.reservations.some(r=>r.missionId===w.missionId&&r.workId===w.workId))reserved+=Math.max(0,w.cap-w.consumed);
  const decisions=(s?.value.decisions??[]).map(d=>({id:d.id,at:d.at,title:copy('ui.budget.title'),question:copy('ui.budget.question'),rows:[[copy('ui.budget.now'),this.#amount(d.limit)],[copy('ui.budget.after'),this.#amount(d.nextLimit)],[copy('ui.budget.paused'),s!.value.reservations.filter(r=>r.decisionId===d.id&&r.state==='waiting').map(r=>r.title).join(' · ')]],action:copy('ui.budget.raise'),state:d.state,...(d.state==='done'?{line:copy('ui.budget.changed')}:{}),budget:{revision:s!.revision,limit:d.nextLimit}}));
  return {feedId:a.feedId,cursor:a.cursor,revision:s?.revision??0,period,timezone,unit:'output-tokens' as const,limit:s?.value.limit??null,spent:a.unknown?null:a.outputTokens,knownOutputTokens:a.outputTokens,inputTokens:a.inputTokens,cost:null,reserved,members:[...a.members].map(([memberId,v])=>({memberId,...v})),decisions};
 }
 #amount(n:number){return copy('ui.budget.tokens',{count:n.toLocaleString('ko-KR')});}
 async configure(input:unknown){ensure(exact(input,['commandId','expectedRevision','limit','timezone'])&&id(input.commandId)&&count(input.expectedRevision),'Exact monthly budget fields required');return this.#dispatch(input.commandId,input.expectedRevision,{type:'configure-monthly-budget',limit:input.limit,timezone:input.timezone},OWNER);}
 async decide(input:unknown){ensure(exact(input,['commandId','expectedRevision','decisionId','answer',...((input as any)?.answer==='act'?['limit']:[])])&&id(input.commandId)&&count(input.expectedRevision),'Exact monthly budget answer fields required');return this.#dispatch(input.commandId,input.expectedRevision,{type:'decide-monthly-budget',decisionId:input.decisionId,answer:input.answer,...(input.answer==='act'?{limit:input.limit}:{})},OWNER);}
 async admit(input:{missionId:string;workId:string;runId:string;amount:number}):Promise<'unmetered'|'reserved'|'waiting'|'replayed'> {
  for(let attempt=0;attempt<5;attempt++){
   const s=await this.#state();if(!s)return 'unmetered';
   const old=s.value.reservations.find(r=>r.missionId===input.missionId&&r.workId===input.workId);if(old){if(old.state==='waiting'){await this.#pause(old);return 'waiting';}if(old.state==='reserved')return 'replayed';}
   const view=await this.read(),snapshot=await this.#store.load(input.missionId) as Snapshot<Mission>|null,w=snapshot?.value.works.find(w=>w.id===input.workId);ensure(snapshot&&w&&!w.runtimeRun&&!w.effects.length&&!w.assignments.length&&w.acceptance==='pending'&&['queued','blocked'].includes(w.execution),'Only fresh Work can reserve monthly budget');
   const at=this.#clock(),entry={...input,inputHash:workInputHash(w),revision:snapshot.revision,title:w.title,period:accountingPeriod(at,s.value.timezone),at};
   const result=await this.#dispatch('monthly-reserve:'+hash(input).slice(0,48),s.revision,{type:'reserve-monthly-budget',entry,used:view.knownOutputTokens+view.reserved,available:view.spent!==null},HOST,at);
   if(result.status==='conflict')continue;if(result.status==='replayed')return 'replayed';const r=result.value.reservations.find(r=>r.missionId===input.missionId&&r.workId===input.workId)!;if(r.state==='waiting'){await this.#pause(r);return 'waiting';}return 'reserved';
  }throw new DomainError('Monthly budget admission contention');
 }
 async #pause(r:Reservation){
  for(let attempt=0;attempt<3;attempt++){
   const s=await this.#store.load(r.missionId) as Snapshot<Mission>|null,w=s?.value.works.find(w=>w.id===r.workId);if(w?.execution==='budget-waiting'&&w.monthlyBudgetDecision===r.decisionId)return;ensure(s&&w&&workInputHash(w)===r.inputHash,'Waiting Work input changed');
   const result=await new Application(this.#store,[{id:HOST,roles:['representative']}]).dispatch({missionId:r.missionId,expectedRevision:s.revision,commandId:'monthly-wait:'+hash([r.decisionId,r.missionId,r.workId]).slice(0,48),actorId:HOST,command:{type:'wait-monthly-budget',workId:r.workId,decisionId:r.decisionId!}});if(result.status!=='conflict')return;
  }throw new DomainError('Budget waiting admission contention');
 }
 async resume(decisionId:string,run:(r:Reservation,revision:number)=>Promise<unknown>){
  const state=await this.#state(),d=state?.value.decisions.find(d=>d.id===decisionId);ensure(d?.state==='done','An explicit budget increase is required');
  for(const r of state!.value.reservations.filter(r=>r.decisionId===decisionId&&r.state==='released')){
   const s=await this.#store.load(r.missionId) as Snapshot<Mission>|null,w=s?.value.works.find(w=>w.id===r.workId);if(!s||!w||w.execution!=='budget-waiting'||workInputHash(w)!==r.inputHash)continue;
   const result=await new Application(this.#store,[{id:OWNER,roles:['owner']}]).dispatch({missionId:r.missionId,expectedRevision:s.revision,commandId:'monthly-resume:'+hash([decisionId,r.missionId,r.workId]).slice(0,48),actorId:OWNER,command:{type:'resume-monthly-budget',workId:r.workId,decisionId}});
   if(result.status==='committed')await run(r,result.revision);
  }
 }
 async #dispatch(commandId:string,expectedRevision:number,command:BudgetCommand,actorId:string,at=this.#clock()):Promise<CommitResult<MonthlyBudgetState>>{
  const identity={id:MONTHLY_BUDGET_ID,commandId,fingerprint:hash({actorId,command,expectedRevision})},s=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
  if((s?.revision??0)!==expectedRevision)return {status:'conflict',revision:s?.revision??0,reason:'revision'};
  const {value,events}=applyMonthlyBudget(s?.value??null,command,{id:actorId,roles:[actorId===OWNER?'owner':'representative']},at),result=await this.#store.commit({...identity,expectedRevision,value,events,outbox:[]});
  if(result.status==='conflict'&&result.reason==='idempotency'){const saved=await this.#store.lookupOperation(identity);if(saved.status!=='unknown')return saved;}return result;
 }
}
