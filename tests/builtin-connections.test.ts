import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS,BUILTIN_REVISION} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID} from '../src/connection-activation.ts';
import type {ConnectionActivationState} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const completion=(model:string,content:string)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
const claudeResult=(reply:string)=>JSON.stringify({type:'result',subtype:'success',is_error:false,result:reply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});
const turn=(reply:string)=>JSON.stringify({reply,work:null});
const activations=async(store:Store<Mission>)=>((await store.load(CONNECTION_ACTIVATION_ID))!.value as unknown as ConnectionActivationState).activations;

async function fixture(t:test.TestContext,models:string[]=['fixture-a','fixture-b']){
 const root=await mkdtemp(join(tmpdir(),'builtin-connections-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 const seen={models:[] as string[],inferences:[] as {model:string;authorization:string|null}[]},cliCalls:string[]=[],listed=[...models];
 const transport=async(url:string|URL|Request,init?:RequestInit)=>{
  const target=String(url);
  if(target.endsWith('/models')){seen.models.push(target);return new Response(JSON.stringify({data:listed.map(id=>({id}))}),{headers:{'content-type':'application/json'}});}
  const body=JSON.parse(String(init!.body));seen.inferences.push({model:body.model,authorization:new Headers(init!.headers).get('authorization')});
  return completion(body.model,turn('Paris.'));
 };
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:claudeResult(turn('4')),stderr:'',timedOut:false,aborted:false,overflow:false};};
 const startup=await loadHostStartup([]);
 const host=(store_:Store<Mission>=store,settings_:InMemoryHostSettings=settings)=>createHostConnections(store_,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings:settings_,cliRunner,loginStatus:async(providerType:string)=>providerType==='claude-code-cli'?'detected' as const:'absent' as const});
 return {root,store,secrets,settings,startup,seen,cliCalls,listed,host};
}

test('without a host configuration the core starts on the built-in five-connection list with a fixed scope',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const list=connections.list();
 assert.equal(f.startup.builtin,true);assert.equal(list.host?.revision,BUILTIN_REVISION);
 assert.deepEqual(list.connections.map(c=>[c.id.split(':')[1],c.label,c.providerType,c.baseUrl,c.mode]),[
  ['claude','Claude Code','claude-code-cli','cli://claude-code/','https'],
  ['codex','Codex','codex-cli','cli://codex/','https'],
  ['anthropic','Anthropic API','anthropic','https://api.anthropic.com/v1/','https'],
  ['openai','OpenAI API','openai','https://api.openai.com/v1/','https'],
  ['zai','Z.ai GLM Coding Plan','zai','https://api.z.ai/api/coding/paas/v4/','https']]);
 for(const id of ['anthropic','openai','zai']){const connection=list.connections.find(c=>c.id.includes(':'+id+':'))!;assert.deepEqual(connections.secretSource(connection.id)!.secret,{owner:id,slot:'api-key'});assert.equal(connections.canReplaceKey(connection.id),true);}
 const scope=list.persistence!.scope!;assert.match(scope,/^builtin:/);assert.equal(f.host().list().persistence!.scope,scope);
 // Only the two recommended CLI models are pre-selected; API models come from discovery.
 assert.deepEqual((list.runtime.connections as any[]).map(p=>p.model).sort(),[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli']].sort());
 await assert.rejects(connections.turnOnConnection('probe','host:none','key-added'),/Unknown connection/);
 const file=join(f.root,'host.json');await writeFile(file,JSON.stringify({version:1,revision:'file-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['exec']}]}));
 const started=await loadHostStartup(['--host-config',file]);assert.equal(started.builtin,undefined);assert.equal(started.manifest!.revision,'file-v1');
 await assert.rejects(loadHostStartup(['--allow-live-model-calls']),/explicit host manifest/);
});

test('a first key on an empty own slot turns the connection on, offers the fetched list unfiltered and pins only the exact chosen model',async t=>{
 const f=await fixture(t,['fixture-a','fixture-b','undeclared-model']),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 const service=new ConnectionLifecycle(f.store,connections);
 assert.equal((await service.replaceKey({commandId:'key-first',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-openai-key'})).status,'completed');
 assert.equal(connections.connectionOn(openai.id),true);assert.equal((await f.secrets.read({owner:'openai',slot:'api-key'})),'fixture-openai-key');
 assert.doesNotMatch(JSON.stringify([f.store.inspect(),await service.read(),connections.list()]),/fixture-openai-key|openai-key/);
 assert.equal(connections.list().representative,null);
 const discovered=await connections.discover(openai.id,openai.configHash);
 assert.equal(discovered.status,'listed');assert.deepEqual(discovered.models.map(m=>m.id),['fixture-a','fixture-b','undeclared-model']);
 assert.equal(discovered.message,'Model metadata received; this does not verify live inference.');
 const {profileId}=await connections.save(()=>connections.selectModel(openai.id,{model:'fixture-a',label:'Fixture A',expectedConfigHash:openai.configHash}));
 assert.equal(await connections.firstRepresentativeFromSelection(profileId),true);
 const representative=connections.list().representative as any;assert.equal(representative.status,'active');assert.equal(representative.route.profileId,profileId);assert.equal(representative.intakeMissionId,'assistant-intake');
 assert.ok(await f.store.load('assistant-intake'));
 await connections.save(()=>connections.authorize({id:'grant',scope:'local',executorProfileId:profileId,verifierProfileId:profileId,maxOutputTokensPerCall:4,expectedConfigHash:connections.list().configHash}));
 await connections.save(()=>connections.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:connections.list().configHash}));
 await connections.save(()=>connections.saveModelGroup({id:'work',name:'Work',description:'Pinned',profileIds:[profileId],expectedConfigHash:connections.list().configHash}));
const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-openai',segment:1,expectedRevision:0,text:'Capital of France? One word.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn.reply,'Paris.');
 assert.deepEqual(f.seen.inferences,[{model:'fixture-a',authorization:'Bearer fixture-openai-key'}]);
 // A model that newly appears in a later fetch is never used until the owner selects it.
 const second=f.host();await second.restoreSettings();
 const openai2=second.list().connections.find(c=>c.id===openai.id)!;
 f.listed.push('fixture-new');

 const modelsAgain=await second.discover(openai2.id,openai2.configHash);assert.equal(modelsAgain.models!.some(m=>m.id==='fixture-new'),true);
 const pinned=second.list().runtime.defaultRoutes[0]!;
 const pinnedModel=(second.list().runtime.connections as any[]).find(p=>p.id===pinned.executor.profileId)!.model;
 assert.equal(pinnedModel,'fixture-a');
 assert.equal((second.chooseGroupModel('work',{outputTokenCap:4}) as any).model,'fixture-a');
 assert.equal((second.list().runtime.connections as any[]).some(p=>p.model==='fixture-new'),false);
 const chosen=await second.save(()=>second.selectModel(openai2.id,{model:'fixture-new',label:'New',expectedConfigHash:openai2.configHash}));
 assert.equal((second.list().runtime.connections as any[]).some(p=>p.model==='fixture-new'),true);assert.notEqual(chosen.profileId,profileId);
 assert.equal(modelsAgain.status,'listed');
 validateMissionJournalLineage(f.store.inspect());
});

test('a detected login alone makes no call; the first owner message turns it on once, answers through it and survives restart',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 assert.equal(connections.list().representative,null);
 assert.equal((await connections.resolveRepresentative()).status,'unresolved');
 assert.deepEqual(f.cliCalls,[]);assert.deepEqual(f.seen.models,[]);assert.deepEqual(f.seen.inferences,[]);
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const offProfile=connections.list().runtime.connections[0]!.id;
 await assert.rejects(connections.save(()=>connections.authorize({id:'off-grant',scope:'local',executorProfileId:offProfile,verifierProfileId:offProfile,maxOutputTokensPerCall:4,expectedConfigHash:connections.list().configHash})),/separately authorized/);
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');assert.equal(first.turn.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);assert.equal(connections.connectionOn(claude.id),true);
 const decisions=await activations(f.store);
 assert.deepEqual(decisions.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']]);assert.ok(Number.isSafeInteger(decisions[0]!.at));
 const representative=connections.list().representative as any;
 assert.equal(representative.status,'active');assert.equal(representative.intakeMissionId,'assistant-intake');
 validateMissionJournalLineage(f.store.inspect());
 // Restart on the same database and settings scope: the on state and route persist, still one decision.
 const restarted=f.host();await restarted.restoreSettings();
 assert.equal(restarted.connectionOn(claude.id),true);assert.equal((await restarted.resolveRepresentative()).status,'resolved');
 const assistant2=new AssistantService(f.store,new ProductService(f.store,undefined,restarted),restarted);
 const view=await assistant2.read();
 const second=await assistant2.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'Again? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(second.turn?.status,'answered');assert.deepEqual(f.cliCalls,['claude','claude']);
 assert.equal((await activations(f.store)).length,1);
});

test('starting a subscription login through the owner command turns that connection on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const logins=new LoginConnections(async()=>({spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false}));
 const server=createWorkbench(f.store,f.root,{connections,logins,scheduleIntervalMs:0});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const response=await fetch(origin+'/connection-login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({providerType:'codex-cli',commandId:'login:1'})});
 assert.equal(response.status,200);
 const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 assert.equal(connections.connectionOn(codex.id),true);
 assert.deepEqual((await activations(f.store)).map(a=>[a.connectionId,a.way]),[[codex.id,'login-started']]);
 validateMissionJournalLineage(f.store.inspect());
});

test('subscription CLIs give no list and the recommended model stays a release-fixed table',async()=>{
 assert.deepEqual({...BUILTIN_CLI_RECOMMENDED_MODELS},{'claude-code-cli':'claude-sonnet-5-5','codex-cli':'gpt-6.1-terra'});
});

