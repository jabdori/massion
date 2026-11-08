import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../src/application.ts';
import {hash,workInputHash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {ASSISTANT_ACTOR_ID,assistantTurnId,assistantWorkId,ownerMessageId} from '../src/assistant-conversation.ts';
import {applyMembers,MEMBERS_ID,MembersService} from '../src/members.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {ProductService} from '../src/product.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'routing-fence-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),settings=new InMemoryHostSettings(),artifacts=new TextArtifactStore(root),calls:string[]=[];
 const manifest=parseHostManifest({version:1,revision:'routing-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'openrouter',baseUrl:'http://127.0.0.1:9999/v1/',models:['openai/producer','google/producer','anthropic/checker']}]});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{const b=JSON.parse(String(init!.body)),p=JSON.parse(b.messages[0].content);calls.push(b.model);const content=p.artifact?JSON.stringify({artifactSha256:p.binding.artifactSha256,criteriaVersion:p.criteria.version,criteriaHash:p.binding.criteriaHash,verdict:'passed',checks:[{criterion:p.criteria.description,passed:true,quote:'Bounded answer',reason:'Fixture'}]}):'Bounded answer';return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:b.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 const hooks:{load?:(id:string)=>Promise<void>;lookup?:(id:string)=>Promise<void>}={};
 const observed=new Proxy(store,{get(target,key){if(key==='load')return async(id:string)=>{const result=await target.load(id);await hooks.load?.(id);return result;};if(key==='lookupOperation')return async(identity:any)=>{const result=await target.lookupOperation(identity);await hooks.lookup?.(identity.commandId);return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const host=(s:Store<any>=observed)=>createHostConnections(s,artifacts,{manifest,allowLiveExecution:false},{transport,settings,readEnvironment:()=>assert.fail('No credentials')});
 const runtime=host(),other=host(store),profile=(name:string)=>(runtime.configuration().connections as any[]).find(p=>p.model===name).id;
 for(const [id,model] of [['default-grant','openai/producer'],['member-grant','google/producer']])await runtime.save(()=>runtime.authorize({id,scope:'local',executorProfileId:profile(model!),verifierProfileId:profile('anthropic/checker'),maxOutputTokensPerCall:4,expectedConfigHash:runtime.list().configHash}));
 await runtime.save(()=>runtime.setDefaultRoute({authorizationId:'default-grant',outputTokenCap:4,expectedConfigHash:runtime.list().configHash}));
 const group=async(r:typeof runtime,model='google/producer')=>r.save(()=>r.saveModelGroup({id:'analysis',name:'Analysis',description:'Checks tables',profileIds:[profile(model),profile('anthropic/checker')],expectedConfigHash:r.list().configHash}));
 await group(runtime);await other.restoreSettings();
 const proposed=applyMembers(null,{type:'propose-member',decisionId:'decision',topic:'Tables',works:[{title:'A'},{title:'B'}],count:2},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{observedAt:1});
 const admitted=applyMembers(proposed.value,{type:'admit-member',decisionId:'decision',memberId:'quill',name:'Quill',shape:'drop'},{id:'local-owner',roles:['owner']},{observedAt:2});
 await store.commit({id:MEMBERS_ID,commandId:'fixture-members',expectedRevision:0,fingerprint:hash('fixture-members'),...admitted,outbox:[]});
 const members=new MembersService(store,()=>'mission');await members.setGroup({commandId:'initial-group',memberId:'quill',modelGroup:'analysis'},runtime);
 const app=new Application(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']}]);
 await app.create({id:'mission',purpose:'Tables',scope:'local',constraints:[],criteria:{version:1,description:'Bounded answer',oracle:'bounded-text-review/v1'}},'local-owner','create');
 const ids:string[]=[];for(const key of ['one','two']){const messageId=ownerMessageId(key),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner' as const,turnId:null,text:'Check a table'};ids.push(workId);await app.dispatch({missionId:'mission',commandId:key,expectedRevision:(await store.load('mission'))!.revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId,title:key,budget:8,assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'openrouter',model:'openai/producer'},memberId:'quill'}}});}
 const product=new ProductService(observed,undefined,runtime),current=async()=>(await store.load('mission'))!,plan=async()=>{const s=await current();return {commandId:'sequence',expectedRevision:s.revision,works:s.value.works.map((w:any)=>({workId:w.id,inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}))};};
 const choice={executorProfileId:profile('google/producer'),verifierProfileId:profile('anthropic/checker'),authorizationId:'member-grant',outputTokenCap:4};
 return {store,observed,hooks,runtime,other,members,product,current,plan,ids,calls,choice,group,transport,artifacts};
}

for(const explicit of [false,true])for(const change of ['local-edit','local-remove','remote-edit','remote-remove','local-assignment','remote-assignment'] as const)test(`sequence fences ${change} between stages (${explicit?'explicit':'implicit'})`,async t=>{
 const f=await fixture(t),run=f.runtime.run.bind(f.runtime);let first=true;
 f.runtime.run=async(...args)=>{const result=await run(...args);if(first&&result.status==='settled'){first=false;if(change.endsWith('assignment'))await f.members.setGroup({commandId:'reassign',memberId:'quill',modelGroup:'default'},change.startsWith('local')?f.runtime:f.other);else{const r=change.startsWith('local')?f.runtime:f.other;if(change.endsWith('edit'))await f.group(r,'openai/producer');else await r.save(()=>r.removeModelGroup({id:'analysis',expectedConfigHash:r.list().configHash}));}}return result;};
 const input=await f.plan(),result=await f.product.runSequence('mission',{...input,...(explicit?{selection:f.choice}:{})});
 assert.equal(result.status,'stopped');assert.deepEqual(result.completedWorkIds,[f.ids[0]]);assert.equal((await f.current()).value.works[1].runtimeRun,undefined);assert.deepEqual(f.calls,['google/producer','anthropic/checker']);
});

for(const explicit of [false,true])for(const kind of ['preflight','start','sequence'] as const)for(const change of ['group','assignment'] as const)test(`${kind} fences ${change} while its original Mission read awaits (${explicit?'explicit':'implicit'})`,async t=>{
 const f=await fixture(t),input=await f.plan();let changed=false;
 f.hooks.load=async id=>{if(changed||id!=='mission')return;changed=true;if(change==='group')await f.group(f.runtime,'openai/producer');else await f.members.setGroup({commandId:'reassign',memberId:'quill',modelGroup:'default'},f.other);};
 const result:any=kind==='preflight'?await f.product.preflight('mission',f.ids[0]!,input.expectedRevision,explicit?f.choice:undefined):kind==='start'?await f.product.run('mission',f.ids[0]!,'single',input.expectedRevision,explicit?f.choice:undefined):await f.product.runSequence('mission',{...input,...(explicit?{selection:f.choice}:{})});
 assert.equal(kind==='preflight'?result.ready:result.status,kind==='preflight'?false:kind==='start'?'blocked':'stopped');assert.deepEqual(f.calls,[]);assert.equal((await f.current()).value.works[0].runtimeRun,undefined);
});

for(const explicit of [false,true])for(const change of ['remote-group','assignment'] as const)test(`single Start fences ${change} after runtime selection before activation (${explicit?'explicit':'implicit'})`,async t=>{
 const f=await fixture(t),s=await f.current();let changed=false;
 f.hooks.lookup=async id=>{if(changed||id!=='activation-race')return;changed=true;if(change==='remote-group')await f.group(f.other,'openai/producer');else await f.members.setGroup({commandId:'reassign',memberId:'quill',modelGroup:'default'},f.other);};
 const result=await f.product.run('mission',f.ids[0]!,'activation-race',s.revision,explicit?f.choice:undefined);
 assert.equal(result.status,'blocked');assert.deepEqual(f.calls,[]);assert.equal((await f.current()).value.works[0].runtimeRun,undefined);
});

test('activation rejects a remote group edit while the member fence read is in flight',async t=>{
 const f=await fixture(t),s=await f.current();let activation=false,changed=false;
 f.hooks.lookup=async id=>{if(id==='late-group')activation=true;};
 f.hooks.load=async id=>{if(!activation||changed||id!==MEMBERS_ID)return;changed=true;await f.group(f.other,'openai/producer');};
 const result=await f.product.run('mission',f.ids[0]!,'late-group',s.revision);
 assert.equal(result.status,'blocked');assert.deepEqual(f.calls,[]);assert.equal((await f.current()).value.works[0].runtimeRun,undefined);
});

for(const explicit of [false,true])test(`unchanged member sequence preserves the selected producers and independent checker (${explicit?'explicit':'implicit'})`,async t=>{
 const f=await fixture(t),input=await f.plan(),result=await f.product.runSequence('mission',{...input,...(explicit?{selection:f.choice}:{})});
 assert.equal(result.status,'completed');assert.deepEqual(f.calls,['google/producer','anthropic/checker','google/producer','anthropic/checker']);
 for(const w of (await f.current()).value.works){assert.equal(w.acceptance,'accepted');assert.equal(w.runtimeRun.authorizationId,'member-grant');assert.notEqual(w.assignments.find((a:any)=>a.role==='executor').actorId,w.assignments.find((a:any)=>a.role==='verifier').actorId);}
});

test('direct configured runtime keeps the Product member fence until activation',async t=>{
 const {lifetimeFixture}=await import('./support/runtime-lifetime-fixture.ts'),{ConfiguredTextRuntime}=await import('../src/configured-runtime.ts'),f=await lifetimeFixture(t);
 let changed=false;const store=new Proxy(f.store,{get(target,key){if(key==='lookupOperation')return async(identity:any)=>{const result=await target.lookupOperation(identity);if(!changed&&identity.commandId==='direct-fence'){changed=true;const input=applyMembers(null,{type:'propose-member',decisionId:'decision',topic:'Tables',works:[{title:'A'},{title:'B'}],count:2},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{observedAt:1});await (target as Store<any>).commit({id:MEMBERS_ID,commandId:'fixture-new-members',expectedRevision:0,fingerprint:hash('fixture-new-members'),...input,outbox:[]});}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const product=new ProductService(store,undefined,new ConfiguredTextRuntime(store,f.config)),result=await product.run('mission','fresh','direct-fence',(await f.current()).revision);
 assert.equal(result.status,'blocked');assert.equal(f.calls.length,0);assert.equal((await f.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun,undefined);
});


test('standalone selectable runtime retains the original member fence through its configured delegate',async t=>{
 const f=await fixture(t),{ConnectionCatalog}=await import('../src/provider-profiles.ts'),{chatProfileFactory}=await import('../src/chat-profile-factory.ts'),{SelectableTextRuntime}=await import('../src/selectable-runtime.ts');
 const profiles:import('../src/provider-profiles.ts').ModelConnectionProfile[]=['google/producer','anthropic/checker'].map((model,i)=>({id:'p'+i,label:model,backend:'model-provider',providerKind:'openrouter',protocol:'openai-chat-completions/v1',model,endpoint:'http://127.0.0.1:9999/v1/chat/completions',revision:'1',enabled:true,auth:{method:'none'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:32768,maxOutputTokens:64,maxResponseBytes:32768,timeoutMs:1000}}));
 const catalog=new ConnectionCatalog(profiles,[chatProfileFactory({mode:'local-http-mock',transport:f.transport})]),permissions=catalog.list().map(p=>({profileId:p.id,configHash:p.configHash})),runtime=new SelectableTextRuntime(f.observed,catalog,[{id:'standalone',scope:'local',mode:'mock-http',executor:permissions,verifier:permissions,maxOutputTokensPerCall:4}],f.artifacts),product=new ProductService(f.observed,undefined,runtime);let changed=false;
 f.hooks.lookup=async id=>{if(id==='standalone-race'&&!changed){changed=true;await f.members.setGroup({commandId:'standalone-reassign',memberId:'quill',modelGroup:'default'},f.other);}};
 const result=await product.run('mission',f.ids[0]!,'standalone-race',(await f.current()).revision,{executorProfileId:'p0',verifierProfileId:'p1',authorizationId:'standalone',outputTokenCap:4});
 assert.equal(result.status,'blocked');assert.deepEqual(f.calls,[]);assert.equal((await f.current()).value.works[0].runtimeRun,undefined);
});

test('drain during the final routing fence remains a definite pre-admission refusal',async t=>{
 const f=await fixture(t),{HostDrainError}=await import('../src/runtime-lifetime.ts');let activation=false,drained=false,memberReads=0;
 f.hooks.lookup=async id=>{if(id==='drain-fence')activation=true;};f.hooks.load=async id=>{if(activation&&!drained&&id===MEMBERS_ID&&++memberReads===2){drained=true;f.runtime.beginDrain();}};
 await assert.rejects(f.product.run('mission',f.ids[0]!,'drain-fence',(await f.current()).revision),HostDrainError);
 assert.deepEqual(f.calls,[]);assert.equal((await f.current()).value.works[0].runtimeRun,undefined);
});
