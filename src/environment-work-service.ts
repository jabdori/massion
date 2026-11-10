import {copy} from './ui-copy.ts';
import {paymentAmount} from './payment-intent.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {DomainError,hash,workInputHash} from './domain.ts';
import type {Mission,Work} from './domain.ts';
import {FeedAdmissionError} from './storage.ts';
import type {Store,CommitResult} from './storage.ts';
import {currentOwnership} from './runtime-continuation.ts';
import {HostDrainError,RunDeadlineError} from './runtime-lifetime.ts';
import {EnvironmentActions} from './environment-actions.ts';
import type {EnvironmentEntry} from './environment-actions.ts';
import {environmentFields as exact,environmentId as id} from './environment.ts';
import type {EnvironmentAdapter,EnvironmentBinding} from './environment.ts';
import {BrowserSessions} from './browser-runtime.ts';
import type {RawBrowserPage} from './browser-runtime.ts';
import type {BrowserEnvironmentConfig} from './browser-environment.ts';
import {openBrowserEnvironment} from './headless-browser.ts';
import {SecretRequestsService} from './secret-requests-service.ts';
import {requestSecretSlot} from './secret-requests.ts';
import {environmentSecretDeclaration,parseEnvironmentWorkPlan,validateEnvironmentWorkDefinitions} from './environment-work.ts';
import type {EnvironmentWorkDefinition,EnvironmentWorkPlan} from './environment-work.ts';
import {environmentIntentApprovals,environmentStepResult,environmentWorkEffectId} from './environment-work-state.ts';
import type {RuntimeEnvironmentBinding,EnvironmentWorkCommand,EnvironmentWorkUpdate} from './environment-work-state.ts';

export const ENVIRONMENT_DECISION_PREFIX='environment-decision:';
export interface EnvironmentWorkContext {missionId:string;workId:string;taskId:string;inputHash:string;dispatchId:string;signal:AbortSignal;record:(command:EnvironmentWorkCommand,commandId:string)=>Promise<CommitResult<Mission>>;receipt:(effectId:string,outcome:'succeeded'|'unknown',receipt:string)=>Promise<unknown>}
interface OwnedBrowser extends EnvironmentAdapter {observedPage(binding:EnvironmentBinding):RawBrowserPage;close():Promise<void>}
interface Options {definitions:EnvironmentWorkDefinition[];secrets:SecretRequestsService;intake:()=>string|undefined;open?:(config:BrowserEnvironmentConfig,address:string,signal:AbortSignal)=>Promise<OwnedBrowser>}
interface Session {binding:RuntimeEnvironmentBinding;context:EnvironmentWorkContext;browser:OwnedBrowser;actions:EnvironmentActions;guarded:Store<Mission>}
function ensure(v:unknown,message='Environment Work is unavailable'):asserts v {if(!v)throw new DomainError(message,'conflict');}
const key=(missionId:string,workId:string)=>JSON.stringify([missionId,workId]);
const reference=(e:EnvironmentEntry)=>({id:e.id,hash:e.hash,at:e.at,deadline:e.deadline});
const decisionId=(missionId:string,workId:string,entryId:string)=>ENVIRONMENT_DECISION_PREFIX+hash([missionId,workId,entryId]).slice(0,40);
export class EnvironmentWorkService {
 readonly #store:Store<Mission>;readonly #owner:Store<Mission>;readonly #options:Options;readonly #sessions=new Map<string,Session>();readonly #jobs=new Map<string,{hash:string;promise:Promise<string>}>();readonly #stop=new AbortController();
 constructor(store:Store<Mission>,ownerStore:Store<Mission>,options:Options){validateEnvironmentWorkDefinitions(options.definitions);this.#store=store;this.#owner=ownerStore;this.#options={...options,definitions:structuredClone(options.definitions)};}
 configHash(){return this.#options.definitions.length?hash(this.#options.definitions):undefined;}
 async bind(missionId:string,work:Work,runId:string):Promise<RuntimeEnvironmentBinding|undefined>{const definition=this.#options.definitions.find(d=>d.memberId===work.team?.memberId);if(!definition)return;const {feedId}=await this.#store.readState(missionId);return {id:'environment:'+hash([feedId,missionId,work.id,runId]).slice(0,40),feedId,definition:structuredClone(definition)};}
 catalog(work:Work){const b=work.runtimeRun?.environment;if(!b)return;const d=b.definition;return {elements:d.elements.filter(e=>!e.ownerOnly).map(e=>({id:e.id,label:e.label,operations:e.operations})),facts:d.facts.map(({id,label,kind})=>({id,label,kind})),waits:d.waits.map(w=>({id:w.id,kind:w.request.kind,what:w.request.what})),secretSlots:d.secrets.flatMap(s=>s.fields.map(f=>({element:f.element,owner:'local-owner',slot:f.slot}))),page:work.browserSession?.pages.at(-1),paymentIntents:environmentIntentApprovals(work).map(({intent,at})=>({intent,at,status:'approved-not-executed'})),observations:work.tasks.flatMap(t=>(t.environment?.records??[]).flatMap(r=>r.kind==='observed'?[r.observation.facts]:[]))};}
 async #current(c:EnvironmentWorkContext,b:RuntimeEnvironmentBinding,secretWait=false){
  this.#stop.signal.throwIfAborted();c.signal.throwIfAborted();const read=await this.#store.readState(c.missionId);this.#stop.signal.throwIfAborted();c.signal.throwIfAborted();if(read.feedId!==b.feedId)throw new FeedAdmissionError();
  const w=read.snapshot?.value.works.find(w=>w.id===c.workId),o=w&&currentOwnership(w);ensure(w&&o&&hash(w.runtimeRun?.environment)===hash(b)&&o.dispatchId===c.dispatchId&&workInputHash(w)===c.inputHash);
  if(Date.now()>=o.deadlineAt)throw new RunDeadlineError();ensure(w.acceptance==='pending'&&!w.runtimeInterruption&&!w.runtimeRecovery&&!w.blocker&&!w.monthlyBudgetDecision&&(['active','queued','waiting'].includes(w.execution)||secretWait&&w.execution==='blocked'&&w.secretRequests?.some(r=>r.state!=='provided')));return {read,work:w};
 }
 #guard(c:EnvironmentWorkContext,b:RuntimeEnvironmentBinding){const service=this;return new Proxy(this.#owner,{get(target,p){if(p==='commit')return async(input:Parameters<typeof target.commit>[0])=>{await service.#current(c,b);c.signal.throwIfAborted();return target.commit(input);};const v=Reflect.get(target,p);return typeof v==='function'?v.bind(target):v;}});}
 execute(context:EnvironmentWorkContext,plan:EnvironmentWorkPlan):Promise<string>{
  plan=structuredClone(plan);const k=key(context.missionId,context.workId)+':'+context.taskId,identity=hash({plan,inputHash:context.inputHash,dispatchId:context.dispatchId}),prior=this.#jobs.get(k);if(prior){ensure(prior.hash===identity,'Environment step identity changed');return prior.promise;}
  const promise=this.#execute(context,plan);this.#jobs.set(k,{hash:identity,promise});return promise;
 }
 async #execute(c:EnvironmentWorkContext,plan:EnvironmentWorkPlan){
  const w=(await this.#store.load(c.missionId))?.value.works.find(w=>w.id===c.workId),b=w?.runtimeRun?.environment;ensure(b&&w&&!w.tasks.find(t=>t.id===c.taskId)?.environment,'Lost environment context cannot resume');ensure(parseEnvironmentWorkPlan(JSON.stringify(plan),b.definition));await this.#current(c,b);
  const record=async(index:number,update:EnvironmentWorkUpdate)=>{await this.#current(c,b);const command:EnvironmentWorkCommand={type:'record-environment-work',workId:c.workId,taskId:c.taskId,environment:b.id,dispatchId:c.dispatchId,inputHash:c.inputHash,index,update};const r=await c.record(command,'assistant-environment-work:'+hash(command).slice(0,40));ensure(r.status!=='conflict','Environment checkpoint conflicted');return r;};
  await record(0,{kind:'begin',plan});
  const k=key(c.missionId,c.workId);let session=this.#sessions.get(k);
  if(session){ensure(hash(session.binding)===hash(b));session.context=c;}
  else{
   const guarded=this.#guard(c,b),signal=AbortSignal.any([c.signal,this.#stop.signal]);const browser=await (this.#options.open??openBrowserEnvironment)({environment:b.id,origin:b.definition.origin,elements:b.definition.elements,facts:b.definition.facts.map(({label,kind,...f})=>f)},b.definition.origin+'/',signal);
   try{await this.#current(c,b);}catch(error){await browser.close();throw error;}
   const adapter:EnvironmentAdapter={observe:async s=>{await this.#current(c,b);const o=await browser.observe(AbortSignal.any([s,signal]));await this.#current(c,b);return o;},act:async(a,ctx)=>{await this.#current(c,b);await browser.act(a,{...ctx,signal:AbortSignal.any([ctx.signal,signal])});}};
   const actions=new EnvironmentActions(this.#store,guarded,adapter,{owner:'local-owner',environment:b.id,resolveSecret:async(ref,s)=>{
    await this.#current(c,b);const secret=b.definition.secrets.find(secret=>secret.fields.some(f=>f.slot===ref.slot));ensure(ref.owner==='local-owner'&&secret);const requestId=this.#secretId(b,secret.id);const value=await this.#options.secrets.slots(c.missionId,c.workId,requestId,b.definition.memberId,secret.purpose).read(requestSecretSlot(c.missionId,c.workId,requestId,ref.slot),AbortSignal.any([s,signal]));await this.#current(c,b);ensure(value!==undefined,'Scoped secret is unavailable');return new TextEncoder().encode(value);
   }});
   session={binding:b,context:c,browser,actions,guarded};this.#sessions.set(k,session);
  }
  const {actions,browser,guarded}=session;
  for(const [index,op] of plan.operations.entries()){
   await this.#current(c,b);
   if(op.kind==='observe'){
    const observed=await actions.observeForHost(op.facts);await this.#current(c,b);const raw=browser.observedPage(observed.binding),pageReadId='environment-page:'+hash([b.id,c.taskId,index]).slice(0,40);
    const pages=new BrowserSessions(this.#store,guarded,{adapter:{async read(){return raw;}}});try{const r=await pages.capture({missionId:c.missionId,workId:c.workId,readId:pageReadId,address:b.definition.origin+'/'});ensure(r.status==='committed','Environment page admission is not fresh');}finally{await pages.drain();}
    await record(index,{kind:'observe',observation:{observationId:observed.observationId,binding:observed.binding,facts:observed.facts,pageReadId}});continue;
   }
   if(op.kind==='act'&&op.input.kind==='type')await this.#secret(c,b,op.input.secret.slot);
   const entryId='environment-entry:'+hash([b.id,c.taskId,index]).slice(0,40);let entry=op.kind==='act'?await actions.propose(entryId,op.element,op.input):await actions.wait(entryId,b.definition.waits.find(w=>w.id===op.id)!.request);
   await record(index,{kind:'link',reference:reference(entry),waiting:entry.status==='waiting'});
   if(entry.status==='waiting'){
    while(entry.status==='waiting'){
     await this.#current(c,b);if(Date.now()>=entry.deadline){await record(index,{kind:'stop'});throw new DomainError('Environment owner wait expired');}
     if(op.kind==='wait'&&Date.now()>=entry.nextPoll)entry=await actions.poll(entry.id);
     else entry=(await actions.state()).entries.find(e=>e.id===entry.id)!;
     if(entry.status==='waiting')await delay(50,undefined,{signal:AbortSignal.any([c.signal,this.#stop.signal])});
    }
    if(entry.status!=='ready'&&entry.status!=='completed'){await record(index,{kind:'stop'});throw new DomainError('Owner did not authorize environment continuation');}await record(index,{kind:'resume',...(op.kind==='act'?{approvedAt:entry.updatedAt}:{})});
   }
   if(op.kind==='wait'){ensure(entry.status==='completed');await record(index,{kind:'complete',result:'owner-completed'});continue;}
   if(entry.request.type==='action'&&entry.request.action.gates.some(g=>g.kind==='payment')){await actions.acknowledgePayment(entry.id,entry.hash);await record(index,{kind:'complete',result:'intent-approved'});continue;}
   const claim=await record(index,{kind:'claim'});ensure(claim.status==='committed','Only a fresh Work claim can deliver an action');
   let delivered=false;try{await this.#current(c,b);delivered=(await actions.execute(entry.id,entry.hash)).status==='delivered';}catch{}
   await c.receipt(environmentWorkEffectId(b.id,c.taskId,index),delivered?'succeeded':'unknown',JSON.stringify({kind:'environment-delivery/v1',environment:b.id,entryId:entry.id,requestHash:entry.hash}));ensure(delivered,'Environment delivery is unknown; never resend');await record(index,{kind:'complete',result:'delivered'});
  }
  const result=(await this.#current(c,b)).work;return environmentStepResult(result,result.tasks.find(t=>t.id===c.taskId)!);
 }
 #secretId(b:RuntimeEnvironmentBinding,id:string){return 'environment-secret:'+hash([b.id,id]).slice(0,40);}
 async #secret(c:EnvironmentWorkContext,b:RuntimeEnvironmentBinding,slot:string){
  const secret=b.definition.secrets.find(s=>s.fields.some(f=>f.slot===slot));ensure(secret);const requestId=this.#secretId(b,secret.id);let current=await this.#current(c,b),request=current.work.secretRequests?.find(r=>r.id===requestId);
  if(!request){const r=await this.#options.secrets.offer({commandId:'assistant-secret-'+hash([b.id,requestId]).slice(0,40),missionId:c.missionId,workId:c.workId,expectedRevision:current.read.snapshot!.revision,requestId,declaration:environmentSecretDeclaration(b.definition,secret)});ensure(r.status==='committed','Secret request admission is not fresh');}
  for(;;){current=await this.#current(c,b,true);request=current.work.secretRequests?.find(r=>r.id===requestId);ensure(request&&['open','providing','provided'].includes(request.state),'Secret request did not complete');if(request.state==='provided')return;await delay(50,undefined,{signal:AbortSignal.any([c.signal,this.#stop.signal])});}
 }
 async decisions(expectedFeed?:string,memberId?:string){
  const read=await this.#store.readState(this.#options.intake());if(expectedFeed!==undefined&&read.feedId!==expectedFeed)throw new FeedAdmissionError();const result=[];
  for(const work of read.snapshot?.value.works??[]){const b=work.runtimeRun?.environment;if(!b||memberId!==undefined&&b.definition.memberId!==memberId||read.feedId!==b.feedId)continue;const actions=new EnvironmentActions(this.#store,this.#owner,undefined,{owner:'local-owner',environment:b.id}),state=await actions.state(),session=this.#sessions.get(key(read.snapshot!.value.id,work.id));
   for(const task of work.tasks){const refs=[...(task.environment?.records??[]).flatMap(r=>r.kind==='observed'?[]:[r.reference]),...(task.environment?.pending?[task.environment.pending]:[])];for(const ref of refs){
    const e=state.entries.find(e=>e.id===ref.id&&e.hash===ref.hash);if(!e||e.request.type==='action'&&!e.request.action.gates.length)continue;const r=e.request,action=r.type==='action',payment=r.type==='action'?r.action.gates.find(g=>g.kind==='payment'):undefined,deadline=Math.min(e.deadline,currentOwnership(work)!.deadlineAt),expired=Date.now()>=deadline&&['waiting','ready'].includes(e.status),live=session&&!session.context.signal.aborted&&!this.#stop.signal.aborted&&work.acceptance==='pending'&&!work.runtimeInterruption&&!work.runtimeRecovery&&!work.blocker&&work.execution==='waiting'&&task.environment!.inputHash===workInputHash(work)&&!expired;
    const question=payment?copy('ui.payment-intent.question',{amount:paymentAmount(payment.intent)}):r.type==='action'?b.definition.elements.find(el=>el.id===r.action.element)!.label:r.wait.what;
    const source=payment?.intent.sourceReference.split(':',1)[0]??'',sourceLabel=copy('ui.payment-intent.source-'+(['document','record','work'].includes(source)?source:['http','https'].includes(source)?'web':'reference'));
    const rows=payment?[[copy('ui.payment-intent.payee'),payment.intent.payee],[copy('ui.effect.payment.amount'),paymentAmount(payment.intent)],[copy('ui.payment-intent.purpose'),payment.intent.purpose],[copy('ui.panel.source'),sourceLabel]]:r.type==='action'?[[copy('ui.environment.target'),b.definition.origin],[copy('ui.environment.what'),r.action.gates.map(g=>copy('ui.environment.gate.'+g.kind)).join(' · ')]]:[[copy('ui.environment.who'),r.wait.who],[copy('ui.environment.what'),r.wait.what],[copy('ui.environment.where'),r.wait.where]];
    const line=copy(expired||e.status==='timed-out'?'ui.apps.credential-expired':['declined','cancelled'].includes(e.status)?'ui.cancelled':['unknown','invalidated'].includes(e.status)?'conversation.text.01':e.status==='waiting'?'sidebar.status.07':payment?'ui.payment-intent.approved':action?'ui.environment.approved':'ui.environment.observed');
    result.push({id:decisionId(read.snapshot!.value.id,work.id,e.id),at:e.at,title:work.title,question,rows,action:copy('ui.payment-intent.approve'),state:live&&e.status==='waiting'?'open':'done',line:payment?copy('ui.payment-intent.decision-line',{payee:payment.intent.payee,amount:paymentAmount(payment.intent),state:line}):question+' · '+line,environment:{missionId:read.snapshot!.value.id,workId:work.id,taskId:task.id,entryId:e.id,requestHash:e.hash,kind:action?'action':'owner-action',deadline,status:e.status,memberId:b.definition.memberId}});
   }}
  }
  if((await this.#store.readState()).feedId!==read.feedId)throw new FeedAdmissionError();return result;
 }
 async decide(raw:unknown):Promise<{status:string;revision:number}>{
  exact(raw,['commandId','decisionId','requestHash','answer']);ensure(id(raw.commandId)&&!raw.commandId.startsWith('assistant-')&&typeof raw.decisionId==='string'&&raw.decisionId.startsWith(ENVIRONMENT_DECISION_PREFIX)&&typeof raw.requestHash==='string'&&['act','reject'].includes(raw.answer),'Invalid environment answer');
  const read=await this.#store.readState(this.#options.intake());ensure(read.snapshot);for(const work of read.snapshot.value.works){const b=work.runtimeRun?.environment;if(!b)continue;for(const task of work.tasks){const refs=[...(task.environment?.records??[]).flatMap(r=>r.kind==='observed'?[]:[r.reference]),...(task.environment?.pending?[task.environment.pending]:[])];const ref=refs.find(r=>decisionId(read.snapshot!.value.id,work.id,r.id)===raw.decisionId);if(!ref)continue;ensure(read.feedId===b.feedId);ensure(ref.hash===raw.requestHash,'Environment answer hash changed');const session=this.#sessions.get(key(read.snapshot.value.id,work.id));const owner=new Proxy(this.#owner,{get:(target,p)=>{if(p==='commit')return async(input:Parameters<typeof target.commit>[0])=>{ensure(session,'Original environment session closed');await this.#current(session.context,b);return target.commit(input);};const v=Reflect.get(target,p);return typeof v==='function'?v.bind(target):v;}});
    const actions=new EnvironmentActions(this.#store,owner,undefined,{owner:'local-owner',environment:b.id});await actions.answer(raw.commandId,ref.id,ref.hash,raw.answer==='act'?'approve':'cancel');return {status:'committed',revision:(await this.#store.load(read.snapshot.value.id))!.revision};
   }}throw new DomainError('Unknown environment decision');
 }
 async close(missionId:string,workId:string){const k=key(missionId,workId),session=this.#sessions.get(k);this.#sessions.delete(k);for(const job of this.#jobs.keys())if(job.startsWith(k+':'))this.#jobs.delete(job);if(session){await session.browser.close();}}
 beginDrain(){this.#stop.abort(new HostDrainError());}
 async drain(){this.beginDrain();await Promise.allSettled([...this.#jobs.values()].map(j=>j.promise));await Promise.all([...this.#sessions.keys()].map(k=>{const [missionId,workId]=JSON.parse(k);return this.close(missionId,workId);}));}
}
