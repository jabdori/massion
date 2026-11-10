import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import {createMission,hash} from '../src/domain.ts';
import {parseResultFacts,workResultFacts} from '../src/result-facts.ts';
import {roomTelemetryWork} from '../scripts/ui-contracts/room-telemetry-fixtures.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {validateMissionLineage} from '../src/backup-lineage.ts';

const facts={format:'massion-facts/v1',kind:'churn',reasons:41,business:9,other:32};
test('checking-seat text cannot overwrite producer counts or invent business observations',()=>{
 const mission=createMission({id:'intake',purpose:'Prices',scope:'local',constraints:[],criteria:{version:1,description:'Controlled prices',oracle:'fixture/v1'}},{id:'local-owner',roles:['owner']}),{work}=roomTelemetryWork(mission,'pricing'),checker=work.tasks.find(t=>t.id===work.id+':verifier')!;
 checker.status='settled';checker.result=JSON.stringify({format:'massion-facts/v1',kind:'causes',causes:999,evidence:999});
 assert.deepEqual(workResultFacts(work).resultFacts,{format:'massion-facts/v1',kind:'pricing',plans:6,tables:1});
});
test('business facts reject extra fields, inconsistent totals, noninteger and unbounded counts',()=>{
 assert.deepEqual(parseResultFacts(JSON.stringify(facts)),facts);
 for(const value of [null,[],{...facts,other:33},{...facts,business:-1},{...facts,reasons:41.5},{...facts,reasons:'41'},{...facts,other:Infinity},{...facts,other:null},{...facts,kind:'unknown'},{...facts,accepted:true},{...facts,reason:'prose'}])assert.equal(parseResultFacts(JSON.stringify(value)),null);
 for(const kind of ['pricing','causes'] as const){const value=kind==='pricing'?{format:'massion-facts/v1',kind,plans:0,tables:0}:{format:'massion-facts/v1',kind,causes:1,evidence:2};assert.deepEqual(parseResultFacts(JSON.stringify(value)),value);}
 assert.equal(parseResultFacts(JSON.stringify({...facts,reasons:1_000_000_001,business:1_000_000_001,other:0})),null);
 assert.equal(parseResultFacts(' '.repeat(1024)+JSON.stringify(facts)),null);
 for(const text of ['41 reasons, business 9, other 32','{"format":"massion-facts/v1",','```json\n'+JSON.stringify(facts)+'\n```'])assert.equal(parseResultFacts(text),null);
});
test('overlapping task result commands retain one original bounded observation and never create acceptance',async()=>{
 const owner={id:'local-owner',roles:['owner'] as const},mission=createMission({id:'intake',purpose:'Controlled prices',scope:'local',constraints:[],criteria:{version:1,description:'Controlled output',oracle:'fixture/v1'}},owner),{work}=roomTelemetryWork(mission,'pricing');
 const store=new InMemoryStore<typeof mission>(),state={...mission,works:[work]};await store.commit({id:mission.id,commandId:'seed',expectedRevision:0,fingerprint:hash(state),value:state,events:[],outbox:[]});
 const app=new Application(store,[{id:'executor',roles:['executor']}]),envelope={missionId:mission.id,actorId:'executor',commandId:'facts',expectedRevision:1,command:{type:'settle-task' as const,workId:work.id,taskId:work.id+':executor',result:JSON.stringify(facts)}};
 await assert.rejects(app.dispatch({...envelope,commandId:'invalid',command:{...envelope.command,result:JSON.stringify({...facts,other:33})}}),/Invalid bounded/);
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const saved=(await store.load(mission.id))!.value.works[0]!;assert.deepEqual(workResultFacts(saved).resultFacts,facts);assert.equal(saved.acceptance,'pending');assert.equal(saved.record,undefined);
 validateMissionLineage({...mission,works:[saved]});
});
test('activity and done-screen business procedures retain real steps, host observations and failed checks',async()=>{
 for(const screen of ['B2','B3-run','B5','B6','B7-done','B7-fail','B7-unknown','B8-done','B9','B9-restart','B9-update','B15','B18','B18-room-b']){
  const fixture=await loadFixture(screen),mission=(fixture.routes['/missions/intake']!.body as any).value;
  const churn=mission.works.find((w:any)=>w.title==='이탈 원인 조사');assert.equal(churn.tasks.filter((t:any)=>t.step).length,5,screen);
  assert.ok(churn.tasks.filter((t:any)=>t.step&&t.status==='settled').every((t:any)=>Number.isSafeInteger(t.endedAt)),screen);
  const result=workResultFacts(churn).resultFacts;assert.ok(result,screen);assert.equal(result.kind,churn.acceptance==='failed'?'causes':'churn',screen);
  assert.equal(churn.record,undefined);if(churn.acceptance==='failed')assert.equal(churn.verdict.status,'failed');
  const rows=(fixture.routes['/assistant/works']!.body as any).works;assert.deepEqual(rows.find((w:any)=>w.workId===churn.id).resultFacts,result,screen);
  for(const price of mission.works.filter((w:any)=>w.title==='경쟁사 가격')){assert.deepEqual(workResultFacts(price).resultFacts,{format:'massion-facts/v1',kind:'pricing',plans:6,tables:1});assert.equal(price.record,undefined);}
 }
});
