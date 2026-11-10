import test from 'node:test';
import assert from 'node:assert/strict';
import {apply,canonical,createMission,hash,workInputHash,DomainError} from '../src/domain.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';

const owner={id:'local-owner',roles:['owner'] as const},rep={id:'runtime-representative',roles:['representative'] as const},host={id:'environment-work-host',roles:['representative'] as const},worker={id:'worker',roles:['executor'] as const};
const definition={memberId:'member',origin:'https://fixture.example',elements:[{id:'field',selector:'#field',role:'textbox',label:'입력',operations:['type'],gates:[{kind:'personal-data-submission'}]}],facts:[{id:'filled',selector:'#field',state:'value-present',label:'입력 확인',kind:'state'}],waits:[],secrets:[{id:'value',label:'입력 정보',purpose:'필드 입력',fields:[{slot:'value',label:'입력값',kind:'id',element:'field'}]}]};
const plan={format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',secret:{owner:'local-owner',slot:'value'}}},{kind:'observe',facts:['filled']}]};
function fixture(){
 let mission=createMission({id:'m',purpose:'Fixture',scope:'local',constraints:[],criteria:{version:1,description:'Observe the result',oracle:'bounded-text-review/v1'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'w',title:'Native form',budget:50},owner).value;mission.works[0]!.team=memberProcedures(null,'member');
 const inputHash=workInputHash(mission.works[0]!);
 mission=apply(mission,{type:'activate-runtime',workId:'w',run:{id:'run',authorizationId:'grant',criteriaHash:hash(mission.criteria),inputHash,mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:1000,deadlineAt:5000},environment:{id:'env',feedId:'feed',definition}}} as any,owner).value;
 mission=apply(mission,{type:'delegate',workId:'w',taskId:'w:executor',parentId:'w:root'},rep).value;
 mission=apply(mission,{type:'delegate',workId:'w',taskId:'w:step:0',parentId:'w:executor',step:{title:'Fill',role:'입력',dependsOn:[]}},rep).value;
 mission=apply(mission,{type:'assign',workId:'w',assignment:{id:'worker-assignment',actorId:worker.id,role:'executor',taskId:'w:step:0',model:{provider:'fixture',model:'fixture',configVersion:'v1',reason:'Fixture',evidenceClass:'fixture'},extensionVersion:'v1'}},rep).value;
 const command=(update:object,index=0)=>({type:'record-environment-work',workId:'w',taskId:'w:step:0',environment:'env',dispatchId:'dispatch',inputHash,index,update});
 const time={observedAt:1001,telemetryVersion:2 as const};return {mission,command,time,inputHash};
}

test('the host checkpoints a bound step, waits, and atomically claims one effect after approval',()=>{
 const f=fixture();let m:any;assert.doesNotThrow(()=>{m=apply(f.mission,f.command({kind:'begin',plan}) as any,host,f.time).value;});
 const reference={id:'entry',hash:hash('action'),at:1000,deadline:4000};m=apply(m,f.command({kind:'link',reference,waiting:true}) as any,host,f.time).value;assert.equal(m.works[0].execution,'waiting');
 assert.throws(()=>apply(m,f.command({kind:'claim'}) as any,host,f.time));
 m=apply(m,f.command({kind:'resume',approvedAt:1001}) as any,host,f.time).value;m=apply(m,f.command({kind:'claim'}) as any,host,f.time).value;assert.equal(m.works[0].effects.length,1);assert.equal(m.works[0].effects[0].status,'pending');assert.throws(()=>apply(m,f.command({kind:'claim'}) as any,host,f.time));
 const pending=m.works[0].tasks.find((t:any)=>t.id==='w:step:0').environment.pending;assert.equal(pending.phase,'claimed');assert.equal(pending.effectId,m.works[0].effects[0].id);
});

test('owner input, expired ownership and changed input bindings cannot create host claims',()=>{
 const f=fixture(),command=f.command({kind:'begin',plan});assert.throws(()=>apply(f.mission,command as any,owner,f.time),e=>e instanceof DomainError&&e.code==='denied');
 for(const changed of [{...command,inputHash:hash('other')},{...command,dispatchId:'other'}])assert.throws(()=>apply(f.mission,changed as any,host,f.time));
 assert.throws(()=>apply(f.mission,command as any,host,{...f.time,observedAt:5000}));assert.throws(()=>apply(f.mission,{type:'cancel',workId:'w'},host));
});

test('overlapping identical step checkpoints replay the stored receipt rather than creating another plan',async()=>{
 const f=fixture(),store=new InMemoryStore<any>();await store.commit({id:'m',commandId:'seed',expectedRevision:0,fingerprint:hash(f.mission),value:f.mission,events:[],outbox:[]});const app=new Application(store,[host],()=>1001),request={missionId:'m',commandId:'begin',expectedRevision:1,actorId:host.id,command:f.command({kind:'begin',plan}) as any};
 const results=await Promise.all([app.dispatch(request),app.dispatch(request)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);assert.equal((await store.load('m'))!.value.works[0].tasks.find((t:any)=>t.id==='w:step:0').environment.cursor,0);
 await app.dispatch({...request,commandId:'link',expectedRevision:2,command:f.command({kind:'link',reference:{id:'entry',hash:hash('action'),at:1000,deadline:4000},waiting:true}) as any});const replay=await app.dispatch({...request,expectedRevision:3});assert.equal(replay.status,'replayed');assert.equal(replay.value.works[0]!.execution,'active');assert.equal((await store.load('m'))!.value.works[0].execution,'waiting');
});


test('a claimed action advances only after its exact delivery receipt, never an unknown result',()=>{
 const f=fixture(),reference={id:'entry',hash:hash('action'),at:1000,deadline:4000};let m=apply(f.mission,f.command({kind:'begin',plan}) as any,host,f.time).value;
 for(const update of [{kind:'link',reference,waiting:true},{kind:'resume',approvedAt:1001},{kind:'claim'}])m=apply(m,f.command(update) as any,host,f.time).value;
 assert.throws(()=>apply(m,f.command({kind:'complete',result:'delivered'}) as any,host,f.time));const effectId=m.works[0]!.effects[0]!.id;
 const uncertain=apply(m,{type:'receipt',workId:'w',effectId,outcome:'unknown',receipt:'Not confirmed',usage:null},worker,f.time).value;assert.throws(()=>apply(uncertain,f.command({kind:'complete',result:'delivered'}) as any,host,f.time));
 m=apply(m,{type:'receipt',workId:'w',effectId,outcome:'succeeded',receipt:JSON.stringify({kind:'environment-delivery/v1',environment:'env',entryId:reference.id,requestHash:reference.hash}),usage:0},worker,f.time).value;
 m=apply(m,f.command({kind:'complete',result:'delivered'}) as any,host,f.time).value;const step=(m.works[0]!.tasks.find(t=>t.id==='w:step:0') as any).environment;assert.equal(step.cursor,1);assert.equal(step.pending,undefined);assert.equal(step.records[0].kind,'delivered');
});

test('host observation records bind a retained page and declared booleans without accepting page text as proof',()=>{
 const f=fixture(),readPlan={format:'massion-environment/v1',operations:[{kind:'observe',facts:['filled']}]};let m=apply(f.mission,f.command({kind:'begin',plan:readPlan}) as any,host,f.time).value;
 assert.throws(()=>apply(m,{type:'settle-task',workId:'w',taskId:'w:step:0',result:'Unobserved'},worker,f.time));
 const observation={observationId:'assistant-environment:read',binding:{environment:'env',surface:'surface',origin:definition.origin,generation:1,revision:1},facts:{filled:true},pageReadId:'page'};
 assert.throws(()=>apply(m,f.command({kind:'observe',observation}) as any,host,f.time));
 m=apply(m,{type:'record-browser-page',workId:'w',sessionId:'browser',navigationId:'navigation',page:{readId:'page',expectedRevision:1,inputHash:f.inputHash,at:1001,address:definition.origin,title:'Fixture',blocks:[],fields:[]}}, {id:'browser-read-host',roles:['representative']}).value;
 for(const facts of [{filled:'confirmed'},{filled:true,extra:true}])assert.throws(()=>apply(m,f.command({kind:'observe',observation:{...observation,facts}}) as any,host,f.time));
 const c=f.command({kind:'observe',observation});assert.deepEqual(apply(m,c as any,host,f.time),apply(JSON.parse(canonical(m)),JSON.parse(canonical(c)),host,f.time));
 m=apply(m,f.command({kind:'observe',observation}) as any,host,f.time).value;const step=(m.works[0]!.tasks.find(t=>t.id==='w:step:0') as any).environment;assert.equal(step.cursor,1);assert.deepEqual(step.records[0].observation.facts,{filled:true});assert.equal(m.works[0]!.effects[0]!.status,'succeeded');assert.match(m.works[0]!.effects[0]!.receipt!,/environment-observation\/v1/);assert.equal(step.records[0].at,1001);assert.equal(m.works[0]!.effects[0]!.deliveredAt,undefined);
});
