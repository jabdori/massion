import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConnectionCatalog} from '../src/provider-profiles.ts';
import type {ModelConnectionProfile} from '../src/provider-profiles.ts';
import {chatProfileFactory} from '../src/chat-profile-factory.ts';
import {SelectableTextRuntime} from '../src/selectable-runtime.ts';
import type {ExecutionAuthorization,ExecutionChoice} from '../src/selectable-runtime.ts';
import {TEXT_REVIEW_ORACLE} from '../src/configured-runtime.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore,SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';

async function setup(t:TestContext,store:Store<Mission>=new InMemoryStore<Mission>(),unknown=false){
 const calls:{model:string;port:number;prompt:any}[]=[];
 const servers=await Promise.all([0,1].map(async(index)=>{const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);const prompt=JSON.parse(body.messages[0].content);calls.push({model:body.model,port:index,prompt});if(unknown){req.socket.destroy();return;}const content=prompt.artifact?JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Fixture result',reason:'Synthetic exact-text evidence'}]}):'Fixture result';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}));});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const address=server.address();assert.ok(address&&typeof address==='object');return `http://127.0.0.1:${address.port}/v1/chat/completions`;}));
 const profiles:ModelConnectionProfile[]=['a','b','c'].map((id,index)=>({id,label:'Connection '+id,backend:'model-provider',providerKind:'fixture-provider-'+index,protocol:'openai-chat-completions/v1',model:'exact-'+id,endpoint:servers[index%2]!,revision:'1',enabled:true,auth:{method:'none'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:32768,maxOutputTokens:64,maxResponseBytes:32768,timeoutMs:1000}}));
 const catalog=new ConnectionCatalog(profiles,[chatProfileFactory({mode:'local-http-mock',transport:fetch})]);const permissions=catalog.list().map(p=>({profileId:p.id,configHash:p.configHash}));
 const grants:ExecutionAuthorization[]=[{id:'test-grant',scope:'fixture-only',mode:'mock-http',executor:permissions,verifier:permissions,maxOutputTokensPerCall:64}];
 const root=await mkdtemp(join(tmpdir(),'massion-selection-'));t.after(()=>rm(root,{recursive:true,force:true}));const artifacts=new TextArtifactStore(join(root,'artifacts'));const runtime=new SelectableTextRuntime(store,catalog,grants,artifacts);const product=new ProductService(store,undefined,runtime);const missionId='selection-'+randomUUID();
 await product.create({id:missionId,purpose:'Selection fixture',scope:'fixture-only',constraints:[],criteria:{version:1,description:'Return fixture text',oracle:TEXT_REVIEW_ORACLE}},'create');await product.admit(missionId,{commandId:'admit',expectedRevision:1,workId:'work',title:'Test selection',budget:128});
 const choice:ExecutionChoice={executorProfileId:'b',verifierProfileId:'a',authorizationId:'test-grant',outputTokenCap:32};
 return {store,calls,profiles,catalog,grants,root,artifacts,runtime,product,missionId,choice};
}
test('explicit per-role choice routes to different actual HTTP endpoints and persists immutable bindings',async t=>{
 const s=await setup(t);const mission=(await s.store.load(s.missionId))!.value;assert.match(mission.works[0]!.blocker!.detail,/Choose executor/);assert.equal(s.runtime.preflight(mission,s.choice).ready,true);assert.equal(s.calls.length,0);
 const result=await s.product.run(s.missionId,'work','run',2,s.choice);assert.equal(result.status,'settled');assert.deepEqual(s.calls.map(c=>[c.model,c.port]),[['exact-b',1],['exact-a',0]]);
 const work=result.snapshot.value.works[0]!;assert.equal(work.runtimeRun!.connectionBindings!.executor.profileId,'b');assert.equal(work.runtimeRun!.connectionBindings!.verifier.profileId,'a');
 assert.equal(work.assignments.find(a=>a.role==='verifier')!.model.configVersion,work.runtimeRun!.connectionBindings!.verifier.configHash);
 assert.notEqual(work.assignments.find(a=>a.role==='executor')!.actorId,work.assignments.find(a=>a.role==='verifier')!.actorId);assert.equal(s.calls[1]!.prompt.artifact.content,'Fixture result');assert.equal(work.record!.evidenceClass,'fixture');
 const operations=[...(s.store as InMemoryStore<Mission>).inspect()];const serialized=await exportPortableBackup({exportJournal:async()=>({schemaVersion:2 as const,head:operations.length,operations})},s.artifacts);const restored=parsePortableBackup(serialized);assert.deepEqual(restored.journal.operations.at(-1)!.value.works[0]!.runtimeRun!.connectionBindings,work.runtimeRun!.connectionBindings);
});
test('missing choice, wrong role grant, changed config, unknown model and unknown usage reject before any effect',async t=>{
 const s=await setup(t);const mission=(await s.store.load(s.missionId))!.value;
 for(const selection of [undefined,{...s.choice,executorProfileId:'missing'},{...s.choice,authorizationId:'wrong'},{...s.choice,outputTokenCap:65}]){assert.equal((await s.product.run(s.missionId,'work',randomUUID(),2,selection)).status,'blocked');}
 const changed=new ConnectionCatalog(s.profiles.map(p=>({...p,model:'changed'})),[chatProfileFactory({mode:'local-http-mock',transport:fetch})]);const runtime=new SelectableTextRuntime(s.store,changed,s.grants,s.artifacts);assert.equal(runtime.preflight(mission,s.choice).ready,false);
 const roleGrant=new SelectableTextRuntime(s.store,s.catalog,[{...s.grants[0]!,verifier:[]}],s.artifacts);assert.equal(roleGrant.preflight(mission,s.choice).ready,false);assert.equal(s.calls.length,0);assert.equal((await s.store.load(s.missionId))!.revision,2);
});
test('same connection may serve separate stateless roles; changing selection after admitted unknown cannot replay',async t=>{
 const s=await setup(t,undefined,true);const result=await s.product.run(s.missionId,'work','unknown-run',2,{...s.choice,verifierProfileId:'b'});assert.equal(result.snapshot.value.works[0]!.effects[0]!.status,'unknown');
 const restarted=new SelectableTextRuntime(s.store,s.catalog,s.grants,s.artifacts);assert.equal((await restarted.run(s.missionId,'work','retry',result.snapshot.revision,{...s.choice,executorProfileId:'c'})).status,'already-started');assert.equal(s.calls.length,1);
});
test('HTTP preflight and run use the same selection contract and catalog exposes no secret reference',async t=>{
 const s=await setup(t);const server=createWorkbench(s.store,s.root,{runtime:s.runtime});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});const address=server.address();assert.ok(address&&typeof address==='object');const url=`http://127.0.0.1:${address.port}`;
 const catalog=await(await fetch(url+'/providers')).json() as any;assert.equal(catalog.runtime.connections.length,3);assert.ok(!JSON.stringify(catalog).includes('secretRef'));
 const post=(route:string,selection:any)=>fetch(url+'/missions/'+s.missionId+'/'+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workId:'work',commandId:'http-run',expectedRevision:2,selection})});
 assert.equal((await(await post('preflight',s.choice)).json() as any).ready,true);assert.equal(s.calls.length,0);
 assert.equal((await(await post('run',s.choice)).json() as any).status,'settled');assert.deepEqual(s.calls.map(c=>c.model),['exact-b','exact-a']);
});
test('actual Surreal reopens selected model bindings and exact accepted Record', {skip:!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
 const transport=createHttpRpcTransport({endpoint:process.env.MASSION_TEST_SURREAL_RPC!,namespace:'massion_storage_tests',database:'massion_storage_tests'});await initializeSurrealSchema(transport);const store=new SurrealStore<Mission>(transport);const s=await setup(t,store);const result=await s.product.run(s.missionId,'work','durable-run',2,s.choice);assert.equal(result.status,'settled');assert.deepEqual(await new SurrealStore<Mission>(transport).load(s.missionId),result.snapshot);
});

test('invalid profile credentials and extra fields cannot escape through public configuration',async t=>{
 const s=await setup(t);const unsafe={...s.profiles[0]!,endpoint:'https://user:SYNTHETIC_SECRET@example.invalid/v1/chat/completions',apiKey:'SYNTHETIC_KEY'};
 const catalog=new ConnectionCatalog([unsafe],[chatProfileFactory({mode:'https',transport:async()=>{throw Error('must not send');}})]);
 const runtime=new SelectableTextRuntime(s.store,catalog,[],s.artifacts);const serialized=JSON.stringify(runtime.configuration());assert.ok(!serialized.includes('SYNTHETIC'));assert.ok(serialized.includes('profile_invalid'));assert.equal(runtime.preflight((await s.store.load(s.missionId))!.value,s.choice).ready,false);
});
test('backup rejects a profile binding that disagrees with already assigned model configuration',async t=>{
 const {validateMissionLineage}=await import('../src/backup-lineage.ts');const s=await setup(t,undefined,true);const result=await s.product.run(s.missionId,'work','run',2,s.choice);const altered=structuredClone(result.snapshot.value);altered.works[0]!.runtimeRun!.connectionBindings!.executor.configHash='0'.repeat(64);assert.throws(()=>validateMissionLineage(altered),/binding mismatch/);
});

test('unknown nested usage fields are rejected and never appear in public configuration',async t=>{
 const s=await setup(t);const unsafe={...s.profiles[0]!,usage:{...s.profiles[0]!.usage,apiKey:'NESTED_SYNTHETIC_SECRET'}};const catalog=new ConnectionCatalog([unsafe],[chatProfileFactory({mode:'local-http-mock',transport:fetch})]);
 const runtime=new SelectableTextRuntime(s.store,catalog,[],s.artifacts);assert.ok(!JSON.stringify(runtime.configuration()).includes('NESTED_SYNTHETIC_SECRET'));assert.equal(catalog.resolve(unsafe.id,['text-output']).status,'unavailable');
});
