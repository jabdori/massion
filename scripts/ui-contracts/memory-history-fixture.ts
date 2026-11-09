import {Application} from '../../src/application.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import {memoryVersionHash} from '../../src/domain.ts';
import type {Command,Memory,Mission} from '../../src/domain.ts';
import {calculationPlan} from '../../src/growth-evaluation.ts';
import {memoryWorkSource} from '../../src/memory-candidates.ts';
import {RuleChangesService} from '../../src/rule-changes.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {copy} from '../../src/ui-copy.ts';
import type {ScreenFixture} from './fixture-host.ts';

export async function memoryHistoryFixture(template:ScreenFixture){
 const fixture=structuredClone(template),store=new InMemoryStore<Mission>(),owner={id:'local-owner',roles:['owner'] as ['owner']},representative={id:'rounding-proposal-host',roles:['representative'] as ['representative']},evaluator={id:'host-rounding-oracle/v1',roles:['evaluator'] as ['evaluator']};
 let at=template.now-3*86400000,sequence=0;const app=new Application(store,[owner,representative,evaluator],()=>at);
 await app.create({id:'intake',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'요청한 결과와 근거 확인',oracle:'bounded-text-review/v1'}},owner.id,'memory-history-create');
 const send=async(command:Command,actorId=owner.id)=>app.dispatch({missionId:'intake',commandId:'memory-history-'+(++sequence),expectedRevision:(await store.load('intake'))!.revision,actorId,command});
 await send({type:'admit-work',workId:'rounding-source',title:copy('ui.rule.source-work'),budget:0});const source=(await store.load('intake'))!.value,sourceWork=memoryWorkSource(source,source.works[0]!);
 const baseline:Memory={id:'rounding',version:1,scope:'local',authority:'explicit',content:'Round each line',source:'Owner rounding policy',effective:true,name:copy('ui.rule.name'),sourceWork},candidate:Memory={...baseline,version:2,authority:'learned',content:'Round aggregate once',source:'Order-level calculation cases',effective:false};
 await send({type:'save-memory',memory:baseline});
 const orders=[{items:[{unitPriceCents:3,quantity:1},{unitPriceCents:3,quantity:1}],discountBasisPoints:5000},{items:[{unitPriceCents:5,quantity:1},{unitPriceCents:5,quantity:1}],discountBasisPoints:5000},{items:[{unitPriceCents:4,quantity:1},{unitPriceCents:4,quantity:1}],discountBasisPoints:5000}],plan=calculationPlan(baseline,candidate,orders);
 const propose=async(id:string,first=false)=>{
  await send({type:'propose-growth',...(first?{candidateMemory:candidate}:{}),proposal:{id,proposer:representative.id,target:'memory',baseline:'rounding@1',candidate:'rounding@2',counterevidence:copy('ui.rule.counterevidence'),status:'proposed'}},representative.id);
  await send({type:'evaluate-growth',ownerDecision:true,growthId:id,baseline:plan.baseline,candidate:plan.candidate,heldOut:plan.heldOut,binding:{baseline:'rounding@1',candidate:'rounding@2',baselineHash:memoryVersionHash(baseline),candidateHash:memoryVersionHash(candidate)}},evaluator.id);
 };
 await propose('rounding-history',true);at=template.now-86400000-2*3600000;
 await send({type:'adopt-growth',growthId:'rounding-history',baseline:'rounding@1',candidate:'rounding@2',recordChangeTime:true});at=template.now-86400000;
 await send({type:'revert-growth',growthId:'rounding-history',baseline:'rounding@1',candidate:'rounding@2',recordChangeTime:true});at=template.now;
 await propose('rounding-growth');validateMissionJournalLineage(store.inspect());
 const snapshot=(await store.load('intake'))!,decision=(await new RuleChangesService(store,()=> 'intake').decisions())[0]!;
 for(const route of ['/read-state?mission=intake','/missions/intake']){const body=fixture.routes[route]?.body as any,current=route.startsWith('/read-state')?body?.snapshot:body;if(current?.value){current.value.works=current.value.works.filter((w:any)=>w.id!==sourceWork.workId);current.value.works.push(structuredClone(source.works[0]));current.value.memories=structuredClone(snapshot.value.memories);current.value.growth=structuredClone(snapshot.value.growth);current.revision=snapshot.revision;}}
 for(const [path,response] of Object.entries(fixture.routes))if(path.startsWith('/assistant/conversation')){const view=response.body as any;view.decisions=[...(view.decisions??[]).filter((d:any)=>d.id!=='rounding'&&!d.ruleChange),decision];}
 fixture.steps=fixture.steps.map(step=>'selector' in step&&step.selector==='#memory-query'?{...step,selector:'#settings-search'}:step);
 fixture.readySelector='[id="chat-decision-'+decision.id+'"]';fixture.reuse.push('scripts/ui-contracts/memory-history-fixture.ts: production timestamped adoption/reversion, active baseline and pending learned decision');return fixture;
}
