import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {loadHostStartup,createHostConnections,parseHostManifest,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
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
import {CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV} from '../src/cli-agent-providers.ts';

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
 const root=await mkdtemp(join(tempRoot(),'model-selected-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[],cliLimits:(string|undefined)[]=[],loginCommands:string[]=[];
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);cliLimits.push(call.env[CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV]);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:reply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};};
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
 return {root,store,secrets,settings,startup,transport,cliCalls,cliLimits,loginCommands,host,setDetect:(next:(providerType:string)=>'detected'|'absent')=>{detect=next;}};
}

async function ownerClient(t:test.TestContext,f:Awaited<ReturnType<typeof fixture>>,connections:ReturnType<typeof f.host>){
 const secret='a'.repeat(64),server=createWorkbench(f.store,f.root,{connections,daemonSecret:secret,scheduleIntervalMs:0});
 const agent=new Agent({keepAlive:true,maxSockets:1});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>{agent.destroy();return new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 const port=(server.address() as {port:number}).port;
 const request=(path:string,headers:Record<string,string>,body?:unknown)=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:any}>((resolve,reject)=>{
  const out=httpRequest({host:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',agent,headers},res=>{
   let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);
   res.on('end',()=>{try{resolve({status:res.statusCode!,headers:res.headers,body:raw?JSON.parse(raw):null});}catch(error){reject(error);}});res.on('error',reject);
  });out.on('error',reject);out.end(body===undefined?undefined:JSON.stringify(body));
 });
 const challenge='b'.repeat(64),handshake=await request('/desktop-auth',{'x-massion-challenge':challenge});
 assert.ok(handshake.headers['x-massion-nonce']);
 const authorization='Bearer '+authProof(secret,'client','http://127.0.0.1:'+port,challenge,handshake.headers['x-massion-nonce'] as string);
 return (path:string,body?:unknown)=>request(path,{'content-type':'application/json',authorization},body);
}

test('a stale window cannot rename the pinned profile and the next message still answers',async t=>{
 const f=await fixture(t,{detect:()=> 'absent'}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const old={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'OLD',expectedConfigHash:claude.configHash};
 const first=await post(path,old);
 assert.equal(first.status,200);assert.deepEqual(first.body.activation,{status:'not-turned-on',reason:'login-not-detected',routeSet:false});
 f.setDetect(()=> 'detected');
 const second=await post(path,{...old,label:'NEW'});
 assert.equal(second.status,200);assert.equal(second.body.profileId,first.body.profileId);
 assert.deepEqual(second.body.activation,{status:'turned-on',reason:null,routeSet:true});
 assert.equal(second.body.representative.status,'active');
 const scope=connections.list().persistence!.scope!,before=await f.settings.load(scope),routeBefore=await f.store.load(CONNECTION_ACTIVATION_ID);

 const stale=await post(path,old);
 assert.equal(stale.status,409,'changing the pinned profile hash must be refused');
 assert.deepEqual(stale.body,{error:'The selection would change the profile pinned by the Representative route.',reason:'representative-profile-pinned'});
 assert.deepEqual(await f.settings.load(scope),before,'the saved profile and its settings revision are unchanged');
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),routeBefore,'the pinned route and its revision are unchanged');
 assert.equal(connections.list().runtime.connections.find(p=>p.id===first.body.profileId)?.label,'NEW');
 assert.equal(connections.list().representative?.status,'active');
 const answer=await post('/assistant/messages',{commandId:'q-reselect',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 assert.equal(answer.status,200);assert.equal(answer.body.turn.status,'answered');assert.equal(answer.body.turn.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
 validateMissionJournalLineage(f.store.inspect());
});

test('a selection loses to a route pinned to that profile before the settings write',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const primary=await post(path,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Primary',expectedConfigHash:claude.configHash});
 assert.equal(primary.body.activation.routeSet,true);
 const other={model:'claude-opus-4-6',label:'Other',expectedConfigHash:claude.configHash},registered=await post(path,other);
 assert.equal(registered.body.activation.routeSet,false);
 const routeOwner=f.host();await routeOwner.restoreSettings();
 const scope=connections.list().persistence!.scope!,before=await f.settings.load(scope);
 const read=await ownerClient(t,f,connections);
 const listedLabel=(body:typeof registered.body)=>body.runtime.connections.find((p:{id:string})=>p.id===registered.body.profileId)?.label;
 const beforeList=await read('/connections');
 assert.equal(beforeList.status,200);
 assert.equal(listedLabel(beforeList.body),'Other');
 let duringList:Awaited<ReturnType<typeof post>>|undefined,duringSettings;
 const save=f.settings.save.bind(f.settings);
 f.settings.save=async(...args)=>{
  await routeOwner.setRepresentative({profileId:registered.body.profileId,outputTokenCap:128,intakeMissionId:'assistant-intake',expectedConfigHash:routeOwner.list().configHash});
  duringList=await read('/connections');
  duringSettings=await f.settings.load(scope);
  return save(...args);
 };

 const selection=await post(path,{...other,label:'Renamed'});
 assert.equal(duringList?.status,200);
 assert.equal(duringList.body.persistence.status,'saving');
 assert.equal(listedLabel(duringList.body),'Other','the list must keep the saved name while the selection waits to save');
 assert.deepEqual(duringSettings,before);
 assert.equal(selection.status,409,'the settings write must refuse a superseded route revision');
 assert.deepEqual(await f.settings.load(scope),before);
 assert.equal(listedLabel(connections.list()),'Other');
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,registered.body.profileId);
 assert.equal(routeOwner.list().representative?.status,'active');
 validateMissionJournalLineage(f.store.inspect());
});

test('an already-on selection reports routeSet false for a previously stale pin of the same profile',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 const {profileId}=await connections.saveModelSelection(claude.id,{model,label:'Pinned',expectedConfigHash:claude.configHash});
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:true});
 const scope=connections.list().persistence!.scope!,row=(await f.settings.load(scope))!;
 const selections=(row.value as {selections:{model:string;label:string}[]}).selections;
 selections.find(p=>p.model===model)!.label='Previously changed';
 await f.settings.save(scope,row.revision,'previous-selection',row.value);
 const restored=f.host();await restored.restoreSettings();
 assert.equal(restored.list().representative?.status,'stale');
 assert.deepEqual(await restored.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:false});
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,profileId);
});

test('reselecting a 4096 profile preserves the separate Representative route limit of 128',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Selected',expectedConfigHash:claude.configHash};
 const first=await post(path,selection);
 assert.equal(first.status,200);assert.equal(first.body.activation.routeSet,true);
 await connections.setRepresentative({profileId:first.body.profileId,outputTokenCap:128,intakeMissionId:'assistant-intake',expectedConfigHash:connections.list().configHash});
 const routeBefore=await f.store.load(CONNECTION_ACTIVATION_ID);

 const repeated=await post(path,selection);
 assert.equal(repeated.status,200,'the separate route limit does not change the profile hash');
 assert.deepEqual(repeated.body.activation,{status:'already-on',reason:null,routeSet:true});
 assert.equal(repeated.body.representative.status,'active');assert.equal(repeated.body.representative.route.outputTokenCap,128);
 assert.equal(repeated.body.runtime.connections.find((p:any)=>p.id===first.body.profileId).limits.maxOutputTokens,4096);
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),routeBefore);
 const answer=await post('/assistant/messages',{commandId:'q-route-cap',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 assert.equal(answer.status,200);assert.equal(answer.body.turn.status,'answered');assert.deepEqual(f.cliLimits,['128']);
 validateMissionJournalLineage(f.store.inspect());
});

test('reselecting a restored 128 profile keeps its stored limit and launches at 128',async t=>{
 const f=await fixture(t),initial=f.host();await initial.restoreSettings();
 const claude=initial.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Restored',expectedConfigHash:claude.configHash};
 const {profileId}=await initial.save(()=>initial.selectModel(claude.id,selection));
 const scope=initial.list().persistence!.scope!,row=(await f.settings.load(scope))!;
 const savedProfile=(value:unknown)=>(value as {selections:{model:string;maxOutputTokens:number}[]}).selections.find(p=>p.model===selection.model)!;
 savedProfile(row.value).maxOutputTokens=128;
 assert.equal((await f.settings.save(scope,row.revision,'restored-limit',row.value)).status,'committed');
 const connections=f.host();await connections.restoreSettings();
 assert.equal(connections.list().runtime.connections.find(p=>p.id===profileId)?.limits?.maxOutputTokens,128);
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:true});
 const routeBefore=await f.store.load(CONNECTION_ACTIVATION_ID);
 assert.equal(connections.list().representative?.route.outputTokenCap,128);
 const post=await ownerClient(t,f,connections);

 const repeated=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',selection);
 assert.equal(savedProfile((await f.settings.load(scope))!.value).maxOutputTokens,128,'the registered limit survives reselection');
 assert.equal(repeated.status,200,'reusing the registered limit keeps the pinned hash valid');
 assert.deepEqual(repeated.body.activation,{status:'already-on',reason:null,routeSet:true});
 assert.equal(repeated.body.representative.status,'active');
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),routeBefore);
 const answer=await post('/assistant/messages',{commandId:'q-profile-cap',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 assert.equal(answer.status,200);assert.equal(answer.body.turn.status,'answered');assert.deepEqual(f.cliLimits,['128']);
 validateMissionJournalLineage(f.store.inspect());
});

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
  for(const loginDetected of [false,true])for(const routePresent of [false,true])for(const routeClosedByOwner of [false,true])
   assert.deepEqual(modelSelectionDecision({origin,loginDetected,routePresent,routeClosedByOwner}),{turnOn:false,route:false},'origin '+origin);
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
 // Nothing changes: the stored route already IS this profile, so the truthful report is routeSet true with no new transition.
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId:second.profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:true});
 assert.equal((await activations(f.store)).length,1);
 assert.equal((await f.store.load(CONNECTION_ACTIVATION_ID))!.revision,revision,'no second transition is committed');
 assert.deepEqual(await aggregate(f.store),route);
 validateMissionJournalLineage(f.store.inspect());
});

test('an unattributed request on an already-on subscription connection sets nothing and says not-owner',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!,claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 // On with no route: one connection on already (key-added chooses no route), so the login-started turn-on records no first route.
 assert.equal((await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 await connections.turnOnConnection('login:1',claude.id,'login-started');
 assert.equal(connections.connectionOn(claude.id),true);assert.equal((await aggregate(f.store))?.routeChoice,null);
 const server=createWorkbench(f.store,f.root,{connections,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port;
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash};
 const response=await new Promise<{status:number,body:string}>((resolve,reject)=>{const payload=JSON.stringify(selection),out=httpRequest({host:'127.0.0.1',port,path:'/connections/'+encodeURIComponent(claude.id)+'/profiles',method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode??0,body:text}));});out.on('error',reject);out.end(payload);});
 assert.equal(response.status,200);
 assert.deepEqual((JSON.parse(response.body) as any).activation,{status:'not-turned-on',reason:'not-owner',routeSet:false});
 const state=await aggregate(f.store);
 assert.equal(state?.routeChoice,null);assert.equal(state?.routeClosedAt,null);
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added','login-started'],'no activation was added or changed');
 validateMissionJournalLineage(f.store.inspect());
});

test('two identical selections fired at once both report the stored outcome and leave one activation',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const {profileId}=await connections.save(()=>connections.selectModel(claude.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash}));
 const input={connectionId:claude.id,profileId,origin:'owner-typed' as const};
 const [first,second]=await Promise.all([connections.activateFromSelection(input),connections.activateFromSelection(input)]);
 for(const outcome of [first,second]){
  assert.equal(outcome.reason,null);assert.equal(outcome.routeSet,true);
  assert.ok(outcome.status==='turned-on'||outcome.status==='already-on','both report the connection on with this selection as the route');
 }
 assert.equal(connections.connectionOn(claude.id),true);
 assert.deepEqual((await activations(f.store)).map(a=>[a.connectionId,a.way]),[[claude.id,'model-selected']]);
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,profileId);
 validateMissionJournalLineage(f.store.inspect());
 assert.deepEqual(replayAggregate(f.store),(await aggregate(f.store)));
});

test('two different selections racing for the first route: exactly one reports routeSet true and it is the stored one',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const picks=[] as {connectionId:string,profileId:string}[];
 for(const connection of [claude,codex]){const model=BUILTIN_CLI_RECOMMENDED_MODELS[connection.providerType as 'claude-code-cli'|'codex-cli'];const {profileId}=await connections.save(()=>connections.selectModel(connection.id,{model,label:model,expectedConfigHash:connection.configHash}));picks.push({connectionId:connection.id,profileId});}
 const outcomes=await Promise.all(picks.map(pick=>connections.activateFromSelection({...pick,origin:'owner-typed'})));
 for(const outcome of outcomes){assert.deepEqual({status:outcome.status,reason:outcome.reason},{status:'turned-on',reason:null});}
 const winners=picks.filter((pick,index)=>outcomes[index]!.routeSet);
 assert.equal(winners.length,1,'exactly one selection became the route');
 const stored=(await aggregate(f.store))?.routeChoice!;
 assert.equal(stored.profileId,winners[0]!.profileId);
 assert.equal(stored.source,'owner-choice');
 assert.equal(new Set((await activations(f.store)).map(a=>a.connectionId)).size,2,'both connections turned on once each');
 validateMissionJournalLineage(f.store.inspect());
 assert.deepEqual(replayAggregate(f.store),(await aggregate(f.store)));
});

test('a non-built-in host keeps main behaviour: the selection outcome is not-builtin and nothing is recorded',async t=>{
 const f=await fixture(t);
 const manifest=parseHostManifest({version:1,revision:'file-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['exec']}]});
 const connections=createHostConnections(f.store,new TextArtifactStore(join(f.root,'artifacts-file')),{manifest,allowLiveExecution:false},{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:f.settings});
 await connections.restoreSettings();
 const connection=connections.list().connections[0]!;
 const {profileId}=await connections.save(()=>connections.selectModel(connection.id,{model:'exec',label:'Exec',expectedConfigHash:connection.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:connection.id,profileId,origin:'owner-typed'}),{status:'not-turned-on',reason:'not-builtin',routeSet:false});
 assert.deepEqual(await activations(f.store),[]);
});

test('an owner selection on an already-on subscription connection reports the stored route, never another',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!,claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'});
 await connections.turnOnConnection('login:1',claude.id,'login-started');
 const first=await connections.save(()=>connections.selectModel(claude.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId:first.profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:true});
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,first.profileId);
 const second=await connections.save(()=>connections.selectModel(claude.id,{model:'claude-opus-4-6',label:'Owner picked exact model',expectedConfigHash:claude.configHash}));
 assert.deepEqual(await connections.activateFromSelection({connectionId:claude.id,profileId:second.profileId,origin:'owner-typed'}),{status:'already-on',reason:null,routeSet:false},'the stored route is the first profile, so the report says false');
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,first.profileId);
 validateMissionJournalLineage(f.store.inspect());
});

test('login detection that flips to absent between attempts leaves the connection off with the real reason',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 await connections.turnOnConnection('seed-key',codex.id,'key-added');
 const seeded=(await f.store.load(CONNECTION_ACTIVATION_ID))!;
 let activationLoads=0;
 const guarded=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(id===CONNECTION_ACTIVATION_ID&&++activationLoads===2)return {revision:0,value:undefined} as never;return await target.load(id as never);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const raced=createHostConnections(guarded as never,new TextArtifactStore(join(f.root,'artifacts-flip')),f.startup,{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:f.settings,cliRunner:async call=>{f.cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:reply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};},loginStatus:async providerType=>{f.loginCommands.push(providerType);return providerType==='claude-code-cli'&&f.loginCommands.filter(entry=>entry==='claude-code-cli').length>1?'absent' as const:'detected' as const;}});
 await raced.restoreSettings();
 const {profileId}=await raced.save(()=>raced.selectModel(claude.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash}));
 assert.deepEqual(await raced.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'}),{status:'not-turned-on',reason:'login-not-detected',routeSet:false});
 assert.equal(raced.connectionOn(claude.id),false);
 assert.equal((await f.store.load(CONNECTION_ACTIVATION_ID))!.revision,seeded.revision,'no transition was committed');
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added']);
});
