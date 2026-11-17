import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Agent,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostStartup,createHostConnections} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {CONNECTION_ACTIVATION_ID,firstRouteDecision} from '../src/connection-activation.ts';
import type {ConnectionActivationState,FirstRouteFacts} from '../src/connection-activation.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {PermissionsService} from '../src/permissions.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {spawnCliRunner,cliProfileFactory} from '../src/cli-agent-providers.ts';
import {CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV,cliLauncherEnvironmentNames} from '../src/cli-agent-providers.ts';
import {cliStamp} from '../src/cli-launcher.ts';
import {createWorkbench} from '../src/server.ts';
import {authProof} from '../src/daemon-auth.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import type {Mission} from '../src/domain.ts';
import type {CliRunner} from '../src/cli-agent-providers.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';

const turn=(reply:string)=>JSON.stringify({reply,work:null});
const claudeReply=turn('4');
const activations=async(store:Store<Mission>)=>((await store.load(CONNECTION_ACTIVATION_ID))?.value as unknown as ConnectionActivationState|undefined)?.activations??[];
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'c1-fix2-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots(),settings=new InMemoryHostSettings();
 const cliCalls:string[]=[],slotWrites:{owner:string;count:number}[]=[];
 let keyWrites=0;const rawSet=secrets.set.bind(secrets);secrets.set=async(slot,value)=>{keyWrites++;await rawSet(slot,value);};
 const cliRunner:CliRunner=async call=>{cliCalls.push(call.command);return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:claudeReply,num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:972,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};};
 const transport=async(url:string|URL|Request)=>new Response(JSON.stringify({data:String(url).endsWith('/models')?[{id:'fixture-a'}]:[]}),{headers:{'content-type':'application/json'}});
 const startup=await loadHostStartup([]);
 let loginGate=deferred(),loginHeld=false;
 const host=()=>createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),startup,{secrets,readEnvironment:()=>undefined,transport,settings,cliRunner,loginStatus:async pt=>{if(loginHeld)await loginGate.promise;return pt==='claude-code-cli'?'detected' as const:'absent' as const;}});
 return {root,store,secrets,settings,host,cliCalls,keyWrites:()=>keyWrites,cliRunner,transport,holdLogin:()=>{loginHeld=true;},releaseLogin:()=>{loginHeld=false;loginGate.resolve();loginGate=deferred();}};
}

test('the default runner refuses slash-less commands and login paths execute only a verified path',async()=>{
 const refused=await spawnCliRunner({command:'claude',args:['auth','status'],stdin:'',cwd:'/',env:{},timeoutMs:1000,maxOutputBytes:1024,signal:new AbortController().signal});
 assert.equal(refused.spawned,false);
 const commands:string[]=[];
 const runner=async(call:any)=>{commands.push(call.command);const codex=call.command.includes('codex');return {spawned:true,exitCode:codex?1:0,stdout:codex?'':JSON.stringify({loggedIn:true,authMethod:'claude.ai'}),stderr:codex?'Not logged in':'',timedOut:false,aborted:false,overflow:false};};
 // Before: a configured selection resolved through verifySignedCli; still proves only the resolved path is executed.
 const verified=new LoginConnections(runner,{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:cliStamp(process.execPath),searchPath:'/discovered/path',version:'2.1.0 (Claude Code)'}:null});
 assert.deepEqual((await verified.list()).map(s=>s.status),['detected','absent']);
 assert.deepEqual(commands,[process.execPath]);
 commands.length=0;
 const tampered=new LoginConnections(runner,{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:cliStamp(process.execPath)+'0',searchPath:'/discovered/path',version:'2.1.0 (Claude Code)'}:null});
 assert.deepEqual((await tampered.list()).map(s=>s.status),['unknown','absent']);
 assert.deepEqual(commands,[]);
});

test('firstRouteDecision covers every rule in one table',()=>{
 const base:FirstRouteFacts={messageAccepted:true,origin:'owner-typed',onConnections:[],detectedLogins:['c1'],routePresent:false,routeClosedByOwner:false,loginWaitingForRoute:null};
 const row=(over:Partial<FirstRouteFacts>)=>firstRouteDecision({...base,...over});
 assert.deepEqual(row({}),{activate:true,connectionId:'c1'});
 assert.deepEqual(row({detectedLogins:[]}),{activate:false});
 // New commands carry each login's provider type: the decision itself orders by FIRST_MESSAGE_LOGIN_ORDER and excludes a provider type outside it.
 assert.deepEqual(row({detectedLogins:['c1','c2'],detectedProviders:['claude-code-cli','codex-cli']}),{activate:true,connectionId:'c1'});
 assert.deepEqual(row({detectedLogins:['c2','c1'],detectedProviders:['codex-cli','claude-code-cli']}),{activate:true,connectionId:'c1'},'the fixed order wins over the collection order');
 assert.deepEqual(row({detectedLogins:['c1','c2'],detectedProviders:['unknown-cli','codex-cli']}),{activate:true,connectionId:'c2'},'a provider type outside the order is never a candidate');
 assert.deepEqual(row({detectedLogins:['c1'],detectedProviders:['unknown-cli']}),{activate:false},'an unknown provider is not turned on unasked');
 // Commands stored before the provider list exist only under main's rule: exactly one bare id. Several logins without provider types activate nothing.
 assert.deepEqual(row({detectedLogins:['c1']}),{activate:true,connectionId:'c1'});
 assert.deepEqual(row({detectedLogins:['c1','c2']}),{activate:false});
 assert.deepEqual(row({detectedLogins:['c2','c1']}),{activate:false});
 assert.deepEqual(row({onConnections:['c9']}),{activate:false});
 assert.deepEqual(row({onConnections:['c9'],loginWaitingForRoute:'c9'}),{activate:true,connectionId:'c9'});
 assert.deepEqual(row({onConnections:['c9','c8'],loginWaitingForRoute:'c9'}),{activate:false});
 assert.deepEqual(row({routePresent:true}),{activate:false});
 assert.deepEqual(row({routeClosedByOwner:true}),{activate:false});
 for(const origin of ['scheduled','member','imported','replayed','unattributed'] as const)assert.deepEqual(row({origin}),{activate:false});
 assert.deepEqual(row({messageAccepted:false}),{activate:false});
});

test('a key added while login detection is awaited loses nothing to the first message',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 f.holdLogin();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const pending=assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 await new Promise(r=>setTimeout(r,20));
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 await new ConnectionLifecycle(f.store,connections).replaceKey({commandId:'key-race',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key'});
 f.releaseLogin();
 const result=await pending;
 assert.equal(result.turn?.status,'failed');
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['key-added']);
 assert.deepEqual(f.cliCalls,[]);
 assert.equal(connections.list().representative,null);
});

test('a command id already used by another aggregate never activates',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 await new PermissionsService(f.store).act({commandId:'q-1',action:'grant-secret',secret:{owner:'fixture',slot:'api-key'},sourceHash:'a'.repeat(64),consumer:{kind:'connection',id:'fixture-connection'},purpose:'Fixture connection grant'});
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const result=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(result.message.status,'conflict');
 assert.deepEqual(await activations(f.store),[]);
 assert.deepEqual(f.cliCalls,[]);
});

test('a concurrent message on the same revision activates at most once',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const winner=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(winner.turn?.status,'answered');
 const loser=await assistant.send({commandId:'q-2',segment:1,expectedRevision:0,text:'Again? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(loser.message.status,'conflict');
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['first-message']);
 assert.deepEqual(f.cliCalls,['claude']);
});

test('a removed representative route is never recreated and a started login gets its route',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const first=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(first.turn?.status,'answered');
 assert.equal(connections.list().representative?.status,'active');
 await connections.save(()=>connections.removeRepresentative({expectedConfigHash:connections.list().configHash}));
 assert.equal(connections.list().representative,null);
 const view=await assistant.read();
 const second=await assistant.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'Again? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(second.turn?.status,'not_started');
 assert.equal(connections.list().representative,null);
 assert.deepEqual((await activations(f.store)).map(a=>a.way),['first-message']);
 // A started login deriving its first route is covered in its own test below.
});

test('a login the owner started gets its first route and the next message answers through it',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const loginClaude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 await connections.turnOnConnection('login:1',loginClaude.id,'login-started');
 assert.equal(connections.list().representative?.status,'active');
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,connections),connections);
 const reply=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(reply.turn?.status,'answered');
 assert.equal(reply.turn.reply,'4');
});

test('the sign-in screen shows while no connection is on and no route exists',async t=>{
 const screen=await loadFixture('B1-signin');
 const entry=(id:string,label:string,providerType:string,baseUrl:string,protocol:string,auth:string,status:string,on:boolean)=>({id,label,providerType,baseUrl,protocol,mode:'https',auth,configHash:'fixture-'+id,on,credentialConfigured:providerType.endsWith('-cli'),connectionStatus:status,discovery:'not-requested',models:[],liveVerified:false});
 const connections=(on:boolean)=>[entry('host:claude:x','Claude Code','claude-code-cli','cli://claude-code/','claude-code-cli/v1','cli-login','cli-login-unverified',on),entry('host:codex:x','Codex','codex-cli','cli://codex/','codex-cli/v1','cli-login','cli-login-unverified',on),entry('host:anthropic:x','Anthropic API','anthropic','https://api.anthropic.com/v1/','anthropic-messages/v1','anthropic-api-key','credential-required',on),entry('host:openai:x','OpenAI API','openai','https://api.openai.com/v1/','openai-chat-completions/v1','bearer','credential-required',on),entry('host:zai:x','Z.ai GLM Coding Plan','zai','https://api.z.ai/api/coding/paas/v4/','openai-chat-completions/v1','bearer','credential-required',on)];
 const catalog=(on:boolean)=>({connections:connections(on),logins:[{providerType:'claude-code-cli',kind:'cli-login',status:'absent'},{providerType:'codex-cli',kind:'cli-login',status:'absent'}],representative:null});
 const base:any=structuredClone(screen.routes['/connections']!.body);void catalog;
 let on=false;
 const app=harness(async(path,options)=>{const routes:any=structuredClone(screen.routes);routes['/connections']={status:200,body:{...base,connections:connections(on),logins:base.logins.map((l:any)=>({...l,status:'absent'})),representative:on?base.representative:null}};const route=routes[path]??(path.startsWith('/events?')?routes['/events']:undefined);return reply(route?.body??{},route?.status??503);});
 await settle();await settle();
 assert.equal(app.node('first-signin').hidden,false);
 assert.equal(app.node('first-claude').hidden,false);
 on=true;
 await app.node('first-login-check').fire('click');
 await settle();
 assert.equal(app.node('first-signin').hidden,true);
});

test('way (c) requires the authenticated owner on the message route',async t=>{
 const f=await fixture(t);
 const make=async(host:Awaited<ReturnType<typeof fixture>>,daemonSecret?:string)=>{const connections=host.host();await connections.restoreSettings();const server=createWorkbench(host.store,host.root,{connections,daemonSecret,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const port=(server.address() as {port:number}).port,origin='http://127.0.0.1:'+port;return {server,connections,origin,port};};
 const unauthenticated=await make(f);
 const open=await fetch(unauthenticated.origin+'/assistant/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'})});
 assert.equal(open.status,200);
 const body=await open.json() as any;
 assert.equal(body.turn.status,'not_started');
 assert.deepEqual(await activations(f.store),[]);
 const g=await fixture(t),secret='a'.repeat(64),authenticated=await make(g,secret);
 // The daemon session is per socket, so the handshake and the message share one keep-alive connection.
 const agent=new Agent({keepAlive:true,maxSockets:1});
 const request=(pathname:string,headers:Record<string,string>,body?:string)=>new Promise<{status:number;headers:Record<string,string>;body:string}>((resolve,reject)=>{const out=httpRequest({host:'127.0.0.1',port:authenticated.port,path:pathname,method:body?'POST':'GET',agent,headers},response=>{let text='';response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode??0,headers:response.headers as Record<string,string>,body:text}));});out.on('error',reject);if(body)out.end(body);else out.end();});
 const challenge='b'.repeat(64),handshake=await request('/desktop-auth',{'x-massion-challenge':challenge});
 const nonce=handshake.headers['x-massion-nonce']!;
 const authorization='Bearer '+authProof(secret,'client',authenticated.origin,challenge,nonce);
 const sent=await request('/assistant/messages',{'content-type':'application/json',Authorization:authorization},JSON.stringify({commandId:'q-2',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'}));
 assert.equal(sent.status,200);
 const answered=JSON.parse(sent.body) as any;
 assert.equal(answered.turn.status,'answered');
 assert.deepEqual((await activations(g.store)).map(a=>a.way),['first-message']);
});

test('a revoked secret grant is re-granted by the next key command',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 const service=new ConnectionLifecycle(f.store,connections);
 assert.equal((await service.replaceKey({commandId:'key-one',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-one'})).status,'completed');
 const grant=(await new PermissionsService(f.store).read()).secrets!.find(g=>g.secret.owner==='openai')!;
 await new PermissionsService(f.store).act({commandId:'revoke-one',action:'revoke-secret',grantId:grant.id});
 const again=await service.replaceKey({commandId:'key-two',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-two'});
 assert.equal(again.status,'completed');
 assert.equal(connections.connectionOn(openai.id),true);
 assert.equal((await f.secrets.read({owner:'openai',slot:'api-key'})),'fixture-key-two');
});

test('the launcher allow-list pins the adapter environment names',async()=>{
 assert.equal(CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV,'CLAUDE_CODE_MAX_OUTPUT_TOKENS');
 assert.equal(cliLauncherEnvironmentNames('claude-code-cli/v1').includes(CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),true);
 assert.equal(cliLauncherEnvironmentNames('codex-cli/v1').includes(CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),false);
 const captured:string[]=[];
 const adapter=cliProfileFactory('claude-code-cli/v1',{mode:'local-http-mock',runner:async call=>{captured.push(...Object.keys(call.env));return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',num_turns:1,usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:1},modelUsage:{m:{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};}}).create({id:'p',label:'m',backend:'model-provider',providerKind:'claude-code-cli',protocol:'claude-code-cli/v1',model:'m',endpoint:'cli://x/run',revision:'v1',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:1024,maxOutputTokens:8,maxResponseBytes:1024,timeoutMs:1000}});
 await adapter.invoke({invocationId:'i',workId:'w',instruction:'x',inputReferences:[],maxOutputTokens:8,signal:new AbortController().signal});
 assert.equal(captured.includes(CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),true);
 assert.deepEqual(captured.filter(name=>!cliLauncherEnvironmentNames('claude-code-cli/v1').includes(name)&&process.env[name]===undefined),[]);
});

test('portable export and restore carry an activation record',async t=>{
 const f=await fixture(t),connections=f.host();await connections.restoreSettings();
 const claude=connections.list().connections.find(c=>c.providerType==='claude-code-cli')!;
 assert.equal((await connections.turnOnConnection('login:1',claude.id,'login-started')).status,'on');
 const operations=structuredClone(f.store.inspect());
 const serialized=await exportPortableBackup({exportJournal:async()=>({schemaVersion:2,head:operations.length,operations:[...operations]})} as never,new TextArtifactStore(join(f.root,'backup-artifacts')));
 // The restore entry validation re-runs the same inventory and lineage over the activation record.
 const parsed=parsePortableBackup(serialized);
 assert.equal(parsed.journal.operations.some(operation=>operation.aggregateId===CONNECTION_ACTIVATION_ID),true);
 const restored=f.host();
 await restored.restoreSettings();
 assert.equal(restored.connectionOn(claude.id),true);
});

test('a replayed key command retries the activation without a second key write',async t=>{
 const f=await fixture(t);
 let blockActivation=true;
 const guarded=new Proxy(f.store,{get(target,key){
  if(key==='commit')return async(input:any)=>{if(blockActivation&&input.id===CONNECTION_ACTIVATION_ID)throw new Error('fixture activation outage');return target.commit(input);};
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const connections=createHostConnections(guarded as never,new TextArtifactStore(join(f.root,'artifacts')),await loadHostStartup([]),{secrets:f.secrets,readEnvironment:()=>undefined,transport:f.transport,settings:new InMemoryHostSettings(),cliRunner:f.cliRunner,loginStatus:async()=>'absent'});
 const openai=connections.list().connections.find(c=>c.id.includes(':openai:'))!;
 const service=new ConnectionLifecycle(guarded as never,connections);
 const first=await service.replaceKey({commandId:'key-once',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-once'});
 assert.equal(first.status,'unknown');
 assert.equal(f.keyWrites(),1);
 assert.equal(connections.connectionOn(openai.id),false);
 blockActivation=false;
 const retry=await service.replaceKey({commandId:'key-once',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key-once'});
 assert.equal(retry.status,'unknown');
 assert.equal(f.keyWrites(),1);
 assert.equal(connections.connectionOn(openai.id),true);
});

