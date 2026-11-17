import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID,FIRST_MESSAGE_LOGIN_ORDER} from '../src/connection-activation.ts';
import type {ConnectionActivationState} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:turn('4'),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});
// The codex runner answers in the codex CLI's own JSONL shape (parseCodexEvents); a claude-shaped stub would hide that provider's real contract.
const codexResult=[{type:'thread.started',thread_id:'t'},{type:'item.completed',item:{id:'item_0',type:'agent_message',text:turn('4')}},{type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:0,output_tokens:3}}].map(line=>JSON.stringify(line)).join('\n');
const aggregate=async(store:InMemoryStore<Mission>)=>(await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined;
const firstMessageCommand=(store:InMemoryStore<Mission>)=>store.inspect().flatMap(operation=>operation.events as unknown as {command?:{kind?:string;way?:string;detectedLogins?:string[]}}[]).flatMap(event=>event.command? [event.command]:[]).find(command=>command.kind==='turn-on'&&command.way==='first-message');

async function fixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'}={}){
 const root=await mkdtemp(join(tempRoot(),'first-message-picks-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:call.command==='codex'?codexResult:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};};
 const loginRunner:CliRunner=async call=>{
  const codex=call.command==='codex',detected=detect(codex?'codex-cli':'claude-code-cli')==='detected';
  if(codex)return {spawned:true,exitCode:detected?0:1,stdout:'',stderr:detected?'Logged in using ChatGPT':'Not logged in',timedOut:false,aborted:false,overflow:false};
  return {spawned:true,exitCode:0,stdout:JSON.stringify(detected?{loggedIn:true,authMethod:'claude.ai'}:{loggedIn:false}),stderr:'',timedOut:false,aborted:false,overflow:false};
 };
 const logins=new LoginConnections(loginRunner);
 const transport=async()=>new Response(JSON.stringify({data:[]}),{headers:{'content-type':'application/json'}});
 const startup=await loadHostStartup([]);
 const host=(store_:InMemoryStore<Mission>=store)=>createHostConnections(store_,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:(providerType:string,signal?:AbortSignal)=>logins.recheck(providerType,signal).then(status=>status.status)});
 return {root,store,secrets,settings,startup,host,cliCalls,setDetect:(next:(providerType:string)=>'detected'|'absent')=>{detect=next;}};
}

test('two detected logins: the first owner message turns Claude Code on, answers through it and records the first route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['claude'],'the pick is Claude Code, not Codex and not both');
 assert.equal(connections.connectionOn(claude.id),true);assert.equal(connections.connectionOn(codex.id),false,'the other connection stays off');
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']]);
 assert.equal(state?.routeChoice?.source,'first-route');
 assert.equal(state?.routeChoice?.model,BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']);
 assert.equal(connections.list().representative?.derived,true,'the route is marked as derived, so a screen can say it was chosen for the owner');
 // Reversing FIRST_MESSAGE_LOGIN_ORDER flips this stored order and the pick; these hardcoded expectations then fail (the constant's use, not only its value).
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[claude.id,codex.id],'the stored detected set is in FIRST_MESSAGE_LOGIN_ORDER');
 validateMissionJournalLineage(f.store.inspect());
});

test('Claude Code installed but logged out, Codex logged in: the first message answers through Codex',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='codex-cli'?'detected' as const:'absent' as const}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['codex'],'only the logged-in login counts');
 assert.equal(connections.connectionOn(codex.id),true);assert.equal(connections.connectionOn(claude.id),false);
 assert.equal((await aggregate(f.store))?.routeChoice?.model,BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli']);
 assert.deepEqual(firstMessageCommand(f.store)?.detectedLogins,[codex.id]);
 validateMissionJournalLineage(f.store.inspect());
});

test('a message that is not owner-typed turns nothing on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'scheduled');
 assert.equal(answer.message.status,'committed');assert.equal(answer.turn?.status,'not_started');
 assert.equal(answer.turn?.diagnostics?.some(d=>d.code==='assistant_route_missing'),true);
 assert.equal(await aggregate(f.store),undefined);
 assert.equal(connections.list().connections.some(c=>c.on),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('an API-key connection the owner turned on: the first message still chooses nothing',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!,claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 assert.equal((await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'not_started');
 assert.deepEqual((await aggregate(f.store))?.activations.map(a=>[a.connectionId,a.way]),[[openai.id,'key-added']],'today\'s behaviour: a connection already on blocks the first-message pick');
 assert.equal(connections.connectionOn(claude.id),false);assert.equal(connections.connectionOn(codex.id),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('a route the owner closed stays closed: the first message turns nothing on',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:true});
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'not_started');
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[codex.id,'model-selected']],'no second activation for the closed route');
 assert.equal(state?.routeChoice,null);assert.equal(connections.connectionOn(claude.id),false);
 assert.deepEqual(f.cliCalls,[]);
 validateMissionJournalLineage(f.store.inspect());
});

test('two first messages racing on one revision: one activation, one route, one answer',async t=>{
 const f=await fixture(t);
 // Signal-based entry gate (issue #227): each request signals when it reaches the segment commit, and the gate opens only after BOTH signalled; no event-loop-turn counting.
 const firstSegment=segmentId(1);
 let opened=false,entered=0;
 let openGate!:()=>void,secondEntered!:()=>void;const gate=new Promise<void>(resolve=>openGate=resolve),bothEntered=new Promise<void>(resolve=>secondEntered=resolve);
 const gatedStore=new Proxy(f.store,{
  get(target,property){
   if(property!=='commit')return Reflect.get(target,property);
   return async(input:Parameters<InMemoryStore<Mission>['commit']>[0])=>{
   if(input.id===firstSegment&&!opened){if(++entered===2)secondEntered();await gate;}
    return await target.commit(input);
   };
  }
 }) as InMemoryStore<Mission>;
 const connections=f.host(gatedStore);await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(gatedStore,new ProductService(gatedStore,undefined,connections),connections);
 const racing=[assistant.send({commandId:'race-a',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed'),assistant.send({commandId:'race-b',segment:1,expectedRevision:0,text:'3+3? Reply with just the numeral.'},undefined,'owner-typed')];
 await bothEntered;openGate();opened=true;
 const results=await Promise.all(racing);
 // The two answers are compared first: with the store's revision lane removed both messages commit and fail here, not on a later count.
 const committed=results.filter(result=>result.message.status==='committed'),refused=results.filter(result=>result.message.status!=='committed');
 assert.equal(committed.length,1,'exactly one first message was accepted');
 assert.equal(refused.length,1,'the racing second message lost at the segment revision');
 assert.equal(committed[0]!.turn?.status,'answered');assert.equal(committed[0]!.turn?.reply,'4');
 assert.equal(refused[0]!.turn,null);
 const state=await aggregate(f.store);
 assert.deepEqual(state?.activations.map(a=>[a.connectionId,a.way]),[[claude.id,'first-message']],'one activation');
 assert.equal(state?.routeChoice?.connectionId,claude.id,'one route');
 assert.equal(connections.connectionOn(codex.id),false);
 assert.deepEqual(f.cliCalls,['claude']);
 validateMissionJournalLineage(f.store.inspect());
});

test('after the pick, selecting the other provider in Settings turns it on and never replaces the route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');
 const picked=(await aggregate(f.store))?.routeChoice!;
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:false});
 assert.equal(connections.connectionOn(codex.id),true);
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,picked.profileId,'an existing route is never replaced silently');
 // The screens have no switch path (PR finding): after the owner closes the route, a selection still sets no route.
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:false});
 assert.equal(connections.list().representative,null);
 validateMissionJournalLineage(f.store.inspect());
});

test('the first-message login order is a release-fixed table: Claude Code CLI, then Codex CLI',()=>{
 assert.deepEqual([...FIRST_MESSAGE_LOGIN_ORDER],['claude-code-cli','codex-cli']);
});
