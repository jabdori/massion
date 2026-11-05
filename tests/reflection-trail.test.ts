import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryStore} from '../src/storage.ts';
import {canonical,hash} from '../src/domain.ts';
import type {Mission,Command,Actor,Work} from '../src/domain.ts';
import {buildReflectionTrail,readReflectionTrail,TRAIL_BYTE_LIMIT} from '../src/reflection-trail.ts';
import type {Store} from '../src/storage.ts';
import {selectionField} from './support/workbench-client.ts';
import {rejectedFixture,rejectedContent} from './support/rejected-text-fixture.ts';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';

const actors:Actor[]=[{id:'local-owner',roles:['owner']},{id:'exec',roles:['executor']}];
async function interrupted(outcome:'unknown'|'quarantine'){
 const store=new InMemoryStore<Mission>(),app=new Application(store,actors);let n=0;
 const send=async(command:Command,actorId='local-owner')=>app.dispatch({missionId:'m',commandId:`c${++n}`,expectedRevision:(await store.load('m'))!.revision,actorId,command});
 await app.create({id:'m',purpose:'Write a readiness note',scope:'local',constraints:['Text only'],criteria:{version:1,description:'Two blockers',oracle:'bounded-text-review/v1'}},'local-owner','create');
 await send({type:'admit-work',workId:'w',title:'Note',budget:128});await send({type:'admit-work',workId:'queued',title:'Not run',budget:8});const w=(await store.load('m'))!.value.works[0]!;
 await send({type:'activate-runtime',workId:'w',run:{id:'run',authorizationId:'secret-authorization',criteriaHash:hash(w.criteria),inputHash:hash({mission:w.missionSnapshot,title:w.title,instructions:[],memoryVersions:[]}),mode:'mock-http',outputTokenCap:64}});
 await send({type:'assign',workId:'w',assignment:{id:'a',actorId:'exec',role:'executor',taskId:'w:root',model:{provider:'local',model:'fake',configVersion:'1',reason:'Fixture only',evidenceClass:'fixture'},extensionVersion:'builtin@1'}});
 await send({type:'admit-effect',workId:'w',effect:{id:'run:executor',taskId:'w:root',status:'pending',target:'local/fake',authority:'mock-only'},reserve:64},'exec');
 if(outcome==='unknown')await send({type:'receipt',workId:'w',effectId:'run:executor',outcome:'unknown',receipt:'Transport closed before reply',usage:null},'exec');
 else await send({type:'quarantine-runtime',workId:'w',runId:'run',reason:'Receipt commit failed; outcome unknown.',acknowledgeUncertainOutcome:true});
 return {store,product:new ProductService(store)};
}
/** Store proxy whose readState result passes through `edit` on the given 1-based call. */
function onRead(store:Store<Mission>,call:number,edit:(state:Awaited<ReturnType<Store<Mission>['readState']>>)=>void){let reads=0;return new Proxy(store,{get(target,key){if(key==='readState')return async(...args:Parameters<Store<Mission>['readState']>)=>{const state=await target.readState(...args);if(++reads===call)edit(state);return state;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Store<Mission>;}

for(const durable of [false,true])test(`${durable?'actual DB':'memory'} accepted and verifier-failed Works yield their trail without writes`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const g=await lifetimeFixture(t,durable);await g.product.run('mission','fresh','accepted-run',(await g.current()).revision);const accepted=(await g.current()).value.works.find(w=>w.id==='fresh')!,journal=await g.journal();
 const ok=(await new ProductService(g.store,undefined,undefined,g.artifacts).reflectionTrail('mission','fresh'))!;
 assert.equal(ok.format,'massion.reflection-trail/v1');assert.equal(ok.work.acceptance,'accepted');assert.equal(ok.work.quarantined,false);assert.equal(ok.recordChecksum,accepted.record!.checksum);assert.equal(ok.artifact!.text!.text,'Original bounded lifetime fixture');assert.ok(ok.effects.length>0&&ok.effects.every(e=>e.status==='succeeded'));
 assert.deepEqual(await g.journal(),journal);
 const f=await rejectedFixture(t,durable),before=await f.journal(),failed=(await f.product.reflectionTrail('mission','fresh'))!;
 assert.equal(failed.work.acceptance,'failed');assert.equal(failed.work.execution,'settled');assert.equal(failed.verdict!.status,'failed');assert.ok(failed.effects.length>0&&failed.effects.every(e=>e.status==='succeeded'));assert.equal(failed.artifact!.text!.text,rejectedContent);assert.equal(failed.recordChecksum,undefined);
 assert.equal(failed.trailHash,hash(Object.fromEntries(Object.entries(failed).filter(([k])=>k!=='trailHash'))));assert.equal(failed.verdict!.evidence[0]!.ref,'evidence:'+failed.verdict!.ref.slice(8)+'#1');
 assert.deepEqual(await f.journal(),before);
});
test('unknown-effect and quarantined Works yield their trail; a queued Work is refused',async()=>{
 const unknown=await interrupted('unknown'),unknownEvents=await unknown.store.readEvents(0),u=(await unknown.product.reflectionTrail('m','w'))!;assert.deepEqual(await unknown.store.readEvents(0),unknownEvents);
 assert.equal(u.work.execution,'blocked');assert.equal(u.work.acceptance,'pending');assert.deepEqual(u.effects,[{ref:'effect:run:executor',status:'unknown'}]);assert.equal(u.work.quarantined,false);assert.equal(u.artifact,undefined);
 const quarantined=await interrupted('quarantine'),quarantinedEvents=await quarantined.store.readEvents(0),q=(await quarantined.product.reflectionTrail('m','w'))!;assert.deepEqual(await quarantined.store.readEvents(0),quarantinedEvents);
 assert.equal(q.work.execution,'cancelled');assert.equal(q.work.quarantined,true);assert.deepEqual(q.effects.map(e=>e.status),['unknown']);
 await assert.rejects(quarantined.product.reflectionTrail('m','queued'),(e:any)=>e.code==='conflict');
 assert.equal(await quarantined.product.reflectionTrail('m','missing'),null);
 assert.equal(JSON.stringify([u,q]).includes('secret-authorization'),false);
});
for(const durable of [false,true])test(`${durable?'actual DB':'memory'} the same settled Work gives a byte-identical trail at two Mission revisions; a stale revision is refused`,{skip:durable&&!process.env.SURREAL_TEST_RUNTIME},async t=>{
 const f=await rejectedFixture(t,durable),r1=(await f.current()).revision,first=(await f.product.reflectionTrail('mission','fresh',r1))!;
 await f.product.admit('mission',{commandId:'unrelated',expectedRevision:r1,workId:'unrelated',title:'Owner later Work',budget:8});
 const r2=(await f.current()).revision,second=(await f.product.reflectionTrail('mission','fresh',r2))!;
 assert.notEqual(r1,r2);assert.equal(canonical(second),canonical(first));assert.equal(second.trailHash,first.trailHash);
 await assert.rejects(f.product.reflectionTrail('mission','fresh',r1),(e:any)=>e.code==='conflict');
 const ok=await fetch(f.base+'/missions/mission/reflection-trail?workId=fresh&revision='+r2);assert.equal(ok.status,200);assert.equal((await ok.json()).trailHash,first.trailHash);
 assert.equal((await fetch(f.base+'/missions/mission/reflection-trail?workId=fresh&revision='+r1)).status,409);
 assert.equal((await fetch(f.base+'/missions/mission/reflection-trail?workId=unrelated&revision='+r2)).status,409);
 for(const query of ['workId=fresh','workId=fresh&revision='+r2+'&path=/etc/passwd','workId=fresh&revision=x'])assert.equal((await fetch(f.base+'/missions/mission/reflection-trail?'+query)).status,400);
});
test('an oversized trail shortens artifact text, then attempt results, then evidence detail, and marks each',async t=>{
 const f=await rejectedFixture(t),mission=(await f.current()).value,base=structuredClone(mission.works.find(w=>w.id==='fresh')!) as Work,big='가🌙x'.repeat(3000),bytes=Buffer.byteLength(big);
 base.instructions=[{actorId:'local-owner',text:'Keep this instruction whole. '.repeat(100)}];
 const only=buildReflectionTrail(mission,base,big);
 assert.ok(Buffer.byteLength(canonical(only))<=TRAIL_BYTE_LIMIT);assert.equal(only.artifact!.text!.truncated,true);assert.equal(only.artifact!.text!.originalBytes,bytes);assert.ok(only.artifact!.text!.text.isWellFormed());assert.ok(only.attempts.every(a=>a.results.every(r=>!r.result.truncated)));assert.equal(only.input.instructions[0]!.text.text,base.instructions[0]!.text);
 const all=structuredClone(base);all.attempts.at(-1)!.results=[{taskId:'fresh:root',result:big}];all.verdict!.evidence[0]!.detail=big+big;
 const cut=buildReflectionTrail(mission,all,big);
 assert.ok(Buffer.byteLength(canonical(cut))<=TRAIL_BYTE_LIMIT);assert.deepEqual(cut.artifact!.text,{text:'',truncated:true,originalBytes:bytes});assert.deepEqual(cut.attempts.at(-1)!.results[0]!.result,{text:'',truncated:true,originalBytes:bytes});
 const detail=cut.verdict!.evidence[0]!.detail;assert.equal(detail.truncated,true);assert.equal(detail.originalBytes,bytes*2);assert.ok(detail.text.length>0&&detail.text.isWellFormed());assert.equal(cut.verdict!.evidence[1]!.detail.truncated,undefined);
 assert.equal(cut.input.instructions[0]!.text.text,base.instructions[0]!.text);
});
test('no credential, connection binding, profile ID, dispatch hash or host path appears in fixture trails',async t=>{
 const f=await rejectedFixture(t),mission=(await f.current()).value,trails=[];
 for(const w of mission.works.filter(w=>w.runtimeRun)){const trail=(await f.product.reflectionTrail('mission',w.id))!;trails.push(trail);const forged=structuredClone(w);forged.runtimeRun!.connectionBindings={executor:{profileId:'profile-executor-secret',configHash:'c'.repeat(64)},verifier:{profileId:'profile-verifier-secret',configHash:'d'.repeat(64)}};forged.runtimeRun!.authorizationId='credential-value-secret';trails.push(buildReflectionTrail(mission,forged,undefined));}
 const text=JSON.stringify(trails),forbidden=[f.root,'profile-executor-secret','c'.repeat(64),'d'.repeat(64),'credential-value-secret','controlled-lifetime-only',...mission.works.flatMap(w=>[w.artifact?.path,w.runtimeRun?.inputHash,...w.effects.map(e=>e.providerDispatch?.requestHash)])].filter(Boolean) as string[];
 for(const value of forbidden)assert.equal(text.includes(value),false,value);
 assert.equal(/"\/(Users|private|tmp|var|home)\//.test(text),false);
 assert.ok(trails.some(t=>t.artifact?.textUnavailable===true));
});
test('the Work detail shows the trail as literal text without POST',async t=>{
 const f=await rejectedFixture(t),app=await f.client(),journal=await f.journal();
 await selectionField(app,'work-reflection-trail-read-fresh').fire('click');
 const shown=selectionField(app,'work-reflection-trail-content-fresh').textContent;assert.equal(JSON.parse(shown).trailHash,(await f.product.reflectionTrail('mission','fresh'))!.trailHash);
 assert.equal(app.all().some(n=>n.tagName==='IMG'),false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);assert.deepEqual(await f.journal(),journal);
});
test('a trail read under another feed identity is refused, over HTTP and in product',async t=>{
 const f=await rejectedFixture(t),revision=(await f.current()).revision,url=f.base+'/missions/mission/reflection-trail?workId=fresh&revision='+revision;
 assert.equal((await fetch(url,{headers:{'X-Massion-Feed':f.input.feedId}})).status,200);
 assert.equal((await fetch(url,{headers:{'X-Massion-Feed':'another-db'}})).status,409);
 await assert.rejects(f.product.reflectionTrail('mission','fresh',revision,'another-db'),(e:any)=>e.code==='conflict');
 assert.equal((await fetch(f.base+'/missions/nope/reflection-trail?workId=fresh&revision='+revision)).status,404);
 assert.equal((await fetch(f.base+'/missions/mission/reflection-trail?workId=nope&revision='+revision)).status,404);
});
test('a storage failure inside the artifact reader propagates instead of becoming textUnavailable',async t=>{
 const f=await rejectedFixture(t),failing=onRead(f.store,2,()=>{throw new Error('transient storage failure');});
 await assert.rejects(readReflectionTrail(failing,f.artifacts,'mission','fresh'),/transient storage failure/);
 const missing=(await readReflectionTrail(f.store,undefined,'mission','fresh'))!;assert.equal(missing.artifact!.textUnavailable,true);
});
test('a Work that changes while its trail is read is refused',async()=>{
 const {store}=await interrupted('unknown'),changing=onRead(store,2,state=>{state.snapshot!.value.works.find(w=>w.id==='w')!.title='Changed';});
 await assert.rejects(readReflectionTrail(changing,undefined,'m','w'),(e:any)=>e.code==='conflict');
});
