import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import {createMission,hash} from '../src/domain.ts';
import {parseResultFacts,workResultFacts} from '../src/result-facts.ts';
import {roomTelemetryWork} from '../scripts/ui-contracts/room-telemetry-fixtures.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {validateMissionLineage} from '../src/backup-lineage.ts';

const facts={format:'massion-facts/v1',items:[{label:'Files',value:41,unit:'items'},{label:'Phase',value:'Ready'}]};
test('generic ordered facts validate bounded integer and text items without interpreting their labels',()=>{
 assert.deepEqual(parseResultFacts(JSON.stringify(facts)),facts);
 const invalid=[null,[],{...facts,kind:'pricing'},{...facts,items:[]},{...facts,items:Array(9).fill(facts.items[0])},...[
  {label:'',value:1},{label:'x'.repeat(65),value:1},{label:' Files',value:1},{label:'Files',value:-1},{label:'Files',value:1.5},{label:'Files',value:1_000_000_001},{label:'Files',value:null},{label:'Files',value:true},{label:'Files',value:{}},{label:'Phase',value:''},{label:'Phase',value:'x'.repeat(97)},{label:'Files',value:1,unit:''},{label:'Files',value:1,unit:'x'.repeat(17)},{label:'Files',value:1,extra:true},{label:'Files',value:'\u202e'},{label:'Files',value:'\ud800'},{label:'Files',value:'a\nb'}
 ].map(item=>({format:'massion-facts/v1',items:[item]})),{format:'massion-facts/v1',kind:'churn',reasons:41,business:9,other:32}];
 for(const value of invalid)assert.equal(parseResultFacts(JSON.stringify(value)),null,JSON.stringify(value));
 for(const item of [{label:'Arbitrary label',value:0},{label:'Anything',value:1_000_000_000,unit:'units'},{label:'<img src=x>',value:'<script>inert</script>'}])assert.deepEqual(parseResultFacts(JSON.stringify({format:'massion-facts/v1',items:[item]})),{format:'massion-facts/v1',items:[item]});
 assert.equal(parseResultFacts(' '.repeat(4096)+JSON.stringify(facts)),null);
 for(const text of ['41 items','{"format":"massion-facts/v1",','```json\n'+JSON.stringify(facts)+'\n```'])assert.equal(parseResultFacts(text),null);
});
test('generic table rows never acquire fact labels and checking-seat text cannot overwrite producer observations',()=>{
 const mission=createMission({id:'intake',purpose:'Rows',scope:'local',constraints:[],criteria:{version:1,description:'Controlled rows',oracle:'fixture/v1'}},{id:'local-owner',roles:['owner']}),{work}=roomTelemetryWork(mission,'pricing');
 for(const task of work.tasks)if(!task.step)delete task.result;
 assert.deepEqual(workResultFacts(work),{resultFacts:null,tableCount:1});
 const checker=work.tasks.find(t=>t.id===work.id+':verifier')!;checker.status='settled';checker.result=JSON.stringify(facts);assert.equal(workResultFacts(work).resultFacts,null);
});
test('overlapping task result commands retain one original bounded observation and never create acceptance',async()=>{
 const owner={id:'local-owner',roles:['owner'] as const},mission=createMission({id:'intake',purpose:'Controlled prices',scope:'local',constraints:[],criteria:{version:1,description:'Controlled output',oracle:'fixture/v1'}},owner),{work}=roomTelemetryWork(mission,'pricing');
 const store=new InMemoryStore<typeof mission>(),state={...mission,works:[work]};await store.commit({id:mission.id,commandId:'seed',expectedRevision:0,fingerprint:hash(state),value:state,events:[],outbox:[]});
 const app=new Application(store,[{id:'executor',roles:['executor']}]),envelope={missionId:mission.id,actorId:'executor',commandId:'facts',expectedRevision:1,command:{type:'settle-task' as const,workId:work.id,taskId:work.id+':executor',result:JSON.stringify(facts)}};
 await assert.rejects(app.dispatch({...envelope,commandId:'invalid',command:{...envelope.command,result:JSON.stringify({...facts,items:[{label:'Files',value:-1}]})}}),/Invalid bounded/);
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const saved=(await store.load(mission.id))!.value.works[0]!;assert.deepEqual(workResultFacts(saved).resultFacts,facts);assert.equal(saved.acceptance,'pending');assert.equal(saved.record,undefined);
 validateMissionLineage({...mission,works:[saved]});
});
test('activity and done-screen business procedures retain real steps, host observations and failed checks',async()=>{
 for(const screen of ['B2','B3-run','B5','B6','B7-done','B7-fail','B7-unknown','B8-done','B9','B9-restart','B9-update','B15','B18','B18-room-b']){
  const fixture=await loadFixture(screen),mission=(fixture.routes['/missions/intake']!.body as any).value;
  const churn=mission.works.find((w:any)=>w.title==='이탈 원인 조사');assert.equal(churn.tasks.filter((t:any)=>t.step).length,5,screen);
  assert.ok(churn.tasks.filter((t:any)=>t.step&&t.status==='settled').every((t:any)=>Number.isSafeInteger(t.endedAt)),screen);
  const result=workResultFacts(churn).resultFacts;assert.ok(result,screen);assert.deepEqual(result.items,churn.acceptance==='failed'?[{label:'기업 고객 원인',value:1,unit:'개'},{label:'근거',value:2,unit:'건'}]:[{label:'해지 사유',value:41,unit:'건'},{label:'기업',value:9,unit:'건'},{label:'그 외',value:32,unit:'건'}],screen);
  assert.equal(churn.record,undefined);if(churn.acceptance==='failed')assert.equal(churn.verdict.status,'failed');
  const rows=(fixture.routes['/assistant/works']!.body as any).works;assert.deepEqual(rows.find((w:any)=>w.workId===churn.id).resultFacts,result,screen);
  for(const price of mission.works.filter((w:any)=>w.title==='경쟁사 가격')){assert.deepEqual(workResultFacts(price).resultFacts,{format:'massion-facts/v1',items:[{label:'요금제',value:6,unit:'개'},{label:'표',value:1,unit:'개'}]});assert.equal(price.record,undefined);}
 }
});

test('fixture members declare narrative progress through real step commands without converting prose to facts',async()=>{
 for(const screen of ['B9','B7-churn','B7-fail','B18-room-b']){
  const fixture=await loadFixture(screen),mission=(fixture.routes['/missions/intake']!.body as any).value;
  const {workCardFacts}=await import('../src/assistant-service.ts');
  for(const work of mission.works.filter((w:any)=>['이탈 원인 조사','경쟁사 가격'].includes(w.title))){
   const view=workCardFacts(work);assert.ok(view.progressNote?.summary,screen+' '+work.title);assert.ok(work.tasks.some((t:any)=>t.progress?.wording?.summary===view.progressNote?.summary));
   assert.equal(work.acceptance==='accepted',false);assert.equal(work.record,undefined);assert.ok(view.resultFacts);
  }
 }
});

test('environment card facts use the latest persisted booleans and declared labels instead of worker or page prose',async()=>{
 const {workCardFacts}=await import('../src/assistant-service.ts'),owner={id:'local-owner',roles:['owner'] as const},mission=createMission({id:'intake',purpose:'Fixture',scope:'local',constraints:[],criteria:{version:1,description:'Observe state',oracle:'fixture/v1'}},owner),{work}=roomTelemetryWork(mission,'pricing');
 const definition={memberId:'member:1',origin:'https://fixture.example',elements:[{id:'button',selector:'#button',role:'button',label:'전송',operations:['click' as const],gates:[]}],facts:[{id:'submitted',selector:'#submitted',state:'present' as const,label:'전송 상태',kind:'state' as const},{id:'confirmed',selector:'#confirmed',state:'present' as const,label:'접수 확인',kind:'order-confirmation' as const}],waits:[],secrets:[]};
 work.runtimeRun!.environment={id:'environment:1',feedId:'feed:1',definition};
 const observation=(at:number,confirmed:boolean)=>({index:0,at,kind:'observed' as const,observation:{observationId:'observation:'+at,binding:{environment:'environment:1',surface:'surface:1',origin:definition.origin,generation:1,revision:1},facts:{submitted:true,confirmed,undeclared:true},pageReadId:'page:'+at}});
 const workers=work.tasks.filter(t=>t.step);for(const [index,task] of workers.slice(0,2).entries())task.environment={inputHash:hash('fixture'),plan:{format:'massion-environment/v1',operations:[{kind:'observe',facts:['submitted','confirmed']}]},cursor:1,records:[observation(index===0?200:100,index!==0)]};
 workers[0]!.progress={done:1,total:1,at:Date.now(),wording:{summary:'페이지에는 완료라고 표시됨',caption:'완료'}};
 const before=structuredClone(work),view=workCardFacts(work);assert.equal(view.progressNote,null);assert.deepEqual(view.resultFacts,{format:'massion-facts/v1',items:[{label:'전송 상태',value:'확인됨'},{label:'접수 확인',value:'미확인'}]});assert.deepEqual(work,before);assert.notEqual(work.acceptance,'accepted');assert.equal(work.record,undefined);
 for(const task of work.tasks)delete task.environment;assert.equal(workCardFacts(work).resultFacts,null,'unobserved environment state must not fall back to worker claims');
});

test('environment summaries keep the existing eight-fact bounds and full labels remain in the pinned definition',async()=>{
 const {workCardFacts}=await import('../src/assistant-service.ts'),mission=createMission({id:'intake',purpose:'Fixture',scope:'local',constraints:[],criteria:{version:1,description:'Observe state',oracle:'fixture/v1'}},{id:'local-owner',roles:['owner']}),{work}=roomTelemetryWork(mission,'pricing');
 const facts=Array.from({length:9},(_,i)=>({id:'fact:'+i,selector:'#fact-'+i,state:'present' as const,label:i?'항목 '+i:'긴 관찰 이름'.repeat(30),kind:'state' as const}));
 work.runtimeRun!.environment={id:'environment:1',feedId:'feed:1',definition:{memberId:'member:1',origin:'https://fixture.example',elements:[],facts,waits:[],secrets:[]}};
 const task=work.tasks.find(t=>t.step)!;task.environment={inputHash:hash('fixture'),plan:{format:'massion-environment/v1',operations:[{kind:'observe',facts:facts.map(f=>f.id)}]},cursor:1,records:[{index:0,at:100,kind:'observed',observation:{observationId:'observation:1',binding:{environment:'environment:1',surface:'surface:1',origin:'https://fixture.example',generation:1,revision:1},facts:Object.fromEntries(facts.map(f=>[f.id,true])),pageReadId:'page:1'}}]};
 const view=workCardFacts(work);assert.equal(view.resultFacts?.items.length,8);assert.ok(parseResultFacts(JSON.stringify(view.resultFacts)));assert.equal(work.runtimeRun!.environment.definition.facts[0]!.label,'긴 관찰 이름'.repeat(30));
});
