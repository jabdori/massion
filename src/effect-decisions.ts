import {apply,DomainError,hash,workInputHash} from './domain.ts';
import {validatePaymentIntent,paymentAmount} from './payment-intent.ts';
import type {PaymentIntent} from './payment-intent.ts';
import type {Actor,Effect,Mission,Work} from './domain.ts';
import {FeedAdmissionError} from './storage.ts';
import type {CommitResult,Store} from './storage.ts';
import type {TimeObservation} from './memory-expiry.ts';
import {requireAnswered} from './work-clarification.ts';
import {teamTaskReady} from './internal-teams.ts';
import {bindPrerequisiteRecords} from './work-prerequisites.ts';
import {callTool,TOOL_TIMEOUT_MS} from './tool-call.ts';
import {HostDrainError} from './runtime-lifetime.ts';

export class EffectAdmissionRejectedError extends Error {readonly code:DomainError['code'];constructor(error:DomainError){super(error.message);this.code=error.code;}}

export const EFFECT_DECISION_PREFIX='effect-decision:',EFFECT_HOST='effect-decision-host',EFFECT_COMMAND_PREFIX='assistant-effect:';
export interface PaymentRequest {kind:'payment';adapterId:string;checkoutId:string;item:string;quantity:number;subtotal:number;shipping:number;total:number;currency:'KRW';merchant:string;origin:string;destination:string;method:string;expiresAt:number;cancellation:string;pagesRead:number;startedAt:number}
export interface ExternalMemberRequest {kind:'external-member';adapterId:string;deviceId:string;deviceName:string;agentId:string;agentName:string;instruction:string;scope:string;repository?:{name:string;tests:string[]}}
export type OwnerEffectRequest=PaymentRequest|ExternalMemberRequest|PaymentIntent;
export type EffectAnswer='act'|'later'|'ask'|'reject';
export interface EffectReceipt {idempotencyKey:string;remoteId:string;outcome:'succeeded'|'failed'|'received';detail:string}
export interface OwnerEffectDecision {stepId:string;at:number;request:OwnerEffectRequest;requestHash:string;inputHash:string;state:'open'|'later'|'approved'|'rejected';answers:{answer:EffectAnswer;actorId:string;at:number;requestHash?:string}[];dispatch?:{idempotencyKey:string;feedId:string;at:number};receipt?:EffectReceipt;settledAt?:number}
export type EffectDecisionCommand=
 | {type:'propose-owner-effect';workId:string;taskId:string;stepId:string;effectId:string;request:OwnerEffectRequest}
 | {type:'answer-owner-effect';workId:string;effectId:string;answer:EffectAnswer;requestHash?:string}
 | {type:'dispatch-owner-effect';workId:string;effectId:string;feedId:string}
 | {type:'record-owner-effect';workId:string;effectId:string;receipt:EffectReceipt|null};
export const isEffectDecisionCommand=(type:string)=>['propose-owner-effect','answer-owner-effect','dispatch-owner-effect','record-owner-effect'].includes(type);
export const effectDecisionId=(missionId:string,workId:string,stepId:string)=>EFFECT_DECISION_PREFIX+hash([missionId,workId,stepId]).slice(0,32);
function ensure(v:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
function exact(v:unknown,keys:string[]):asserts v is Record<string,any> {ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)),'Exact effect fields required');}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=2000&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;
export function validateEffectRequest(r:OwnerEffectRequest):void {
 ensure(r&&typeof r==='object','Effect request required');
 if(r.kind==='payment-intent'){validatePaymentIntent(r);return;}
 if(r.kind==='payment'){
  exact(r,['kind','adapterId','checkoutId','item','quantity','subtotal','shipping','total','currency','merchant','origin','destination','method','expiresAt','cancellation','pagesRead','startedAt']);
  ensure(id(r.adapterId)&&id(r.checkoutId)&&[r.item,r.merchant,r.destination,r.method,r.cancellation].every(line),'Invalid checkout fields');
  ensure([r.quantity,r.subtotal,r.shipping,r.total,r.expiresAt,r.pagesRead,r.startedAt].every(integer)&&r.quantity>0&&r.total>0&&r.total===r.subtotal+r.shipping&&r.currency==='KRW'&&r.expiresAt>r.startedAt,'Invalid payment amounts or expiry');
  let origin:URL;try{origin=new URL(r.origin);}catch{throw new DomainError('Invalid checkout origin');}ensure(origin.protocol==='https:'&&origin.origin===r.origin&&!origin.username&&!origin.password,'Exact HTTPS checkout origin required');
 }else{
  exact(r,['kind','adapterId','deviceId','deviceName','agentId','agentName','instruction','scope',...(Object.hasOwn(r,'repository')?['repository']:[])]);
  if(Object.hasOwn(r,'repository')){exact(r.repository,['name','tests']);ensure(line(r.repository.name)&&Array.isArray(r.repository.tests)&&r.repository.tests.length<=32&&r.repository.tests.every(line)&&new Set(r.repository.tests).size===r.repository.tests.length,'Invalid transmitted repository fields');}
  ensure(r.kind==='external-member'&&[r.adapterId,r.deviceId,r.agentId].every(id)&&[r.deviceName,r.agentName,r.instruction,r.scope].every(line),'Invalid external member request');
 }
}
function validateReceipt(r:EffectReceipt,d:OwnerEffectDecision){
 exact(r,['idempotencyKey','remoteId','outcome','detail']);ensure(d.dispatch&&r.idempotencyKey===d.dispatch.idempotencyKey&&line(r.remoteId)&&line(r.detail)&&['succeeded','failed',...(d.request.kind==='external-member'?['received']:[])].includes(r.outcome),'Receipt must match the original transmission');
}
export function validateOwnerEffect(e:Effect,interrupted=false){
 const d=e.ownerDecision;if(!d)return;
 exact(d,['stepId','at','request','requestHash','inputHash','state','answers',...(d.dispatch?['dispatch']:[]),...(d.receipt?['receipt']:[]),...(d.settledAt!==undefined?['settledAt']:[])]);validateEffectRequest(d.request);
 ensure(id(d.stepId)&&integer(d.at)&&d.requestHash===hash(d.request)&&/^[a-f0-9]{64}$/.test(d.inputHash)&&['open','later','approved','rejected'].includes(d.state)&&Array.isArray(d.answers)&&d.answers.length<=64,'Invalid owner effect decision');
 let state:OwnerEffectDecision['state']='open',at=d.at;
 for(const a of d.answers){exact(a,['answer','actorId','at',...(d.request.kind==='payment-intent'?['requestHash']:[])]);if(d.request.kind==='payment-intent')ensure(a.requestHash===d.requestHash,'Payment intent answer hash mismatch');ensure(a.actorId==='local-owner'&&integer(a.at)&&a.at>=at&&(a.answer==='ask'?state==='later':state==='open'),'Invalid owner answer history');state=a.answer==='ask'?'open':a.answer==='later'?'later':a.answer==='act'?'approved':a.answer==='reject'?'rejected':(()=>{throw new DomainError('Invalid answer');})();at=a.at;}
 ensure(state===d.state,'Owner decision history mismatch');
 if(d.request.kind==='payment-intent')ensure(!d.dispatch&&!d.receipt&&d.settledAt===undefined,'Payment intents are never executed');
 if(d.dispatch){exact(d.dispatch,['idempotencyKey','feedId','at']);ensure(state==='approved'&&id(d.dispatch.feedId)&&/^[a-f0-9]{64}$/.test(d.dispatch.idempotencyKey)&&integer(d.dispatch.at)&&d.dispatch.at>=at,'Invalid original dispatch');}
 if(d.settledAt!==undefined)ensure(d.dispatch&&integer(d.settledAt)&&d.settledAt>=d.dispatch.at,'Invalid receipt observation');
 if(d.receipt){ensure(d.settledAt!==undefined,'Receipt observation required');validateReceipt(d.receipt,d);}
 ensure(d.dispatch?e.status===(d.receipt&&d.receipt.outcome!=='received'?d.receipt.outcome:'unknown'):e.status===(state==='rejected'?'failed':interrupted?'unknown':'pending'),'Owner effect status mismatch');
}
function current(w:Work,d:OwnerEffectDecision,at:number){
 ensure(w.execution!=='cancelled'&&w.acceptance==='pending'&&!w.runtimeInterruption&&!w.runtimeRecovery&&!w.blocker,'Work no longer permits this effect','conflict');
 ensure(d.request.kind==='payment-intent'||!w.runtimeRun?.ownership||at<w.runtimeRun.ownership.deadlineAt,'Work deadline expired','conflict');
 ensure(d.inputHash===workInputHash(w),'Work input changed before effect admission','conflict');
 ensure(d.request.kind!=='payment'||at<d.request.expiresAt,'Checkout expired','conflict');requireAnswered(w);
}
export function applyEffectDecision(mission:Mission,c:EffectDecisionCommand,actor:Actor,time?:TimeObservation){
 exact(time,['observedAt']);ensure(integer(time.observedAt),'Host effect clock required');const at=time.observedAt,w=mission.works.find(w=>w.id===c.workId);ensure(w,'Unknown Work');
 ensure(actor.id===(c.type==='answer-owner-effect'?'local-owner':EFFECT_HOST)&&actor.roles.includes(c.type==='answer-owner-effect'?'owner':'representative'),'Actor lacks effect authority','denied');
 if(c.type==='propose-owner-effect'){
  exact(c,['type','workId','taskId','stepId','effectId','request']);validateEffectRequest(c.request);ensure(id(c.stepId)&&c.effectId===effectDecisionId(mission.id,w.id,c.stepId),'Invalid effect identity');
  ensure(!w.effects.some(e=>e.id===c.effectId),'Effect step already proposed; never resend','conflict');ensure(w.effects.length<128&&!w.effects.some(e=>e.status==='pending'||e.status==='unknown'),'Unresolved effect blocks a new proposal','conflict');
  ensure(['queued','active'].includes(w.execution),'Work is not progressing','conflict');const task=w.tasks.find(t=>t.id===c.taskId);ensure(task&&task.status!=='settled'&&w.assignments.some(a=>a.taskId===task.id&&a.role==='executor')&&(!task.step||teamTaskReady(w,task)),'Task is not ready');
  const d:OwnerEffectDecision={stepId:c.stepId,at,request:structuredClone(c.request),requestHash:hash(c.request),inputHash:workInputHash(w),state:'open',answers:[]};current(w,d,at);
  ensure(c.request.kind!=='payment'||c.request.startedAt<=at,'Browser observation is in the future');
  bindPrerequisiteRecords(mission,w);task.status='active';w.attempts.at(-1)!.status='active';
  w.effects.push({id:c.effectId,taskId:c.taskId,status:'pending',target:c.request.kind==='external-member'?c.request.agentName:'결제 요청',authority:'owner-decision',ownerDecision:d});w.execution='waiting';return;
 }
 const e=w.effects.find(e=>e.id===c.effectId);ensure(e?.ownerDecision,'Unknown effect decision');const d=e.ownerDecision;validateOwnerEffect(e);ensure(at>=(d.dispatch?.at??d.answers.at(-1)?.at??d.at),'Host effect clock moved backwards');
 switch(c.type){
  case 'answer-owner-effect':{
   exact(c,['type','workId','effectId','answer',...(d.request.kind==='payment-intent'?['requestHash']:[])]);if(d.request.kind==='payment-intent')ensure(c.requestHash===d.requestHash,'Payment intent hash changed','conflict');ensure(['act','later','ask','reject'].includes(c.answer),'Invalid effect answer');ensure(d.answers.length<64,'Decision history bound reached');
   ensure(c.answer==='ask'?d.state==='later':d.state==='open','Only an open decision can be answered','conflict');ensure(w.execution==='waiting'&&!w.runtimeRecovery&&!w.runtimeInterruption,'Work no longer awaits this decision','conflict');
   if(c.answer==='act')current(w,d,at);d.answers.push({answer:c.answer,actorId:actor.id,at,...(d.request.kind==='payment-intent'?{requestHash:d.requestHash}:{})});d.state=c.answer==='ask'?'open':c.answer==='later'?'later':c.answer==='act'?'approved':'rejected';
   if(c.answer==='reject'){e.status='failed';e.receipt='Owner rejected before dispatch';}break;
  }
  case 'dispatch-owner-effect':{
   ensure(d.request.kind!=='payment-intent','Payment intents are never executed');
   exact(c,['type','workId','effectId','feedId']);ensure(id(c.feedId),'Invalid feed identity');ensure(d.state==='approved'&&!d.dispatch&&e.status==='pending','Effect already claimed; never resend','conflict');current(w,d,at);ensure(w.execution==='waiting','Work no longer awaits this dispatch','conflict');
   d.dispatch={idempotencyKey:hash([c.feedId,mission.id,w.id,e.id,d.requestHash]),feedId:c.feedId,at};e.status='unknown';e.receipt='응답 없음 · 다시 보내지 않음';w.execution='blocked';break;
  }
  case 'record-owner-effect':{
   ensure(d.request.kind!=='payment-intent','Payment intents are never executed');
   exact(c,['type','workId','effectId','receipt']);ensure(!w.runtimeRecovery&&!w.runtimeInterruption&&d.dispatch&&d.settledAt===undefined&&e.status==='unknown','Only the original uncertain dispatch accepts its receipt','conflict');d.settledAt=at;
   if(c.receipt){validateReceipt(c.receipt,d);d.receipt=structuredClone(c.receipt);e.status=c.receipt.outcome==='received'?'unknown':c.receipt.outcome;e.receipt=c.receipt.detail;}
   if(e.status!=='unknown'&&w.execution==='blocked'&&!w.blocker&&!w.runtimeRecovery&&!w.runtimeInterruption&&!w.effects.some(e=>e.status==='unknown'||e.status==='pending'))w.execution='active';break;
  }
 }
 validateOwnerEffect(e);
}

export interface EffectAdapter {id:string;kind:'payment'|'external-member';send(input:{idempotencyKey:string;request:PaymentRequest|ExternalMemberRequest;signal:AbortSignal}):Promise<EffectReceipt>}
interface DecisionView {id:string;at:number;answeredAt?:number;title:string;question:string;rows:string[][];action:string;state:string;line:string;effect:{kind:OwnerEffectRequest['kind'];missionId:string;workId:string;effectId:string;status:Effect['status'];request:OwnerEffectRequest;requestHash?:string;claimedAt?:number;receipt?:EffectReceipt;answer?:EffectAnswer}}
type Proposal={missionId:string;workId:string;taskId:string;stepId:string;request:OwnerEffectRequest};
export class EffectDecisionsService {
 readonly #store:Store<Mission>;readonly #owner:Store<Mission>;readonly #intake:()=>string|undefined;readonly #clock:()=>number;readonly #timeout:number;readonly #adapters:EffectAdapter[];readonly #active=new Set<Promise<unknown>>();readonly #controllers=new Set<AbortController>();#draining=false;unsettled=false;
 constructor(store:Store<Mission>,ownerStore:Store<Mission>,intake:()=>string|undefined,options:{adapters?:EffectAdapter[];clock?:()=>number;timeoutMs?:number}={}){this.#store=store;this.#owner=ownerStore;this.#intake=intake;this.#clock=options.clock??Date.now;this.#timeout=options.timeoutMs??TOOL_TIMEOUT_MS;ensure(integer(this.#timeout)&&this.#timeout>0&&this.#timeout<=TOOL_TIMEOUT_MS,'Invalid effect timeout');this.#adapters=options.adapters??[];ensure(new Set(this.#adapters.map(a=>a.id)).size===this.#adapters.length,'Duplicate effect adapter');}
 async propose(input:Proposal):Promise<CommitResult<Mission>>{
  input=structuredClone(input);exact(input,['missionId','workId','taskId','stepId','request']);ensure([input.missionId,input.workId,input.taskId,input.stepId].every(id)&&input.missionId===this.#intake(),'Exact intake Work required');
  const effectId=effectDecisionId(input.missionId,input.workId,input.stepId),{missionId,...proposal}=input;
  return this.#dispatch(missionId,EFFECT_COMMAND_PREFIX+'propose:'+effectId.slice(EFFECT_DECISION_PREFIX.length),{type:'propose-owner-effect',...proposal,effectId},false);
 }
 async decide(input:unknown):Promise<CommitResult<Mission>>{
  exact(input,['commandId','decisionId','answer',...(input&&typeof input==='object'&&Object.hasOwn(input,'requestHash')?['requestHash']:[])]);ensure(id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.decisionId)&&['act','later','ask','reject'].includes(input.answer),'Exact decision answer required');
  const {commandId,decisionId,answer}=structuredClone(input) as {commandId:string;decisionId:string;answer:EffectAnswer},missionId=this.#intake();ensure(missionId,'Intake Mission unavailable');const snapshot=await this.#store.load(missionId),w=snapshot?.value.works.find(w=>w.effects.some(e=>e.id===decisionId&&e.ownerDecision));ensure(w,'Unknown effect decision');
  const d=w.effects.find(e=>e.id===decisionId)!.ownerDecision!;ensure(answer!=='reject'||d.request.kind==='payment-intent','Exact decision answer required');
  if(d.request.kind==='payment-intent')ensure(typeof input.requestHash==='string'&&/^[a-f0-9]{64}$/.test(input.requestHash),'Payment intent hash required');
  const c:EffectDecisionCommand={type:'answer-owner-effect',workId:w.id,effectId:decisionId,answer,...(Object.hasOwn(input,'requestHash')?{requestHash:input.requestHash}:{})};
  let result:CommitResult<Mission>;try{result=await this.#dispatch(missionId,commandId,c,true);}catch(error){if(error instanceof DomainError)throw new EffectAdmissionRejectedError(error);throw error;}
  if(result.status==='committed'&&answer==='act'&&d.request.kind!=='payment-intent'){
   const task=this.#invoke(missionId,w.id,decisionId);this.#active.add(task);try{await task;}finally{this.#active.delete(task);}
  }
  return result;
 }
 async #invoke(missionId:string,workId:string,effectId:string){
  const original=(await this.#store.load(missionId))?.value.works.find(w=>w.id===workId)?.effects.find(e=>e.id===effectId)?.ownerDecision;ensure(original,'Unknown effect decision');if(this.#draining)throw new HostDrainError();
  const request=original.request;if(request.kind==='payment-intent')return;
  const adapter=this.#adapters.find(a=>a.id===request.adapterId&&a.kind===request.kind);if(!adapter)return;
  const feedId=(await this.#store.readState()).feedId,base=EFFECT_COMMAND_PREFIX+effectId.slice(EFFECT_DECISION_PREFIX.length);
  const claim=await this.#dispatch(missionId,base+':dispatch',{type:'dispatch-owner-effect',workId,effectId,feedId},false);
  if(claim.status!=='committed')return;
  const d=claim.value.works.find(w=>w.id===workId)!.effects.find(e=>e.id===effectId)!.ownerDecision!,controller=new AbortController();this.#controllers.add(controller);if(this.#draining)controller.abort();let receipt:EffectReceipt|null=null;
  try{
   ensure(d.request.kind!=='payment-intent','Payment intents are never executed');const request=d.request;
   const received=await callTool(signal=>adapter.send({idempotencyKey:d.dispatch!.idempotencyKey,request:structuredClone(request),signal}),{signal:controller.signal,timeoutMs:this.#timeout});validateReceipt(received,d);receipt=structuredClone(received);
  }catch{controller.abort();}finally{this.#controllers.delete(controller);}
  try{const settled=await this.#dispatch(missionId,base+':receipt',{type:'record-owner-effect',workId,effectId,receipt},false,true);if(settled.status!=='committed'&&settled.status!=='replayed')this.unsettled=true;}catch{this.unsettled=true;}
 }
 beginDrain(){this.#draining=true;for(const c of this.#controllers)c.abort();}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#active]);if(this.unsettled)throw new Error('Effect bookkeeping is unsettled');}
 async #dispatch(missionId:string,commandId:string,command:EffectDecisionCommand,owner:boolean,settling=false):Promise<CommitResult<Mission>>{
  const actor:Actor={id:owner?'local-owner':EFFECT_HOST,roles:[owner?'owner':'representative']},identity={id:missionId,commandId,fingerprint:hash({actorId:actor.id,command})},store=settling?this.#store:this.#owner;
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await store.load(missionId),prior=await store.lookupOperation(identity);if(prior.status!=='unknown'){ensure(prior.status!=='conflict'||prior.reason!=='idempotency','Command identity conflict','conflict');return prior;}ensure(snapshot,'Unknown Mission');
   const {value,events}=apply(snapshot.value,command,actor,{observedAt:this.#clock()});
   if(command.type==='answer-owner-effect'&&command.answer==='act'){const r=value.works.find(w=>w.id===command.workId)!.effects.find(e=>e.id===command.effectId)!.ownerDecision!.request;ensure(r.kind==='payment-intent'||this.#adapters.some(a=>a.id===r.adapterId&&a.kind===r.kind),'Effect adapter unavailable','denied');}
   if(!settling&&this.#draining)throw new HostDrainError();let result:CommitResult<Mission>;try{result=await store.commit({...identity,expectedRevision:snapshot.revision,value,events,outbox:[]});}catch(error){if(error instanceof Error&&error.name==='CommitOutcomeUnknownError')this.unsettled=true;throw error;}if(result.status!=='conflict')return result;
  }
  return {status:'conflict',revision:(await store.load(missionId))?.revision??0,reason:'revision'};
 }
 async decisions(expectedFeed?:string){
  const {copy}=await import('./ui-copy.ts');
  const missionId=this.#intake(),read=await this.#store.readState(missionId);if(expectedFeed!==undefined&&read.feedId!==expectedFeed)throw new FeedAdmissionError();const snapshot=read.snapshot;if(!snapshot)return [];
  return snapshot.value.works.flatMap(w=>w.effects.flatMap((e):DecisionView[]=>{
   const d=e.ownerDecision;if(!d)return [];const r=d.request;
   if(r.kind==='payment-intent'){
    validateOwnerEffect(e,!!w.runtimeInterruption||!!w.runtimeRecovery);const amount=paymentAmount(r),state=d.state==='open'?'open':d.state==='later'?'later':'done',answer=state==='done'?d.answers.at(-1):undefined,kind=r.sourceReference.split(':',1)[0]!,source=copy('ui.payment-intent.source-'+(['document','record','work'].includes(kind)?kind:['http','https'].includes(kind)?'web':'reference'));
    const line=copy(d.state==='approved'?'ui.payment-intent.approved':d.state==='rejected'?'ui.payment-intent.declined':'ui.effect.waiting');
    return [{id:e.id,at:answer?.at??d.at,...(answer?{answeredAt:answer.at}:{}),title:w.title,question:copy('ui.payment-intent.question',{amount}),rows:[[copy('ui.payment-intent.payee'),r.payee],[copy('ui.effect.payment.amount'),amount],[copy('ui.payment-intent.purpose'),r.purpose],[copy('ui.panel.source'),source]],action:copy('ui.payment-intent.approve'),state,line:answer?copy('ui.payment-intent.decision-line',{payee:r.payee,amount,state:line}):line,effect:{kind:r.kind,missionId:snapshot.value.id,workId:w.id,effectId:e.id,status:e.status,request:structuredClone(r),requestHash:d.requestHash,...(d.answers.length?{answer:d.answers.at(-1)!.answer}:{})}}];
   }
   const payment=r.kind==='payment',money=(n:number)=>copy('ui.effect.money',{amount:n.toLocaleString('ko-KR')}),who=payment?'':copy('ui.effect.external.who',{device:r.deviceName,agent:r.agentName}),time=(at:number)=>new Date(at).toLocaleTimeString('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false});
   const question=payment?copy('ui.effect.payment.question',{amount:money(r.total)}):copy('ui.effect.external.question',{who}),state=d.state==='open'?'open':d.state==='later'?'later':'done';
   const sentenceCount=payment?0:[...new Intl.Segmenter('ko',{granularity:'sentence'}).segment(r.instruction)].filter(s=>s.segment.trim()).length,requestSummary=copy(sentenceCount===1?'ui.effect.external.request-one':'ui.effect.external.request-many',sentenceCount===1?{}:{count:sentenceCount});
   const rows=payment?[[copy('ui.effect.payment.item'),r.item],[copy('ui.effect.payment.merchant'),r.merchant+' · '+new URL(r.origin).hostname],[copy('ui.effect.payment.amount'),copy('ui.effect.payment.total-method',{amount:money(r.total),method:r.method})],[copy('ui.effect.payment.expiry'),copy('ui.effect.payment.until',{time:time(r.expiresAt)})],[copy('conversation.link.25'),r.cancellation]]:[[copy('ui.effect.external.destination'),copy('ui.effect.external.target',{agent:r.agentName,device:r.deviceName})],[copy('ui.effect.external.content'),r.repository?copy('ui.effect.external.payload',{request:requestSummary,repository:r.repository.name,count:r.repository.tests.length}):copy('ui.effect.external.payload-scope',{request:requestSummary,scope:r.scope})],[copy('ui.effect.external.excluded'),copy('ui.effect.external.excluded-value')],[copy('ui.effect.external.caution'),copy('ui.effect.external.irreversible')]];
   const line=d.state==='later'?(payment?copy('ui.effect.payment.action',{amount:money(r.total)}):copy('ui.effect.external.later',{who})):d.state==='rejected'?copy('ui.effect.rejected'):d.dispatch?(payment?copy(e.status==='succeeded'?'ui.effect.payment.paid':e.status==='failed'?'ui.effect.payment.failed':'ui.effect.unknown'):d.receipt?.outcome==='received'?copy('ui.effect.external.sent',{who,time:time(d.dispatch.at)}):copy(d.receipt?.outcome==='succeeded'?'ui.effect.external.replied':d.receipt?.outcome==='failed'?'ui.effect.external.failed':'ui.effect.unknown')):copy('ui.effect.waiting');
   return [{id:e.id,at:d.at,title:w.title,question,rows,action:payment?copy('ui.effect.payment.action',{amount:money(r.total)}):copy('conversation.button.08'),state,line,effect:{kind:r.kind,missionId:snapshot.value.id,workId:w.id,effectId:e.id,status:e.status,request:structuredClone(r),...(d.dispatch?{claimedAt:d.dispatch.at}:{}),...(d.receipt?{receipt:structuredClone(d.receipt)}:{}),...(d.answers.length?{answer:d.answers.at(-1)!.answer}:{})}}];
  }));
 }
}
