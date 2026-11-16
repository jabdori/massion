import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID,modelSelectionDecision,applyActivation,activationState as parseActivation,replayConnectionActivation} from '../src/connection-activation.ts';
import type {ConnectionActivationState} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {authProof} from '../src/daemon-auth.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store,Operation} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';

const reply=JSON.stringify({reply:'4',work:null});
const aggregate=async(store:Store<Mission>)=>(await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined;
const activations=async(store:Store<Mission>)=>(await aggregate(store))?.activations??[];
/** Replay every stored activation operation and require the derived state to equal the live aggregate. */
function replayAggregate(store:InMemoryStore<Mission>):ConnectionActivationState|undefined{
 let replayed=parseActivation(undefined),prior:Operation<ConnectionActivationState>|undefined,seen:Operation<ConnectionActivationState>|undefined;
 for(const operation of store.inspect() as unknown as Operation<ConnectionActivationState>[]){
  if(operation.aggregateId!==CONNECTION_ACTIVATION_ID)continue;
  replayConnectionActivation(operation,prior);
  const command=(operation.events[0] as {command:Parameters<typeof applyActivation>[1]}).command;
  replayed=applyActivation(replayed,command).value;prior=operation;seen=operation;
 }
 void seen;return replayed;
}

async function fixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'}={}){
 const root=await mkdtemp(join(tmpdir(),'model-selected-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[],loginCommands:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:reply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};};
 // The login host runs the provider status commands through this runner; a provider login command would appear here too.
 const loginRunner:CliRunner=async call=>{
  loginCommands.push(call.command+' '+call.args.join(' '));
  const codex=call.command==='codex',detected=detect(codex?'codex-cli':'claude-code-cli')==='detected';
  if(codex)return {spawned:true,exitCode:detected?0:1,stdout:'',stderr:detected?'Logged in using ChatGPT':'Not logged in',timedOut:false,aborted:false,overflow:false};
  return {spawned:true,exitCode:0,stdout:JSON.stringify(detected?{loggedIn:true,authMethod:'claude.ai'}:{loggedIn:false}),stderr:'',timedOut:false,aborted:false,overflow:false};
 };
 const logins=new LoginConnections(loginRunner);
 const transport=async()=>new Response(JSON.stringify({data:[]}),{headers:{'content-type':'application/json'}});
 const startup=await loadHostStartup([]);
 const host=()=>createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:(providerType:string,signal?:AbortSignal)=>logins.recheck(providerType,signal).then(status=>status.status)});
 return {root,store,secrets,settings,cliCalls,loginCommands,host,setDetect:(next:(providerType:string)=>'detected'|'absent')=>{detect=next;}};
}

test('modelSelectionDecision covers every combination of its inputs in one table',()=>{
 const owner={origin:'owner-typed' as const};
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:true,routePresent:false,routeClosedByOwner:false}),{turnOn:true,route:true});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:true,routePresent:true,routeClosedByOwner:false}),{turnOn:true,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:true,routePresent:false,routeClosedByOwner:true}),{turnOn:true,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:true,routePresent:true,routeClosedByOwner:true}),{turnOn:true,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:false,routePresent:false,routeClosedByOwner:false}),{turnOn:false,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:false,routePresent:true,routeClosedByOwner:false}),{turnOn:false,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:false,routePresent:false,routeClosedByOwner:true}),{turnOn:false,route:false});
 assert.deepEqual(modelSelectionDecision({...owner,loginDetected:false,routePresent:true,routeClosedByOwner:true}),{turnOn:false,route:false});
 for(const origin of ['scheduled','member','imported','replayed','unattributed'] as const){
  assert.deepEqual(modelSelectionDecision({origin,loginDetected:true,routePresent:false,routeClosedByOwner:false}),{turnOn:false,route:false},'origin '+origin);
  assert.deepEqual(modelSelectionDecision({origin,loginDetected:false,routePresent:true,routeClosedByOwner:true}),{turnOn:false,route:false},'origin '+origin);
 }
});

test('two detected logins: the Settings selection turns the chosen connection on, becomes the route and the first message answers',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(claude.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash}));
 const outcome=await connections.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'});
 assert.deepEqual(outcome,{status:'turned-on',reason:null,routeSet:true});
 assert.equal(connections.connectionOn(claude.id),true);assert.equal(connections.connectionOn(codex.id),false);
 const representative=connections.list().representative as any;
 assert.equal(representative.route.profileId,profileId);assert.equal(representative.derived,false,'the selection is recorded as the owner choice, not a derived first route');assert.equal(representative.status,'active');
 assert.deepEqual((await activations(f.store)).map(a=>[a.connectionId,a.way]),[[claude.id,'model-selected']]);
 assert.equal((await aggregate(f.store))?.routeChoice?.source,'owner-choice');
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const answer=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(answer.turn?.status,'answered');assert.equal(answer.turn.reply,'4');assert.deepEqual(f.cliCalls,['claude']);
 validateMissionJournalLineage(f.store.inspect());
 assert.deepEqual(replayAggregate(f.store),(await aggregate(f.store)));
});

test('login not detected: the selection is saved, the connection stays off, the outcome says why and no login command runs',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='claude-code-cli'?'absent' as const:'detected' as const});
 const connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const server=createWorkbench(f.store,f.root,{connections,daemonSecret:'a'.repeat(64),scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port,origin='http://127.0.0.1:'+port;
 // The daemon session is per socket, so the handshake and the selection share one keep-alive connection.
 const agent=new Agent({keepAlive:true,maxSockets:1});
 const request=(pathname:string,headers:Record<string,string>,body?:string)=>new Promise<{status:number,headers:Record<string,string>,body:string}>((resolve,reject)=>{const out=httpRequest({host:'127.0.0.1',port,path:pathname,method:body?'POST':'GET',agent,headers},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers as Record<string,string>,body:text}));});out.on('error',reject);if(body)out.end(body);else out.end();});
 const challenge='b'.repeat(64),handshake=await request('/desktop-auth',{'x-massion-challenge':challenge});
 const authorization='Bearer '+authProof('a'.repeat(64),'client',origin,challenge,handshake.headers['x-massion-nonce']!);
 const selection={model:'claude-opus-4-6',label:'Owner picked exact model',expectedConfigHash:claude.configHash};
 const response=await request('/connections/'+encodeURIComponent(claude.id)+'/profiles',{'content-type':'application/json',authorization},JSON.stringify(selection));
 assert.equal(response.status,200);
 const body=JSON.parse(response.body) as any;
 assert.deepEqual(body.activation,{status:'not-turned-on',reason:'login-not-detected',routeSet:false});
 assert.equal(typeof body.profileId,'string');assert.equal(body.connections.find((c:any)=>c.id===claude.id).on,false);assert.equal(body.representative,null);
 assert.equal(body.runtime.connections.some((p:any)=>p.model==='claude-opus-4-6'),true,'the selection is still saved as today');
 assert.deepEqual(await activations(f.store),[]);
 assert.ok(f.loginCommands.every(command=>command!=='claude auth login'&&command!=='codex login'),'no provider login command is spawned');
 validateMissionJournalLineage(f.store.inspect());
});

test('a Representative route that already exists is never replaced by a later selection',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='claude-code-cli'?'detected' as const:'absent' as const}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');
 const existing=(await aggregate(f.store))?.routeChoice!;
 f.setDetect(()=>'detected' as const);
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 const outcome=await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'});
 assert.deepEqual(outcome,{status:'turned-on',reason:null,routeSet:false});
 assert.equal(connections.connectionOn(codex.id),true);
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,existing.profileId);
 assert.equal(connections.list().representative?.route.profileId,existing.profileId);
 validateMissionJournalLineage(f.store.inspect());
 assert.deepEqual(replayAggregate(f.store),(await aggregate(f.store)));
});

test('a route the owner closed stays closed while the selection still turns the connection on',async t=>{
 const f=await fixture(t,{detect:providerType=>providerType==='claude-code-cli'?'detected' as const:'absent' as const}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 assert.equal(connections.list().representative,null);
 f.setDetect(()=>'detected' as const);
 const {profileId}=await connections.save(()=>connections.selectModel(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],expectedConfigHash:codex.configHash}));
 const outcome=await connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'});
 assert.deepEqual(outcome,{status:'turned-on',reason:null,routeSet:false});
 assert.equal(connections.connectionOn(codex.id),true);
 const state=await aggregate(f.store);
 assert.equal(state?.routeChoice,null);assert.notEqual(state?.routeClosedAt,null);assert.equal(connections.list().representative,null);
 validateMissionJournalLineage(f.store.inspect());
 assert.deepEqual(replayAggregate(f.store),state);
});

test('a selection request without the owner proof turns nothing on',async t=>{
 const f=await fixture(t);
 const connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const server=createWorkbench(f.store,f.root,{connections,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port;
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash};
 const response=await new Promise<{status:number,body:string}>((resolve,reject)=>{const payload=JSON.stringify(selection),out=httpRequest({host:'127.0.0.1',port,path:'/connections/'+encodeURIComponent(claude.id)+'/profiles',method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode??0,body:text}));});out.on('error',reject);out.end(payload);});
 assert.equal(response.status,200);
 const body=JSON.parse(response.body) as any;
 assert.deepEqual(body.activation,{status:'not-turned-on',reason:'not-owner',routeSet:false});
 assert.equal(connections.connectionOn(claude.id),false);assert.deepEqual(await activations(f.store),[]);assert.equal(connections.list().representative,null);
 validateMissionJournalLineage(f.store.inspect());
});

test('selecting on an API-key connection behaves as today: off does nothing to the route, on sets it from the selection',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 const {profileId}=await connections.save(()=>connections.selectModel(openai.id,{model:'fixture-api-model',label:'Fixture API model',expectedConfigHash:openai.configHash}));
 const off=await connections.activateFromSelection({connectionId:openai.id,profileId,origin:'owner-typed'});
 assert.deepEqual(off,{status:'not-turned-on',reason:'not-a-subscription-connection',routeSet:false});
 assert.equal(connections.list().representative,null);
 assert.equal((await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 assert.equal(connections.connectionOn(openai.id),true);
 const on=await connections.activateFromSelection({connectionId:openai.id,profileId,origin:'owner-typed'});
 assert.deepEqual(on,{status:'not-turned-on',reason:'not-a-subscription-connection',routeSet:true});
 assert.equal(connections.list().representative?.route.profileId,profileId);
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added']);
 validateMissionJournalLineage(f.store.inspect());
});

test('a repeated identical selection changes nothing more',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 const select=()=>connections.save(()=>connections.selectModel(claude.id,{model,label:model,expectedConfigHash:claude.configHash}));
 const first=await select();
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId:first.profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:true});
 const revision=(await f.store.load(CONNECTION_ACTIVATION_ID))!.revision,route=await aggregate(f.store);
 const second=await select();
 assert.equal(second.profileId,first.profileId);
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId:second.profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:false});
 assert.equal((await activations(f.store)).length,1);
 assert.equal((await f.store.load(CONNECTION_ACTIVATION_ID))!.revision,revision,'no second transition is committed');
 assert.deepEqual(await aggregate(f.store),route);
 validateMissionJournalLineage(f.store.inspect());
});
