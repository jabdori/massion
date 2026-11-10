import test from 'node:test';
import assert from 'node:assert/strict';
import {workCardFacts} from '../src/assistant-service.ts';
import {documentContentHash} from '../src/domain.ts';
import type {Work} from '../src/domain.ts';
import {githubReviewDocument} from '../src/github-review.ts';
import {Application} from '../src/application.ts';
import {hash,workInputHash,apply} from '../src/domain.ts';
import type {Command,Mission} from '../src/domain.ts';
import {InMemoryStore} from '../src/storage.ts';
import {ownerMessageId,assistantTurnId,assistantWorkId} from '../src/assistant-conversation.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {validateMissionLineage} from '../src/backup-lineage.ts';

function readingWork():Work {
 const document=githubReviewDocument({repository:'example/repo',number:1,headSha:'a'.repeat(40),url:'https://github.com/example/repo/pull/1'},'document:source',[{path:'a.ts',content:'A'},{path:'b.ts',content:'B'},{path:'c.ts',content:'C'}]);
 return {id:'work',tasks:[{id:'read',status:'active',step:{title:'Read',role:'Read',dependsOn:[],sourceFiles:['a.ts','b.ts']}}],assignments:[],effects:[],sourceDocuments:[{document}],acceptance:'pending',execution:'active'} as unknown as Work;
}
const delivery=(id:string,path:string,at:number,taskId='read')=>({id,taskId,status:'succeeded',deliveredAt:at,providerDispatch:{fileInputs:[{documentId:'document:source',path,sha256:documentContentHash(path==='a.ts'?'A':path==='b.ts'?'B':'C')}]}});
const completions=(work:Work)=>(workCardFacts(work) as any).fileReads;

test('read completion counts exact declared files once at their first delivery time, independent of later Work outcome',()=>{
 const work=readingWork();work.effects=[delivery('a','a.ts',110),delivery('b','b.ts',130),delivery('again','a.ts',180),delivery('other','c.ts',200)] as any;
 assert.deepEqual(completions(work),[{taskId:'read',count:2,completedAt:130}]);
 work.execution='blocked';work.effects.push({id:'later',status:'unknown'} as any);
 assert.deepEqual(completions(work),[{taskId:'read',count:2,completedAt:130}]);
 work.acceptance='failed';assert.deepEqual(completions(work),[{taskId:'read',count:2,completedAt:130}]);
});

test('partial, absent, untimed, skipped, wrong-step and changed-byte observations never complete reads',()=>{
 const work=readingWork();assert.deepEqual(completions(work),[]);
 work.effects=[delivery('a','a.ts',110)] as any;assert.deepEqual(completions(work),[]);
 for(const patch of [{status:'pending'},{status:'unknown'},{status:'failed'},{deliveredAt:undefined},{taskId:'another'},{providerDispatch:{fileInputs:[{documentId:'document:source',path:'b.ts',sha256:'f'.repeat(64)}]}}]){
  work.effects=[delivery('a','a.ts',110),{...delivery('b','b.ts',130),...patch}] as any;assert.deepEqual(completions(work),[]);
 }
 work.effects=[delivery('a','a.ts',110),delivery('b','b.ts',130)] as any;work.tasks[0]!.step!.skipReason='Not requested';assert.deepEqual(completions(work),[]);
 delete work.tasks[0]!.step!.skipReason;delete work.tasks[0]!.step!.sourceFiles;assert.deepEqual(completions(work),[]);
 work.effects.push(delivery('c','c.ts',140) as any);assert.deepEqual(completions(work),[{taskId:'read',count:3,completedAt:140}]);
});

async function pendingRead(){
 const owner={id:'owner',roles:['owner'] as const},rep={id:'rep',roles:['representative'] as const},worker={id:'worker',roles:['executor'] as const};
 let now=100,id=0;const store=new InMemoryStore<Mission>(),app=new Application(store,[owner,rep,worker,{id:'assistant-representative',roles:['assistant']}],()=>now++);
 await app.create({id:'mission',purpose:'Read',scope:'fixture',constraints:[],criteria:{version:1,description:'Read source',oracle:'fixture'}},owner.id,'create');
 const current=async()=>(await store.load('mission'))!;
 const send=async(command:Command,actorId=owner.id)=>app.dispatch({missionId:'mission',commandId:command.type==='admit-work'?'assistant-work:'+command.assistantSource!.turnId:'c'+id++,expectedRevision:(await current()).revision,actorId,command});
 const messageId=ownerMessageId('file-activity'),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),taskId=workId+':step:0',message={id:messageId,ordinal:1,actorId:owner.id,role:'owner' as const,turnId:null,text:'Read source'};
 await send({type:'admit-work',workId,title:'Read source',budget:20,team:memberProcedures(null,'member'),assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'fixture'},memberId:'member'}},'assistant-representative');
 const document=githubReviewDocument({repository:'example/repo',number:1,headSha:'a'.repeat(40),url:'https://github.com/example/repo/pull/1'},'document:source',[{path:'a.ts',content:'A'}]);
 await send({type:'capture-document',document});await send({type:'attach-work-source',workId,documentId:'document:source',version:1,contentSha256:documentContentHash(document.content),reason:'Read exact bytes'});
 const work=(await current()).value.works[0]!;
 await send({type:'activate-runtime',workId,run:{id:'run',authorizationId:'grant',criteriaHash:hash(work.criteria),inputHash:workInputHash(work),mode:'mock-http',outputTokenCap:1,ownership:{hostSessionId:'host',dispatchId:'dispatch',startedAt:100,deadlineAt:1000}}});
 await send({type:'delegate',workId,taskId:workId+':executor',parentId:workId+':root'},rep.id);
 await send({type:'delegate',workId,taskId,parentId:workId+':executor',step:{title:'Read',role:'Read',dependsOn:[],sourceFiles:['a.ts']}},rep.id);
 await send({type:'assign',workId,assignment:{id:'reader',actorId:worker.id,role:'executor',taskId,model:{provider:'fixture',model:'fixture',reason:'Fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'}},rep.id);
 await send({type:'admit-effect',workId,effect:{id:'read',taskId,status:'pending',target:'fixture/fixture',authority:'grant'},reserve:1},worker.id);
 await send({type:'claim-provider-dispatch',workId,effectId:'read',claim:{id:'claim',runId:'run',hostSessionId:'host',dispatchId:'dispatch',actorId:worker.id,assignmentId:'reader',provider:'fixture',model:'fixture',configVersion:'v1',requestHash:'b'.repeat(64),claimedAt:100,fileInputs:[{documentId:'document:source',path:'a.ts',sha256:documentContentHash('A')}]}},worker.id);
 return {store,app,current,send,worker,workId,taskId,setNow:(value:number)=>{now=value;}};
}

test('overlapping receipt replay retains one host delivery time and recorded event replay reproduces it',async()=>{
 const s=await pendingRead(),before=await s.current(),workId=s.workId,command:Command={type:'receipt',workId,effectId:'read',providerDispatchId:'claim',outcome:'succeeded',receipt:'Received exact file',usage:1};
 await assert.rejects(s.send({type:'admit-effect',workId,effect:{id:'forged',taskId:s.taskId,status:'pending',target:'fixture/fixture',authority:'grant',deliveredAt:1},reserve:0},s.worker.id),/pending and unclaimed/);
 s.setNow(99);await assert.rejects(s.send(command,s.worker.id),/delivery time precedes dispatch/);
 s.setNow(500);const envelope={missionId:'mission',commandId:'receipt',expectedRevision:before.revision,actorId:s.worker.id,command};
 const results=await Promise.all([s.app.dispatch(envelope),s.app.dispatch(envelope)]);assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
 const after=await s.current(),effect=after.value.works[0]!.effects[0] as any;assert.equal(effect.deliveredAt,500);
 assert.deepEqual(completions(after.value.works[0]!),[{taskId:s.taskId,count:1,completedAt:500}]);
 assert.equal((apply(before.value,command,{id:s.worker.id,roles:['executor']}).value.works[0]!.effects[0] as any).deliveredAt,undefined);
 const event=s.store.inspect().at(-1)!.events[0] as any;assert.deepEqual(apply(before.value,event.command,{id:s.worker.id,roles:['executor']},event.time).value,after.value);
 validateMissionLineage(after.value);
 const bad=structuredClone(after.value);(bad.works[0]!.effects[0] as any).deliveredAt=-1;assert.throws(()=>validateMissionLineage(bad),/delivery|time/i);
});

test('all three activity screen fixtures expose one command-produced completion with matching accepted receipts',async()=>{
 const {loadFixture}=await import('../scripts/ui-contracts/fixture-host.ts');
 for(const screen of ['B7-done','B7-fail','B7-unknown']){
  const f=await loadFixture(screen),mission=(f.routes['/missions/intake']!.body as any).value as Mission,work=mission.works.find(w=>w.title==='PR #84 검토')!;
  const rows=(f.routes['/assistant/works']!.body as any).works,read=rows.find((w:any)=>w.workId===work.id).fileReads;
  assert.equal(read.length,1);assert.equal(read[0].count,11);assert.equal(read[0].completedAt,1793855280001);
  assert.deepEqual(work.record!.receipts,work.effects);const {checksum,...bundle}=work.record!;assert.equal(checksum,hash(bundle));
  assert.ok(work.effects.some(e=>e.deliveredAt===1793855280001&&e.providerDispatch?.fileInputs?.length===11));
 }
});

test('unknown receipt and later owner reconciliation do not invent a delivery observation',async()=>{
 const s=await pendingRead(),workId=s.workId;await s.send({type:'receipt',workId,effectId:'read',providerDispatchId:'claim',outcome:'unknown',receipt:'No reply',usage:null},s.worker.id);
 await s.send({type:'reconcile-effect',workId,effectId:'read',outcome:'succeeded',receipt:'Owner readback'});
 const after=await s.current();assert.equal((after.value.works[0]!.effects[0] as any).deliveredAt,undefined);assert.deepEqual(completions(after.value.works[0]!),[]);validateMissionLineage(after.value);
});
