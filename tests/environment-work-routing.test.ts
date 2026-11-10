import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {ProductService} from '../src/product.ts';
import {hash} from '../src/domain.ts';
import type {EnvironmentWorkDefinition} from '../src/environment-work.ts';
import type {Mission} from '../src/domain.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import {applyMembers,MEMBERS_ID} from '../src/members.ts';
import {ASSISTANT_ACTOR_ID} from '../src/assistant-conversation.ts';

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'massion-environment-routing-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new InMemoryStore<any>();
 const proposed=applyMembers(null,{type:'propose-member',decisionId:'member-decision:1',topic:'양식 작성',works:[{title:'첫 작업'},{title:'다음 작업'}],count:2},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{observedAt:1}).value;
 const members=applyMembers(proposed,{type:'admit-member',decisionId:'member-decision:1',memberId:'member:1',name:'민수',shape:'round'},{id:'local-owner',roles:['owner']},{observedAt:2}).value;
 await store.commit({id:MEMBERS_ID,commandId:'members',expectedRevision:0,fingerprint:'members',value:members,events:[],outbox:[]});
 const server=createWorkbench(store,root,{scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.drain());
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port,feed=(await store.readState()).feedId;
 return {root,store,server,url,feed};
}
const decision={id:'environment-decision:one',at:3,title:'양식 작성',question:'전송 승인',rows:[['대상','https://fixture.example']],action:'승인',state:'open',line:'확인 대기',environment:{missionId:'intake',workId:'work:1',taskId:'task:1',entryId:'entry:1',requestHash:'a'.repeat(64),kind:'action',deadline:Date.now()+60000,status:'waiting' as const,memberId:'member:1'}};

test('normal conversation routes project environment decisions with the exact feed and selected member',async t=>{
 const {server,url,feed}=await fixture(t);assert.ok(server.environmentWork);
 const reads:unknown[][]=[];server.environmentWork.decisions=async(expectedFeed,memberId)=>{reads.push([expectedFeed,memberId]);return [decision];};
 for(const suffix of ['', '?member=member%3A1']){
  const response=await fetch(url+'/assistant/conversation'+suffix);assert.equal(response.status,200);const body=await response.json();assert.ok(body.decisions.some((d:any)=>d.id===decision.id));
 }
 assert.deepEqual(reads,[[feed,undefined],[feed,'member:1']]);
});

test('environment answers use the normal feed-bound decision route without adding fields',async t=>{
 const {server,url,feed}=await fixture(t);assert.ok(server.environmentWork);const answers:unknown[]=[];
 server.environmentWork.decide=async body=>{answers.push(body);return {status:'committed',revision:9};};
 const body={commandId:'approve',decisionId:decision.id,requestHash:decision.environment.requestHash,answer:'act'};
 const post=(selectedFeed:string)=>fetch(url+'/assistant/decisions',{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':selectedFeed},body:JSON.stringify(body)});
 assert.equal((await post('feed:replaced')).status,409);assert.equal(answers.length,0);
 const response=await post(feed);assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'committed',revision:9,feedId:feed});assert.deepEqual(answers,[body]);
});

test('server drain fences environment admission immediately and waits for service shutdown',async t=>{
 const {server}=await fixture(t);assert.ok(server.environmentWork);let blocked=false,release!:()=>void,settled=false;const held=new Promise<void>(r=>{release=r;});
 server.environmentWork.beginDrain=()=>{blocked=true;};server.environmentWork.drain=async()=>{await held;};
 const draining=server.drain().then(()=>{settled=true;});assert.equal(blocked,true);await new Promise<void>(r=>setImmediate(r));assert.equal(settled,false);release();await draining;assert.equal(settled,true);
});


test('normal host configuration routes the lazily resolved server environment service into execution',async t=>{
 const {root,store,server}=await fixture(t);let resolutions=0,bindings=0;
 const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier']}]});
 const manager=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),{manifest,allowLiveExecution:false},{environment:()=>{resolutions++;return server.environmentWork;},readEnvironment:()=>assert.fail('No secrets'),transport:async(_url,init)=>{
  const request=JSON.parse(String(init.body)),prompt=JSON.parse(request.messages[0].content),content=prompt.artifact?JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Fixture evidence',reason:'Fixture'}]}):'Fixture evidence';
  return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:request.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 }});
 assert.equal(resolutions,0);server.environmentWork.bind=async()=>{bindings++;return undefined;};
 const profiles=manager.list().runtime.connections;assert.equal(resolutions,0);manager.authorize({id:'grant',scope:'local',executorProfileId:profiles[0]!.id,verifierProfileId:profiles[1]!.id,maxOutputTokensPerCall:8,expectedConfigHash:manager.list().configHash});manager.setDefaultRoute({authorizationId:'grant',outputTokenCap:8,expectedConfigHash:manager.list().configHash});
 const product=new ProductService(store as InMemoryStore<Mission>,undefined,manager);await product.create({id:'routing',purpose:'Fixture',scope:'local',constraints:[],criteria:{version:1,description:'Fixture evidence',oracle:'bounded-text-review/v1'}},'create');await product.admit('routing',{commandId:'admit',expectedRevision:1,workId:'work',title:'Fixture',budget:32});
 assert.equal((await product.run('routing','work','run',2)).status,'settled');assert.equal(bindings,1);assert.ok(resolutions>0);
});

test('server environment definitions are passed to the normal service constructor',async t=>{
 const {root,store}=await fixture(t),definitions:EnvironmentWorkDefinition[]=[{memberId:'member:1',origin:'https://fixture.example',elements:[{id:'button',selector:'#button',role:'button',label:'전송',operations:['click'],gates:[]}],facts:[],waits:[],secrets:[]}];
 const server=createWorkbench(store,root,{scheduleIntervalMs:0,environmentDefinitions:definitions});t.after(()=>server.drain());assert.equal(server.environmentWork.configHash(),hash(definitions));
});

test('a feed replaced during environment projection cannot return stale decisions',async t=>{
 const {store,server,url}=await fixture(t),readState=store.readState.bind(store);let replaced=false;
 store.readState=async id=>{const read=await readState(id);return replaced?{...read,feedId:'feed:replaced'}:read;};
 server.environmentWork.decisions=async()=>{replaced=true;return [decision];};
 const response=await fetch(url+'/assistant/conversation');assert.equal(response.status,503);const body=await response.json();assert.equal(body.reason,'feed');assert.equal(body.decisions,undefined);
});
