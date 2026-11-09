import {capturePages,checkoutPage,attachBrowserRoute} from './browser-fixtures.ts';
import {Application} from '../../src/application.ts';
import {EffectDecisionsService} from '../../src/effect-decisions.ts';
import type {PaymentRequest,ExternalMemberRequest,EffectAdapter} from '../../src/effect-decisions.ts';
import {InMemoryStore} from '../../src/storage.ts';
import type {Mission} from '../../src/domain.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';

export const EFFECT_SCREENS=['B4','B16','B16-sent','B16-later'];
/** Recorded background conversation fixtures remain; every new effect fact comes from production transitions and the decision reader. */
export async function effectFixture(template:ScreenFixture){
 const fixture=structuredClone(template),payment=fixture.screen==='B4',workId=payment?'toner':'external-tests',title=payment?'프린터 토너 주문':'깨지는 테스트 고치기';
 let now=payment?fixture.now:Date.UTC(2026,10,5,0,12);fixture.now=now;
 const store=new InMemoryStore<Mission>(),app=new Application(store,[{id:'local-owner',roles:['owner']}],()=>now);
 await app.create({id:'intake',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'요청한 결과와 근거 확인',oracle:'bounded-text-review/v1'}},'local-owner','effect-fixture-create');
 await app.dispatch({missionId:'intake',commandId:'effect-fixture-work',expectedRevision:1,actorId:'local-owner',command:{type:'admit-work',workId,title,budget:8}});
 await app.dispatch({missionId:'intake',commandId:'effect-fixture-assign',expectedRevision:2,actorId:'local-owner',command:{type:'assign',workId,assignment:{id:workId+':executor',actorId:'executor',role:'executor',taskId:workId+':root',model:{provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Data-only effect fixture',evidenceClass:'fixture'},extensionVersion:'v1'}}});
 const browser=payment?await capturePages(store,'intake',workId,[checkoutPage,checkoutPage,checkoutPage,checkoutPage],now):undefined;
 const request:PaymentRequest|ExternalMemberRequest=payment?{kind:'payment',adapterId:'fixture-payment',checkoutId:'toner-cart',item:'레이저 토너 검정',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'오피스몰',origin:'https://shop.example.com',destination:'집 · 저장된 주소',method:'카드 끝자리 0000',expiresAt:now+18*60000,cancellation:'결제 후 취소 신청 가능',pagesRead:4,startedAt:now-3*60000}:{kind:'external-member',adapterId:'fixture-external',deviceId:'owner-laptop',deviceName:'노트북',agentId:'claude-code',agentName:'Claude Code',instruction:'massion 저장소에서 깨지는 테스트 하나 고쳐 줘.',scope:'massion 저장소',repository:{name:'massion',tests:['tests/domain.test.ts']}};
 const adapter:EffectAdapter={id:request.adapterId,kind:request.kind,async send(input){return {idempotencyKey:input.idempotencyKey,remoteId:payment?'fixture-order':'fixture-remote-task',outcome:payment?'succeeded':'received',detail:payment?'Fixture order receipt':'Fixture arrival receipt; no processing result'};}};
 const service=new EffectDecisionsService(store,store,()=>'intake',{adapters:[adapter],clock:()=>now});
 await service.propose({missionId:'intake',workId,taskId:workId+':root',stepId:payment?'checkout':'handoff',request});
 const decisionId=(await service.decisions())[0]!.id;
 if(fixture.screen!=='B4'&&fixture.screen!=='B16'){now+=60000;fixture.now=now;await service.decide({commandId:'fixture-answer',decisionId,answer:fixture.screen==='B16-sent'?'act':'later'});}
 validateMissionJournalLineage(store.inspect());
 const decisions=await service.decisions(),snapshot=(await store.load('intake'))!,view=fixture.routes['/assistant/conversation']!.body as any;
 view.decisions=decisions;view.cursor=snapshot.revision;
 if(!payment){view.turns=[{id:'assistant-turn:m:delegate',messageId:'m:delegate',status:'answered',displayStatus:'answered',at:decisions[0]!.at}];view.segment.messages[1].turnId='assistant-turn:m:delegate';}
 if(payment){for(const turn of view.turns){if(turn.work?.workId===workId)Object.assign(turn.work,{execution:snapshot.value.works[0]!.execution,unknown:snapshot.value.works[0]!.effects.some(e=>e.status==='unknown'),missionRevision:snapshot.revision});}}
 const read=fixture.routes['/read-state?mission=intake']!.body as any;
 read.snapshot.value.works=read.snapshot.value.works.filter((w:any)=>w.id!==workId);read.snapshot.value.works.push(snapshot.value.works[0]);read.snapshot.revision=snapshot.revision;
 fixture.routes['/missions/intake']={status:200,body:structuredClone(read.snapshot)};
 const summaries=(fixture.routes['/assistant/works']!.body as any).works;
 const current={missionId:'intake',missionRevision:snapshot.revision,workId,title,memberId:null,execution:snapshot.value.works[0]!.execution,acceptance:'pending',unknown:snapshot.value.works[0]!.effects.some(e=>e.status==='unknown'),started:true,startedAt:request.kind==='payment'?request.startedAt:decisions[0]!.at,endedAt:null,turnId:payment?'assistant-turn:m:toner':'assistant-turn:m:delegate',segment:1,steps:{done:0,total:0}};
 (fixture.routes['/assistant/works']!.body as any).works=read.snapshot.value.works.map((w:any)=>w.id===workId?current:summaries.find((entry:any)=>entry.workId===w.id));
 fixture.readySelector='[id="chat-decision-'+decisionId+'"]';
 if(payment)fixture.steps=[{action:'click',selector:'[id="chat-checkout-'+decisionId+'"]',readySelector:'#pane-effect:not([hidden])'}];
 else {fixture.readySelector='#chat-log';fixture.steps=[{action:'click',selector:'#activity-toggle',readySelector:'#side-activity:not([hidden])'}];}
 if(browser)await attachBrowserRoute(fixture,browser,'intake',workId);
 fixture.gaps=payment?[]:['The separate rounding-rule decision has no producer in E6c; its activity row remains absent.'];
 fixture.reuse.push('scripts/ui-contracts/effect-fixtures.ts: production EffectDecisionsService and validated Mission journal; fixture adapters only');
 return fixture;
}
