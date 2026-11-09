import {memoryHistoryFixture} from './memory-history-fixture.ts';
import {SchedulesService} from '../../src/schedules.ts';
import {Application} from '../../src/application.ts';
import {calculationPlan} from '../../src/growth-evaluation.ts';
import {memoryVersionHash} from '../../src/domain.ts';
import type {Mission,Memory} from '../../src/domain.ts';
import {RuleChangesService,withRuleBriefings} from '../../src/rule-changes.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import {copy} from '../../src/ui-copy.ts';
import type {ScreenFixture} from './fixture-host.ts';
export const GROWTH_SCREENS=['B12','B2','B2-offline','B2-offline-failed','B9','B9-restart','B9-update','B16','B16-later','B16-sent','B7-done','B7-unknown','B7-fail'];
export async function growthFixture(template:ScreenFixture){
 if(template.screen==='B12')return memoryHistoryFixture(template);
 const fixture=structuredClone(template),at=((template.routes['/assistant/conversation']!.body as any).decisions??[]).find((d:any)=>d.id==='rounding')?.at??Date.UTC(2026,10,5,0,0),store=new InMemoryStore<Mission>(),owner={id:'local-owner',roles:['owner'] as const},representative={id:'rounding-proposal-host',roles:['representative'] as const},evaluator={id:'host-rounding-oracle/v1',roles:['evaluator'] as const},app=new Application(store,[{...owner,roles:[...owner.roles]},{...representative,roles:[...representative.roles]},{...evaluator,roles:[...evaluator.roles]}],()=>at);
 await app.create({id:'intake',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'요청한 결과와 근거 확인',oracle:'bounded-text-review/v1'}},owner.id,'rule-fixture-create');
 const baseline:Memory={id:'rounding',version:1,scope:'local',authority:'explicit',content:'Round each line',source:'Owner rounding policy',effective:true,name:copy('ui.rule.name')},candidate:Memory={...baseline,version:2,authority:'learned',content:'Round aggregate once',source:'Order-level calculation cases',effective:false};
 await app.dispatch({missionId:'intake',commandId:'rule-fixture-baseline',expectedRevision:(await store.load('intake'))!.revision,actorId:owner.id,command:{type:'save-memory',memory:baseline}});
 await app.dispatch({missionId:'intake',commandId:'rule-fixture-proposal',expectedRevision:(await store.load('intake'))!.revision,actorId:representative.id,command:{type:'propose-growth',candidateMemory:candidate,proposal:{id:'rounding-growth',proposer:representative.id,target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:copy('ui.rule.counterevidence'),status:'proposed'}}});
 const orders=[{items:[{unitPriceCents:3,quantity:1},{unitPriceCents:3,quantity:1}],discountBasisPoints:5000},{items:[{unitPriceCents:5,quantity:1},{unitPriceCents:5,quantity:1}],discountBasisPoints:5000},{items:[{unitPriceCents:4,quantity:1},{unitPriceCents:4,quantity:1}],discountBasisPoints:5000}],plan=calculationPlan(baseline,candidate,orders);
 await app.dispatch({missionId:'intake',commandId:'rule-fixture-evaluate',expectedRevision:(await store.load('intake'))!.revision,actorId:evaluator.id,command:{type:'evaluate-growth',ownerDecision:true,growthId:'rounding-growth',baseline:plan.baseline,candidate:plan.candidate,heldOut:plan.heldOut,binding:{baseline:'rounding@1',candidate:'rounding@2',baselineHash:memoryVersionHash(baseline),candidateHash:memoryVersionHash(candidate)}}});
 validateMissionJournalLineage(store.inspect());const decision=(await new RuleChangesService(store,()=> 'intake').decisions())[0]!,view=fixture.routes['/assistant/conversation']!.body as any;view.decisions=[...(view.decisions??[]).filter((d:any)=>d.id!=='rounding'),decision];
 const briefingScreen=['B2','B2-offline','B2-offline-failed','B9','B9-restart','B9-update'].includes(fixture.screen);
 if(briefingScreen){let scheduleNow=at;const schedules=new SchedulesService(store,async()=>({segment:{number:1},turns:[]}),()=>scheduleNow);await schedules.act({commandId:'rule-fixture-briefing',action:'create',minute:480,offset:540,budget:{runs:1}});scheduleNow=(await schedules.read()).schedules[0]!.nextAt;await schedules.tick();view.briefings=withRuleBriefings((await schedules.conversation(1)).briefings,[decision]);validateMissionJournalLineage(store.inspect());fixture.captureScroll={selector:'#chat-scroll',top:0};
  const summaries=fixture.routes['/assistant/works']!.body as any;summaries.works=summaries.works.filter((w:any)=>w.workId!=='rounding-work');
  for(const response of Object.values(fixture.routes)){const body=response.body as any,mission=body?.snapshot?.value??body?.value;if(mission?.works)mission.works=mission.works.filter((w:any)=>w.id!=='rounding-work');}
 }
 for(const route of ['/read-state?mission=intake','/missions/intake']){const body=fixture.routes[route]?.body as any,snapshot=route.startsWith('/read-state')?body?.snapshot:body;if(snapshot?.value){snapshot.revision=(await store.load('intake'))!.revision;snapshot.value.memories=structuredClone((await store.load('intake'))!.value.memories);snapshot.value.growth=structuredClone((await store.load('intake'))!.value.growth);}}
 const revision=(await store.load('intake'))!.revision;for(const turn of view.turns??[])if(turn.work?.missionId==='intake')turn.work.missionRevision=revision;const workRows=(fixture.routes['/assistant/works']?.body as any)?.works;for(const work of workRows??[])if(work.missionId==='intake')work.missionRevision=revision;
 if(['B16-later','B16-sent'].includes(fixture.screen))fixture.steps.push({action:'click',selector:'[id="activity-row-decision:'+decision.id+'"]',readySelector:'#chat-log'});
 if(['B7-done','B7-unknown','B7-fail','B2-offline','B2-offline-failed'].includes(fixture.screen))fixture.steps.unshift({action:'click',selector:'#activity-toggle'},{action:'click',selector:'[id="activity-row-decision:'+decision.id+'"]'},{action:'click',selector:'#activity-toggle'});
 fixture.gaps=fixture.gaps.filter(g=>!/check-rule case-detail|separate rounding-rule decision|rounding.*proposal.*no producer/.test(g));if(fixture.readySelector==='#chat-decision-rounding')fixture.readySelector='[id="chat-'+(decision.state==='done'?'system-':'decision-')+decision.id+'"]';fixture.reuse.push('scripts/ui-contracts/growth-fixtures.ts: production Growth transitions, exact calculation plan and RuleChangesService projection');return fixture;
}
