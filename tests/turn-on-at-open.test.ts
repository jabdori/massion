import test from 'node:test';
import assert from 'node:assert/strict';
import {Agent,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {runInContext} from 'node:vm';
import {tempRoot} from './support/temp-root.ts';
import {loadHostStartup,createHostConnections,BUILTIN_CLI_RECOMMENDED_MODELS} from '../src/host-connections.ts';
import {CONNECTION_ACTIVATION_ID,FIRST_MESSAGE_LOGIN_ORDER,activationCommandId,activationFingerprint,applyActivation,activationState as parseActivation} from '../src/connection-activation.ts';
import type {ConnectionActivationState,RouteSnapshot} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {AssistantConversation,assistantTurnId,ownerMessageId} from '../src/assistant-conversation.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {authProof} from '../src/daemon-auth.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import {workbenchPage} from '../src/workbench.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {copy} from '../src/ui-copy.ts';

const claudeReply=JSON.stringify({reply:'4',work:null});
const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:claudeReply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});

async function serverFixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'|'unknown';reverseManifest?:boolean;authenticated?:boolean}={}){
 const root=await mkdtemp(join(tempRoot(),'turn-on-at-open-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 let detect=options.detect??(()=>'detected' as const);
 const cliCalls:string[]=[],loginStatusCalls:string[]=[],loginStartCalls:string[]=[];
 const cliRunner:CliRunner=async call=>{
  cliCalls.push(call.command);
  return {spawned:true,exitCode:0,stdout:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};
 };
 const loginRunner:CliRunner=async call=>{
  const provider=call.command==='codex'?'codex-cli':'claude-code-cli';
  if(call.args.join(' ')==='login'||call.args.join(' ')==='auth login')loginStartCalls.push(provider);
  else loginStatusCalls.push(provider);
  const state=detect(provider);
  if(state==='unknown')return {spawned:true,exitCode:0,stdout:provider==='codex-cli'?'':'unreadable',stderr:provider==='codex-cli'?'Unexpected account data':'',timedOut:false,aborted:false,overflow:false};
  const detected=state==='detected';
  if(provider==='codex-cli')return {spawned:true,exitCode:detected?0:1,stdout:'',stderr:detected?'Logged in using ChatGPT':'Not logged in',timedOut:false,aborted:false,overflow:false};
  return {spawned:true,exitCode:0,stdout:JSON.stringify(detected?{loggedIn:true,authMethod:'claude.ai'}:{loggedIn:false}),stderr:'',timedOut:false,aborted:false,overflow:false};
 };
 const logins=new LoginConnections(loginRunner);
 const transport=async()=>new Response(JSON.stringify({data:[]}),{headers:{'content-type':'application/json'}});
 const baseStartup=await loadHostStartup([]);
 const startup=options.reverseManifest
  ?{...baseStartup,manifest:{...baseStartup.manifest!,connections:[baseStartup.manifest!.connections[1]!,baseStartup.manifest!.connections[0]!,...baseStartup.manifest!.connections.slice(2)]}}
  :baseStartup;
 const host=(customStore:InMemoryStore<Mission>=store,customLogins:LoginConnections=logins)=>createHostConnections(customStore,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:(providerType,signal)=>customLogins.recheck(providerType,signal).then(status=>status.status)});
 const connections=host();
 await connections.restoreSettings();
 const boot=async(conn:ReturnType<typeof host>,log:LoginConnections)=>{
  const authenticated=options.authenticated??true;
  const secret='a'.repeat(64);
  const server=createWorkbench(store,root,{connections:conn,logins:log,...(authenticated?{daemonSecret:secret}:{}),scheduleIntervalMs:0});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agent=new Agent({keepAlive:true,maxSockets:1});
  t.after(()=>{agent.destroy();return new Promise<void>(resolve=>server.close(()=>resolve()));});
  const port=(server.address() as {port:number}).port;
  const origin='http://127.0.0.1:'+port;
  const rawRequest=(path:string,headers:Record<string,string>={},body?:unknown)=>new Promise<{status:number;headers:import('node:http').IncomingHttpHeaders;body:any}>((resolve,reject)=>{
   const out=httpRequest({host:'127.0.0.1',port,path,method:body===undefined?'GET':'POST',agent,headers},res=>{
    let raw='';res.setEncoding('utf8');res.on('data',chunk=>raw+=chunk);
    res.on('end',()=>{try{resolve({status:res.statusCode!,headers:res.headers,body:raw?JSON.parse(raw):null});}catch(error){reject(error);}});res.on('error',reject);
   });out.on('error',reject);out.end(body===undefined?undefined:JSON.stringify(body));
  });
  let authorization='';
  if(authenticated){
   const challenge='b'.repeat(64),handshake=await rawRequest('/desktop-auth',{'x-massion-challenge':challenge});
   authorization='Bearer '+authProof(secret,'client',origin,challenge,handshake.headers['x-massion-nonce'] as string);
  }
  const request=(path:string,body?:unknown)=>rawRequest(path,{'content-type':'application/json',...(authorization?{authorization}:{})},body);
  return {origin,request};
 };
 const booted=await boot(connections,logins);
 const restart=async()=>{
  const nextLogins=new LoginConnections(loginRunner);
  const nextConnections=host(store,nextLogins);
  await nextConnections.restoreSettings();
  return {connections:nextConnections,logins:nextLogins,...await boot(nextConnections,nextLogins)};
 };
 return {root,store,secrets,settings,connections,logins,origin:booted.origin,request:booted.request,restart,cliCalls,loginStatusCalls,loginStartCalls,setDetect:(next:typeof detect)=>{detect=next;}};
}

test('GET /connections uses FIRST_MESSAGE_LOGIN_ORDER as the single source for both logins order and firstCandidate',async t=>{
 const f=await serverFixture(t,{reverseManifest:true});
 const response=await f.request('/connections');
 assert.equal(response.status,200);
 const body=response.body;
 assert.deepEqual(body.logins.map((l:any)=>l.providerType),[...FIRST_MESSAGE_LOGIN_ORDER],'LoginConnections.list() follows FIRST_MESSAGE_LOGIN_ORDER');
 const claude=body.connections.find((c:any)=>c.providerType==='claude-code-cli')!;
 assert.deepEqual(body.firstCandidate,{connectionId:claude.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']},'firstCandidate picks the first provider in FIRST_MESSAGE_LOGIN_ORDER even when the manifest lists Codex first');
});

test('GET /connections firstCandidate is null without owner proof (when turn-on would refuse not-owner) and non-null for the owner',async t=>{
 const unauth=await serverFixture(t,{authenticated:false});
 const claudeUnauth=unauth.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const unauthList=await unauth.request('/connections');
 assert.equal(unauthList.status,200);
 assert.equal(unauthList.body.firstCandidate,null,'unauthenticated requester never receives a candidate');
 const unauthPost=await unauth.request('/connections/'+encodeURIComponent(claudeUnauth.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:claudeUnauth.configHash});
 assert.equal(unauthPost.status,200);
 assert.deepEqual(unauthPost.body.activation,{status:'not-turned-on',reason:'not-owner',routeSet:false});

 const owner=await serverFixture(t,{authenticated:true});
 const claudeOwner=owner.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const ownerList=await owner.request('/connections');
 assert.equal(ownerList.status,200);
 assert.deepEqual(ownerList.body.firstCandidate,{connectionId:claudeOwner.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']});
});

test('GET /connections firstCandidate covers every state without extra probes or CLI starts',async t=>{
 // Both detected -> Claude Code
 const f=await serverFixture(t);
 const claude=f.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const codex=f.connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const both=(await f.request('/connections')).body;
 assert.deepEqual(both.firstCandidate,{connectionId:claude.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']});
 assert.equal(f.loginStatusCalls.filter(p=>p==='claude-code-cli').length,1,'at most one status probe per provider per GET /connections');
 assert.equal(f.loginStatusCalls.filter(p=>p==='codex-cli').length,1);
 assert.deepEqual(f.loginStartCalls,[],'no CLI login command started');
 assert.deepEqual(f.cliCalls,[],'no model CLI started');

 // Only Codex detected -> Codex
 f.setDetect(provider=>provider==='codex-cli'?'detected':'absent');
 const onlyCodex=(await f.request('/connections')).body;
 assert.deepEqual(onlyCodex.firstCandidate,{connectionId:codex.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli']});

 // Nothing detected (absent and unknown) -> null
 f.setDetect(provider=>provider==='claude-code-cli'?'absent':'unknown');
 const none=(await f.request('/connections')).body;
 assert.equal(none.firstCandidate,null);

 // A connection on without a route (API key added) -> null even when both logins are detected
 f.setDetect(()=>'detected');
 const openai=f.connections.list().connections.find(c=>c.providerType==='openai')!;
 assert.equal((await new ConnectionLifecycle(f.store,f.connections).replaceKey({commandId:'key-first',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 assert.equal(f.connections.list().representative,null);
 const apiOn=(await f.request('/connections')).body;
 assert.equal(apiOn.firstCandidate,null);

 // A route present -> null
 const g=await serverFixture(t);
 const gClaude=g.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 assert.equal((await g.connections.turnOnConnection('login:route',gClaude.id,'login-started')).status,'on');
 const routePresent=(await g.request('/connections')).body;
 assert.equal(routePresent.firstCandidate,null);

 // Route closed by the owner -> null
 await g.connections.save(()=>g.connections.removeRepresentative({expectedConfigHash:g.connections.list().configHash}));
 const routeClosed=(await g.request('/connections')).body;
 assert.equal(routeClosed.firstCandidate,null);

 // POST /connections/<id>/profiles also carries firstCandidate: null and probes nothing
 const beforeProbes=g.loginStatusCalls.length;
 const postRes=await g.request('/connections/'+encodeURIComponent(gClaude.id)+'/profiles',{model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:gClaude.configHash});
 assert.equal(postRes.status,200);
 assert.equal(postRes.body.firstCandidate,null);
 assert.equal(g.loginStatusCalls.length,beforeProbes,'POST /connections/<id>/profiles does not re-probe logins when returning the connection list');
});

test('no-route send records a not_started turn and makes zero provider calls even with detected logins',async t=>{
 const f=await serverFixture(t);
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,f.connections),f.connections);
 const sent=await assistant.send({commandId:'q-no-route',segment:1,expectedRevision:0,text:'2+2?'},undefined,'owner-typed');
 assert.equal(sent.message.status,'committed');
 assert.equal(sent.turn?.status,'not_started');
 assert.equal(sent.turn?.diagnostics?.[0]?.code,'assistant_route_missing');
 assert.equal(Object.hasOwn(sent,'activation'),false);
 assert.deepEqual(f.cliCalls,[]);
 assert.equal(await f.store.load(CONNECTION_ACTIVATION_ID),null);
});

test('a store with a journalled first-message turn-on and legacy not-sent receipt loads and answers',async t=>{
 const f=await serverFixture(t);
 const claude=f.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const codex=f.connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const profile=(f.connections.list().runtime.connections as any[]).find(p=>p.providerKind==='claude-code-cli')!;
 const route:RouteSnapshot={model:profile.model,profileId:profile.id,configHash:profile.configHash,outputTokenCap:profile.limits.maxOutputTokens,intakeMissionId:'assistant-intake'};

 // Seed a historical first-message turn-on command and a legacy not-sent turn in a fresh store, by the author the old send path used (OWNER in src/assistant-service.ts).
 const oldStore=new InMemoryStore<Mission>();
 const msgId=ownerMessageId('legacy-1'),turnId=assistantTurnId(msgId);
 const conversation=new AssistantConversation(oldStore,[{id:'local-owner',roles:['owner']},{id:'assistant-representative',roles:['assistant']}],()=>1000);
 await conversation.dispatch({segment:1,commandId:'legacy-1',expectedRevision:0,actorId:'local-owner',command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId:msgId,origin:'owner-typed',text:'Earlier message',turn:{status:'not_started',id:turnId,diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]}}});
 await conversation.dispatch({segment:1,commandId:'legacy-not-sent',expectedRevision:1,actorId:'local-owner',command:{type:'append-assistant-message',recordMessageTime:true,messageId:ownerMessageId('legacy-not-sent'),origin:'owner-typed',text:'Not sent then',turn:{status:'pending',id:assistantTurnId(ownerMessageId('legacy-not-sent')),route:{profileId:route.profileId,configHash:route.configHash,provider:'claude-code-cli',model:route.model,mode:'live',outputTokenCap:route.outputTokenCap},ownership:{hostSessionId:'old-host',dispatchId:'old-dispatch',startedAt:1,deadlineAt:60000},requestHash:'a'.repeat(64),contextMessageIds:[]}}});
 await conversation.dispatch({segment:1,commandId:'assistant-settle:'+assistantTurnId(ownerMessageId('legacy-not-sent')),expectedRevision:2,actorId:'assistant-representative',command:{type:'settle-assistant-turn',turnId:assistantTurnId(ownerMessageId('legacy-not-sent')),status:'failed',usage:{inputTokens:null,outputTokens:null},receipt:'This message turned the connection on, but was not sent.'}});

 const activationCmd={kind:'turn-on' as const,commandId:activationCommandId('legacy-1','first-message'),connectionId:claude.id,way:'first-message' as const,at:1,messageId:msgId,messageOrigin:'owner-typed' as const,detectedLogins:[claude.id,codex.id],detectedProviders:['claude-code-cli','codex-cli'],route};
 const applied=applyActivation(parseActivation(undefined),activationCmd);
 const commit=await oldStore.commit({id:CONNECTION_ACTIVATION_ID,commandId:activationCmd.commandId,fingerprint:activationFingerprint(activationCmd),expectedRevision:0,value:applied.value,events:applied.events,outbox:[]} as any);
 assert.equal(commit.status,'committed');
 validateMissionJournalLineage(oldStore.inspect());

 // Boot a fresh ConnectionWorkbench and AssistantService against that existing store.
 const startup=await loadHostStartup([]);
 const restored=createHostConnections(oldStore,new TextArtifactStore(join(f.root,'artifacts-old')),startup,{secrets:f.secrets,readEnvironment:()=>undefined,transport:async()=>new Response('{}'),settings:new InMemoryHostSettings(),cliRunner:async call=>{f.cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};},loginStatus:async()=>'detected'});
 await restored.restoreSettings();
 assert.equal(restored.connectionOn(claude.id),true);
 assert.equal(restored.list().representative?.route.profileId,route.profileId);
 assert.equal(restored.list([{providerType:'claude-code-cli',status:'detected'}]).firstCandidate,null);

 const assistant=new AssistantService(oldStore,new ProductService(oldStore,undefined,restored),restored);
 const view=await assistant.read(1);
 assert.equal(view.turns[1]?.settlement?.reason,'This message turned the connection on, but was not sent.','legacy not-sent receipt still classifies');

 const answered=await assistant.send({commandId:'q-after-old',segment:1,expectedRevision:view.segment!.revision,text:'2+2?'},undefined,'owner-typed');
 assert.equal(answered.turn?.status,'answered');
 assert.equal(answered.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
});

test('a store whose model-selected turn-on was recorded as the owner choice (the shape PR #304 wrote) loads, replays and answers unchanged',async t=>{
 const f=await serverFixture(t);
 // The command, the stored value and the fingerprint are written out by hand in the shape PR #304 stored, never borrowed from the transition: no automaticPick field, the source owner-choice.
 // The fingerprint is the one the code at d4c1386f produced for exactly this command. It is a literal, so a later change of activationFingerprint fails here with the fingerprint mismatch instead of passing while old journals stop loading.
 const command={kind:'turn-on' as const,commandId:'connection-on:4b4d2507ede7d51e562d171f08f775f8',connectionId:'host:claude:ca0264faa4ff83d7',way:'model-selected' as const,at:1,messageOrigin:'owner-typed' as const,detectedLogins:['host:claude:ca0264faa4ff83d7'],route:{model:'claude-sonnet-5-5',profileId:'profile:6e6b28e8b4db2c9d822fdd7574eb7b47',configHash:'b639d592d563a59cdcca999342178fe88a90d9c2b9fb344dde0abf531ba66a5f',outputTokenCap:4096,intakeMissionId:'assistant-intake'}};
 const fingerprint='56e5d812ccb51bc4d56889698206cab6cd5762de8030c05880e8e91e25621210';
 const claude=f.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const profile=(f.connections.list().runtime.connections as any[]).find(p=>p.providerKind==='claude-code-cli')!;
 // The pinned journal names the built-in connection and profile as this host still lists them, which is what lets the restored host answer; if this fails the built-in host changed, not the stored shape.
 assert.equal(claude.id,command.connectionId);assert.equal(profile.id,command.route.profileId);assert.equal(profile.configHash,command.route.configHash);
 const route:RouteSnapshot=command.route;
 const storedValue:ConnectionActivationState={kind:'connection-activation',id:CONNECTION_ACTIVATION_ID,activations:[{connectionId:claude.id,at:1,way:'model-selected'}],routeChoice:{...route,connectionId:claude.id,at:1,source:'owner-choice'},routeClosedAt:null};
 const oldStore=new InMemoryStore<Mission>();
 const commit=await oldStore.commit({id:CONNECTION_ACTIVATION_ID,commandId:command.commandId,fingerprint,expectedRevision:0,value:storedValue,events:[{type:'connection-activation',actor:'local-owner',command}],outbox:[]} as any);
 assert.equal(commit.status,'committed');
 // The lineage replay derives the stored value from the stored command.
 validateMissionJournalLineage(oldStore.inspect());
 const before=await oldStore.load(CONNECTION_ACTIVATION_ID);

 // Boot a fresh ConnectionWorkbench and AssistantService against that existing store.
 const restored=createHostConnections(oldStore,new TextArtifactStore(join(f.root,'artifacts-old')),await loadHostStartup([]),{secrets:f.secrets,readEnvironment:()=>undefined,transport:async()=>new Response('{}'),settings:new InMemoryHostSettings(),cliRunner:async call=>{f.cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:claudeResult,stderr:'',timedOut:false,aborted:false,overflow:false};},loginStatus:async()=>'detected'});
 await restored.restoreSettings();
 const listed=restored.list([{providerType:'claude-code-cli',status:'detected'}],'owner-typed');
 assert.equal(restored.connectionOn(claude.id),true);
 assert.equal(listed.representative?.route.profileId,route.profileId);
 assert.equal(listed.representative?.derived,false,'a record written before this change keeps its meaning: the owner choice');
 assert.equal(listed.firstCandidate,null,'a stored route, whichever source it has, is not picked over again');

 const assistant=new AssistantService(oldStore,new ProductService(oldStore,undefined,restored),restored);
 const answered=await assistant.send({commandId:'q-after-304',segment:1,expectedRevision:0,text:'2+2?'},undefined,'owner-typed');
 assert.equal(answered.turn?.status,'answered');
 assert.equal(answered.turn?.reply,'4');
 assert.deepEqual(f.cliCalls,['claude']);
 // Nothing was rewritten: the stored aggregate and its one journal operation are what was written before the host loaded it.
 assert.deepEqual(await oldStore.load(CONNECTION_ACTIVATION_ID),before);
 assert.equal(oldStore.inspect().filter(operation=>operation.aggregateId===CONNECTION_ACTIVATION_ID).length,1);
 validateMissionJournalLineage(oldStore.inspect());
});

async function screenFixture(options:{candidate?:{connectionId:string;model:string}|null;representative?:boolean;representativeProfileId?:string;profile?:{label:string;model:string};holdReadState?:Promise<void>;onTurnOn?:(path:string,body:any,baseConnections:any)=>Promise<ReturnType<typeof reply>>|ReturnType<typeof reply>}={}){
 const base=await loadFixture('B1');
 const claudeId='host:claude:fixture';
 const profile=options.profile?{id:'profile:claude',providerKind:'claude-code-cli',diagnostics:[],...options.profile}:{id:'profile:claude',label:'claude-sonnet-5-5',providerKind:'claude-code-cli',model:'claude-sonnet-5-5',diagnostics:[]};
 const baseConnections={
  ...(base.routes['/connections']!.body as any),
  connections:[{id:claudeId,label:'Claude Code',providerType:'claude-code-cli',protocol:'claude-code-cli/v1',baseUrl:'cli://claude-code/',mode:'https',auth:'cli-login',configHash:'hash-claude',on:false,credentialConfigured:true,connectionStatus:'cli-login-unverified',discovery:'not-requested',models:[],liveVerified:false}],
  runtime:{connections:[profile],defaultRoutes:[],authorizations:[]},
  representative:options.representative?{route:{profileId:options.representativeProfileId??'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]}:null,
  firstCandidate:options.candidate===undefined?{connectionId:claudeId,model:'claude-sonnet-5-5'}:options.candidate,
  logins:[{providerType:'claude-code-cli',kind:'cli-login',status:'detected'}],
 };
 (base.routes['/connections']!.body as any)=baseConnections;
 const messagePosts:any[]=[],turnOnPosts:any[]=[];
 const app=harness(async(path,reqOptions)=>{
  if(reqOptions?.method==='POST'&&path==='/assistant/messages'){
   messagePosts.push(JSON.parse(reqOptions.body));
   return reply({message:{status:'committed',revision:1,value:{kind:'assistant-conversation',id:'assistant-conversation:1',segment:1,previous:null,closed:false,timeWatermark:1,messages:[],turns:[]}},turn:{id:'turn-1',status:'answered',reply:'ok'}});
  }
  if(reqOptions?.method==='POST'&&path.startsWith('/connections/')&&path.endsWith('/profiles')){
   const body=JSON.parse(reqOptions.body);
   turnOnPosts.push({path,body});
   if(options.onTurnOn)return await options.onTurnOn(path,body,baseConnections);
   return reply({profileId:'profile:claude',activation:{status:'turned-on',reason:null,routeSet:true},...baseConnections,connections:[{...baseConnections.connections[0],on:true}],representative:{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},firstCandidate:null});
  }
  if(path==='/read-state'&&options.holdReadState)await options.holdReadState;
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:path.startsWith('/assistant/conversation')?base.routes['/assistant/conversation']:undefined);
  return reply(route?.body??{},route?.status??503);
 });
 return {app,baseConnections,claudeId,messagePosts,turnOnPosts};
}

test('screen: sends turn-on once at install and never loops even if response echoes firstCandidate; skips when null',async()=>{
 // Echoing firstCandidate in the POST response (even with routeSet: false and representative: null) must never trigger a second request.
 let calls=0;
 const withEcho=await screenFixture({
  onTurnOn:async(_path,_body,baseConnections)=>{
   if(++calls>5)throw new Error('turn-on loop exceeded bound');
   return reply({profileId:'profile:claude',activation:{status:'not-turned-on',reason:'login-not-detected',routeSet:false},...baseConnections,representative:null,firstCandidate:{connectionId:'host:claude:fixture',model:'claude-sonnet-5-5'}});
  },
 });
 await settle();
 assert.equal(withEcho.turnOnPosts.length,1);
 assert.deepEqual(withEcho.turnOnPosts[0],{path:'/connections/host%3Aclaude%3Afixture/profiles',body:{model:'claude-sonnet-5-5',label:'claude-sonnet-5-5',expectedConfigHash:'hash-claude',automaticPick:true}});

 // When firstCandidate is null, nothing is sent.
 const withoutCandidate=await screenFixture({candidate:null});
 await settle();
 assert.equal(withoutCandidate.turnOnPosts.length,0);
});

test('screen: lock disables send, blocks sendChat and firstAssign while in flight, and ends on answer',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const f=await screenFixture({
  onTurnOn:async()=>{
   await gate;
   return reply({profileId:'profile:claude',activation:{status:'turned-on',reason:null,routeSet:true},...f.baseConnections,connections:[{...f.baseConnections.connections[0],on:true}],representative:{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},firstCandidate:null});
  },
 });
 await settle();
 assert.equal(f.turnOnPosts.length,1);
 assert.equal(f.app.node('chat-send').disabled,true,'chat-send is disabled while turn-on is in flight without a route');

 // sendChat is blocked while locked.
 f.app.node('chat-input').value='Hello while locked';
 await runInContext('sendChat()',f.app.context);
 await settle();
 assert.equal(f.messagePosts.length,0,'sendChat does not post while locked');

 // firstAssign (automatic first send) also respects the lock and leaves the input untouched.
 f.app.node('chat-input').value='';
 await f.app.all().find(n=>n.id==='first-calculation')!.fire('click');
 await settle();
 await f.app.all().find(n=>n.id==='first-assign')!.fire('click');
 await settle();
 assert.equal(f.app.node('chat-input').value,'','firstAssign stops before filling the composer while locked');
 assert.equal(f.messagePosts.length,0,'firstAssign does not post while locked');

 // Resolving the turn-on unlocks send and installs the route.
 release();
 await settle();
 assert.equal(f.app.node('chat-send').disabled,false);
 await f.app.all().find(n=>n.id==='first-assign')!.fire('click');
 await settle();
 assert.equal(f.messagePosts.length,1);
});

test('screen: lock ends on 409 and rejection with no new text, and next list install may try once',async()=>{
 for(const mode of ['409','throw'] as const){
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let failTurnOn=true;
  const f=await screenFixture({
   onTurnOn:async()=>{
    await gate;
    if(failTurnOn){
     if(mode==='409')return reply({error:'Connection activation could not be recorded; refresh and try again'},409);
     throw new Error('network lost');
    }
    return reply({profileId:'profile:claude',activation:{status:'turned-on',reason:null,routeSet:true},...f.baseConnections,representative:{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},firstCandidate:null});
   },
  });
  await settle();
  assert.equal(f.turnOnPosts.length,1);
  assert.equal(f.app.node('chat-send').disabled,true);
  const statusBefore=f.app.node('chat-status').textContent,hiddenBefore=f.app.node('chat-status').hidden;

  release();
  await settle();
  assert.equal(f.turnOnPosts.length,1,'failure never retries in a loop');
  assert.equal(f.app.node('chat-send').disabled,false,'lock ends on '+mode);
  assert.equal(f.app.node('chat-status').textContent,statusBefore,'no new text on '+mode);
  assert.equal(f.app.node('chat-status').hidden,hiddenBefore,'no new status element shown on '+mode);

  // A subsequent list install (e.g. refreshConnections) may try again once.
  failTurnOn=false;
  await runInContext('refreshConnections()',f.app.context);
  await settle();
  assert.equal(f.turnOnPosts.length,2);
 }
});

test('screen: lock ends after the timeout bound when neither answer nor failure arrives',async()=>{
 const timers:Array<{ms:number;fn:()=>void}>=[];
 const never=new Promise<ReturnType<typeof reply>>(()=>{});
 const f=await screenFixture({onTurnOn:()=>never});
 await settle();
 (f.app.context as any).setTimeout=(fn:()=>void,ms:number)=>{timers.push({ms,fn});return timers.length;};
 // Trigger a fresh reconnect + pollEvents under the capturing setTimeout so we capture endConnectionTurnOn's 15000ms timer.
 await runInContext('requireReconnect()',f.app.context);
 await runInContext('pollEvents()',f.app.context);
 await settle();
 const endTurnOnTimer=timers.findLast(entry=>entry.ms===15000&&entry.fn.toString().includes('endConnectionTurnOn'))?.fn;
 assert.ok(endTurnOnTimer,'expected endConnectionTurnOn 15000ms lock bound timer');
 assert.equal(f.app.node('chat-send').disabled,true);

 f.app.node('chat-input').value='Blocked before bound';
 await runInContext('sendChat()',f.app.context);
 await settle();
 assert.equal(f.messagePosts.length,0);

 // Fire endConnectionTurnOn's bound timer callback without sleeping.
 endTurnOnTimer();
 await settle();
 assert.equal(f.app.node('chat-send').disabled,false,'lock ends when the bound elapses');
 await runInContext('sendChat()',f.app.context);
 await settle();
 assert.equal(f.messagePosts.length,1,'send works after bound expires');
});

test('screen: installs the returned list as the reply (never fabricates representative from routeSet)',async()=>{
 // Case 1: not-turned-on with returned list carrying a real representative installs it (fails if installConnections is removed).
 const routeExists=await screenFixture({
  onTurnOn:async(_path,_body,baseConnections)=>reply({
   profileId:'profile:api',
   activation:{status:'not-turned-on',reason:'not-a-subscription-connection',routeSet:true},
   ...baseConnections,
   representative:{route:{profileId:'profile:api',configHash:'d'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},
   firstCandidate:null,
  }),
 });
 await settle();
 assert.equal(routeExists.app.node('chat-send').disabled,false);
 assert.equal(runInContext('connectionCatalog.representative?.route.profileId',routeExists.app.context),'profile:api');

 // Case 2: routeSet true with representative: null installs null rather than fabricating a dummy representative.
 const fabricatedNotAllowed=await screenFixture({
  onTurnOn:async(_path,_body,baseConnections)=>reply({
   profileId:'profile:claude',
   activation:{status:'turned-on',reason:null,routeSet:true},
   ...baseConnections,
   representative:null,
   firstCandidate:null,
  }),
 });
 await settle();
 assert.equal(runInContext('connectionCatalog.representative',fabricatedNotAllowed.app.context),null);

 // Case 3: already-on with representative: null installs null.
 const noRoute=await screenFixture({
  onTurnOn:async(_path,_body,baseConnections)=>reply({
   profileId:'profile:claude',
   activation:{status:'already-on',reason:null,routeSet:false},
   ...baseConnections,
   representative:null,
   firstCandidate:null,
  }),
 });
 await settle();
 assert.equal(runInContext('connectionCatalog.representative',noRoute.app.context),null);
});

const workbenchScript=workbenchPage.match(/<script>([\s\S]*)<\/script>/)![1]!;

async function waitFor(predicate:()=>boolean,label:string,timeoutMs=5000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){
  if(predicate())return;
  await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.fail('Timed out waiting for: '+label);
}

async function preListFixture(mode:'resolve'|'fail'|'throw'|'hang'){
 const base=await loadFixture('B1');
 const baseConnections={
  ...(base.routes['/connections']!.body as any),
  representative:null,
  firstCandidate:null,
 };
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const messagePosts:any[]=[];
 const app=harness(async(path,reqOptions)=>{
  if(reqOptions?.method==='POST'&&path==='/assistant/messages'){
   messagePosts.push(JSON.parse(reqOptions.body));
   return reply({message:{status:'committed',revision:1,value:{kind:'assistant-conversation',id:'assistant-conversation:1',segment:1,previous:null,closed:false,timeWatermark:1,messages:[],turns:[]}},turn:{id:'turn-1',status:'answered',reply:'ok'}});
  }
  if(path==='/connections'){
   await gate;
   if(mode==='throw')throw new Error('connections network error');
   if(mode==='fail')return reply({error:'unavailable'},503);
   return reply(baseConnections);
  }
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
  return reply(route?.body??{},route?.status??503);
 },{},undefined,mode==='hang'?{scripts:['const __timers=[];setTimeout=(fn,ms)=>{__timers.push({ms,fn});return __timers.length;};',workbenchScript]}:undefined);
 return {app,release,messagePosts};
}

test('screen: pre-list lock blocks sendChat, keeps typed text, and unlocks on install, failure, exception, and product bound',async()=>{
 for(const mode of ['resolve','fail','throw','hang'] as const){
  const f=await preListFixture(mode);
  await settle();
  assert.equal(f.app.node('chat-send').disabled,true,'locked before first list resolves ('+mode+')');
  f.app.node('chat-input').value='Typed before list';
  await runInContext('sendChat()',f.app.context);
  await settle();
  assert.equal(f.messagePosts.length,0,'sendChat blocked before first list ('+mode+')');
  assert.equal(f.app.node('chat-input').value,'Typed before list','typed text stays before first list ('+mode+')');

  if(mode==='hang'){
   const hasInitialTimer=runInContext("__timers.some(t=>t.ms===15000&&t.fn.toString().includes('endInitialConnectionWait'))",f.app.context);
   assert.equal(hasInitialTimer,true,'product startup armed initial 15000ms wait timer');
   runInContext("__timers.findLast(t=>t.ms===15000&&t.fn.toString().includes('endInitialConnectionWait')).fn()",f.app.context);
  }else{
   f.release();
  }
  await settle();
  assert.equal(f.app.node('chat-send').disabled,false,'unlocked after '+mode);
  if(mode==='fail'||mode==='throw')assert.equal(runInContext('connectionCatalog',f.app.context),null,'failed list sets connectionCatalog null without relocking');
  assert.equal(f.app.node('chat-input').value,'Typed before list','typed text stays after '+mode);
  await runInContext('sendChat()',f.app.context);
  await settle();
  assert.equal(f.messagePosts.length,1,'send succeeds after '+mode);
 }
});

test('screen: failed events read at open keeps pre-list lock until connection list has an outcome',async()=>{
 let failEvents=true,releaseList!:()=>void;
 const listGate=new Promise<void>(resolve=>{releaseList=resolve;});
 const base=await loadFixture('B1');
 const baseConnections={...(base.routes['/connections']!.body as any),representative:null,firstCandidate:null};
 const messagePosts:any[]=[];
 const app=harness(async(path,reqOptions)=>{
  if(reqOptions?.method==='POST'&&path==='/assistant/messages'){
   messagePosts.push(JSON.parse(reqOptions.body));
   return reply({message:{status:'committed',revision:1,value:{kind:'assistant-conversation',id:'assistant-conversation:1',segment:1,previous:null,closed:false,timeWatermark:1,messages:[],turns:[]}},turn:{id:'turn-1',status:'answered',reply:'ok'}});
  }
  if(path.startsWith('/events?'))return failEvents?reply({error:'events unavailable'},503):reply(base.routes['/events']!.body);
  if(path==='/connections'){await listGate;return reply(baseConnections);}
  const route=base.routes[path];
  return reply(route?.body??{},route?.status??503);
 });
 await settle();
 assert.equal(runInContext('connectionInitialPending',app.context),true,'initial lock stays up when /events fails before /connections runs');
 assert.equal(app.node('chat-send').disabled,true);
 app.node('chat-input').value='Draft during failed events';
 await runInContext('sendChat()',app.context);
 await settle();
 assert.equal(messagePosts.length,0);
 assert.equal(app.node('chat-input').value,'Draft during failed events');

 failEvents=false;
 releaseList();
 runInContext('void pollEvents()',app.context);
 await waitFor(()=>!runInContext('connectionInitialPending',app.context)&&!app.node('chat-send').disabled,'unlock after list resolves');
 await runInContext('sendChat()',app.context);
 await settle();
 assert.equal(messagePosts.length,1);
});

test('screen: the model text beside the composer follows the route states and never shows the profile label or provider kind',async()=>{
 // Route present: the profile's model name as plain text, not a control, and the row carries no account or provider name.
 const present=await screenFixture({representative:true,candidate:null,profile:{label:'Claude Code',model:'claude-sonnet-5-5'}});
 await settle();
 const model=present.app.node('chat-model');
 assert.equal(model.textContent,'claude-sonnet-5-5');
 assert.equal(model.tagName,'SPAN','the model text is not a button or link');
 assert.equal(model.listeners.size,0,'the model text has no click handler');
 assert.equal(model.hasAttribute('tabindex'),false,'the model text is not focusable');
 const row=['chat-attach','chat-permission','chat-model','chat-send'].map(id=>present.app.node(id).textContent).join('');
 assert.equal(row,'claude-sonnet-5-5','only the model name is in the composer row');
 assert.ok(!row.includes('Claude Code')&&!row.includes('claude-code-cli'),'no account or provider name in the composer row');
 assert.equal(present.app.node('chat-connection').hidden,true,'no header status once the route is known');

 // Route present but no runtime profile matches it: no text and no invented fallback.
 const missing=await screenFixture({representative:true,candidate:null,representativeProfileId:'profile:gone'});
 await settle();
 assert.equal(missing.app.node('chat-model').textContent,'');
 assert.equal(missing.app.node('chat-model').hidden,true);
});

test('screen: while the first turn-on runs the header reads 연결 중 with no model text, and the installed route replaces both',async()=>{
 let release!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const f=await screenFixture({profile:{label:'Claude Code',model:'claude-sonnet-5-5'},onTurnOn:async()=>{
  await gate;
  return reply({profileId:'profile:claude',activation:{status:'turned-on',reason:null,routeSet:true},...f.baseConnections,connections:[{...f.baseConnections.connections[0],on:true}],representative:{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},firstCandidate:null});
 }});
 await settle();
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),'turning on shows 연결 중');
 assert.equal(f.app.node('chat-connection').hidden,false);
 assert.equal(f.app.node('chat-model').textContent,'','no model text while turning on');
 assert.equal(f.app.node('chat-model').hidden,true);
 assert.equal(f.app.node('chat-send').disabled,true,'send stays locked while turning on');
 release();
 await settle();
 assert.equal(f.app.node('chat-model').textContent,'claude-sonnet-5-5','the installed route names the answering model');
 assert.equal(f.app.node('chat-connection').hidden,true,'연결 중 is gone once the route is installed');
});

test('screen: the turn-on start itself redraws the header slot even when called directly',async()=>{
 const never=new Promise<ReturnType<typeof reply>>(()=>{});
 const f=await screenFixture({candidate:null,onTurnOn:()=>never});
 await settle();
 assert.equal(f.app.node('chat-connection').hidden,true,'no header status before the turn-on');
 runInContext("turnOnFirstCandidate({connectionId:'host:claude:fixture',model:'claude-sonnet-5-5'},{configHash:'hash-claude'})",f.app.context);
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),'starting the turn-on draws 연결 중 without waiting for the request');
 assert.equal(f.app.node('chat-connection').hidden,false,'the slot is shown, not carrying hidden text');
});

test('screen: while the reconnect gate is still raised and the turn-on is in flight, the header reads 연결 중',async()=>{
 let releaseRead!:()=>void;
 const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
 const never=new Promise<ReturnType<typeof reply>>(()=>{});
 const f=await screenFixture({onTurnOn:()=>never,holdReadState:readGate});
 await settle();
 assert.equal(runInContext('connectionTurnOnInFlight',f.app.context),true,'the turn-on is in flight');
 assert.equal(runInContext('reconnectRequired',f.app.context),true,'the reconnect read still holds the gate up, as on a real first open');
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),'turning on wins over the still-raised gate');
 assert.equal(f.app.node('chat-connection').hidden,false);
 releaseRead();
 await settle();
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),'연결 중 stays after the gate lowers while the turn-on is still in flight');
});

test('screen: a member 1:1 thread shows no model text; the Representative conversation shows it again',async()=>{
 const f=await screenFixture({representative:true,candidate:null});
 await settle();
 assert.equal(f.app.node('chat-model').textContent,'claude-sonnet-5-5');
 await runInContext("chatOpenThread('member-quill')",f.app.context);
 await settle();
 assert.equal(f.app.node('chat-model').textContent,'','a member thread answers through its model group, not the Representative route');
 assert.equal(f.app.node('chat-model').hidden,true);
 await runInContext("chatOpenThread('')",f.app.context);
 await settle();
 assert.equal(f.app.node('chat-model').textContent,'claude-sonnet-5-5','back on the Representative conversation');
});

test('screen: a later failed list read clears the stale model name from the composer row',async()=>{
 let failList=false;
 const base=await loadFixture('B1');
 const claudeId='host:claude:fixture';
 const baseConnections={
  ...(base.routes['/connections']!.body as any),
  connections:[{id:claudeId,label:'Claude Code',providerType:'claude-code-cli',protocol:'claude-code-cli/v1',baseUrl:'cli://claude-code/',mode:'https',auth:'cli-login',configHash:'hash-claude',on:false,credentialConfigured:true,connectionStatus:'cli-login-unverified',discovery:'not-requested',models:[],liveVerified:false}],
  runtime:{connections:[{id:'profile:claude',label:'claude-sonnet-5-5',providerKind:'claude-code-cli',model:'claude-sonnet-5-5',diagnostics:[]}],defaultRoutes:[],authorizations:[]},
  representative:{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]},
  firstCandidate:null,
  logins:[{providerType:'claude-code-cli',kind:'cli-login',status:'detected'}],
 };
 const app=harness(async(path)=>{
  if(path==='/connections')return failList?reply({error:'unavailable'},503):reply(baseConnections);
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
  return reply(route?.body??{},route?.status??503);
 });
 await settle();
 assert.equal(app.node('chat-model').textContent,'claude-sonnet-5-5');
 failList=true;
 await runInContext('refreshConnections()',app.context);
 assert.equal(app.node('chat-model').textContent,'','a failed later list leaves no stale model name');
 assert.equal(app.node('chat-model').hidden,true);
});

test('screen: a failed conversation read is read again when the reconnect gate lowers, so 연결 끊김 does not stay',async()=>{
 let conversationDown=true,releaseRead!:()=>void;
 const readGate=new Promise<void>(resolve=>{releaseRead=resolve;});
 const app=harness(async(path)=>{
  if(path.startsWith('/assistant/conversation'))return conversationDown?reply({error:'Conversation unavailable'},503):reply({feedId:'conversation:fixture',cursor:0,head:1,segment:null,turns:[]});
  if(path.startsWith('/read-state')){await readGate;return reply({feedId:'feed:a',cursor:0,snapshot:null});}
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:0,events:[]});
  return reply({});
 });
 const reads=()=>app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length;
 await settle();
 assert.equal(runInContext('chatDisconnected',app.context),true,'the first conversation read failed');
 assert.equal(app.node('chat-connection').textContent,copy('header.status.01'));
 const before=reads();
 conversationDown=false;
 releaseRead();
 await settle();
 assert.equal(runInContext('reconnectRequired',app.context),false,'the reconnect read finished and lowered the gate');
 assert.equal(reads(),before+1,'lowering the gate reads the conversation once more');
 assert.equal(runInContext('chatDisconnected',app.context),false,'the read after recovery succeeded');
 assert.equal(app.node('chat-connection').hidden,true,'연결 끊김 is gone once the conversation was read again');
});

test('screen: every failed turn-on ending leaves 연결 없음 in the model text place and no 연결 중',async()=>{
 for(const mode of ['refusal','non-ok','network','bound','abort'] as const){
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const never=new Promise<ReturnType<typeof reply>>(()=>{});
  const f=await screenFixture({
   onTurnOn:mode==='refusal'||mode==='non-ok'||mode==='network'?async()=>{
    await gate;
    if(mode==='refusal')return reply({profileId:'profile:claude',activation:{status:'not-turned-on',reason:'login-not-detected',routeSet:false},...f.baseConnections,representative:null,firstCandidate:null});
    if(mode==='non-ok')return reply({error:'Connection activation could not be recorded; refresh and try again'},409);
    throw new Error('network lost');
   }:()=>never,
  });
  await settle();
  assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),mode+' starts with 연결 중');
  if(mode==='bound'){
   const timers:Array<{ms:number;fn:()=>void}>=[];
   (f.app.context as any).setTimeout=(fn:()=>void,ms:number)=>{timers.push({ms,fn});return timers.length;};
   await runInContext('requireReconnect()',f.app.context);
   await runInContext('pollEvents()',f.app.context);
   await settle();
   timers.findLast(entry=>entry.ms===15000&&entry.fn.toString().includes('endConnectionTurnOn'))?.fn();
  }else if(mode==='abort'){
   runInContext('requireReconnect()',f.app.context);
  }else{
   release();
  }
  await settle();
  assert.equal(f.app.node('chat-model').textContent,copy('ui.reason-route-missing'),mode+' shows 연결 없음 in the model text place');
  if(mode==='abort')assert.equal(f.app.node('chat-connection').textContent,copy('header.status.01'),mode+' shows the reconnect gate text');
  else assert.equal(f.app.node('chat-connection').hidden,true,mode+' ends 연결 중');
 }
});

test('screen: nothing new before the first list outcome or after a failed list; a resolved empty list shows 연결 없음',async()=>{
 for(const mode of ['hang','fail','throw','resolve'] as const){
  const f=await preListFixture(mode);
  await settle();
  assert.equal(f.app.node('chat-model').textContent,'',mode+' shows no model text before the list outcome');
  assert.equal(f.app.node('chat-model').hidden,true);
  assert.equal(f.app.node('chat-connection').textContent,copy('header.status.01'),mode+' keeps the existing gate text, not 연결 중');
  if(mode==='hang'){
   runInContext("__timers.findLast(t=>t.ms===15000&&t.fn.toString().includes('endInitialConnectionWait')).fn()",f.app.context);
  }else{
   f.release();
  }
  await settle();
  if(mode==='resolve')assert.equal(f.app.node('chat-model').textContent,copy('ui.reason-route-missing'),mode+' shows 연결 없음 once the empty list is installed');
  else assert.equal(f.app.node('chat-model').textContent,'',mode+' still shows no model text after the failed or bound list');
 }
});

test('screen: a conversation that disconnects while turning on keeps 연결 끊김 over 연결 중',async()=>{
 const never=new Promise<ReturnType<typeof reply>>(()=>{});
 const f=await screenFixture({onTurnOn:()=>never});
 await settle();
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'));
 runInContext('chatConnection(true)',f.app.context);
 assert.equal(f.app.node('chat-connection').textContent,copy('header.status.01'),'disconnection wins over 연결 중');
 assert.equal(f.app.node('chat-connection').hidden,false);
 assert.equal(f.app.node('chat-model').textContent,'','no model text while the turn-on is still in flight');
 assert.equal(runInContext('reconnectRequired',f.app.context),false,'the reconnect gate is down here');
 runInContext('controls()',f.app.context);
 assert.equal(f.app.node('chat-connection').textContent,copy('header.status.01'),'a controls() redraw keeps the lost conversation status once the gate is down');
 runInContext('chatConnection(false)',f.app.context);
 assert.equal(f.app.node('chat-connection').textContent,copy('legacy.connecting'),'a successful conversation read hands the slot back to the turn-on');
});

test('screen: the reconnect gate raised with no turn-on keeps 연결 끊김 as today',async()=>{
 const f=await screenFixture({candidate:null});
 await settle();
 assert.equal(f.app.node('chat-model').textContent,copy('ui.reason-route-missing'),'the known list with no route shows 연결 없음');
 runInContext('requireReconnect()',f.app.context);
 assert.equal(f.app.node('chat-connection').textContent,copy('header.status.01'));
 assert.equal(f.app.node('chat-connection').hidden,false);
});

test('screen: no detected login keeps the approved login choice screen unchanged',async()=>{
 const base=await loadFixture('B1-signin');
 const app=harness(async(path,reqOptions)=>{
  if(reqOptions?.method==='POST')return reply({});
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
  return reply(route?.body??{},route?.status??503);
 });
 await settle();
 assert.equal(app.node('first-signin').hidden,false,'the login choice screen shows');
 assert.equal(app.node('app').hidden,true,'the composer surface stays hidden behind it');
 const row=['chat-attach','chat-permission','chat-model','chat-send'].map(id=>app.node(id).textContent).join('');
 assert.ok(!row.includes('Claude')&&!row.includes('claude-code-cli'),'no account or provider name in the composer row');
});

test('screen: requireReconnect aborts turn-on and clears lock immediately without waiting for async settle',async()=>{
 const never=new Promise<ReturnType<typeof reply>>(()=>{});
 const f=await screenFixture({onTurnOn:()=>never});
 await settle();
 assert.equal(runInContext('connectionTurnOnInFlight',f.app.context),true);
 assert.equal(f.app.node('chat-send').disabled,true);

 runInContext('requireReconnect()',f.app.context);
 // Inspect lock state synchronously right after requireReconnect() aborts the request.
 assert.equal(runInContext('connectionTurnOnInFlight',f.app.context),false);
 assert.equal(f.app.node('chat-send').disabled,false);
});

test('screen: turn-on does not swallow program errors and unlocks send button if install after reply throws',async()=>{
 const f=await screenFixture({candidate:null});
 await settle();
 runInContext("installConnections=()=>{throw new TypeError('broken install');};$('chat-send').disabled=true;",f.app.context);
 assert.equal(f.app.node('chat-send').disabled,true);
 await assert.rejects(
  runInContext("turnOnFirstCandidate({connectionId:'host:claude:fixture',model:'claude-sonnet-5-5'},{configHash:'hash-claude'})",f.app.context),
  {name:'TypeError',message:'broken install'},
 );
 assert.equal(runInContext('connectionTurnOnInFlight',f.app.context),false);
 assert.equal(f.app.node('chat-send').disabled,false,'send button is not left visually disabled when installConnections throws');

 // A ReferenceError thrown during the turn-on request propagates rather than being swallowed.
 const g=await screenFixture({
  candidate:null,
  onTurnOn:()=>{throw new ReferenceError('bug inside handler');},
 });
 await settle();
 await assert.rejects(
  runInContext("turnOnFirstCandidate({connectionId:'host:claude:fixture',model:'claude-sonnet-5-5'},{configHash:'hash-claude'})",g.app.context),
  {name:'ReferenceError',message:'bug inside handler'},
 );
 assert.equal(g.app.node('chat-send').disabled,false);
});

test('integration: screen sends its exact turn-on request body to createWorkbench with owner proof and activates the route',async t=>{
 const s=await serverFixture(t,{authenticated:true});
 const base=await loadFixture('B1');
 const postBodies:Array<{path:string;body:unknown}>=[];
 const app=harness(async(path,reqOptions)=>{
  if(path==='/connections'&&(!reqOptions?.method||reqOptions.method==='GET')){
   const res=await s.request('/connections');
   return reply(res.body,res.status);
  }
  if(reqOptions?.method==='POST'&&path.startsWith('/connections/')&&path.endsWith('/profiles')){
   const payload=JSON.parse(reqOptions.body);
   postBodies.push({path,body:payload});
   const res=await s.request(path,payload);
   return reply(res.body,res.status);
  }
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
  return reply(route?.body??{},route?.status??503);
 });
 await waitFor(()=>postBodies.length===1&&!runInContext('connectionTurnOnInFlight',app.context)&&s.connections.list().representative!==null&&!app.node('chat-send').disabled,'screen initial turn-on complete');
 const claude=s.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 assert.equal(postBodies.length,1);
 assert.deepEqual(postBodies[0],{
  path:'/connections/'+encodeURIComponent(claude.id)+'/profiles',
  body:{
   model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],
   label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],
   expectedConfigHash:claude.configHash,
  automaticPick:true,
  },
 });
 assert.equal(s.connections.connectionOn(claude.id),true);
 const listed=s.connections.list();
 const claudeProfile=listed.runtime.connections.find(p=>p.id===listed.representative?.route.profileId);
 assert.equal(claudeProfile?.model,BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']);
// The screen turned the connection on by itself: the stored route says first-route, the list reports it as derived, and the journal replays.
assert.equal(((await s.store.load(CONNECTION_ACTIVATION_ID))!.value as unknown as ConnectionActivationState).routeChoice?.source,'first-route');
assert.equal(listed.representative?.derived,true);
validateMissionJournalLineage(s.store.inspect());
 assert.equal(runInContext('connectionCatalog.representative?.route.profileId',app.context),listed.representative?.route.profileId);
 assert.equal(runInContext('connectionCatalog.firstCandidate',app.context),null);
 assert.equal(app.node('chat-send').disabled,false);
});

test('restart: route established via screen turn-on command survives host restart without re-turning on',async t=>{
 const s=await serverFixture(t,{authenticated:true});
 const base=await loadFixture('B1');
 const claude=s.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const wire=(req:typeof s.request,posts:string[])=>harness(async(path,reqOptions)=>{
  if(path==='/connections'&&(!reqOptions?.method||reqOptions.method==='GET')){
   const res=await req('/connections');
   return reply(res.body,res.status);
  }
  if(reqOptions?.method==='POST'&&path.startsWith('/connections/')&&path.endsWith('/profiles')){
   posts.push(path);
   const res=await req(path,JSON.parse(reqOptions.body));
   return reply(res.body,res.status);
  }
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
  return reply(route?.body??{},route?.status??503);
 });

 // First boot opens and establishes route via POST /connections/:id/profiles.
 const firstPosts:string[]=[];
 const app1=wire(s.request,firstPosts);
 await waitFor(()=>firstPosts.length===1&&!runInContext('connectionTurnOnInFlight',app1.context)&&s.connections.list().representative!==null,'first boot turn-on complete');
 assert.equal(firstPosts.length,1);
 const establishedRoute=s.connections.list().representative?.route;
 assert.ok(establishedRoute);

 // Restart against the persisted store and settings.
 const restarted=await s.restart();
 assert.equal(restarted.connections.connectionOn(claude.id),true);
 assert.deepEqual(restarted.connections.list().representative?.route,establishedRoute);
 const restartedList=await restarted.request('/connections');
 assert.equal(restartedList.status,200);
 assert.deepEqual(restartedList.body.representative?.route,establishedRoute);
 assert.equal(restartedList.body.representative?.derived,true,'the route recorded at open is still reported as the automatic pick after a restart');
 assert.equal(restartedList.body.firstCandidate,null);

 // Re-opening the screen after restart does not re-post turn-on and can send immediately.
 const secondPosts:string[]=[];
 const app2=wire(restarted.request,secondPosts);
 await waitFor(()=>Boolean(runInContext('connectionCatalog',app2.context))&&!app2.node('chat-send').disabled,'restarted screen catalog installed');
 assert.equal(secondPosts.length,0);
 assert.equal(app2.node('chat-send').disabled,false);

 // Sending via AssistantService uses the restarted route without re-activating.
 const assistant=new AssistantService(s.store,new ProductService(s.store,undefined,restarted.connections),restarted.connections);
 const answered=await assistant.send({commandId:'q-after-restart',segment:1,expectedRevision:0,text:'2+2?'},undefined,'owner-typed');
 assert.equal(answered.turn?.status,'answered');
 assert.equal(answered.turn?.reply,'4');
 assert.deepEqual(s.cliCalls,['claude']);
});
