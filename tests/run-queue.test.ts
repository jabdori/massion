/** Stage-1 durable run queue: joining, the single taker and the hand-over (docs/architecture/host-admission.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {growthStore} from './support/growth-fixture.ts';
import {InMemoryHostSettings,StorageContentionError} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {Application} from '../src/application.ts';
import {ASSISTANT_ACTOR_ID} from '../src/assistant-conversation.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {RUN_QUEUE_ID,MAX_RUN_QUEUE_ENTRIES} from '../src/run-queue.ts';
import {hash,workInputHash} from '../src/domain.ts';
import {MEMBERS_ID,applyMembers} from '../src/members.ts';
import type {MembersCommand} from '../src/members.ts';
import type {Mission,Actor} from '../src/domain.ts';

const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]} as never);
type Variant='memory'|'delayed'|'durable';
type Fixture=Awaited<ReturnType<typeof queueFixture>>;
const VARIANTS:readonly Variant[]=['memory','delayed','durable'];
/** Every test runs against the plain memory store, a slow serialized store (like the durable one) and, where available, the actual durable store. */
const queueTest=(name:string,make:(t:import('node:test').TestContext,variant:Variant)=>Promise<Fixture>,body:(f:Fixture,variant:Variant,t:import('node:test').TestContext)=>Promise<void>)=>{for(const variant of VARIANTS)test(`${variant==='durable'?'durable':variant==='delayed'?'delayed store':'memory'} ${name}`,{skip:variant==='durable'&&!process.env.SURREAL_TEST_RUNTIME},async t=>body(await make(t,variant),variant,t));};
const plain=(t:import('node:test').TestContext,variant:Variant)=>queueFixture(t,variant);
/** A slow store: every load and commit awaits a few milliseconds and commits serialize, the way the durable store behaves under load. */
function delayedStore(store:Store<any>,ms=12):Store<any>{
 let chain:Promise<unknown>=Promise.resolve();
 const delay=()=>new Promise<void>(r=>setTimeout(r,ms));
 return new Proxy(store,{get(target,key){
  if(key==='load')return async(id:string)=>{await delay();return target.load(id);};
  if(key==='commit')return (input:Parameters<typeof target.commit>[0])=>{const run=chain.then(async()=>{await delay();return target.commit(input);});chain=run.catch(()=>{});return run;};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
/** One controlled transient failure: the first commit with this command id rejects with StorageContentionError. */
function sabotageStore(store:Store<any>,commandId:string,marker:{thrown:boolean}):Store<any>{
 let fired=false;
 return new Proxy(store,{get(target,key){
  if(key==='commit')return (input:Parameters<typeof target.commit>[0])=>{if(!fired&&input.commandId===commandId){fired=true;marker.thrown=true;return Promise.reject(new StorageContentionError('Controlled transient storage contention'));}return target.commit(input);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
/** Holds the verifier of named Works so a run occupies the slot at a deterministic point; tracks overlapping model calls. */
async function queueFixture(t:import('node:test').TestContext,variant:Variant='memory',verdicts:Record<string,'passed'|'failed'>={},reuse?:{store:Store<any>},failFirstCommit?:string){
 const root=await mkdtemp(join(tempRoot(),'massion-run-queue-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const shared=reuse?.store??(await growthStore(variant==='durable')).store;
 const base=variant==='delayed'&&!reuse?delayedStore(shared):shared;
 const sabotage=failFirstCommit?{thrown:false}:undefined;
 const store=(sabotage?sabotageStore(base,failFirstCommit!,sabotage):base) as Store<any>,artifacts=new TextArtifactStore(join(root,'artifacts')),settings=new InMemoryHostSettings();
 const gates=new Map<string,Promise<void>>(),releases=new Map<string,()=>void>(),calls:{workId:string;role:string}[]=[];let overlaps=0,inFlight=0;const overlapPairs:string[]=[];
 let queueLoadGate:Promise<void>|undefined,queueLoadRelease:(()=>void)|undefined,heldQueueLoad=false;
 const gated=queueGate(store,()=>({gate:queueLoadGate,armed:heldQueueLoad,observe:()=>{heldQueueLoad=false;}}));
 let missionLoads=0,missionGate:{nth:number;gate:Promise<void>;arrived:()=>void;release:()=>void}|undefined;
 const productStore=new Proxy(store,{get(target,key){
  if(key==='load')return async(id:string)=>{const gate=missionGate;if(gate&&id==='m1'&&++missionLoads===gate.nth){gate.arrived();await gate.gate;}return target.load(id);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 const transport=async(_url:any,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body));let prompt:any={};try{prompt=JSON.parse(body.messages[0].content);}catch{}
  if(Object.hasOwn(prompt,'currentMessage'))return reply(body.model,JSON.stringify({reply:'ok',work:null}));
  const workId=prompt.binding?.workId as string,role=prompt.artifact?'verifier':'executor';
  inFlight++;if(inFlight>1){overlaps++;overlapPairs.push((calls.at(-1)?.workId||'?')+':'+(calls.at(-1)?.role||'?')+' + '+workId+':'+role);}
  if(role==='verifier'){const gate=gates.get(workId);if(gate)await gate;}
  calls.push({workId,role});inFlight--;
  if(prompt.artifact)return reply(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:verdicts[workId]??'passed',checks:[{criterion:prompt.criteria.description,passed:(verdicts[workId]??'passed')==='passed',quote:'Answer bounded',reason:'Controlled fixture'}]}));
  return reply(body.model,'Answer bounded fixture text');
 };
 function reply(model:string,content:string){return new Response(JSON.stringify({id:'x',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});}
 const m=createHostConnections(gated,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'x',settings});
 const product=new ProductService(productStore,undefined,m);m.setRunQueueDrain(()=>product.runQueuePass());
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
 const holdMissionLoad=(nth:number)=>{missionLoads=0;let releaseGate!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>releaseGate=r),held=new Promise<void>(r=>arrived=r);missionGate={nth,gate,arrived,release:releaseGate};return held;};
 const releaseMissionLoad=()=>{if(missionGate){missionGate.release();missionGate=undefined;}};
 t.after(async()=>{releaseQueueLoad();releaseMissionLoad();await m.drain();});
 const untilWork=async(check:()=>Promise<boolean>|boolean,limit=4000)=>{for(let i=0;i<limit;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw Error('Run queue fixture deadline');};
 return {store,m,product,app,choice,calls,admit,run,work,revision,hold,release,holdQueueLoad,releaseQueueLoad,holdMissionLoad,releaseMissionLoad,untilWork,sabotage,overlaps:()=>overlaps,overlapPairs,queue:()=>m.runQueue.entries(),noOverlap:()=>assert.equal(overlaps,0,'overlapping model calls: '+JSON.stringify(overlapPairs)+' in '+JSON.stringify(calls.map(c=>c.workId+':'+c.role)))};
}
function queueGate(store:Store<any>,state:()=>{gate:Promise<void>|undefined;armed:boolean;observe:()=>void}):Store<any>{
 return new Proxy(store,{get(target,key){
  if(key==='load')return async(id:string)=>{const s=state();if(s.armed&&id===RUN_QUEUE_ID){s.observe();await s.gate;}return target.load(id);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
const settled=async(f:Fixture,...ids:string[])=>f.untilWork(async()=>(await Promise.all(ids.map(async id=>(await f.work(id)).acceptance==='accepted'))).every(ok=>ok)&&(await f.queue()).length===0);
const queueEntries=async(f:Fixture)=>((await f.store.load(RUN_QUEUE_ID))!.value as {entries:{seq:number;work:{workId:string}}[]}).entries.sort((a,b)=>a.seq-b.seq).map(e=>e.work.workId);
/** A's Mission commits are paused once its verifier dispatch is claimed and the model call is held: joins then cannot race them. */
const atVerifierHold=async(f:Fixture,workId:string)=>f.untilWork(async()=>(await f.work(workId)).effects.some(e=>e.taskId===workId+':verifier'&&e.providerDispatch));
/** Commits members commands the way MembersService does, so queue tests can admit and archive a member without the conversation card. */
const memberCommand=async(store:Store<any>,commandId:string,actorId:string,command:MembersCommand)=>{
 const actor:Actor={id:actorId,roles:[actorId===ASSISTANT_ACTOR_ID?'assistant':'owner']};
 const snapshot=await store.load(MEMBERS_ID);
 const {value,events}=applyMembers(snapshot?.value??null,command,actor,{observedAt:Date.now()});
 return store.commit({id:MEMBERS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:hash({actorId,command}),value,events,outbox:[]});
};

queueTest('queueFixture sanity: one slot, join, hand-over',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');
 await atVerifierHold(f,'a');
 const joined=await f.run('b','run-b');
 assert.equal(joined.status,'queued');assert.equal((await f.work('b')).runtimeRun,undefined);
 f.release('a');assert.equal((await a).status,'settled');
 await settled(f,'b');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');f.noOverlap();
});

queueTest('a Work nobody asked to run never starts by itself while the queue drains',(t,variant)=>queueFixture(t,variant,{revised:'failed'}),async f=>{
 await f.admit('created');await f.admit('revised');await f.admit('budget');
 let rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'wait-budget',expectedRevision:rev,actorId:'runtime-representative',command:{type:'wait-monthly-budget',workId:'budget',decisionId:'d1'}});
 rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'resume-budget',expectedRevision:rev,actorId:'local-owner',command:{type:'resume-monthly-budget',workId:'budget',decisionId:'d1'}});
 const failed=await f.run('revised','run-revised');
 await f.untilWork(async()=>(await f.work('revised')).verdict?.status==='failed');
 rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'revise',expectedRevision:rev,actorId:'local-owner',command:{type:'revise-work',workId:'revised'}});
 assert.equal((await f.work('created')).execution,'blocked');
 for(const id of ['revised','budget'])assert.equal((await f.work(id)).execution,'queued');
 await f.hold('a');await f.admit('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 const queued=await f.run('created','never-requested');
 assert.equal(queued.status,'queued');
 f.release('a');await a;await f.untilWork(async()=>(await f.work('created')).acceptance==='accepted');
 for(const id of ['revised','budget'])assert.equal((await f.work(id)).acceptance,'pending');
 assert.equal((await f.work('revised')).runtimeRun!.id,'run-revised');
 assert.equal((await f.work('budget')).runtimeRun,undefined);
 assert.equal((await f.work('created')).runtimeRun!.id,'never-requested');
});

queueTest('the queue continues by itself: B and C wait untouched, then start in order with no further request',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 const bBefore=structuredClone(await f.work('b')),cBefore=structuredClone(await f.work('c'));
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 assert.equal((await f.run('b','run-b')).status,'queued');assert.equal((await f.run('c','run-c')).status,'queued');
 assert.deepEqual(await f.work('b'),bBefore);assert.deepEqual(await f.work('c'),cBefore);
 assert.equal((await f.queue()).length,2);
 f.release('a');assert.equal((await a).status,'settled');
 await settled(f,'c');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');assert.equal((await f.work('c')).runtimeRun!.id,'run-c');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b','c','c']);f.noOverlap();
});

queueTest('a new request in the hand-over gap joins behind the queue and never runs beside the next entry',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');await f.admit('d');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const joined=await f.run('d','run-d');
 assert.equal(joined.status,'queued');assert.equal((await f.work('d')).runtimeRun,undefined);
 f.releaseQueueLoad();
 await settled(f,'d');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b','c','c','d','d']);
 f.noOverlap();
});

queueTest('concurrent requests at the moment A settles never take the slot and keep the queue order',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');await f.admit('d');await f.admit('e');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 f.holdQueueLoad();
 f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const late=[f.run('d','run-d'),f.run('e','run-e')];await Promise.all(late);
 // Queue order is a required property: the entries' committed sequence order is read from the store, and the taker must follow it.
 const tail=await queueEntries(f);
 assert.equal(tail.length,4);
 f.releaseQueueLoad();
 await settled(f,'d','e');
 const order=f.calls.map(c=>c.workId);
 assert.deepEqual(order,['a','a',...tail.flatMap(id=>[id,id])]);
 f.noOverlap();assert.equal((await f.queue()).length,0);
});

queueTest('two triggers of the single taker at once start one Work',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 const both=Promise.all([f.m.drainRunQueue(),f.m.drainRunQueue()]);
 f.release('a');await a;await both;
 await settled(f,'b');
 assert.equal(f.calls.filter(c=>c.workId==='b').length,2);f.noOverlap();
});

queueTest('after a restart the host continues the queue in the same order',plain,async(f,variant,t)=>{
 await f.admit('a');await f.admit('b');await f.admit('c');await f.admit('d');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 for(const id of ['b','c','d'])await f.run(id,'run-'+id);
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const restarted=await queueFixture(t,variant,{},{store:f.store});
 await restarted.m.drainRunQueue();
 for(const id of ['b','c','d'])await restarted.untilWork(async()=>(await restarted.work(id)).acceptance==='accepted');
 await restarted.untilWork(async()=>(await restarted.queue()).length===0);
 assert.deepEqual(restarted.calls.map(c=>c.workId),['b','b','c','c','d','d']);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a']);assert.equal((await f.queue()).length,0);assert.equal(f.overlaps()+restarted.overlaps(),0,JSON.stringify({first:f.overlapPairs,restarted:restarted.overlapPairs}));
});

queueTest('a queued entry whose authorization was revoked is dropped with the reason and the next entry starts',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.m.save(()=>f.m.authorize({id:'grant-c',scope:'local',executorProfileId:f.choice.executorProfileId,verifierProfileId:f.choice.verifierProfileId,maxOutputTokensPerCall:4,expectedConfigHash:f.m.list().configHash}));
 const choiceC={...f.choice,authorizationId:'grant-c'};
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 await f.product.run('m1','c','run-c',await f.revision(),choiceC);
 f.holdQueueLoad();f.release('a');await a;
 await f.m.save(()=>f.m.revoke({authorizationId:'grant',expectedConfigHash:f.m.list().configHash}));
 f.releaseQueueLoad();
 await settled(f,'c');
 const b=await f.work('b');
 assert.equal(b.runtimeRun,undefined);assert.equal(b.acceptance,'pending');assert.equal(b.blocker!.code,'runtime_unavailable');
 // The drop is the revocation at the turn, not the admit-time gate: a direct request for B now is refused by the revoked grant.
 const direct=await f.run('b','run-b-direct');
 assert.equal(direct.status,'blocked');assert.equal((await f.work('b')).runtimeRun,undefined);
 assert.equal((await f.queue()).length,0);assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

queueTest('a queued entry whose Work input changed is removed and the next entry starts',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 // Wait for A's verifier dispatch: its Mission commits are then paused at the held model call, so clarifyWork cannot race them.
 const asked=await f.product.clarifyWork('m1',{commandId:'question-b',expectedRevision:await f.revision(),workId:'b',questionId:'q1',text:'Which source document should be used?'},false);
 assert.equal(asked.status,'committed');
 // An answered question passes the answered-clarification check, so only the changed input hash can drop the entry.
 const answered=await f.product.clarifyWork('m1',{commandId:'answer-b',expectedRevision:await f.revision(),workId:'b',questionId:'q1',text:'Which source document should be used?'},true);
 assert.equal(answered.status,'committed');
 f.release('a');await a;
 await settled(f,'c');
 const b=await f.work('b');
 assert.equal(b.runtimeRun,undefined);assert.ok(b.questions?.length);assert.ok(b.questions.every(q=>q.answer!==null));
 assert.equal((await f.queue()).length,0);assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

queueTest('a sibling Work committing in the same Mission while B waits does not fail B',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 f.release('a');await a;
 await settled(f,'b');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');
});

queueTest('a second request for a queued Work changes nothing',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 const first=await f.run('b','run-b');const journal=structuredClone(await f.queue());
 const second=await f.run('b','run-b-again');
 assert.equal(first.status,'queued');assert.equal(second.status,'queued');
 assert.match(second.reason!,/already queued/i);
 assert.deepEqual(await f.queue(),journal);assert.equal((await f.work('b')).runtimeRun,undefined);
 f.release('a');await a;await settled(f,'b');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');
});

queueTest('the seventeenth request is refused with queue_full and changes nothing',plain,async f=>{
 await f.admit('a');
 for(let i=1;i<=MAX_RUN_QUEUE_ENTRIES+1;i++)await f.admit('w'+i);
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 for(let i=1;i<=MAX_RUN_QUEUE_ENTRIES;i++)assert.equal((await f.run('w'+i,'run-w'+i)).status,'queued');
 const worksBefore=structuredClone((await f.store.load('m1'))!.value.works),queueBefore=structuredClone(await f.queue());
 const refused=await f.run('w'+(MAX_RUN_QUEUE_ENTRIES+1),'run-full');
 assert.equal(refused.status,'blocked');assert.match(refused.reason!,/queue_full/);
 assert.deepEqual((await f.store.load('m1'))!.value.works,worksBefore);assert.deepEqual(await f.queue(),queueBefore);
 assert.equal((await f.work('w'+(MAX_RUN_QUEUE_ENTRIES+1))).runtimeRun,undefined);
 f.release('a');await a;
 const ids=Array.from({length:MAX_RUN_QUEUE_ENTRIES},(_,k)=>'w'+(k+1));
 const acceptance=async()=>Promise.all(ids.map(async id=>[(await f.work(id)).acceptance,(await f.work(id)).runtimeRun!==undefined]));
 await f.untilWork(async()=>(await acceptance()).every(row=>row[0]==='accepted')&&(await f.queue()).length===0,12000).catch(async error=>{const rows=await acceptance();throw new Error(error.message+' stuck: '+JSON.stringify(ids.map((id,i)=>[id,rows[i]])));});
 assert.equal((await f.queue()).length,0);f.noOverlap();
});

queueTest('host drain starts nothing and leaves the entries in place',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 f.m.beginDrain();f.release('a');await a;await f.m.drain();
 assert.equal((await f.work('b')).runtimeRun,undefined);assert.equal((await f.queue()).length,1);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a']);
});

queueTest('an assistant-requested entry activates with the assistant actor and its assistant run id',plain,async f=>{
 await f.admit('a');
 const messageId='m:'+hash('queue-turn').slice(0,32),turnId='assistant-turn:m:'+messageId.slice(2);
 const message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner',turnId:null,text:'Please summarize the launch notes.'};
 const assistantSource={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'controlled',model:'representative'}} as never;
 let rev=await f.revision();
 await f.app.dispatch({missionId:'m1',commandId:'admit-assistant',expectedRevision:rev,actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId:'assistant-'+hash(turnId).slice(0,24),title:'Assistant Work',budget:8,assistantSource}});
 const workId='assistant-'+hash(turnId).slice(0,24);
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 rev=await f.revision();
 const joined=await f.product.run('m1',workId,'assistant-run:'+turnId,rev,f.choice,'assistant');
 assert.equal(joined.status,'queued');
 f.release('a');await a;
 await settled(f,workId);
 assert.equal((await f.work(workId)).runtimeRun!.id,'assistant-run:'+turnId);
});

queueTest('a run-sequence request in the hand-over gap is refused and never runs beside or ahead of the queue',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('x');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const w=await f.work('x');
 const seq=await f.product.runSequence('m1',{commandId:'seq-x',expectedRevision:await f.revision(),works:[{workId:'x',inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}],selection:f.choice});
 assert.equal(seq.status,'stopped');assert.match(seq.reason!,/already owned another Work/);
 assert.equal((await f.work('x')).runtimeRun,undefined);
 f.releaseQueueLoad();
 await settled(f,'b');
 assert.equal((await f.work('x')).runtimeRun,undefined);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b']);f.noOverlap();
});

queueTest('a resume request in the hand-over gap is refused as busy and the queue keeps its turn',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 const resumed=await f.m.resume('m1','b');
 assert.equal(resumed.status,'blocked');assert.equal(resumed.reason,'Local runtime is busy');
 assert.equal((await f.queue()).length,1);
 f.releaseQueueLoad();
 await settled(f,'b');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','b','b']);
});

queueTest('a queued Work of an archived member is removed with the member reason and the next entry starts',(t,variant)=>queueFixture(t,variant),async f=>{
 assert.equal((await memberCommand(f.store,'q1a-propose-member',ASSISTANT_ACTOR_ID,{type:'propose-member',decisionId:'decision-q',topic:'Queue member admission',works:[{title:'Member Work'}],count:2})).status,'committed');
 assert.equal((await memberCommand(f.store,'q1a-admit-member','local-owner',{type:'admit-member',decisionId:'decision-q',memberId:'member-q',name:'Queue Member',shape:'round'})).status,'committed');
 const messageId='m:'+hash('member-work').slice(0,32),turnId='assistant-turn:m:'+messageId.slice(2);
 const message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner',turnId:null,text:'Please summarize the launch notes.'};
 const assistantSource={segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'controlled',model:'representative'},memberId:'member-q'} as never;
 const memberWorkId='assistant-'+hash(turnId).slice(0,24);
 await f.app.dispatch({missionId:'m1',commandId:'admit-member-work',expectedRevision:await f.revision(),actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId:memberWorkId,title:'Member Work',budget:8,assistantSource}});
 await f.admit('a');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 assert.equal((await f.product.run('m1',memberWorkId,'run-mb',await f.revision(),f.choice)).status,'queued');
 await f.run('c','run-c');
 assert.equal((await memberCommand(f.store,'q1a-archive-member','local-owner',{type:'archive-member',memberId:'member-q'})).status,'committed');
 f.release('a');await a;
 await settled(f,'c');
 const mb=await f.work(memberWorkId);
 assert.equal(mb.runtimeRun,undefined);assert.equal(mb.acceptance,'pending');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
 // A direct request for the same archived member's Work gets the same refusal, not a run.
 const direct=await f.product.run('m1',memberWorkId,'run-mb-direct',await f.revision(),f.choice);
 assert.equal(direct.status,'blocked');assert.match(direct.reason!,/archived/i);
 assert.equal((await f.work(memberWorkId)).runtimeRun,undefined);
});

queueTest('a stale expectedRevision is refused when busy exactly as when idle',plain,async f=>{
 await f.admit('a');await f.admit('b');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 const fresh=await f.revision();
 const busy=await f.product.run('m1','b','run-b',fresh-1,f.choice);
 assert.equal(busy.status,'conflict');assert.match(busy.reason!,/changed since this selection was checked/);
 assert.equal((await f.work('b')).runtimeRun,undefined);assert.equal((await f.queue()).length,0);
 f.release('a');await a;
 const idle=await f.product.run('m1','b','run-b-idle',fresh-1,f.choice);
 assert.equal(idle.status,'conflict');assert.match(idle.reason!,/changed since this selection was checked/);
 assert.equal((await f.work('b')).runtimeRun,undefined);
});

queueTest('a Work change between the pass\'s hash comparison and the admission is caught',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 // The pass reads the Mission once (load 1) and hands that revision to the admission, which reads it again (load 2).
 const admissionRead=f.holdMissionLoad(2);
 f.holdQueueLoad();f.release('a');await a;
 await f.untilWork(async()=>(await f.work('a')).acceptance==='accepted');
 f.releaseQueueLoad();
 await admissionRead;
 const asked=await f.product.clarifyWork('m1',{commandId:'question-b-late',expectedRevision:await f.revision(),workId:'b',questionId:'q1',text:'Which source document should be used?'},false);
 assert.equal(asked.status,'committed');
 const answered=await f.product.clarifyWork('m1',{commandId:'answer-b-late',expectedRevision:await f.revision(),workId:'b',questionId:'q1',text:'Which source document should be used?'},true);
 assert.equal(answered.status,'committed');
 f.releaseMissionLoad();
 await settled(f,'c');
 const b=await f.work('b');
 assert.equal(b.runtimeRun,undefined);assert.ok(b.questions?.length);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

queueTest('a storage contention error during the pass leaves the entry and the next trigger starts it',(t,variant)=>queueFixture(t,variant,{},undefined,'run-b'),async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 f.release('a');await a;
 await f.untilWork(()=>f.sabotage!.thrown===true);
 // The transient error said nothing about the entries: both stay stored and nothing else started.
 assert.deepEqual(await queueEntries(f),['b','c']);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a']);
 await f.untilWork(async()=>{await f.m.drainRunQueue();return (await f.work('b')).acceptance==='accepted';});
 await settled(f,'b','c');
 assert.equal((await f.work('b')).runtimeRun!.id,'run-b');
 assert.equal((await f.work('c')).runtimeRun!.id,'run-c');f.noOverlap();
});

queueTest('a Work that goes to budget-waiting leaves the queue',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 const waited=await f.app.dispatch({missionId:'m1',commandId:'wait-budget-b',expectedRevision:await f.revision(),actorId:'runtime-representative',command:{type:'wait-monthly-budget',workId:'b',decisionId:'d-b'}});
 assert.equal(waited.status,'committed');assert.equal((await f.work('b')).execution,'budget-waiting');
 f.release('a');await a;
 await settled(f,'c');
 assert.equal((await f.work('b')).runtimeRun,undefined);
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});

queueTest('an owner cancel removes the queued entry without a run',plain,async f=>{
 await f.admit('a');await f.admit('b');await f.admit('c');
 await f.hold('a');const a=f.run('a','run-a');await atVerifierHold(f,'a');
 await f.run('b','run-b');await f.run('c','run-c');
 const cancelled=await f.product.intervene('m1',{commandId:'cancel-b',expectedRevision:await f.revision(),command:{type:'cancel',workId:'b'}});
 assert.equal(cancelled.status,'committed');
 f.release('a');await a;
 await settled(f,'c');
 assert.equal((await f.work('b')).runtimeRun,undefined);assert.equal((await f.work('b')).execution,'cancelled');
 assert.deepEqual(f.calls.map(c=>c.workId),['a','a','c','c']);
});
