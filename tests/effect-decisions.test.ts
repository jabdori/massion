import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {EffectDecisionsService} from '../src/effect-decisions.ts';
import type {EffectAdapter,PaymentRequest,ExternalMemberRequest} from '../src/effect-decisions.ts';
import {CommitOutcomeUnknownError,withAdmissionFeed} from '../src/storage.ts';
import {apply,hash,workInputHash,DomainError} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {EFFECT_HOST} from '../src/effect-decisions.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import {createWorkbench} from '../src/server.ts';
import type {ConnectionWorkbench} from '../src/connection-workbench.ts';

const NOW=Date.UTC(2026,10,5,0,12);
export const payment:PaymentRequest={kind:'payment',adapterId:'fixture-payment',checkoutId:'cart-1',item:'레이저 토너 검정',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'오피스몰',origin:'https://shop.example.com',destination:'집 · 저장된 주소',method:'카드 끝자리 0000',expiresAt:NOW+3600000,cancellation:'결제 후 취소 신청 가능',pagesRead:4,startedAt:NOW-120000};
export const external:ExternalMemberRequest={kind:'external-member',adapterId:'fixture-external',deviceId:'laptop',deviceName:'내 노트북',agentId:'claude-code',agentName:'Claude Code',instruction:'massion 저장소에서 깨지는 테스트 하나 고쳐 줘.',scope:'massion 저장소'};
async function setup(adapter?:EffectAdapter,owned=false){
 const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']}]);
 await app.create({id:'intake',purpose:'Fixture effects',scope:'local',constraints:[],criteria:{version:1,description:'Independent result check',oracle:'fixture/v1'}},'local-owner','create');
 await app.dispatch({missionId:'intake',commandId:'work',expectedRevision:1,actorId:'local-owner',command:{type:'admit-work',workId:'work',title:'프린터 토너 주문',budget:8}});
 if(owned){const w=(await store.load('intake'))!.value.works[0]!;await app.dispatch({missionId:'intake',commandId:'run',expectedRevision:2,actorId:'local-owner',command:{type:'activate-runtime',workId:'work',run:{id:'run',authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:NOW-1000,deadlineAt:NOW+1000}}}});}
 await app.dispatch({missionId:'intake',commandId:'assign',expectedRevision:(await store.load('intake'))!.revision,actorId:'local-owner',command:{type:'assign',workId:'work',assignment:{id:'executor',actorId:'executor',role:'executor',taskId:'work:root',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'Data-only effect fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 let now=NOW;const service=new EffectDecisionsService(store,store,()=>'intake',{adapters:adapter?[adapter]:[],clock:()=>now,timeoutMs:20});
 const propose=(request:PaymentRequest|ExternalMemberRequest=payment)=>service.propose({missionId:'intake',workId:'work',taskId:'work:root',stepId:'checkout',request});
 const read=async()=>(await store.load('intake'))!.value.works[0]!;
 return {store,app,service,propose,read,advance:(ms:number)=>{now+=ms;}};
}

test('payment pauses atomically; overlapping approval runs the pinned effect once, and replay never sends again',async()=>{
 const calls:any[]=[];const s=await setup({id:'fixture-payment',kind:'payment',async send(input){calls.push(input);return {idempotencyKey:input.idempotencyKey,remoteId:'order-1',outcome:'succeeded',detail:'Order fixture'};}});
 await s.propose();const before=await s.read(),id=before.effects[0]!.id;assert.equal(before.execution,'waiting');assert.equal(calls.length,0);
 const results=await Promise.all([1,2].map(()=>s.service.decide({commandId:'pay',decisionId:id,answer:'act'})));
 assert.ok(results.every(r=>['committed','replayed'].includes(r.status)));assert.equal(calls.length,1);assert.deepEqual(calls[0].request,payment);
 assert.equal((await s.read()).effects[0]!.status,'succeeded');await s.service.decide({commandId:'pay',decisionId:id,answer:'act'});assert.equal(calls.length,1);
 await assert.rejects(s.service.decide({commandId:'pay',decisionId:id,answer:'later'}),/identity|conflict/i);
});

test('later and ask retain history; rejection closes the original step without a payment',async()=>{
 const s=await setup();await s.propose();const id=(await s.read()).effects[0]!.id;
 for(const answer of ['later','ask'] as const)await s.service.decide({commandId:answer,decisionId:id,answer});
 await assert.rejects(s.service.decide({commandId:'reject',decisionId:id,answer:'reject'}),/Exact decision answer/);
 const refused=apply((await s.store.load('intake'))!.value,{type:'answer-owner-effect',workId:'work',effectId:id,answer:'reject'},{id:'local-owner',roles:['owner']},{observedAt:NOW}).value;
 const e=refused.works[0]!.effects[0]!;assert.equal(e.ownerDecision!.state,'rejected');assert.deepEqual(e.ownerDecision!.answers.map(a=>a.answer),['later','ask','reject']);
 assert.throws(()=>apply(refused,{type:'answer-owner-effect',workId:'work',effectId:id,answer:'act'},{id:'local-owner',roles:['owner']},{observedAt:NOW}),/open|decision/i);
 await assert.rejects(s.propose({...payment,total:35000,subtotal:32000}),/identity|conflict/i);
});

test('external admission pins remote identity; arrival is not completion and lost receipt remains unknown across restart',async()=>{
 let calls=0;const s=await setup({id:'fixture-external',kind:'external-member',async send(input){calls++;return {idempotencyKey:input.idempotencyKey,remoteId:'remote-task-1',outcome:'received',detail:'Arrival only'};}});
 await s.propose(external);const id=(await s.read()).effects[0]!.id;await s.service.decide({commandId:'handoff',decisionId:id,answer:'act'});
 const w=await s.read();assert.equal(w.effects[0]!.status,'unknown');assert.equal(w.acceptance,'pending');assert.equal(w.effects[0]!.ownerDecision!.receipt!.remoteId,'remote-task-1');
 const restarted=new EffectDecisionsService(s.store,s.store,()=>'intake');await restarted.decide({commandId:'handoff',decisionId:id,answer:'act'});assert.equal(calls,1);
});

test('expired checkout cannot be approved',async()=>{
 const s=await setup();await s.propose();s.advance(3600001);await assert.rejects(s.service.decide({commandId:'expired',decisionId:(await s.read()).effects[0]!.id,answer:'act'}),/expired/i);
});

test('timeout and mismatched receipt stay unknown; a late reply and restart cannot resend',async()=>{
 for(const mismatch of [false,true]){
  let release!:(value:any)=>void,calls=0;
  const adapter:EffectAdapter={id:'fixture-payment',kind:'payment',async send(input){calls++;if(mismatch)return {idempotencyKey:'wrong',remoteId:'x',outcome:'succeeded',detail:'Wrong request'};return new Promise(r=>{release=r;});}};
  const s=await setup(adapter);await s.propose();const id=(await s.read()).effects[0]!.id;await s.service.decide({commandId:'pay',decisionId:id,answer:'act'});
  const w=await s.read(),d=w.effects[0]!.ownerDecision!;assert.equal(w.execution,'blocked');assert.equal(w.effects[0]!.status,'unknown');assert.equal(d.receipt,undefined);assert.equal(d.settledAt,NOW);
  if(!mismatch){release({idempotencyKey:d.dispatch!.idempotencyKey,remoteId:'late-order',outcome:'succeeded',detail:'Late'});await Promise.resolve();}
  await s.service.decide({commandId:'pay',decisionId:id,answer:'act'});assert.equal(calls,1);assert.equal((await s.read()).effects[0]!.status,'unknown');validateMissionJournalLineage(s.store.inspect());
 }
});

test('a committed claim with a lost storage reply does not authorize a call or replay',async()=>{
 let calls=0;const s=await setup(),adapter:EffectAdapter={id:'fixture-payment',kind:'payment',async send(){calls++;throw Error('Must not call');}};
 await s.propose();const id=(await s.read()).effects[0]!.id;
 const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{const r=await target.commit(input);if(input.events[0].type==='dispatch-owner-effect')throw new CommitOutcomeUnknownError(input);return r;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const service=new EffectDecisionsService(s.store,owner,()=>'intake',{adapters:[adapter],clock:()=>NOW});
 await assert.rejects(service.decide({commandId:'pay',decisionId:id,answer:'act'}),CommitOutcomeUnknownError);assert.equal((await s.read()).effects[0]!.status,'unknown');
 await service.decide({commandId:'pay',decisionId:id,answer:'act'});assert.equal(calls,0);validateMissionJournalLineage(s.store.inspect());
});

test('owner admission and the dispatch claim both honor drain after asynchronous reads',async()=>{
 for(const stopAt of ['answer-owner-effect','dispatch-owner-effect']){
  let calls=0;const s=await setup();await s.propose();const id=(await s.read()).effects[0]!.id;
  const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0].type===stopAt)throw new HostDrainError();return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  const service=new EffectDecisionsService(s.store,owner,()=>'intake',{adapters:[{id:'fixture-payment',kind:'payment',async send(){calls++;throw Error('Must not call');}}],clock:()=>NOW});
  await assert.rejects(service.decide({commandId:'pay',decisionId:id,answer:'act'}),HostDrainError);assert.equal(calls,0);assert.equal((await s.read()).effects[0]!.ownerDecision!.dispatch,undefined);
 }
});

test('unavailable adapter, changed inputs, forged owner and generic effect bypasses are refused',async()=>{
 const s=await setup();await s.propose();const w=await s.read(),id=w.effects[0]!.id,mission=(await s.store.load('intake'))!.value;
 await assert.rejects(s.service.decide({commandId:'pay',decisionId:id,answer:'act'}),/adapter unavailable/);
 assert.equal((await s.read()).effects[0]!.ownerDecision!.state,'open');
 assert.throws(()=>apply(mission,{type:'answer-owner-effect',workId:w.id,effectId:id,answer:'act'},{id:'executor',roles:['owner']},{observedAt:NOW}),/authority/);
 const changed=structuredClone(mission);changed.works[0]!.instructions=[{actorId:'local-owner',text:'Change the order'}];
 assert.throws(()=>apply(changed,{type:'answer-owner-effect',workId:w.id,effectId:id,answer:'act'},{id:'local-owner',roles:['owner']},{observedAt:NOW}),/input changed/);
 const assigned=structuredClone(mission);assigned.works[0]!.assignments.push({id:'executor',actorId:'executor',role:'executor',taskId:'work:root',model:{provider:'fixture',model:'none',configVersion:'v1',reason:'fixture',evidenceClass:'fixture'},extensionVersion:'v1'});
 assert.throws(()=>apply(assigned,{type:'receipt',workId:w.id,effectId:id,outcome:'succeeded',receipt:'Forged',usage:0},{id:'executor',roles:['executor']}),/receipt/);
 assert.throws(()=>apply(mission,{type:'cancel',workId:w.id},{id:EFFECT_HOST,roles:['owner']}),/effect-only/);
 const tampered=structuredClone(s.store.inspect());tampered.at(-1)!.value.works[0]!.effects[0]!.ownerDecision!.requestHash=hash('different');assert.throws(()=>validateMissionJournalLineage(tampered),/decision/);
});

test('a changed database feed refuses an approval before the adapter',async()=>{
 let calls=0;const s=await setup({id:'fixture-payment',kind:'payment',async send(){calls++;throw Error('Must not call');}});await s.propose();
 await assert.rejects(withAdmissionFeed('replaced-feed',()=>s.service.decide({commandId:'pay',decisionId:(s.store.inspect().at(-1)!.value.works[0]!.effects[0]!.id),answer:'act'})),/database|feed/i);assert.equal(calls,0);
});

test('normal HTTP decision route admits external member only after ask/act and replays the receipt',async t=>{
 const s=await setup(),calls:any[]=[];
 const connections={list:()=>({representative:{intakeMissionId:'intake'}})} as unknown as ConnectionWorkbench;
 const server=createWorkbench(s.store,'.',{connections,scheduleIntervalMs:0,effectAdapters:[{id:'fixture-external',kind:'external-member',async send(input){calls.push(input);return {idempotencyKey:input.idempotencyKey,remoteId:'remote-1',outcome:'received',detail:'Arrival fixture'};}}]});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 await server.effectDecisions.propose({missionId:'intake',workId:'work',taskId:'work:root',stepId:'remote',request:external});
 const view=await fetch(url+'/assistant/conversation').then(r=>r.json());assert.equal(view.decisions.length,1);const id=view.decisions[0].id;
 const post=(answer:string,commandId=answer,extra={})=>fetch(url+'/assistant/decisions',{method:'POST',headers:{'content-type':'application/json','x-massion-feed':view.feedId},body:JSON.stringify({commandId,decisionId:id,answer,...extra})});
 assert.equal((await post('act','tampered',{request:{deviceId:'someone-else'}})).status,400);assert.equal(calls.length,0);
 assert.equal((await post('later')).status,200);assert.equal((await post('act','premature')).status,409);assert.equal((await post('ask')).status,200);assert.equal((await post('act')).status,200);assert.equal(calls.length,1);
 const sent=await fetch(url+'/assistant/conversation').then(r=>r.json());assert.equal(sent.decisions[0].effect.receipt.remoteId,'remote-1');assert.equal(sent.decisions[0].effect.status,'unknown');
 assert.equal((await post('act')).status,200);assert.equal(calls.length,1);assert.equal((await server.drain()).status,'drained');
});

test('drain aborts local waiting and persists unknown without claiming remote cancellation',async()=>{
 let entered!:()=>void,signal:AbortSignal|undefined;const ready=new Promise<void>(r=>{entered=r;});
 const s=await setup({id:'fixture-payment',kind:'payment',async send(input){signal=input.signal;entered();return new Promise(()=>{});}});await s.propose();const id=(await s.read()).effects[0]!.id;
 const sending=s.service.decide({commandId:'pay',decisionId:id,answer:'act'});await ready;await s.service.drain();await sending;
 assert.equal(signal!.aborted,true);const d=(await s.read()).effects[0]!.ownerDecision!;assert.equal(d.receipt,undefined);assert.equal(d.settledAt,NOW);assert.equal((await s.read()).effects[0]!.status,'unknown');
});


test('runtime closure preserves an unclaimed proposal as inert history and rejects late approval',async()=>{
 const s=await setup(undefined,true);await s.propose();const id=(await s.read()).effects[0]!.id;s.advance(1001);
 await s.app.dispatch({missionId:'intake',commandId:'close',expectedRevision:(await s.store.load('intake'))!.revision,actorId:'local-owner',command:{type:'close-expired-runtime',workId:'work',runId:'run',dispatchId:'dispatch',hostSessionId:'host',deadlineAt:NOW+1000,observedAt:NOW+1001,reason:'Original deadline passed',acknowledgeUncertainOutcome:true}});
 validateMissionJournalLineage(s.store.inspect());await assert.rejects(s.service.decide({commandId:'late',decisionId:id,answer:'act'}));assert.equal((await s.read()).effects[0]!.ownerDecision!.dispatch,undefined);
});

test('HTTP owner answer held in a read is refused if host drain begins before admission',async t=>{
 const s=await setup();await s.propose(external);const id=(await s.read()).effects[0]!.id;let hold=true,entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(s.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id==='intake'){hold=false;entered();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store,'.',{connections:{list:()=>({representative:{intakeMissionId:'intake'}})} as unknown as ConnectionWorkbench,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const sending=fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'defer',decisionId:id,answer:'later'})});await ready;const drained=server.drain();release();assert.equal((await sending).status,503);await drained;assert.equal((await s.read()).effects[0]!.ownerDecision!.state,'open');
});


test('external content summary derives from the pinned payload without showing the literal instruction',async()=>{
 const s=await setup();await s.propose({...external,repository:{name:'massion',tests:['tests/domain.test.ts']}});
 const d=(await s.service.decisions())[0]!;assert.equal(d.rows.find(r=>r[0]==='받는 곳')![1],'Claude Code · 내 노트북');
 assert.equal(d.rows.find(r=>r[0]==='보낼 내용')![1],'요청 한 문장 · 저장소 이름 massion · 테스트 이름 1개');assert.ok(!JSON.stringify(d.rows).includes(external.instruction));
});


test('a successful external reply is reported without accepting the Work',async()=>{
 const s=await setup({id:'fixture-external',kind:'external-member',async send(input){return {idempotencyKey:input.idempotencyKey,remoteId:'remote-reply',outcome:'succeeded',detail:'Fixture reply'};}});await s.propose(external);await s.service.decide({commandId:'send',decisionId:(await s.read()).effects[0]!.id,answer:'act'});
 const d=(await s.service.decisions())[0]!;assert.match(d.line,/응답 받음/);assert.doesNotMatch(d.line,/응답 없음/);assert.equal((await s.read()).acceptance,'pending');
});


test('HTTP marks pre-admission refusal explicitly but not a failure after owner approval',async t=>{
 for(const afterApproval of [false,true]){
  const s=await setup();let calls=0;
  const store=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(afterApproval&&input.events[0].type==='dispatch-owner-effect')throw new DomainError('Claim refused','denied');return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
  const server=createWorkbench(store,'.',{connections:{list:()=>({representative:{intakeMissionId:'intake'}})} as unknown as ConnectionWorkbench,scheduleIntervalMs:0,effectAdapters:afterApproval?[{id:'fixture-external',kind:'external-member',async send(){calls++;throw Error('Must not call');}}]:[]});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
  await server.effectDecisions.propose({missionId:'intake',workId:'work',taskId:'work:root',stepId:'remote',request:external});const decisionId=(await s.read()).effects[0]!.id;
  const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'act',decisionId,answer:'act'})}),body=await response.json();assert.equal(response.status,403);assert.equal(body.phase,afterApproval?undefined:'admission');assert.equal(body.outcome,afterApproval?undefined:'rejected');assert.equal(calls,0);assert.equal((await s.read()).effects[0]!.ownerDecision!.state,afterApproval?'approved':'open');
 }
});
