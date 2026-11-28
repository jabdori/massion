import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {Agent,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tempRoot} from './support/temp-root.ts';
import {growthStore} from './support/growth-fixture.ts';
import {loadHostStartup,createHostConnections,parseHostManifest,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {ConnectionWorkbench,MODEL_PROVIDER_TYPES} from '../src/connection-workbench.ts';
import {CONNECTION_ACTIVATION_ID,modelSelectionDecision,applyActivation,activationState as parseActivation,replayConnectionActivation} from '../src/connection-activation.ts';
import type {ConnectionActivationState} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ASSISTANT_ACTOR_ID} from '../src/assistant-conversation.ts';
import {applyMembers,MEMBERS_ID,MembersService} from '../src/members.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {authProof} from '../src/daemon-auth.ts';
import {CommitOutcomeUnknownError,InMemoryHostSettings,InMemoryStore,SurrealHostSettings} from '../src/storage.ts';
import type {Store,Operation,CommitInput,CommitResult,Snapshot,HostSettingsStore} from '../src/storage.ts';
import {Application} from '../src/application.ts';
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
/** The real store behind overrides for the intake Mission and activation writes. */
function intakeStore(store:Store<Mission>,overrides:{load?:()=>Promise<Snapshot<Mission>|null>;commit?:(input:CommitInput<Mission>)=>Promise<CommitResult<Mission>>;activationCommit?:(input:CommitInput<Mission>)=>Promise<CommitResult<Mission>>}):Store<Mission>{
 return new Proxy(store,{get(target,key){
  if(key==='load'&&overrides.load)return async(id:string)=>id==='assistant-intake'?overrides.load!():target.load(id);
  if(key==='commit')return (input:CommitInput<Mission>)=>{
   if(input.id==='assistant-intake'&&overrides.commit)return overrides.commit(input);
   if(input.id===CONNECTION_ACTIVATION_ID&&overrides.activationCommit)return overrides.activationCommit(input);
   return target.commit(input);
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}

/** A store whose armed read of the activation aggregate observes the store at once and returns only on release: the read that finishes late. `arm` resolves once that read is waiting. */
function lateActivationRead(store:Store<Mission>){
 let armed=false,held=false,release:()=>void=()=>{},waiting:()=>void=()=>{},gate:Promise<void>=Promise.resolve();
 const proxied=new Proxy(store,{get(target,key){if(key==='load')return async(id:string)=>{const snapshot=await target.load(id as never);if(id===CONNECTION_ACTIVATION_ID&&armed&&!held){held=true;waiting();await gate;}return snapshot;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Store<Mission>;
 return {store:proxied,arm(){armed=true;held=false;gate=new Promise<void>(resolve=>{release=resolve;});return new Promise<void>(resolve=>{waiting=resolve;});},release:()=>release()};
}

async function fixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent';wrap?:(store:InMemoryStore<Mission>)=>Store<Mission>}={}){
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
 const host=(durable?:{store:Store<Mission>;settings:HostSettingsStore})=>createHostConnections(durable?.store??(options.wrap?options.wrap(store):store),new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings:durable?.settings??settings,cliRunner,loginStatus:(providerType:string,signal?:AbortSignal)=>logins.recheck(providerType,signal).then(status=>status.status)});
 return {root,store,secrets,settings,startup,transport,cliCalls,cliLimits,loginCommands,logins,host,setDetect:(next:(providerType:string)=>'detected'|'absent')=>{detect=next;}};
}

async function ownerClient(t:test.TestContext,f:{root:string;store:Store<Mission>},connections:ConnectionWorkbench,options:{owner?:false;logins?:LoginConnections}={}){
 const secret='a'.repeat(64),server=createWorkbench(f.store,f.root,{connections,...(options.owner!==false?{daemonSecret:secret}:{}),logins:options.logins,scheduleIntervalMs:0});
 const agent=new Agent({keepAlive:true,maxSockets:1});
 t.after(async()=>{
  agent.destroy();
  const closed=once(server,'close',{signal:AbortSignal.timeout(5000)});
  server.close();server.closeAllConnections();
  await closed;
 });
 const listening=once(server,'listening',{signal:AbortSignal.any([t.signal,AbortSignal.timeout(5000)])});
 server.listen(0,'127.0.0.1');await listening;
 const port=(server.address() as {port:number}).port;
 const signal=AbortSignal.any([t.signal,AbortSignal.timeout(30000)]);
 const request=(path:string,headers:Record<string,string>,body?:unknown)=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:any}>((resolve,reject)=>{
  const out=httpRequest({host:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',agent,headers,signal},res=>{
   let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);
   res.on('end',()=>{try{resolve({status:res.statusCode!,headers:res.headers,body:raw?JSON.parse(raw):null});}catch(error){reject(error);}});res.on('error',reject);
  });out.on('error',reject);out.end(body===undefined?undefined:JSON.stringify(body));
 });
 if(options.owner===false)return (path:string,body?:unknown)=>request(path,{'content-type':'application/json'},body);
 const challenge='b'.repeat(64),handshake=await request('/desktop-auth',{'x-massion-challenge':challenge});
 assert.ok(handshake.headers['x-massion-nonce']);
 const authorization='Bearer '+authProof(secret,'client','http://127.0.0.1:'+port,challenge,handshake.headers['x-massion-nonce'] as string);
 return (path:string,body?:unknown)=>request(path,{'content-type':'application/json',authorization},body);
}

test('a 129-character CLI model ID is refused without saving or publishing the candidate',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections),read=await ownerClient(t,f,connections);
 const scope=connections.list().persistence!.scope!,before=await f.settings.load(scope);
 const beforeList=await read('/connections');
 assert.equal(beforeList.status,200);
 const save=f.settings.save.bind(f.settings);
 let writes=0;
 f.settings.save=(...args)=>{writes++;return save(...args);};
 const load=f.store.load.bind(f.store);
 let duringList:Awaited<ReturnType<typeof read>>|undefined;
 f.store.load=async id=>{
  if(id===CONNECTION_ACTIVATION_ID&&!duringList)duringList=await read('/connections');
  return load(id);
 };

 const selection=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{
  model:'a'.repeat(129),label:'Refused CLI model',expectedConfigHash:claude.configHash
 });

 assert.deepEqual(await f.settings.load(scope),before,'nothing stored for a model the CLI adapter refuses');
 assert.equal(writes,0,'the refused selection never calls the settings writer');
 assert.equal(selection.status,400);
 assert.deepEqual(selection.body,{error:'Exact model ID required.',reason:'invalid-model-id'});
 assert.equal(duringList?.status,200);
 assert.deepEqual(duringList.body.runtime.connections,beforeList.body.runtime.connections);
 const afterList=await read('/connections');
 assert.equal(afterList.status,200);
 assert.deepEqual(afterList.body,beforeList.body);
 assert.deepEqual(await activations(f.store),[]);
});

test('a 128-character CLI model ID is saved and activated',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections),model='a'.repeat(128);
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{
  model,label:'Accepted CLI model',expectedConfigHash:claude.configHash
 });
 assert.equal(response.status,200);
 const scope=connections.list().persistence!.scope!,saved=await f.settings.load(scope);
 assert.ok(saved);
 assert.ok((saved.value as {selections:{model:string}[]}).selections.some(p=>p.model===model));
 assert.deepEqual(response.body.activation,{status:'turned-on',reason:null,routeSet:true});
 assert.equal(response.body.representative.status,'active');
});

test('a selection request without the automatic-pick field records the route as the owner choice; the field accepts only the literal true',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const scope=connections.list().persistence!.scope!;
 const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Owner selection',expectedConfigHash:claude.configHash};
 const refused=await post(path,{...selection,automaticPick:false});
 assert.equal(refused.status,400);
 assert.deepEqual(refused.body,{error:'Invalid automatic pick'});
 assert.deepEqual(await activations(f.store),[],'a field that is not the literal true turns nothing on');
 assert.equal(await f.settings.load(scope),null,'and saves no selection');
 // The Settings form and a screen from before the field existed send these three fields and nothing more.
 const selected=await post(path,selection);
 assert.equal(selected.status,200,JSON.stringify(selected.body));
 assert.deepEqual(selected.body.activation,{status:'turned-on',reason:null,routeSet:true});
 assert.equal(selected.body.representative.derived,false);
 assert.equal((await aggregate(f.store))?.routeChoice?.source,'owner-choice');
 validateMissionJournalLineage(f.store.inspect());
});

for(const model of ['sonnet','a'.repeat(129)]){
 test(`browser QA without a CLI runner records a ${model.length}-character selection for this session`,async t=>{
  const f=await fixture(t);
  const connections=new ConnectionWorkbench(f.store,new TextArtifactStore(join(f.root,'artifacts')),{allowFixture:true,transport:f.transport});
  const request=await ownerClient(t,f,connections);
  const claude=MODEL_PROVIDER_TYPES.find(p=>p.id==='claude-code-cli')!;
  const connected=await request('/connections',{id:'qa-claude',label:'Claude QA',providerType:claude.id,baseUrl:claude.baseUrl,mode:'local-http-mock'});
  assert.equal(connected.status,200);
  const label='My model';
  const selected=await request('/connections/qa-claude/profiles',{model,label,expectedConfigHash:connected.body.connections[0].configHash});
  assert.equal(selected.status,200,JSON.stringify(selected.body));
  assert.deepEqual(selected.body.activation,{status:'not-turned-on',reason:'not-builtin',routeSet:false});
  const listed=await request('/connections');
  assert.equal(listed.status,200);
  assert.equal(listed.body.persistence,null);
  assert.equal(listed.body.runtime.connections.find((p:{id:string})=>p.id===selected.body.profileId)?.label,label);
 });

 for(const providerType of ['claude-code-cli','openai']){
  test(`${providerType} saves a ${model.length}-character selection when login is absent or inapplicable`,async t=>{
   const f=await fixture(t,{detect:()=> 'absent'}),connections=f.host();await connections.restoreSettings();
   const connection=connections.list().connections.find(c=>c.providerType===providerType)!;
   const apiKey=providerType==='openai';
   if(apiKey)await connections.turnOnConnection('previous-key',connection.id,'key-added');
   const request=await ownerClient(t,f,connections),label='My model';
   const selected=await request('/connections/'+encodeURIComponent(connection.id)+'/profiles',{model,label,expectedConfigHash:connection.configHash});
   assert.equal(selected.status,200,JSON.stringify(selected.body));
   assert.deepEqual(selected.body.activation,{status:'not-turned-on',reason:apiKey?'not-a-subscription-connection':'login-not-detected',routeSet:apiKey});
   const saved=await f.settings.load(connections.list().persistence!.scope!);
   assert.equal(saved?.revision,1);
   assert.equal((saved.value as {selections:{model:string;label:string}[]}).selections.find(p=>p.model===model)?.label,label);
  });
 }
}

test('an already-on CLI only refuses an invalid selection when it would set the first route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const openai=connections.list().connections.find(c=>c.providerType==='openai')!;
 await connections.turnOnConnection('previous-key',openai.id,'key-added');
 await connections.turnOnConnection('previous-login',claude.id,'login-started');
 const request=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const input={model:'a'.repeat(129),label:'My model',expectedConfigHash:claude.configHash};
 const scope=connections.list().persistence!.scope!;
 const refused=await request(path,input);
 assert.equal(refused.status,400);
 assert.deepEqual(refused.body,{error:'Exact model ID required.',reason:'invalid-model-id'});
 assert.equal(await f.settings.load(scope),null);

 const first=await request(path,{...input,model:'sonnet'});
 assert.deepEqual(first.body.activation,{status:'already-on',reason:null,routeSet:true});
 const selected=await request(path,input);
 assert.equal(selected.status,200,JSON.stringify(selected.body));
 assert.deepEqual(selected.body.activation,{status:'already-on',reason:null,routeSet:false});
 assert.equal(selected.body.representative.route.profileId,first.body.profileId);
 const saved=await f.settings.load(scope);
 assert.equal(saved?.revision,2);
 assert.equal((saved.value as {selections:{model:string;label:string}[]}).selections.find(p=>p.model===input.model)?.label,input.label);
});

for(const [picked,request,source,derived] of [['automatic',{automaticPick:true},'first-route',true],['Settings',{},'owner-choice',false]] as const){
 test(`an already-on subscription connection with no route records the ${picked} pick as ${source}`,async t=>{
  const f=await fixture(t),connections=f.host();await connections.restoreSettings();
  const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,openai=connections.list().connections.find(c=>c.providerType==='openai')!;
  // On with no route: the API key is on already, so the login-started turn-on of the subscription connection records no first route.
  assert.equal((await connections.turnOnConnection('previous-key',openai.id,'key-added')).status,'on');
  assert.equal((await connections.turnOnConnection('previous-login',claude.id,'login-started')).status,'on');
  assert.equal((await aggregate(f.store))?.routeChoice,null);
  const post=await ownerClient(t,f,connections);
  const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Picked',expectedConfigHash:claude.configHash,...request});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.activation,{status:'already-on',reason:null,routeSet:true});
  assert.equal(response.body.representative.derived,derived);
  assert.equal((await aggregate(f.store))?.routeChoice?.source,source);
  validateMissionJournalLineage(f.store.inspect());
  assert.deepEqual(replayAggregate(f.store),await aggregate(f.store));
 });
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
 const request=await ownerClient(t,f,connections);
 const selection={model:'claude-opus-4-6',label:'Owner picked exact model',expectedConfigHash:claude.configHash};
 const response=await request('/connections/'+encodeURIComponent(claude.id)+'/profiles',selection);
 assert.equal(response.status,200);
 const {body}=response;
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
 assert.equal((await connections.turnOnConnection('login:initial',claude.id,'login-started')).status,'on');
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
 assert.equal((await connections.turnOnConnection('login:initial-close',claude.id,'login-started')).status,'on');
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
 const post=await ownerClient(t,f,connections,{owner:false});
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash};
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',selection);
 assert.equal(response.status,200);
 const {body}=response;
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
 const post=await ownerClient(t,f,connections,{owner:false});
 const selection={model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claude.configHash};
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',selection);
 assert.equal(response.status,200);
 assert.deepEqual(response.body.activation,{status:'not-turned-on',reason:'not-owner',routeSet:false});
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

test('an owner selection on an already-on subscription connection reports the stored route, never another',{timeout:30000},async t=>{
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
 const before=await f.store.load(CONNECTION_ACTIVATION_ID);
 assert.equal((await reviseIntake(f.store,'assistant-intake')).status,'committed');
 const post=await ownerClient(t,f,connections);
 const unsuitable=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:'claude-opus-4-6',label:'Owner picked exact model',expectedConfigHash:claude.configHash});
 assert.equal(unsuitable.status,500);
 assert.deepEqual(unsuitable.body,OPERATION_FAILED);
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),before);
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

test('the connection list refuses a failed activation read at startup and recovers on retry',{timeout:30000},async t=>{
 const f=await fixture(t),seed=f.host();await seed.restoreSettings();
 const {connections:available}=seed.list(),openai=available.find(c=>c.providerType==='openai')!;
 assert.equal((await seed.turnOnConnection('seed-key',openai.id,'key-added')).status,'on');
 const stored=await f.store.load(CONNECTION_ACTIVATION_ID);
 let failures=2,activationReads=0;
 const failing=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(id!==CONNECTION_ACTIVATION_ID)return target.load(id as never);activationReads++;if(failures>0){failures--;throw Error('Activation read lost');}return target.load(id as never);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Store<Mission>;
 const restarted=f.host({store:failing,settings:f.settings});await restarted.restoreSettings();
 activationReads=0;
 const post=await ownerClient(t,f,restarted);
 // While the list's own read fails too, the list is refused and reports no connection at all.
 const refused=await post('/connections');
 assert.equal(refused.status,500);assert.deepEqual(refused.body,OPERATION_FAILED);assert.equal(failures,0);assert.equal(activationReads,1);
 // The next read returns the stored state; a later list needs no further read.
 const recovered=await post('/connections');
 assert.equal(recovered.status,200);assert.equal(recovered.body.connections.find((c:{id:string})=>c.id===openai.id).on,true);assert.equal(activationReads,2);
 assert.equal((await post('/connections')).status,200);assert.equal(activationReads,2);
 assert.equal(restarted.connectionOn(openai.id),true);assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),stored,'nothing was written');
});

test('an activation read that finishes after a newer state leaves the cache at the newer revision',{timeout:30000},async t=>{
 const f=await fixture(t),late=lateActivationRead(f.store);t.after(()=>late.release());
 const host=f.host({store:late.store,settings:f.settings});await host.restoreSettings();
 const {connections:available}=host.list(),openai=available.find(c=>c.providerType==='openai')!,claude=available.find(c=>c.providerType==='claude-code-cli')!,codex=available.find(c=>c.providerType==='codex-cli')!,anthropic=available.find(c=>c.providerType==='anthropic')!;
 assert.equal((await host.turnOnConnection('seed-key',openai.id,'key-added')).status,'on');
 // The bound only ends a wait that would otherwise hang; the wait itself observes the read reaching the store.
 const reached=async(waiting:Promise<void>,what:string)=>{let timer!:ReturnType<typeof setTimeout>;const ok=await Promise.race([waiting.then(()=>true),new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);clearTimeout(timer);assert.ok(ok,what);};
 // Two refresh reads: the older is still waiting when this host turns a connection on and a newer read returns.
 let waiting=late.arm();const older=host.refreshStoredSettings();
 await reached(waiting,'the older refresh read must be waiting at the store');
 assert.equal((await host.turnOnConnection('seed-claude',claude.id,'login-started')).status,'on');
 await host.refreshStoredSettings();late.release();
 assert.equal(await older,undefined,'the older read changed nothing');
 assert.equal(host.connectionOn(claude.id),true,'the older read must not turn the connection off again');
 // An admission check that meets an older read refuses and keeps the newer state.
 waiting=late.arm();const check=host.checkConfiguration('');
 await reached(waiting,'the older check read must be waiting at the store');
 assert.equal((await host.turnOnConnection('seed-codex',codex.id,'login-started')).status,'on');
 await host.refreshStoredSettings();late.release();
 assert.equal((await check)?.code,'settings_pending');
 assert.equal(host.connectionOn(codex.id),true);
 // A selection that read the older state keeps the newer one and is refused on its older precondition.
 waiting=late.arm();const selection=host.saveModelSelection(anthropic.id,{model:'claude-sonnet-5',label:'Later',expectedConfigHash:anthropic.configHash});
 await reached(waiting,'the older selection read must be waiting at the store');
 assert.equal((await host.turnOnConnection('seed-anthropic',anthropic.id,'key-added')).status,'on');
 late.release();
 await assert.rejects(selection,/could not be confirmed/);
 assert.equal(host.connectionOn(anthropic.id),true);
});

test('late settings reads leave the cached settings revision intact',{timeout:30000},async t=>{
 const f=await fixture(t),host=f.host();await host.restoreSettings();
 const {connections,persistence}=host.list(),openai=connections.find(c=>c.providerType==='openai')!;
 const selection={model:'fixture-api-model',expectedConfigHash:openai.configHash};
 await host.saveModelSelection(openai.id,{...selection,label:'Older'});
 const load=f.settings.load.bind(f.settings),older=await load(persistence!.scope!);

 const order=new EventEmitter(),signal=AbortSignal.any([t.signal,AbortSignal.timeout(5000)]);
 const captured=once(order,'captured',{signal});
 f.settings.load=async scope=>{
  f.settings.load=load;
  const row=await load(scope),unblocked=once(order,'unblocked',{signal});
  order.emit('captured');await unblocked;return row;
 };
 const overlapping=host.refreshStoredSettings();
 await captured;
 await host.saveModelSelection(openai.id,{...selection,label:'Newer'});
 const newer=await load(persistence!.scope!);
 assert.ok(older&&newer&&newer.revision>older.revision);
 order.emit('unblocked');
 assert.equal(await overlapping,undefined);
 assert.equal(host.list().persistence?.revision,newer.revision,'an overlapping refresh must keep the newer settings revision');

 // A read can return an older snapshot even when the cache stays at the same revision throughout the call.
 f.settings.load=async()=>older;
 await host.refreshStoredSettings();
 assert.equal(host.list().persistence?.revision,newer.revision,'refresh must discard a lower settings revision');
 const diagnostic=await host.checkConfiguration('');
 assert.equal(host.list().persistence?.revision,newer.revision,'admission must discard a lower settings revision');
 assert.equal(diagnostic?.code,'settings_pending');
});

const OPERATION_FAILED={error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'};
const COMMIT_UNKNOWN={error:'Commit outcome is unknown. Read durable events before deciding any next action.',outcome:'unknown'};

const intakeApp=(store:Store<Mission>)=>new Application(store,[{id:'local-owner',roles:['owner']}]);
function seedIntake(store:Store<Mission>,id:string,oracle:'bounded-text-review/v1'|'human-review/v1'){
 return intakeApp(store).create({id,purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Review the request',oracle}},'local-owner','seed-'+id);
}
function reviseIntake(store:Store<Mission>,id:string,oracle:'bounded-text-review/v1'|'human-review/v1'='human-review/v1'){
 return intakeApp(store).dispatch({missionId:id,commandId:'revise-'+id,expectedRevision:1,actorId:'local-owner',command:{type:'revise-mission',purpose:'Owner requests',criteria:{version:2,description:'Review the request again',oracle}}});
}

for(const routeState of ['owner-closed','stale'] as const){
 test(`a selection turns a connection on with an unsuitable intake when the route is ${routeState}`,{timeout:30000},async t=>{
  const f=await fixture(t),initial=f.host();await initial.restoreSettings();
  const claude=initial.list().connections.find(c=>c.providerType==='claude-code-cli')!,codex=initial.list().connections.find(c=>c.providerType==='codex-cli')!;
  const model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
  const postInitial=await ownerClient(t,f,initial);
  const first=await postInitial('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Pinned',expectedConfigHash:claude.configHash});
  assert.equal(first.status,200);
  assert.equal(first.body.activation.routeSet,true);
  if(routeState==='owner-closed'){
   await initial.save(()=>initial.removeRepresentative({expectedConfigHash:initial.list().configHash}));
  }else{
   const scope=initial.list().persistence!.scope!,row=(await f.settings.load(scope))!;
   const selections=(row.value as {selections:{model:string;label:string}[]}).selections;
   selections.find(p=>p.model===model)!.label='Previously changed';
   assert.equal((await f.settings.save(scope,row.revision,'previous-selection',row.value)).status,'committed');
  }
  assert.equal((await reviseIntake(f.store,'assistant-intake')).status,'committed');
  const connections=f.host();await connections.restoreSettings();
  assert.equal(connections.list().representative?.status,routeState==='stale'?'stale':undefined);
  assert.equal(connections.connectionOn(codex.id),false);
  const before=(await aggregate(f.store))!;
  const post=await ownerClient(t,f,connections);

  const response=await post('/connections/'+encodeURIComponent(codex.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:'Picked',expectedConfigHash:codex.configHash});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.activation,{status:'turned-on',reason:null,routeSet:false});
  const after=(await aggregate(f.store))!;
  assert.ok(after.activations.some(a=>a.connectionId===codex.id&&a.way==='model-selected'));
  assert.deepEqual(after.routeChoice,before.routeChoice);
  assert.equal(after.routeClosedAt,before.routeClosedAt);
 });
}

test('a failed intake preparation turns nothing on: the selection answers as a failed preparation and no route is stored',{timeout:30000},async t=>{
 const f=await fixture(t,{wrap:store=>intakeStore(store,{commit:async()=>{throw new Error('Intake Mission store unavailable');}})}),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 const post=await ownerClient(t,f,connections);
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Picked',expectedConfigHash:claude.configHash});
 assert.equal(response.status,500);
 assert.deepEqual(response.body,OPERATION_FAILED);
 assert.equal(connections.connectionOn(claude.id),false);
 assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null,'the activation was never committed');
 assert.equal(connections.list().representative,null);
 // A selection that was already saved may stay.
 const saved=(await f.settings.load(connections.list().persistence!.scope!))!.value as {selections:{model:string}[]};
 assert.ok(saved.selections.some(p=>p.model===model));
});

for(const [oracle,status] of [['bounded-text-review/v1',200],['human-review/v1',500]] as const){
 test(`a creation conflict reads the stored intake Mission again: a row using ${oracle} answers ${status}`,{timeout:30000},async t=>{
  let intakeReads=0,creations=0;
  // The first read says absent while a row exists, so the creation is attempted and conflicts on the revision.
  const f=await fixture(t,{wrap:store=>intakeStore(store,{load:async()=>++intakeReads===1?null:store.load('assistant-intake'),commit:async input=>{creations++;return store.commit(input);}})}),connections=f.host();await connections.restoreSettings();
  const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
  const seeded=await new Application(f.store,[{id:'local-owner',roles:['owner']}]).create({id:'assistant-intake',purpose:'Seeded before this host',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle}},'local-owner','seed-intake-create');
  assert.ok(seeded.status==='committed');
  const post=await ownerClient(t,f,connections);
  const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Picked',expectedConfigHash:claude.configHash});
  assert.equal(response.status,status,JSON.stringify(response.body));
  assert.equal(creations,1,'the creation was attempted once');
  assert.ok(intakeReads>1,'the stored row was read again after the conflict');
  assert.deepEqual(await f.store.load('assistant-intake'),{revision:1,value:seeded.value},'the existing row is used as stored and never replaced');
  if(status===200){
   assert.deepEqual(response.body.activation,{status:'turned-on',reason:null,routeSet:true});
   assert.deepEqual((await activations(f.store)).map(a=>[a.connectionId,a.way]),[[claude.id,'model-selected']]);
  }else{
   assert.deepEqual(response.body,OPERATION_FAILED);
   assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null,'the activation was never committed');
   assert.equal(connections.connectionOn(claude.id),false);assert.equal(connections.list().representative,null);
  }
  validateMissionJournalLineage(f.store.inspect());
 });
}

test('an existing intake Mission with the wrong acceptance criteria fails the selection, is left as stored and never becomes a route',{timeout:30000},async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 await new Application(f.store,[{id:'local-owner',roles:['owner']}]).create({id:'assistant-intake',purpose:'Seeded before this host',scope:'local',constraints:[],criteria:{version:1,description:'Reviewed by a person',oracle:'human-review/v1'}},'local-owner','seed-intake-create');
 const seeded=await f.store.load('assistant-intake');
 const post=await ownerClient(t,f,connections);
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Picked',expectedConfigHash:claude.configHash});
 assert.equal(response.status,500);
 assert.deepEqual(response.body,OPERATION_FAILED);
 assert.equal(connections.connectionOn(claude.id),false);
 assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null,'the activation was never committed');
 assert.equal(connections.list().representative,null,'no usable route is reported');
 assert.deepEqual(await f.store.load('assistant-intake'),seeded,'the unsuitable row is not replaced');
});

test('a replayed intake creation cannot authorize an activation when the current Mission is unsuitable',{timeout:30000},async t=>{
 let miss=false,activationWrites=0;
 const f=await fixture(t,{wrap:store=>intakeStore(store,{
  load:async()=>{if(miss){miss=false;return null;}return store.load('assistant-intake');},
  activationCommit:input=>{activationWrites++;return store.commit(input);}
 })}),connections=f.host();await connections.restoreSettings();
 const {connections:available}=connections.list(),openai=available.find(c=>c.providerType==='openai')!,claude=available.find(c=>c.providerType==='claude-code-cli')!;
 // The legacy path creates the Mission with the same command identity selection uses.
 assert.equal((await connections.turnOnConnection('seed-key',openai.id,'key-added')).status,'on');
 assert.equal((await reviseIntake(f.store,'assistant-intake')).status,'committed');
 const before=await f.store.load(CONNECTION_ACTIVATION_ID),post=await ownerClient(t,f,connections);
 activationWrites=0;miss=true;
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Picked',expectedConfigHash:claude.configHash});
 assert.equal(response.status,500);
 assert.deepEqual(response.body,OPERATION_FAILED);
 assert.equal(activationWrites,0,'the current Mission must be checked before attempting activation');
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),before);
});

test('on an already-on connection an intake Mission with the wrong acceptance criteria fails the selection and records no route',{timeout:30000},async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 // On with no route: the API key is on already, so the login-started turn-on of the subscription connection records no first route.
 assert.equal((await connections.turnOnConnection('seed-key',openai.id,'key-added')).status,'on');
 assert.equal((await connections.turnOnConnection('seed-login',claude.id,'login-started')).status,'on');
 assert.equal((await aggregate(f.store))?.routeChoice,null);
 const revised=await new Application(f.store,[{id:'local-owner',roles:['owner']}]).dispatch({missionId:'assistant-intake',commandId:'revise-intake',expectedRevision:1,actorId:'local-owner',command:{type:'revise-mission',purpose:'Owner requests',criteria:{version:2,description:'Reviewed by a person',oracle:'human-review/v1'}}});
 assert.ok(revised.status==='committed');
 const seeded=await f.store.load('assistant-intake');
 const post=await ownerClient(t,f,connections);
 const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Picked',expectedConfigHash:claude.configHash});
 assert.equal(response.status,500);
 assert.deepEqual(response.body,OPERATION_FAILED);
 const state=await aggregate(f.store);
 assert.equal(state?.routeChoice,null);assert.equal(state?.routeClosedAt,null);
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added','login-started'],'no activation was added');
 assert.equal(connections.list().representative,null);
 assert.deepEqual(await f.store.load('assistant-intake'),seeded,'the unsuitable row is not replaced');
 validateMissionJournalLineage(f.store.inspect());
});

for(const [picked,request,source] of [['Settings',{},'owner-choice'],['automatic',{automaticPick:true},'first-route']] as const){
 test(`the first ${picked} selection still turns the connection on with a usable intake Mission`,{timeout:30000},async t=>{
  let intakeReads=0,intakeWrites=0,activationWrites=0,settingsWrites=0;
  const f=await fixture(t,{wrap:store=>intakeStore(store,{
   load:()=>{intakeReads++;return store.load('assistant-intake');},
   commit:input=>{intakeWrites++;return store.commit(input);},
   activationCommit:input=>{activationWrites++;return store.commit(input);}
  })}),connections=f.host();await connections.restoreSettings();
  const save=f.settings.save.bind(f.settings);
  f.settings.save=(...args)=>{settingsWrites++;return save(...args);};
  const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
  const post=await ownerClient(t,f,connections);
  const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Picked',expectedConfigHash:claude.configHash,...request});
  assert.equal(response.status,200,JSON.stringify(response.body));
  assert.deepEqual(response.body.activation,{status:'turned-on',reason:null,routeSet:true});
  assert.equal(response.body.representative.status,'active');
  assert.equal(response.body.representative.intakeMissionId,'assistant-intake');
  assert.equal((await aggregate(f.store))?.routeChoice?.source,source);
  assert.equal((await f.store.load('assistant-intake'))?.value.criteria?.oracle,'bounded-text-review/v1');
  assert.deepEqual({intakeReads,intakeWrites,activationWrites,settingsWrites},{intakeReads:1,intakeWrites:1,activationWrites:1,settingsWrites:1});
  validateMissionJournalLineage(f.store.inspect());
 });
}

for(const failure of ['unsuitable row','read error'] as const){
 test(`an unknown creation still answers 503 when a read-back finds ${failure==='unsuitable row'?'an unsuitable row':'a read error'}`,{timeout:30000},async t=>{
  let reads=0;
  const f=await fixture(t,{wrap:store=>intakeStore(store,{
   load:async()=>{if(++reads===1)return null;if(failure==='read error')throw new Error('Read unavailable');return store.load('assistant-intake');},
   commit:async input=>{if(failure==='unsuitable row')assert.equal((await seedIntake(store,'assistant-intake','human-review/v1')).status,'committed');throw new CommitOutcomeUnknownError(input);}
  })}),connections=f.host();await connections.restoreSettings();
  const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
  const post=await ownerClient(t,f,connections);
  const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Picked',expectedConfigHash:claude.configHash});
  assert.equal(response.status,503);
  assert.deepEqual(response.body,COMMIT_UNKNOWN);
  assert.equal(reads,2,'the read-back was attempted');
  assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null);
  if(failure==='unsuitable row')assert.equal((await f.store.load('assistant-intake'))?.value.criteria.oracle,'human-review/v1');
 });
}

test('starting a login still succeeds when the existing intake Mission is unsuitable',{timeout:30000},async t=>{
 const f=await fixture(t,{detect:()=>'absent'}),connections=f.host();await connections.restoreSettings();
 assert.equal((await seedIntake(f.store,'assistant-intake','human-review/v1')).status,'committed');
 const post=await ownerClient(t,f,connections,{logins:f.logins});
 const response=await post('/connection-login',{commandId:'login-unsuitable-intake',providerType:'claude-code-cli'});
 assert.equal(response.status,200);
 assert.equal(response.body.outcome,'login-started');
 assert.ok(f.loginCommands.includes('claude auth login'));
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['login-started']);
});

test('registering a key still completes when the existing intake Mission is unsuitable',{timeout:30000},async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 assert.equal((await seedIntake(f.store,'assistant-intake','human-review/v1')).status,'committed');
 const openai=connections.list().connections.find(c=>c.providerType==='openai')!;
 const post=await ownerClient(t,f,connections);
 const response=await post('/connections/'+encodeURIComponent(openai.id)+'/key',{commandId:'key-unsuitable-intake',expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'});
 assert.equal(response.status,200);
 assert.equal(response.body.status,'completed');
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added']);
});

test('reselecting an already-on subscription with an existing route rejects its unsuitable intake Mission',{timeout:30000},async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
 const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles',selection={model,label:'Picked',expectedConfigHash:claude.configHash};
 const first=await post(path,selection);
 assert.equal(first.status,200);assert.equal(first.body.activation.routeSet,true);
 const before=await f.store.load(CONNECTION_ACTIVATION_ID);
 assert.equal((await reviseIntake(f.store,'assistant-intake')).status,'committed');
 const response=await post(path,selection);
 assert.equal(response.status,500);
 assert.deepEqual(response.body,OPERATION_FAILED);
 assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),before);
});

test('selection conflicts when the Representative route is replaced during its intake read',{timeout:30000},async t=>{
 let replaceRoute:(()=>Promise<void>)|undefined;
 const f=await fixture(t,{wrap:store=>intakeStore(store,{load:async()=>{
  const row=await store.load('assistant-intake');await replaceRoute?.();return row;
 }})}),connections=f.host();await connections.restoreSettings();
 const {connections:available}=connections.list(),claude=available.find(c=>c.providerType==='claude-code-cli')!,codex=available.find(c=>c.providerType==='codex-cli')!;
 const post=await ownerClient(t,f,connections),replace=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(claude.id)+'/profiles';
 const first=await post(path,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Representative',expectedConfigHash:claude.configHash});
 assert.equal(first.status,200);assert.equal(first.body.activation.routeSet,true);
 const other=await post('/connections/'+encodeURIComponent(codex.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:'Replacement',expectedConfigHash:codex.configHash});
 assert.equal(other.status,200);assert.equal(other.body.activation.routeSet,false);
 assert.equal((await seedIntake(f.store,'custom-intake','bounded-text-review/v1')).status,'committed');
 replaceRoute=async()=>{
  replaceRoute=undefined;
  const result=await replace('/assistant-settings',{profileId:other.body.profileId,outputTokenCap:128,intakeMissionId:'custom-intake',expectedConfigHash:connections.list().configHash});
  assert.equal(result.status,200);
  assert.equal((await reviseIntake(f.store,'custom-intake')).status,'committed');
 };
 const response=await post(path,{model:'claude-opus-4-6',label:'Different model',expectedConfigHash:claude.configHash});
 assert.equal(response.status,409);
 assert.equal(response.body.error,'Representative route changed elsewhere; refresh before changing again.');
 assert.equal((await aggregate(f.store))?.routeChoice?.profileId,other.body.profileId);
});

for(const provider of ['claude-code-cli','openai'] as const){
 test(`reselecting ${provider} validates the custom Mission used by the existing route`,{timeout:30000},async t=>{
  const f=await fixture(t),connections=f.host();await connections.restoreSettings();
  const connection=connections.list().connections.find(c=>c.providerType===provider)!;
  const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(connection.id)+'/profiles';
  if(provider==='openai')assert.equal((await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'seed-key',connectionId:connection.id,expectedConfigHash:connection.configHash,apiKey:'fixture-key-value'})).status,'completed');
  const model=provider==='openai'?'fixture-api-model':BUILTIN_CLI_RECOMMENDED_MODELS[provider];
  const selection={model,label:'Picked',expectedConfigHash:connection.configHash},first=await post(path,selection);
  assert.equal(first.status,200);
  assert.equal((await seedIntake(f.store,'custom-intake','bounded-text-review/v1')).status,'committed');
  const custom=await post('/assistant-settings',{profileId:first.body.profileId,outputTokenCap:128,intakeMissionId:'custom-intake',expectedConfigHash:connections.list().configHash});
  assert.equal(custom.status,200);
  assert.equal((await reviseIntake(f.store,'assistant-intake')).status,'committed');
  const healthy=await post(path,selection);
  assert.equal(healthy.status,200);
  assert.equal(healthy.body.activation.routeSet,true);
  assert.equal(healthy.body.representative.intakeMissionId,'custom-intake');
  const codex=connections.list().connections.find(c=>c.providerType==='codex-cli')!,codexModel=BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'];
  const another=await post('/connections/'+encodeURIComponent(codex.id)+'/profiles',{model:codexModel,label:'Picked',expectedConfigHash:codex.configHash});
  assert.equal(another.status,200);
  assert.deepEqual(another.body.activation,{status:'turned-on',reason:null,routeSet:false});
  const before=await f.store.load(CONNECTION_ACTIVATION_ID);
  assert.equal((await reviseIntake(f.store,'custom-intake')).status,'committed');
  const unsuitable=await post(path,selection);
  assert.equal(unsuitable.status,500);
  assert.deepEqual(unsuitable.body,OPERATION_FAILED);
  assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),before);
 });
}

for(const [alreadyOn,suitable,durable] of [[false,false],[true,false],[false,true],[true,true],[false,false,true]] as const){
 test(`rechecking a ${suitable?'still suitable':'now unsuitable'} intake at commit for ${alreadyOn?'the first route on an on connection':'a new activation'}${durable?' in SurrealDB':''}`,{timeout:30000,skip:durable&&!process.env.MASSION_TEST_SURREAL_RPC},async t=>{
  let revise=false;
  const checkedRevisions:(number|undefined)[]=[];
  const wrap=(store:Store<Mission>)=>intakeStore(store,{activationCommit:async input=>{
   if(revise){revise=false;assert.equal((await reviseIntake(store,'assistant-intake',suitable?'bounded-text-review/v1':'human-review/v1')).status,'committed');}
   if(checkedRevisions.length||input.requires)checkedRevisions.push(input.requires?.revision);
   return store.commit(input);
  }});
  const f=await fixture(t,{wrap}),db=durable?await growthStore(true,t.signal):undefined,store=db?.store??f.store;
  const connections=f.host(db?{store:wrap(store),settings:new SurrealHostSettings(db.transport!)}:undefined);await connections.restoreSettings();
  const provider=alreadyOn?'openai':'claude-code-cli',connection=connections.list().connections.find(c=>c.providerType===provider)!;
  if(alreadyOn)assert.equal((await connections.turnOnConnection('seed-key',connection.id,'key-added')).status,'on');
  const before=await store.load(CONNECTION_ACTIVATION_ID);
  const post=await ownerClient(t,{root:f.root,store},connections);
  revise=true;
  const response=await post('/connections/'+encodeURIComponent(connection.id)+'/profiles',{model:alreadyOn?'fixture-api-model':BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Picked',expectedConfigHash:connection.configHash});
  assert.equal(response.status,suitable?200:500);
  assert.deepEqual(checkedRevisions,suitable?[1,2]:[1]);
  if(suitable){
   assert.equal(response.body.activation.routeSet,true);
   assert.equal((await store.load(CONNECTION_ACTIVATION_ID))?.revision,(before?.revision??0)+1);
  }else{
   assert.deepEqual(response.body,OPERATION_FAILED);
   assert.deepEqual(await store.load(CONNECTION_ACTIVATION_ID),before);
  }
 });
}

for(const during of ['preparation','first route preparation','commit'] as const){
 test(`a rename during ${during} cannot leave a stale first route on the same host`,{timeout:30000},async t=>{
  let rename:(()=>Promise<void>)|undefined;
  const f=await fixture(t,{wrap:store=>intakeStore(store,{
   load:async()=>{if(during==='first route preparation')await rename?.();return store.load('assistant-intake');},
   commit:async input=>{if(during==='preparation')await rename?.();return store.commit(input);},
   activationCommit:async input=>{if(during==='commit')await rename?.();return store.commit(input);}
  })}),connections=f.host();await connections.restoreSettings();
  const firstRoute=during==='first route preparation',provider=firstRoute?'openai':'claude-code-cli';
  const connection=connections.list().connections.find(c=>c.providerType===provider)!,model=firstRoute?'fixture-api-model':BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
  if(firstRoute)assert.equal((await connections.turnOnConnection('seed-key',connection.id,'key-added')).status,'on');
  const before=await f.store.load(CONNECTION_ACTIVATION_ID);
  const post=await ownerClient(t,f,connections),path='/connections/'+encodeURIComponent(connection.id)+'/profiles',selection={model,label:'Picked',expectedConfigHash:connection.configHash};
  let renamed=false,competingStatus:number|undefined;
  rename=async()=>{
   rename=undefined;
   if(during!=='commit'){
    await connections.saveModelSelection(connection.id,{...selection,label:'Renamed'},'owner-typed');renamed=true;
   }else{
    const other=await ownerClient(t,f,connections);
    const response=await other(path,{...selection,label:'Renamed'});
    competingStatus=response.status;
   }
  };
  const response=await post(path,selection);
  if(during!=='commit'){
   assert.equal(renamed,true);
   assert.equal(response.status,409);
   assert.deepEqual(await f.store.load(CONNECTION_ACTIVATION_ID),before);
  }else{
   assert.equal(competingStatus,400,'a competing settings write must be refused while the activation is in flight');
   assert.equal(response.status,200);
   assert.equal(response.body.representative.status,'active');
  }
 });
}

for(const phase of ['before','after','closed'] as const)test(phase==='closed'?'another host closing the Representative during activation prevents the first provider call':`the first message is answered ${phase} another connection is committed, while its activation is pending`,{timeout:30000},async t=>{
 let duringActivation:(()=>Promise<void>)|undefined;
 const f=await fixture(t,{wrap:store=>intakeStore(store,{activationCommit:async input=>{
  if(phase==='before')await duringActivation?.();
  const result=await store.commit(input);
  if(phase!=='before')await duringActivation?.();
  return result;
 }})}),connections=f.host();await connections.restoreSettings();
 const {connections:available}=connections.list(),claude=available.find(c=>c.providerType==='claude-code-cli')!,codex=available.find(c=>c.providerType==='codex-cli')!;
 const select=await ownerClient(t,f,connections),send=await ownerClient(t,f,connections);
 const first=await select('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Representative',expectedConfigHash:claude.configHash});
 assert.equal(first.status,200);
 assert.deepEqual(first.body.activation,{status:'turned-on',reason:null,routeSet:true});
 let answer:Awaited<ReturnType<typeof send>>|undefined;
 duringActivation=async()=>{
  if(phase==='closed'){
   const otherHost=f.host({store:f.store,settings:f.settings});await otherHost.restoreSettings();
   await otherHost.removeRepresentative({expectedConfigHash:otherHost.list().configHash});
  }
  answer=await send('/assistant/messages',{commandId:'q-during-activation',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 };
 const other=await select('/connections/'+encodeURIComponent(codex.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:'Other connection',expectedConfigHash:codex.configHash});
 assert.equal(answer?.status,200);
 if(phase==='closed'){
  assert.deepEqual(f.cliCalls,[]);
  assert.equal(answer.body.turn.status,'not_started');
  assert.equal(answer.body.turn.diagnostics[0].code,'settings_changed');
  assert.equal(other.body.representative,null);
 }else{
  assert.equal(answer.body.turn.status,'answered',JSON.stringify(answer.body.turn.diagnostics));assert.equal(answer.body.turn.reply,'4');
  assert.deepEqual(f.cliCalls,['claude']);
  assert.equal(other.body.representative.route.profileId,first.body.profileId);
 }
 assert.equal(other.status,200);
 assert.deepEqual(other.body.activation,{status:'turned-on',reason:null,routeSet:false});
});

test('the first message answers when its settings read starts before the other activation write',{timeout:30000},async t=>{
 const order=new EventEmitter();
 let holdAcknowledgement:(()=>Promise<unknown>)|undefined;
 const f=await fixture(t,{wrap:store=>intakeStore(store,{activationCommit:async input=>{
  const result=await store.commit(input);
  order.emit('activationStored');await holdAcknowledgement?.();
  return result;
 }})}),connections=f.host();await connections.restoreSettings();
 const {connections:available}=connections.list(),claude=available.find(c=>c.providerType==='claude-code-cli')!,codex=available.find(c=>c.providerType==='codex-cli')!;
 const post=await ownerClient(t,f,connections);
 const first=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Representative',expectedConfigHash:claude.configHash});
 assert.equal(first.status,200);assert.equal(first.body.activation.routeSet,true);
 const {profileId}=await connections.saveModelSelection(codex.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:'Other connection',expectedConfigHash:codex.configHash},'owner-typed');
 const load=f.settings.load.bind(f.settings),signal=AbortSignal.any([t.signal,AbortSignal.timeout(5000)]);
 const reading=once(order,'settingsRead',{signal}),written=once(order,'activationStored',{signal});
 f.settings.load=async scope=>{
  f.settings.load=load;
  const row=await load(scope);
  order.emit('settingsRead');await written;
  return row;
 };
 const answer=post('/assistant/messages',{commandId:'q-before-activation-write',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 holdAcknowledgement=()=>answer;
 const activating=reading.then(()=>connections.activateFromSelection({connectionId:codex.id,profileId,origin:'owner-typed'}));
 const [response,activation]=await Promise.all([answer,activating,written]);
 assert.equal(response.status,200);
 assert.equal(response.body.turn.status,'answered',JSON.stringify(response.body.turn.diagnostics));
 assert.equal(response.body.turn.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
 assert.deepEqual(activation,{status:'turned-on',reason:null,routeSet:false});
});

test('the next member message uses the connection another host turned on while the Representative stayed the same',{timeout:30000},async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const {connections:available}=connections.list(),codex=available.find(c=>c.providerType==='codex-cli')!,claude=available.find(c=>c.providerType==='claude-code-cli')!;
 const post=await ownerClient(t,f,connections);
 const first=await post('/connections/'+encodeURIComponent(codex.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli'],label:'Representative',expectedConfigHash:codex.configHash});
 assert.equal(first.status,200);assert.equal(first.body.activation.routeSet,true);
 const {profileId}=await connections.saveModelSelection(claude.id,{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:'Member model',expectedConfigHash:claude.configHash},'owner-typed');
 await connections.save(()=>connections.saveModelGroup({id:'analysis',name:'Analysis',description:'Checks tables',profileIds:[profileId],expectedConfigHash:connections.list().configHash}));
 const proposed=applyMembers(null,{type:'propose-member',decisionId:'analysis-decision',topic:'Tables',works:[{title:'First'},{title:'Second'}],count:2},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{observedAt:1});
 const admitted=applyMembers(proposed.value,{type:'admit-member',decisionId:'analysis-decision',memberId:'quill',name:'Quill',shape:'drop'},{id:'local-owner',roles:['owner']},{observedAt:2});
 await (f.store as Store<unknown>).commit({id:MEMBERS_ID,commandId:'fixture-members',expectedRevision:0,fingerprint:'fixture-members',...admitted,outbox:[]});
 const members=new MembersService(f.store,()=>first.body.representative.intakeMissionId);
 assert.equal((await members.setGroup({commandId:'quill-group',memberId:'quill',modelGroup:'analysis'},connections)).status,'committed');

 const otherHost=f.host();await otherHost.restoreSettings();
 assert.deepEqual(await otherHost.activateFromSelection({connectionId:claude.id,profileId,origin:'owner-typed'}),{status:'turned-on',reason:null,routeSet:false});
 assert.equal(connections.connectionOn(claude.id),false);

 const response=await post('/assistant/messages',{commandId:'q-to-member-after-activation',member:'quill',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'});
 assert.equal(response.status,200);
 assert.equal(response.body.turn.status,'answered',JSON.stringify(response.body.turn.diagnostics));
 assert.equal(response.body.turn.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
 assert.equal(connections.list().representative?.route.profileId,first.body.profileId);
});

for(const [stored,status] of [[true,200],[false,503]] as const){
 test(`an unknown creation outcome is decided by the stored row: ${stored?'the row is there and the selection succeeds':'no row, so the selection answers unknown and turns nothing on'}`,{timeout:30000},async t=>{
  const f=await fixture(t,{wrap:store=>intakeStore(store,{commit:async input=>{if(stored)await store.commit(input);throw new CommitOutcomeUnknownError(input);}})}),connections=f.host();await connections.restoreSettings();
  const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!,model=BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'];
  const post=await ownerClient(t,f,connections);
  const response=await post('/connections/'+encodeURIComponent(claude.id)+'/profiles',{model,label:'Picked',expectedConfigHash:claude.configHash});
  assert.equal(response.status,status,JSON.stringify(response.body));
  if(stored){
   assert.deepEqual(response.body.activation,{status:'turned-on',reason:null,routeSet:true});
   assert.equal((await f.store.load('assistant-intake'))?.value.criteria?.oracle,'bounded-text-review/v1');
  }else{
   assert.deepEqual(response.body,{error:'Commit outcome is unknown. Read durable events before deciding any next action.',outcome:'unknown'});
   assert.equal(await f.store.load('assistant-intake'),null);
   assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null,'the activation was never committed');
   assert.equal(connections.connectionOn(claude.id),false);
  }
 });
}
