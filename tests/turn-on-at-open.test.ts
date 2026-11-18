import test from 'node:test';
import assert from 'node:assert/strict';
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
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';

const claudeReply=JSON.stringify({reply:'4',work:null});
const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:claudeReply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{[BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']]:{}}});

async function serverFixture(t:test.TestContext,options:{detect?:(providerType:string)=>'detected'|'absent'|'unknown';reverseManifest?:boolean}={}){
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
 const host=(customStore:InMemoryStore<Mission>=store)=>createHostConnections(customStore,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:(providerType,signal)=>logins.recheck(providerType,signal).then(status=>status.status)});
 const connections=host();
 await connections.restoreSettings();
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 return {root,store,secrets,settings,connections,logins,origin,cliCalls,loginStatusCalls,loginStartCalls,setDetect:(next:typeof detect)=>{detect=next;}};
}

test('GET /connections uses FIRST_MESSAGE_LOGIN_ORDER as the single source for both logins order and firstCandidate',async t=>{
 const f=await serverFixture(t,{reverseManifest:true});
 const response=await fetch(f.origin+'/connections');
 assert.equal(response.status,200);
 const body=await response.json() as any;
 assert.deepEqual(body.logins.map((l:any)=>l.providerType),[...FIRST_MESSAGE_LOGIN_ORDER],'LoginConnections.list() follows FIRST_MESSAGE_LOGIN_ORDER');
 const claude=body.connections.find((c:any)=>c.providerType==='claude-code-cli')!;
 assert.deepEqual(body.firstCandidate,{connectionId:claude.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']},'firstCandidate picks the first provider in FIRST_MESSAGE_LOGIN_ORDER even when the manifest lists Codex first');
});

test('GET /connections firstCandidate covers every state without extra probes or CLI starts',async t=>{
 // Both detected -> Claude Code
 const f=await serverFixture(t);
 const claude=f.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const codex=f.connections.list().connections.find(c=>c.providerType==='codex-cli')!;
 const both=(await (await fetch(f.origin+'/connections')).json()) as any;
 assert.deepEqual(both.firstCandidate,{connectionId:claude.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli']});
 assert.equal(f.loginStatusCalls.filter(p=>p==='claude-code-cli').length,1,'at most one status probe per provider per GET /connections');
 assert.equal(f.loginStatusCalls.filter(p=>p==='codex-cli').length,1);
 assert.deepEqual(f.loginStartCalls,[],'no CLI login command started');
 assert.deepEqual(f.cliCalls,[],'no model CLI started');

 // Only Codex detected -> Codex
 f.setDetect(provider=>provider==='codex-cli'?'detected':'absent');
 const onlyCodex=(await (await fetch(f.origin+'/connections')).json()) as any;
 assert.deepEqual(onlyCodex.firstCandidate,{connectionId:codex.id,model:BUILTIN_CLI_RECOMMENDED_MODELS['codex-cli']});

 // Nothing detected (absent and unknown) -> null
 f.setDetect(provider=>provider==='claude-code-cli'?'absent':'unknown');
 const none=(await (await fetch(f.origin+'/connections')).json()) as any;
 assert.equal(none.firstCandidate,null);

 // A connection on without a route (API key added) -> null even when both logins are detected
 f.setDetect(()=>'detected');
 const openai=f.connections.list().connections.find(c=>c.providerType==='openai')!;
 assert.equal((await new ConnectionLifecycle(f.store,f.connections).replaceKey({commandId:'key-first',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-value'})).status,'completed');
 assert.equal(f.connections.list().representative,null);
 const apiOn=(await (await fetch(f.origin+'/connections')).json()) as any;
 assert.equal(apiOn.firstCandidate,null);

 // A route present -> null
 const g=await serverFixture(t);
 const gClaude=g.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 assert.equal((await g.connections.turnOnConnection('login:route',gClaude.id,'login-started')).status,'on');
 const routePresent=(await (await fetch(g.origin+'/connections')).json()) as any;
 assert.equal(routePresent.firstCandidate,null);

 // Route closed by the owner -> null
 await g.connections.save(()=>g.connections.removeRepresentative({expectedConfigHash:g.connections.list().configHash}));
 const routeClosed=(await (await fetch(g.origin+'/connections')).json()) as any;
 assert.equal(routeClosed.firstCandidate,null);

 // POST /connections/<id>/profiles also carries firstCandidate: null and probes nothing
 const beforeProbes=g.loginStatusCalls.length;
 const postRes=await fetch(g.origin+'/connections/'+encodeURIComponent(gClaude.id)+'/profiles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],label:BUILTIN_CLI_RECOMMENDED_MODELS['claude-code-cli'],expectedConfigHash:gClaude.configHash})});
 assert.equal(postRes.status,200);
 const postBody=(await postRes.json()) as any;
 assert.equal(postBody.firstCandidate,null);
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

 // Seed a historical first-message turn-on command and a legacy not-sent turn in a fresh store.
 const oldStore=new InMemoryStore<Mission>();
 const msgId=ownerMessageId('legacy-1'),turnId=assistantTurnId(msgId);
 const conversation=new AssistantConversation(oldStore,[{id:'owner',roles:['owner']},{id:'assistant-representative',roles:['assistant']}],()=>1000);
 await conversation.dispatch({segment:1,commandId:'legacy-1',expectedRevision:0,actorId:'owner',command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId:msgId,origin:'owner-typed',text:'Earlier message',turn:{status:'not_started',id:turnId,diagnostics:[{code:'assistant_route_missing',message:'No Representative route is set.'}]}}});
 await conversation.dispatch({segment:1,commandId:'legacy-not-sent',expectedRevision:1,actorId:'owner',command:{type:'append-assistant-message',recordMessageTime:true,messageId:ownerMessageId('legacy-not-sent'),origin:'owner-typed',text:'Not sent then',turn:{status:'pending',id:assistantTurnId(ownerMessageId('legacy-not-sent')),route:{profileId:route.profileId,configHash:route.configHash,provider:'claude-code-cli',model:route.model,mode:'live',outputTokenCap:route.outputTokenCap},ownership:{hostSessionId:'old-host',dispatchId:'old-dispatch',startedAt:1,deadlineAt:60000},requestHash:'a'.repeat(64),contextMessageIds:[]}}});
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

async function screenFixture(options:{candidate?:{connectionId:string;model:string}|null;representative?:boolean;onTurnOn?:(path:string,body:any,baseConnections:any)=>Promise<ReturnType<typeof reply>>|ReturnType<typeof reply>}={}){
 const base=await loadFixture('B1');
 const claudeId='host:claude:fixture';
 const baseConnections={
  ...(base.routes['/connections']!.body as any),
  connections:[{id:claudeId,label:'Claude Code',providerType:'claude-code-cli',protocol:'claude-code-cli/v1',baseUrl:'cli://claude-code/',mode:'https',auth:'cli-login',configHash:'hash-claude',on:false,credentialConfigured:true,connectionStatus:'cli-login-unverified',discovery:'not-requested',models:[],liveVerified:false}],
  runtime:{connections:[{id:'profile:claude',label:'claude-sonnet-5-5',providerKind:'claude-code-cli',model:'claude-sonnet-5-5',diagnostics:[]}],defaultRoutes:[],authorizations:[]},
  representative:options.representative?{route:{profileId:'profile:claude',configHash:'c'.repeat(64),outputTokenCap:4096},intakeMissionId:'assistant-intake',status:'active',diagnostics:[]}:null,
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
  const route=base.routes[path]??(path.startsWith('/events?')?base.routes['/events']:undefined);
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
 assert.deepEqual(withEcho.turnOnPosts[0],{path:'/connections/host%3Aclaude%3Afixture/profiles',body:{model:'claude-sonnet-5-5',label:'claude-sonnet-5-5',expectedConfigHash:'hash-claude'}});

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

test('screen: not-turned-on with routeSet true is treated as a route existing, while already-on with routeSet false is not',async()=>{
 // Case 1: not-turned-on + routeSet: true (not-a-subscription-connection branch)
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
 assert.ok(runInContext('connectionCatalog.representative',routeExists.app.context),'representative route is treated as present');

 // Case 2: already-on + routeSet: false without representative -> no route exists
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
 assert.equal(runInContext('connectionCatalog.representative',noRoute.app.context),null,'already-on with routeSet:false does not fabricate a route');
});
