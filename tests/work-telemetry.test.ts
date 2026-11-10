import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {apply,createMission,workInputHash} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const owner={id:'owner',roles:['owner'] as const},rep={id:'rep',roles:['representative'] as const},worker={id:'worker',roles:['executor'] as const};
const input={id:'mission',purpose:'Retain observations',scope:'fixture',criteria:{version:1,description:'Read the source',oracle:'fixture'},constraints:[]};
async function setup(){let now=100;const store=new InMemoryStore<Mission>(),app=new Application(store,[owner,rep,worker],()=>now++);await app.create(input,owner.id,'create');let id=0;const send=async(command:Command,actorId=owner.id)=>app.dispatch({missionId:input.id,commandId:'command-'+id++,expectedRevision:(await store.load(input.id))!.revision,actorId,command});await send({type:'admit-work',workId:'work',title:'Read',budget:10});return {store,app,send};}

test('overlapping identical owner messages retain one original timestamp and cannot forge it',async()=>{
 const {store,app}=await setup(),before=(await store.load(input.id))!,envelope={missionId:input.id,commandId:'message',expectedRevision:before.revision,actorId:owner.id,command:{type:'append-work-message' as const,workId:'work',messageId:'message',replyTo:null,text:'Read only'}};
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const after=(await store.load(input.id))!,message=after.value.conversations![0]!.messages[0]!;assert.ok(Number.isSafeInteger(message.at));assert.equal(after.value.conversations![0]!.messages.length,1);assert.equal(workInputHash(after.value.works[0]!),workInputHash(before.value.works[0]!));
 const replay=await app.dispatch(envelope);assert.ok(replay.status!=='conflict');assert.deepEqual(replay.value,after.value);
 await assert.rejects(app.dispatch({...envelope,commandId:'forged',expectedRevision:after.revision,command:{...envelope.command,messageId:'forged',at:0} as Command}),/Exact owner message/);
 validateMissionJournalLineage(store.inspect());
 const tampered=structuredClone(store.inspect());tampered.at(-1)!.value.conversations![0]!.messages[0]!.at=0;assert.throws(()=>validateMissionJournalLineage(tampered),/replay|derived|differs|match/i);
});

test('effect admission and settlement record separate task times; unknown effects never gain an end',async()=>{
 const {store,send}=await setup();await send({type:'delegate',workId:'work',taskId:'task',parentId:'work:root'},rep.id);
 await send({type:'assign',workId:'work',assignment:{id:'assignment',actorId:worker.id,role:'executor',taskId:'task',model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'admit-effect',workId:'work',effect:{id:'effect',taskId:'task',status:'pending',target:'fixture',authority:'fixture'},reserve:1},worker.id);
 let w=(await store.load(input.id))!.value.works[0]!;assert.ok(w.tasks[1]!.startedAt!>w.admittedAt!);assert.equal(w.tasks[1]!.endedAt,undefined);
 await send({type:'receipt',workId:'work',effectId:'effect',outcome:'unknown',receipt:'Lost response',usage:null},worker.id);
 await assert.rejects(send({type:'settle-task',workId:'work',taskId:'task',result:'Done'},worker.id),/unsettled effects/);
 w=(await store.load(input.id))!.value.works[0]!;assert.equal(w.tasks[1]!.endedAt,undefined);
 await send({type:'reconcile-effect',workId:'work',effectId:'effect',outcome:'succeeded',receipt:'Independent readback'});
 await send({type:'settle-task',workId:'work',taskId:'task',result:'Read source'},worker.id);
 w=(await store.load(input.id))!.value.works[0]!;assert.ok(w.tasks[1]!.endedAt!>w.tasks[1]!.startedAt!);validateMissionJournalLineage(store.inspect());
});

test('legacy transitions remain untimed and telemetry does not become command authority',()=>{
 const m=createMission(input,owner),command={type:'admit-work' as const,workId:'work',title:'Read',budget:10};
 const legacy=apply(m,command,owner);assert.equal(legacy.value.works[0]!.admittedAt,undefined);
 assert.equal(Object.hasOwn(legacy.events[0] as object,'time'),false);assert.deepEqual(legacy.value.works[0]!.tasks,[{id:'work:root',parentId:null,status:'queued'}]);
 assert.throws(()=>apply(m,command,owner,{observedAt:-1,telemetryVersion:1}),/time/);
});

async function teamFixture(){
 const {memberProcedures}=await import('../src/internal-teams.ts'),s=await setup();
 const snapshot=(await s.store.load(input.id))!,m=snapshot.value;m.works[0]!.team=memberProcedures(null,'member');
 await s.store.commit({id:input.id,commandId:'fixture-team',expectedRevision:snapshot.revision,fingerprint:'fixture-team',value:m,events:[],outbox:[]});
 await s.send({type:'delegate',workId:'work',taskId:'work:executor',parentId:'work:root'},rep.id);
 await s.send({type:'delegate',workId:'work',taskId:'work:step:0',parentId:'work:executor',step:{title:'Read',role:'Read',dependsOn:[]}},rep.id);
 await s.send({type:'assign',workId:'work',assignment:{id:'reader',actorId:worker.id,role:'executor',taskId:'work:step:0',model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await s.send({type:'admit-effect',workId:'work',effect:{id:'read',taskId:'work:step:0',status:'pending',target:'fixture inputs',authority:'fixture'},reserve:1},worker.id);
 return s;
}

test('assigned step progress is bounded, monotonic and replayed once; unknown effects fence observations',async()=>{
 const s=await teamFixture(),command={type:'record-step-progress',workId:'work',taskId:'work:step:0',progress:{done:4,total:11,note:{label:'Source C',text:'Annual price only'}}} as Command;
 const envelope={missionId:input.id,commandId:'progress',expectedRevision:(await s.store.load(input.id))!.revision,actorId:worker.id,command};
 const results=await Promise.all([s.app.dispatch(envelope),s.app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const w=(await s.store.load(input.id))!.value.works[0]!,p=w.tasks.find(t=>t.step)!.progress!;assert.equal(p.done,4);assert.equal(p.total,11);assert.ok(Number.isSafeInteger(p.at));assert.equal(w.acceptance,'pending');
 for(const progress of [null,[],{done:3,total:11},{done:5,total:12},{done:12,total:11},{done:4,total:11,at:0}])await assert.rejects(s.send({...command,progress} as Command,worker.id),/progress/);
 await assert.rejects(s.send(command,owner.id),/role|assigned/);
 await s.send({type:'receipt',workId:'work',effectId:'read',outcome:'unknown',receipt:'Unknown',usage:null},worker.id);
 await assert.rejects(s.send({...command,progress:{done:5,total:11}} as Command,worker.id),/unknown|Unresolved/);
});

test('step notes stay owner discussion, bind an exact step and use the drain-aware message store',async()=>{
 const s=await teamFixture(),{ProductService}=await import('../src/product.ts'),{HostDrainError}=await import('../src/runtime-lifetime.ts');
 const before=(await s.store.load(input.id))!,product=new ProductService(s.store),message={commandId:'step-note',expectedRevision:before.revision,workId:'work',messageId:'step-note',replyTo:null,text:'Run tests first',stepNote:{taskId:'work:step:0',title:'Tests first'}};
 const replies=await Promise.all([product.appendWorkMessage(input.id,message),product.appendWorkMessage(input.id,message)]);assert.deepEqual(replies.map(r=>r.status).sort(),['committed','replayed']);
 const after=(await s.store.load(input.id))!;assert.deepEqual(after.value.works,before.value.works);assert.deepEqual(after.value.conversations![0]!.messages[0]!.stepNote,message.stepNote);
 await assert.rejects(product.appendWorkMessage(input.id,{...message,commandId:'wrong-step',messageId:'wrong-step',expectedRevision:after.revision,stepNote:{taskId:'other:step:0',title:'Wrong Work'}}),/step/);
 const guarded=new Proxy(s.store,{get(target,key){if(key==='commit')return ()=>{throw new HostDrainError();};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(new ProductService(guarded).appendWorkMessage(input.id,{...message,commandId:'drain-note',messageId:'drain-note',expectedRevision:after.revision}),HostDrainError);assert.deepEqual(await s.store.load(input.id),after);
});

test('independent predicate observations have host times while v1 replay retains its original shape',async()=>{
 const {store,send}=await setup(),verifier={id:'verifier',roles:['verifier'] as const};
 await send({type:'assign',workId:'work',assignment:{id:'producer',actorId:worker.id,role:'executor',taskId:'work:root',model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'assign',workId:'work',assignment:{id:'checker',actorId:verifier.id,role:'verifier',taskId:'work:root',model:{provider:'fixture',model:'checker',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'admit-effect',workId:'work',effect:{id:'produce',taskId:'work:root',status:'pending',target:'fixture',authority:'fixture'},reserve:1},worker.id);
 await send({type:'receipt',workId:'work',effectId:'produce',outcome:'succeeded',receipt:'Read source',usage:1},worker.id);
 await send({type:'settle-task',workId:'work',taskId:'work:root',result:'Read source'},worker.id);
 await send({type:'publish-artifact',workId:'work',artifact:{id:'work:text',version:1,sha256:'a'.repeat(64),path:'/fixture/work/'+'a'.repeat(64)+'.txt',kind:'text'}},worker.id);
 const before=(await store.load(input.id))!,app=new Application(store,[owner,worker,verifier],()=>500),command:Command={type:'verify',workId:'work',verdict:{id:'verdict',verifierAssignmentId:'checker',artifactSha256:'a'.repeat(64),artifactVersion:1,criteriaVersion:1,status:'passed',evidence:[{kind:'fixture',detail:'Independent source readback',source:'checker'}],predicates:[{criterion:input.criteria.description,passed:true,quote:'Read source',reason:'Matches the source'}]}};
 const envelope={missionId:input.id,commandId:'check',expectedRevision:before.revision,actorId:verifier.id,command};
 const replies=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(replies.map(r=>r.status).sort(),['committed','replayed']);
 const after=(await store.load(input.id))!,verdict=after.value.works[0]!.verdict!;
 assert.equal(verdict.predicates![0]!.checkedAt,500);assert.equal(verdict.checkedAt,500);assert.equal(after.value.works[0]!.acceptance,'pending');
 assert.equal(apply(before.value,command,verifier,{observedAt:500,telemetryVersion:1}).value.works[0]!.verdict!.predicates![0]!.checkedAt,undefined);
 await assert.rejects(app.dispatch({...envelope,commandId:'forged-check',expectedRevision:after.revision,command:{...command,verdict:{...command.verdict,predicates:[{...command.verdict.predicates![0]!,checkedAt:1}]}} as Command}),/predicates/);
 validateMissionJournalLineage(store.inspect());
 const tampered=structuredClone(store.inspect());tampered.at(-1)!.value.works[0]!.verdict!.predicates![0]!.checkedAt=1;
 assert.throws(()=>validateMissionJournalLineage(tampered),/time|predicates|replay|derived|differs|match/i);
});

test('a worker acknowledges an owner proposal only before its step starts, preserving admission pins',async()=>{
 const s=await teamFixture();
 await s.send({type:'delegate',workId:'work',taskId:'work:step:1',parentId:'work:executor',step:{title:'Draft',role:'Write',dependsOn:['work:step:0'],instruction:'Draft after reading'}},rep.id);
 await s.send({type:'assign',workId:'work',assignment:{id:'writer',actorId:worker.id+'2',role:'executor',taskId:'work:step:1',model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await s.send({type:'append-work-message',workId:'work',messageId:'edit',replyTo:null,text:'Write tests before the draft',stepNote:{taskId:'work:step:1',title:'Tests first'}});
 const before=(await s.store.load(input.id))!,app=new Application(s.store,[owner,{id:'worker2',roles:['executor']}],()=>500);
 const command={type:'acknowledge-step-note',workId:'work',messageId:'edit'} as unknown as Command;
 const envelope={missionId:input.id,commandId:'ack',expectedRevision:before.revision,actorId:'worker2',command};
 const results=await Promise.all([app.dispatch(envelope),app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const after=(await s.store.load(input.id))!,w=after.value.works[0]!,task=w.tasks.find(t=>t.id==='work:step:1')!;
 assert.deepEqual(task.step,before.value.works[0]!.tasks.find(t=>t.id===task.id)!.step);assert.deepEqual(w.team,before.value.works[0]!.team);
 assert.deepEqual((task as any).procedureEdit,{messageId:'edit',actorId:'worker2',title:'Tests first',instruction:'Write tests before the draft',at:500});
 assert.notEqual(workInputHash(w),workInputHash(before.value.works[0]!));
 await assert.rejects(app.dispatch({...envelope,commandId:'owner-ack',expectedRevision:after.revision,actorId:owner.id}),/role|assigned/);
 await s.send({type:'append-work-message',workId:'work',messageId:'late',replyTo:null,text:'Too late',stepNote:{taskId:'work:step:0',title:'Rewrite started step'}});
 await assert.rejects(s.send({type:'acknowledge-step-note',workId:'work',messageId:'late'} as unknown as Command,worker.id),/started|queued/);
});

test('member progress wording is bounded, assignment-bound and durably replayed without acceptance',async()=>{
 const s=await teamFixture(),wording={summary:'Read 4 files. Comparing sources now.',caption:'Reading complete · comparing',checkCaption:'At least 3 sources'};
 const command={type:'record-step-progress',workId:'work',taskId:'work:step:0',progress:{done:4,total:11,wording}} as unknown as Command;
 const before=(await s.store.load(input.id))!,envelope={missionId:input.id,commandId:'wording',expectedRevision:before.revision,actorId:worker.id,command};
 const results=await Promise.all([s.app.dispatch(envelope),s.app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const saved=(await s.store.load(input.id))!.value.works[0]!;assert.deepEqual((saved.tasks.find(t=>t.step)!.progress as any).wording,wording);assert.equal(saved.acceptance,'pending');assert.deepEqual((await s.app.dispatch(envelope) as any).value.works[0],saved);
 for(const bad of [null,[],{}, {...wording,summary:'x'.repeat(201)},{...wording,caption:'x'.repeat(101)},{...wording,summary:'line\nbreak'},{...wording,summary:'\u202e'},{...wording,summary:'\ud800'},{...wording,summary:' leading'},{...wording,accepted:true}])await assert.rejects(s.send({...command,progress:{done:4,total:11,wording:bad}} as unknown as Command,worker.id),/wording/);
 await assert.rejects(s.send(command,owner.id),/role|assigned/);
 await s.send({type:'receipt',workId:'work',effectId:'read',outcome:'unknown',receipt:'Unknown',usage:null},worker.id);
 await assert.rejects(s.send(command,worker.id),/unknown|Unresolved/);
});
