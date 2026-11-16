/** Stage-1 durable run queue: joining, the single taker and the hand-over (docs/architecture/host-admission.md). Re-run marker. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {growthStore} from './support/growth-fixture.ts';
import {InMemoryHostSettings} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {Application} from '../src/application.ts';
import {ASSISTANT_ACTOR_ID} from '../src/assistant-conversation.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {RUN_QUEUE_ID,MAX_RUN_QUEUE_ENTRIES} from '../src/run-queue.ts';
import {hash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';

const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]} as never);
type Fixture=Awaited<ReturnType<typeof queueFixture>>;
/** Holds the verifier of named Works so a run occupies the slot at a deterministic point; tracks overlapping model calls. */
async function queueFixture(t:import('node:test').TestContext,durable=false,verdicts:Record<string,'passed'|'failed'>={},reuse?:{store:Store<any>}){
 const root=await mkdtemp(join(tempRoot(),'massion-run-queue-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=(reuse?.store??(await growthStore(durable)).store) as Store<any>,artifacts=new TextArtifactStore(join(root,'artifacts')),settings=new InMemoryHostSettings();
 const gates=new Map<string,Promise<void>>(),releases=new Map<string,()=>void>(),calls:{workId:string;role:string}[]=[];let overlaps=0,inFlight=0;
 let queueLoadGate:Promise<void>|undefined,queueLoadRelease:(()=>void)|undefined,heldQueueLoad=false;
 const gated=queueGate(store,()=>({gate:queueLoadGate,armed:heldQueueLoad,observe:()=>{heldQueueLoad=false;}}));
 const transport=async(_url:any,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body));let prompt:any={};try{prompt=JSON.parse(body.messages[0].content);}catch{}
  if(Object.hasOwn(prompt,'currentMessage'))return reply(body.model,JSON.stringify({reply:'ok',work:null}));
  const workId=prompt.binding?.workId as string,role=prompt.artifact?'verifier':'executor';
  inFlight++;if(inFlight>1)overlaps++;
  if(role==='verifier'){const gate=gates.get(workId);if(gate)await gate;}
  calls.push({workId,role});inFlight--;
  if(prompt.artifact)return reply(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:verdicts[workId]??'passed',checks:[{criterion:prompt.criteria.description,passed:(verdicts[workId]??'passed')==='passed',quote:'Answer bounded',reason:'Controlled fixture'}]}));
  return reply(body.model,'Answer bounded fixture text');
 };
 function reply(model:string,content:string){return new Response(JSON.stringify({id:'x',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});}
 const m=createHostConnections(gated,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'x',settings});
 const product=new ProductService(store,undefined,m);m.setRunQueueDrain(()=>product.runQueuePass());
 await product.create({id:'m1',purpose:'Queue fixture',scope:'local',constraints:[],criteria:{version:1,description:'Original bounded queue fixture',oracle:'bounded-text-review/v1'}},'create-m1');
 const profile=(model:string)=>(m.list().runtime.connections as any[]).find((p:any)=>p.model===model).id as string;
 await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));
 const choice={executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),authorizationId:'grant',outputTokenCap:4};
 const app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'runtime-representative',roles:['representative']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']}]);
 const revision=async(id='m1')=>(await store.load(id))!.revision;
 const admit=async(workId:string,missionId='m1')=>product.admit(missionId,{commandId:'admit-'+workId,expectedRevision:await revision(missionId),workId,title:'Work '+workId,budget:8});
 const run=async(workId:string,runId:string,missionId='m1')=>product.run(missionId,workId,runId,await revision(missionId),choice);
 const work=async(workId:string,missionId='m1')=>((await store.load(missionId))!.value as Mission).works.find(w=>w.id===workId)!;
 const hold=async(workId:string)=>{const p=new Promise<void>(r=>releases.set(workId,r));gates.set(workId,p);};
 const release=(workId:string)=>{gates.delete(workId);releases.get(workId)!();releases.delete(workId);};
 const holdQueueLoad=()=>{heldQueueLoad=true;queueLoadGate=new Promise<void>(r=>queueLoadRelease=r);};
 const releaseQueueLoad=()=>{if(!queueLoadRelease)return;heldQueueLoad=false;queueLoadRelease();queueLoadRelease=undefined;};
 const untilWork=async(check:()=>Promise<boolean>|boolean,limit=4000)=>{for(let i=0;i<limit;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Run queue fixture deadline');};
 return {store,m,product,app,choice,calls,admit,run,work,revision,hold,release,holdQueueLoad,releaseQueueLoad,untilWork,overlaps:()=>overlaps,queue:()=>m.runQueue.entries()};
}
function queueGate(store:Store<any>,state:()=>{gate:Promise<void>|undefined;armed:boolean;observe:()=>void}):Store<any>{
 return new Proxy(store,{get(target,key){
  if(key==='load')return async(id:string)=>{const s=state();if(s.armed&&id===RUN_QUEUE_ID){s.observe();await s.gate;}return target.load(id);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

for(const durable of [false,true])test(`queueFixture ${durable?'durable':'memory'} sanity: one slot, join, hand-over`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');
 await f.untilWork(async()=>(await f.queue()).length===0&&false||f.calls.length===1&&true);
 const joined=await f.run('b','run-b');
 assert.equal(joined.status,'queued');assert.equal((await f.work('b')).runtimeRun,undefined);
 f.release('a');assert.equal((await a).status,'settled');
 await f.untilWork(async()=>(await f.work('b')).acceptance==='accepted');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');assert.equal(f.overlaps(),0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a Work nobody asked to run never starts by itself while the queue drains`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable,{revised:'failed'});
 // Three unrequested Works whose execution is 'queued': only created, revised after a failed check, and back from budget waiting.
 await f.admit('created');await f.admit('revised');await f.admit('budget');
 let rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'wait-budget',expectedRevision:rev,actorId:'runtime-representative',command:{type:'wait-monthly-budget',workId:'budget',decisionId:'d1'}});
 rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'resume-budget',expectedRevision:rev,actorId:'local-owner',command:{type:'resume-monthly-budget',workId:'budget',decisionId:'d1'}});
 const failed=await f.run('revised','run-revised');
 await f.untilWork(async()=>(await f.work('revised')).verdict?.status==='failed');
 rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'revise',expectedRevision:rev,actorId:'local-owner',command:{type:'revise-work',workId:'revised'}});
 // Admit-only Work keeps today's runtime gate ('blocked'); revise-work and the budget resume set 'queued'. None was ever run-requested.
 assert.equal((await f.work('created')).execution,'blocked');
 for(const id of ['revised','budget'])assert.equal((await f.work(id)).execution,'queued');
 await f.hold('a');await f.admit('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.some(c=>c.workId==='a'&&c.role==='executor'));
 const queued=await f.run('created','never-requested');
 assert.equal(queued.status,'queued');
 f.release('a');await a;await f.untilWork(async()=>(await f.work('created')).acceptance==='accepted');
 for(const id of ['revised','budget'])assert.equal((await f.work(id)).acceptance,'pending');
 assert.equal((await f.work('revised')).runtimeRun!.id,'run-revised');
 assert.equal((await f.work('budget')).runtimeRun,undefined);
 assert.equal((await f.work('created')).runtimeRun!.id,'never-requested');
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} the queue continues by itself: B and C wait untouched, then start in order with no further request`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');await f.admit('c');
 const bBefore=structuredClone(await f.work('b')),cBefore=structuredClone(await f.work('c'));
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 assert.equal((await f.run('b','run-b')).status,'queued');assert.equal((await f.run('c','run-c')).status,'queued');
 assert.deepEqual(await f.work('b'),bBefore);assert.deepEqual(await f.work('c'),cBefore);
 assert.equal((await f.queue()).length,2);
 f.release('a');assert.equal((await a).status,'settled');
 await f.untilWork(async()=>(await f.work('c')).acceptance==='accepted');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');assert.equal((await f.work('c')).runtimeRun!.id,'run-c');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b','c','c']);assert.equal(f.overlaps(),0);assert.equal((await f.queue()).length,0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a new request in the hand-over gap joins behind the queue and never runs beside the next entry`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');await f.admit('c');await f.admit('d');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');await f.run('c','run-c');
 // The single taker stalls on its queue read: the slot is free, the mark is held, and D must still join behind C.
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const joined=await f.run('d','run-d');
 assert.equal(joined.status,'queued');assert.equal((await f.work('d')).runtimeRun,undefined);
 f.releaseQueueLoad();
 await f.untilWork(async()=>(await f.work('d')).acceptance==='accepted');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b','c','c','d','d']);
 assert.equal(f.overlaps(),0);assert.equal((await f.queue()).length,0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} concurrent requests at the moment A settles never take the slot and keep the queue order`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);for(const id of ['a','b','c','d','e'])await f.admit(id);
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');await f.run('c','run-c');
 f.release('a');
 const late=[f.run('d','run-d'),f.run('e','run-e')];void late;
 await a;await Promise.all(late);
 for(const id of ['b','c','d','e'])await f.untilWork(async()=>(await f.work(id)).acceptance==='accepted');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b','c','c','d','d','e','e']);
 assert.equal(f.overlaps(),0);assert.equal((await f.queue()).length,0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} two triggers of the single taker at once start one Work`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');f.release('a');await a;
 const both=await Promise.all([f.m.drainRunQueue(),f.m.drainRunQueue()]);
 void both;
 await f.untilWork(async()=>(await f.work('b')).acceptance==='accepted');
 assert.equal(f.calls.filter(c=>c.workId==='b').length,2);assert.equal((await f.queue()).length,0);assert.equal(f.overlaps(),0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} after a restart the host continues the queue in the same order`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);for(const id of ['a','b','c','d'])await f.admit(id);
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 for(const id of ['b','c','d'])await f.run(id,'run-'+id);
 // Freeze the old host's taker so the entries survive into a restarted host over the same store.
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const restarted=await queueFixture(t,durable,{},{store:f.store});
 await restarted.m.drainRunQueue();
 for(const id of ['b','c','d'])await restarted.untilWork(async()=>(await restarted.work(id)).acceptance==='accepted');
 assert.deepEqual(restarted.calls.map(c=>c.workId),['b','b','c','c','d','d']);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a']);assert.equal((await f.queue()).length,0);assert.equal(f.overlaps()+restarted.overlaps(),0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a queued entry whose authorization was revoked is dropped with the reason and the next entry starts`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');await f.admit('c');
 await f.m.save(()=>f.m.authorize({id:'grant-c',scope:'local',executorProfileId:f.choice.executorProfileId,verifierProfileId:f.choice.verifierProfileId,maxOutputTokensPerCall:4,expectedConfigHash:f.m.list().configHash}));
 const choiceC={...f.choice,authorizationId:'grant-c'};
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');
 await f.product.run('m1','c','run-c',await f.revision(),choiceC);
 // Revoke in the hand-over gap: A settled, the taker stalls on its queue read, no dispatch is active.
 f.holdQueueLoad();f.release('a');await a;
 await f.m.save(()=>f.m.revoke({authorizationId:'grant',expectedConfigHash:f.m.list().configHash}));
 f.releaseQueueLoad();
 await f.untilWork(async()=>(await f.work('c')).acceptance==='accepted');
 const b=await f.work('b');
 assert.equal(b.runtimeRun,undefined);assert.equal(b.acceptance,'pending');assert.equal(b.blocker!.code,'runtime_unavailable');
 assert.equal((await f.queue()).length,0);assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a queued entry whose Work input changed is removed and the next entry starts`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');await f.run('c','run-c');
 const rev=await f.revision();
 await f.product.clarifyWork('m1',{commandId:'question-b',expectedRevision:rev,workId:'b',questionId:'q1',text:'Which source document should be used?'},false);
 f.release('a');await a;
 await f.untilWork(async()=>(await f.work('c')).acceptance==='accepted');
 assert.equal((await f.work('b')).runtimeRun,undefined);assert.ok((await f.work('b')).questions?.length);
 assert.equal((await f.queue()).length,0);assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a sibling Work committing in the same Mission while B waits does not fail B`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');
 f.release('a');await a;
 await f.untilWork(async()=>(await f.work('b')).acceptance==='accepted');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} a second request for a queued Work changes nothing`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 const first=await f.run('b','run-b');const journal=structuredClone(await f.queue());
 const second=await f.run('b','run-b-again');
 assert.equal(first.status,'queued');assert.equal(second.status,'queued');
 assert.match(second.reason!,/already queued/i);
 assert.deepEqual(await f.queue(),journal);assert.equal((await f.work('b')).runtimeRun,undefined);
 f.release('a');await a;await f.untilWork(async()=>(await f.work('b')).acceptance==='accepted');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} the seventeenth request is refused with queue_full and changes nothing`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');
 for(let i=1;i<=MAX_RUN_QUEUE_ENTRIES+1;i++)await f.admit('w'+i);
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 for(let i=1;i<=MAX_RUN_QUEUE_ENTRIES;i++)assert.equal((await f.run('w'+i,'run-w'+i)).status,'queued');
 const worksBefore=structuredClone((await f.store.load('m1'))!.value.works),queueBefore=structuredClone(await f.queue());
 const refused=await f.run('w'+(MAX_RUN_QUEUE_ENTRIES+1),'run-full');
 assert.equal(refused.status,'blocked');assert.match(refused.reason!,/queue_full/);
 assert.deepEqual((await f.store.load('m1'))!.value.works,worksBefore);assert.deepEqual(await f.queue(),queueBefore);
 assert.equal((await f.work('w'+(MAX_RUN_QUEUE_ENTRIES+1))).runtimeRun,undefined);
 f.release('a');await a;
 for(let i=1;i<=MAX_RUN_QUEUE_ENTRIES;i++){const id='w'+i;await f.untilWork(async()=>(await f.work(id)).acceptance==='accepted');}
 assert.equal((await f.queue()).length,0);assert.equal(f.overlaps(),0);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} host drain starts nothing and leaves the entries in place`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 await f.run('b','run-b');
 f.m.beginDrain();f.release('a');await a;await f.m.drain();
 assert.equal((await f.work('b')).runtimeRun,undefined);assert.equal((await f.queue()).length,1);
 assert.deepEqual(f.calls.map(c=>c.workId),['a']);
});

for(const durable of [false,true])test(`${durable?'durable':'memory'} an assistant-requested entry activates with the assistant actor and its assistant run id`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await queueFixture(t,durable);await f.admit('a');
 const messageId='m:'+hash('queue-turn').slice(0,32),turnId='assistant-turn:m:'+messageId.slice(2);
 const message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner',turnId:null,text:'Please summarize the launch notes.'};
 const assistantSource={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'controlled',model:'representative'}} as never;
 let rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'admit-assistant',expectedRevision:rev,actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId:'assistant-'+hash(turnId).slice(0,24),title:'Assistant Work',budget:8,assistantSource}});
 const workId='assistant-'+hash(turnId).slice(0,24);
 await f.hold('a');const a=f.run('a','run-a');await f.untilWork(()=>f.calls.length===1);
 rev=await f.revision();
 const joined=await f.product.run('m1',workId,'assistant-run:'+turnId,rev,f.choice,'assistant');
 assert.equal(joined.status,'queued');
 f.release('a');await a;
 await f.untilWork(async()=>(await f.work(workId)).acceptance==='accepted');
 assert.equal((await f.work(workId)).runtimeRun!.id,'assistant-run:'+turnId);
});
