import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,realpathSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {LoginConnections} from '../src/connection-logins.ts';
import {spawnCliRunner} from '../src/cli-process.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';
import {createWorkbench} from '../src/server.ts';
import {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {createHostConnections,loadHostStartup} from '../src/host-connections.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {CONNECTION_ACTIVATION_ID} from '../src/connection-activation.ts';
import {CliLauncher,cliStamp,sameCliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import {CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV,cliArgPatterns,cliEnvironmentAllowed,cliLauncherEnvironmentNames,cliProfileFactory} from '../src/cli-agent-providers.ts';

for(const mode of ['login drain','status drain','status abort before drain'] as const){
 test(`${mode} waits for real runner cleanup after SIGTERM is ignored`,{skip:process.platform==='win32'},async t=>{
  const root=await mkdtemp(join(tempRoot(),'login-cleanup-')),ready=join(root,'ready');
  const script='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)';
  let cleanup:Promise<CliResult>|undefined,cleaned=false,calls=0;
  const logins=new LoginConnections(call=>{
   calls++;
   // start() reads the login state before launching; that read resolves at once so the drain proof still targets the real LOGIN process.
   if(mode==='login drain'&&call.args.includes('status'))return Promise.resolve({spawned:true,exitCode:1,stdout:'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false});
   // Use the real process runner with a local helper and no inherited credentials.
   cleanup=spawnCliRunner({...call,command:process.execPath,args:['-e',script,ready],env:{}});
   void cleanup.then(()=>{cleaned=true;});
   return cleanup;
  });
  t.after(async()=>{logins.beginDrain();await cleanup;await rm(root,{recursive:true,force:true});});
  const controller=new AbortController();
  const response=mode==='login drain'?undefined:logins.recheck('codex-cli',controller.signal);
  if(!response)assert.equal((await logins.start({providerType:'codex-cli',commandId:'cleanup:login'})).status,'started');
  let pid:number|undefined;const deadline=Date.now()+3000;
  while(pid===undefined){
   try{const value=Number(await readFile(ready,'utf8'));if(Number.isSafeInteger(value)&&value>0)pid=value;}
   catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   assert.ok(Date.now()<deadline,'helper installed its SIGTERM handler');
   if(pid===undefined)await delay(10);
  }
  assert.equal(cleaned,false);
  if(mode==='status abort before drain'){
   controller.abort();
   assert.equal((await response!).status,'unknown');
   assert.equal(cleaned,false,'the caller responds before process cleanup');
  }
  const draining=logins.drain();
  if(mode==='status drain'){
   assert.equal((await response!).status,'unknown');
   assert.equal(cleaned,false,'the caller responds before process cleanup');
  }
  await draining;
  assert.equal(cleaned,true,'drain must await underlying process cleanup, not only the aborted tool wrapper');
  assert.throws(()=>process.kill(pid!,0),{code:'ESRCH'});
  assert.equal(calls,mode==='login drain'?2:1,'cleanup never retries a login or status command');
 });
}

test('login drain kills a stdio-detached descendant even when the direct child exits on SIGTERM',{skip:process.platform==='win32'},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-descendant-')),ready=join(root,'ready');
 const descendant='process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(process.argv[1],JSON.stringify({direct:process.ppid,descendant:process.pid}));setInterval(()=>{},1000)';
 const script='process.on("SIGTERM",()=>process.exit(0));require("node:child_process").spawn(process.execPath,["-e",'+JSON.stringify(descendant)+',process.argv[1]],{stdio:"ignore"});setInterval(()=>{},1000)';
 let cleanup:Promise<CliResult>|undefined,pids:{direct:number;descendant:number}|undefined;
 const logins=new LoginConnections(call=>{
  // start() reads the login state before launching; that read resolves at once so the descendant proof still targets the real LOGIN process.
  if(call.args.includes('status'))return Promise.resolve({spawned:true,exitCode:1,stdout:'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false});
  cleanup=spawnCliRunner({...call,command:process.execPath,args:['-e',script,ready],env:{}});
  return cleanup;
 });
 const running=(pid:number)=>{
  try{const status=execFileSync('/bin/ps',['-o','stat=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return status!==''&&!status.startsWith('Z');}
  catch{return false;}
 };
 t.after(async()=>{
  logins.beginDrain();
  if(pids){try{process.kill(-pids.direct,'SIGKILL');}catch{}}
  await cleanup;await rm(root,{recursive:true,force:true});
 });
 await logins.start({providerType:'codex-cli',commandId:'cleanup:descendant'});
 const deadline=Date.now()+3000;
 while(!pids){
  try{pids=JSON.parse(await readFile(ready,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
  assert.ok(Date.now()<deadline,'descendant installed its SIGTERM handler');
  if(!pids)await delay(10);
 }
 assert.ok(Number.isSafeInteger(pids.direct)&&pids.direct>0&&Number.isSafeInteger(pids.descendant)&&pids.descendant>0);
 assert.equal(running(pids.direct),true);assert.equal(running(pids.descendant),true);
 await logins.drain();
 assert.equal((await cleanup!).aborted,true);
 assert.equal(running(pids.direct),false,'the direct child has exited');
 assert.equal(running(pids.descendant),false,'drain cannot leave a live descendant awaiting a future SIGKILL timer');
});

const stateAnswer=(provider:'claude-code-cli'|'codex-cli',behavior:string):CliResult=>{
 switch(behavior){
  case 'logged-in':return provider==='claude-code-cli'?{spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};
  // The lead's real observation (codex-cli 0.167.1): exit 0, "Logged in using ChatGPT" on stderr, stdout empty; the second line pins stderr-before-stdout (src/connection-logins.ts:64).
  case 'logged-in-stderr-priority':return {spawned:true,exitCode:0,stdout:'Some other text',stderr:'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};
  case 'logged-out':return provider==='claude-code-cli'?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:1,stdout:'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};
  // Real observation (lead, 2026-11-17, Claude Code 2.1.326): with ANTHROPIC_API_KEY in the environment the same subscription login reports authMethod api_key; the product never passes that variable.
  case 'api_key':return {spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"api_key"}',stderr:'',timedOut:false,aborted:false,overflow:false};
  case 'status-failed':return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
  case 'unrecognised':return provider==='claude-code-cli'?{spawned:true,exitCode:0,stdout:'not json',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'Something else',stderr:'',timedOut:false,aborted:false,overflow:false};
  case 'timed-out':return {spawned:true,exitCode:null,stdout:'',stderr:'',timedOut:true,aborted:false,overflow:false};
  case 'aborted':return {spawned:true,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false};
  case 'overflow':return {spawned:true,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:true};
  case 'nonzero-logged-in':return {spawned:true,exitCode:1,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false};
  default:return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
 }
};

test('GET /connections reports every login state per provider with today status values',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-states-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const versions={'claude-code-cli':'2.1.0 (Claude Code)','codex-cli':'codex-cli 0.1.0'} as const;
 const servers:ReturnType<typeof createWorkbench>[]=[];t.after(()=>{for(const server of servers)server.close();});
 for(const provider of ['claude-code-cli','codex-cli'] as const)for(const [behavior,status,state,reason] of [
  ['missing','absent','cli-not-found',undefined],
  ['logged-out','absent','logged-out',undefined],
  ['logged-in','detected','logged-in',undefined],
  ...(provider==='codex-cli'?[['logged-in-stderr-priority','detected','logged-in',undefined]]:[]),
  ['status-failed','absent','unreadable','failed'],
  ['discovery-failed','absent','cli-not-found',undefined],
  ['aborted','unknown','unreadable','failed'],
  ['overflow','unknown','unreadable','failed'],
  ['unrecognised','unknown','unreadable','unrecognised-output'],
  ['timed-out','unknown','unreadable','timed-out'],
  ...(provider==='claude-code-cli'?[['api_key','absent','logged-out',undefined],['nonzero-logged-in','unknown','unreadable','unrecognised-output']]:[])
 ] as [string,string,string,string|undefined][]){
  const standIn={path:'/stand-in/'+provider+'/'+behavior,stamp:'',searchPath:'',version:versions[provider]};
  const logins=new LoginConnections(async()=>stateAnswer(provider,behavior),{discover:async p=>{if(p!==provider||behavior==='missing')return null;if(behavior==='discovery-failed')throw new Error('discovery failed');return standIn;},rediscover:async p=>{if(p!==provider||behavior==='missing')return null;if(behavior==='discovery-failed')throw new Error('discovery failed');return standIn;}});
  const server=createWorkbench(new InMemoryStore<any>(),root,{connections:new ConnectionWorkbench(new InMemoryStore<any>(),new TextArtifactStore(root),{transport:async()=>{throw new Error('no model transport permitted');}}),logins,scheduleIntervalMs:0});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const entry=((await (await fetch(origin+'/connections')).json()) as {logins:{providerType:string}[]}).logins.find(l=>l.providerType===provider);
  assert.deepEqual(entry,{providerType:provider,kind:'cli-login',status,state,...(reason?{unreadableReason:reason}:{}),...(behavior==='missing'||behavior==='discovery-failed'?{}:{version:versions[provider]})},provider+' '+behavior+' keeps status within today\'s closed set, so an older client still works');
  assert.equal(entry.state==='logged-in',entry.status==='detected',provider+' '+behavior+': state logged-in exists only where status is detected (src/connection-logins.ts #status branches)');
  assert.ok(!Object.hasOwn(entry,'executablePath'),provider+' '+behavior+' carries no path field in the entry');
 }
 // A host WITHOUT a discovery source is unknown for both providers; reading it absent must fail here.
 assert.deepEqual((await new LoginConnections().list()).map(entry=>[entry.status,entry.state]),[['unknown','unknown'],['unknown','unknown']],'a host without a discovery source reports unknown, not absent');
});

const isLoginCommand=(call:CliInvocation)=>call.args.join(' ')==='auth login'||call.args.join(' ')==='login';
const loginRoute=async(t:test.TestContext,root:string,answer:(call:CliInvocation)=>CliResult|Promise<CliResult>,discover?:(provider:string)=>Promise<unknown>,rediscover?:(provider:string)=>Promise<unknown>)=>{
 const calls:CliInvocation[]=[];const standIn=(provider:string)=>({path:'/stand-in/'+provider,stamp:'',searchPath:'',version:provider==='claude-code-cli'?'2.1.0 (Claude Code)':'codex-cli 0.1.0'});
 const resolve=discover??(async(provider:string)=>standIn(provider));
 const logins=new LoginConnections(async call=>{calls.push({...call,env:{...call.env}});return await answer(call);},{discover:resolve,rediscover:rediscover??resolve} as never);
 const store=new InMemoryStore<any>(),connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),await loadHostStartup([]),{secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,transport:async()=>{throw new Error('no HTTP provider may be called');},settings:new InMemoryHostSettings(),loginStatus:async(providerType,signal)=>(await logins.recheck(providerType,signal)).status});
 await connections.restoreSettings();
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 return {calls,origin,store,connections,logins,post:(body:unknown)=>fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
};

test('POST /connection-login on a logged-in CLI spawns no login, turns that connection on and answers already-logged-in',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-already-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const both=(call:CliInvocation):CliResult=>call.command.includes('claude')?{spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};
 const {calls,origin,post}=await loginRoute(t,root,both);
 const response=await post({providerType:'claude-code-cli',commandId:'login:already'});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'settled',outcome:'already-logged-in'});
 assert.equal(calls.length,1,'only the status read ran');
 assert.deepEqual(calls[0]!.args,['auth','status','--json'],'no login command was spawned');
 const catalog=(await (await fetch(origin+'/connections')).json()) as any;
 assert.equal(catalog.connections.find((c:any)=>c.providerType==='claude-code-cli').on,true,'the connection is turned on');
 assert.equal(catalog.connections.find((c:any)=>c.providerType==='codex-cli').on,false,'the other logged-in CLI stays off until its own request');
 assert.ok(catalog.representative,'the first route was set while no connection was on');
 assert.equal(catalog.runtime.connections.find((p:any)=>p.id===catalog.representative.route.profileId).model,'claude-sonnet-5-5','the route points at the chosen provider\'s recommended model');
});

test('POST /connection-login on a logged-out CLI spawns the login as today and still turns the connection on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-logged-out-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const loggedOut=(call:CliInvocation):CliResult=>call.command.includes('claude')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};
 const {calls,origin,post}=await loginRoute(t,root,loggedOut);
 const response=await post({providerType:'claude-code-cli',commandId:'login:out'});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'settled',outcome:'login-started'},'an older client still reads today\'s status field; the stand-in resolves at once, so the record has settled by response time');
 assert.equal(calls.filter(isLoginCommand).length,1,'exactly one interactive login command was spawned');
 assert.equal(calls.filter(call=>call.args.join(' ')==='auth status --json').length,1,'one status read preceded it');
 const catalog=(await (await fetch(origin+'/connections')).json()) as any;
 assert.equal(catalog.connections.find((c:any)=>c.providerType==='claude-code-cli').on,true,'the connection is turned on');
});

test('POST /connection-login on a CLI whose state cannot be read still starts the login and says login-started',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-unreadable-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const unreadable=(call:CliInvocation):CliResult=>call.command.includes('claude')?{spawned:true,exitCode:0,stdout:'not json',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};
 const {calls,post}=await loginRoute(t,root,unreadable);
 const response=await post({providerType:'claude-code-cli',commandId:'login:unreadable'});
 assert.equal(response.status,200);
 assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'settled',outcome:'login-started'},'the stand-in resolves at once, so the record has settled by response time');
 assert.equal(calls.filter(isLoginCommand).length,1,'the person asked for the login, so it starts');
});

test('a drain that begins during the status read refuses with draining and turns nothing on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-drain-read-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();let statusSeen=false;
 const standIn={path:'/stand-in/claude',stamp:'',searchPath:'',version:'2.1.0 (Claude Code)'};
 const logins=new LoginConnections(call=>call.args.includes('status')?new Promise(resolve=>{statusSeen=true;call.signal.addEventListener('abort',()=>resolve({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false}),{once:true});}):Promise.resolve({spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false}),{discover:async()=>standIn,rediscover:async()=>standIn});
 const connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),await loadHostStartup([]),{secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,transport:async()=>{throw new Error('no HTTP provider may be called');},settings:new InMemoryHostSettings(),loginStatus:async(providerType,signal)=>(await logins.recheck(providerType,signal)).status});
 await connections.restoreSettings();
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const pending=fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerType:'claude-code-cli',commandId:'login:drain-read'})});
 for(let guard=0;!statusSeen&&guard<2000;guard++)await delay(1);
 assert.ok(statusSeen,'the status read is in flight before the drain begins');
 logins.beginDrain();
 const response=await pending;
 assert.equal(response.status,403);
 assert.deepEqual(await response.json(),{error:'Login host is draining',outcome:'rejected',reason:'draining'});
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
});

test('an executable removed between discovery and the spawn refuses with cli-not-found and turns nothing on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-removed-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'claude');await writeFile(file,'x');chmodSync(file,0o755);
 const discovered={path:file,stamp:cliStamp(file),searchPath:'',version:'2.1.0 (Claude Code)'};
 const {origin,post,store,connections}=await loginRoute(t,root,async call=>{
  if(call.args.includes('status')){await rm(file,{force:true});return {spawned:true,exitCode:1,stdout:'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};}
  return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
 },async()=>discovered,async()=>null);
 const response=await post({providerType:'claude-code-cli',commandId:'login:removed'});
 assert.equal(response.status,403);
 assert.deepEqual(await response.json(),{error:'Subscription login executable is unavailable',outcome:'rejected',reason:'cli-not-found'});
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
});

test('a login the runner could not spawn refuses with login-not-started and turns nothing on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-not-started-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const notSpawned=(call:CliInvocation):CliResult=>call.args.includes('status')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
 const {origin,post,store,connections}=await loginRoute(t,root,notSpawned);
 const command={providerType:'claude-code-cli',commandId:'login:not-started'};
 const response=await post(command);
 assert.equal(response.status,403);
 assert.deepEqual(await response.json(),{error:'Login command could not be started',outcome:'rejected',reason:'login-not-started'});
 const again=await post(command);
 assert.equal(again.status,403,'the refused command left no unresolved record behind');
 assert.equal((await again.json()).reason,'login-not-started');
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
});

const laneSuite=async(t:test.TestContext,root:string,answer:(call:CliInvocation)=>CliResult|Promise<CliResult>)=>{
 let discoveryEntries=0;let discoveryReached!:()=>void;const firstDiscovery=new Promise<void>(resolve=>{discoveryReached=resolve;});
 let releaseDiscovery!:()=>void;const hold=new Promise<void>(resolve=>{releaseDiscovery=resolve;});
 const gatedDiscover=async(provider:string)=>{discoveryEntries++;if(discoveryEntries===1){discoveryReached();await hold;}return {path:'/stand-in/'+provider,stamp:'',searchPath:'',version:'2.1.0 (Claude Code)'};};
 const route=await loginRoute(t,root,answer,gatedDiscover,gatedDiscover);
 const flush=async()=>{for(let index=0;index<40;index++)await new Promise<void>(resolve=>setImmediate(resolve));};
 return {...route,firstDiscovery,releaseDiscovery,discoveryCount:()=>discoveryEntries,flush};
};
const noActivation=async(route:{store:InMemoryStore<any>,connections:ReturnType<typeof createHostConnections>})=>{
 const aggregate=await route.store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(route.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
};
const oneActivation=async(route:{store:InMemoryStore<any>,connections:ReturnType<typeof createHostConnections>})=>{
 const aggregate=await route.store.load(CONNECTION_ACTIVATION_ID) as {value:{activations:unknown[]}}|null;
 assert.equal(aggregate?.value.activations.length,1,'exactly one activation');
 assert.equal(route.connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,true,'the connection is on');
};
const loggedOutStatus=(call:CliInvocation):CliResult=>call.args.includes('status')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};

test('two requests with different command ids for one provider: exactly one login starts',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-different-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let logins=0;
 let finishLogin!:()=>void;t.after(()=>finishLogin());
 // The login child acknowledges its spawn and then stays unfinished, like a real interactive login.
 const suite=await laneSuite(t,root,call=>{if(call.args.includes('status'))return {spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false};logins++;call.onSpawned?.();return new Promise<CliResult>(resolve=>{finishLogin=()=>resolve({spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false});});});
 const first=suite.post({providerType:'claude-code-cli',commandId:'login:lane-a'});
 const second=suite.post({providerType:'claude-code-cli',commandId:'login:lane-b'});
 await suite.firstDiscovery;await suite.flush();suite.releaseDiscovery();
 const [firstResponse,secondResponse]=await Promise.all([first,second]);
 assert.equal(firstResponse.status,200);assert.equal((await firstResponse.json()).outcome,'login-started');
 assert.equal(secondResponse.status,409);assert.equal((await secondResponse.json()).reason,'already-started','the second command finds the first unresolved record');
 assert.equal(logins,1,'the login command spawned exactly once');
 assert.equal(suite.discoveryCount(),2,'one deciding section ran its two discovery calls; the second request never entered the section');
 await oneActivation(suite);
});

test('the same command id whose first start could not spawn: both refused the same way, nothing activated',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-not-started-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const suite=await laneSuite(t,root,call=>call.args.includes('status')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false});
 const first=suite.post({providerType:'claude-code-cli',commandId:'login:lane-same'});
 const second=suite.post({providerType:'claude-code-cli',commandId:'login:lane-same'});
 await suite.firstDiscovery;await suite.flush();suite.releaseDiscovery();
 const [firstResponse,secondResponse]=await Promise.all([first,second]);
 for(const response of [firstResponse,secondResponse]){assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Login command could not be started',outcome:'rejected',reason:'login-not-started'});}
 await noActivation(suite);
});

test('the same command id already logged in: both answer already-logged-in through one deciding section',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-already-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let statusReads=0;
 const suite=await laneSuite(t,root,call=>{if(call.args.includes('status')){statusReads++;return {spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false};}return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};});
 const first=suite.post({providerType:'claude-code-cli',commandId:'login:lane-settled'});
 const second=suite.post({providerType:'claude-code-cli',commandId:'login:lane-settled'});
 await suite.firstDiscovery;await suite.flush();suite.releaseDiscovery();
 const [firstResponse,secondResponse]=await Promise.all([first,second]);
 for(const response of [firstResponse,secondResponse]){assert.equal(response.status,200);assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'settled',outcome:'already-logged-in'});}
 assert.equal(statusReads,1,'one status read: the second request replays the settled record');
 assert.equal(suite.discoveryCount(),2,'one deciding section ran; the second never entered');
 await oneActivation(suite);
});

test('a drain that begins while the first request is in discovery refuses both requests the same way',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const suite=await laneSuite(t,root,loggedOutStatus);
 const first=suite.post({providerType:'claude-code-cli',commandId:'login:lane-drain'});
 const second=suite.post({providerType:'claude-code-cli',commandId:'login:lane-drain'});
 await suite.firstDiscovery;await suite.flush();
 suite.logins.beginDrain();
 suite.releaseDiscovery();
 const [firstResponse,secondResponse]=await Promise.all([first,second]);
 for(const response of [firstResponse,secondResponse]){assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Login host is draining',outcome:'rejected',reason:'draining'});}
 assert.equal(suite.discoveryCount(),1,'the first request stopped before its status read and the second never entered the section');
 await noActivation(suite);
});

test('a refused start does not block the next request for the same provider',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-chain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const missing=async()=>null;
 const {post}=await loginRoute(t,root,loggedOutStatus,missing,missing);
 const first=await post({providerType:'claude-code-cli',commandId:'login:chain-a'});
 assert.equal(first.status,403);assert.equal((await first.json()).reason,'cli-not-found');
 const second=await post({providerType:'claude-code-cli',commandId:'login:chain-b'});
 assert.equal(second.status,403);assert.equal((await second.json()).reason,'cli-not-found','the lane still runs after a refusal');
});

test('status, login and model children share one environment allow-list and receive no credential',async t=>{
 const captured={status:[] as string[],login:[] as string[],model:[] as string[]};
 const credentials=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY'];
 const originals=[...credentials,'LC_ALL','LC_MESSAGES','LC_TIME'].map(name=>[name,process.env[name]] as [string,string|undefined]);
 t.after(()=>{for(const [name,value] of originals){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
 process.env.LC_ALL='C';process.env.LC_MESSAGES='C';process.env.LC_TIME='C';
 for(const name of credentials)process.env[name]='fixture-never-a-real-credential';
 const standIn={path:'/stand-in/claude',stamp:'',searchPath:'/discovered',version:'2.1.0 (Claude Code)'};
 const logins=new LoginConnections(async call=>{(call.args.join(' ')==='auth login'?captured.login:captured.status).push(...Object.keys(call.env));return {spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};},{discover:async()=>standIn});
 await logins.list();
 await logins.start({providerType:'claude-code-cli',commandId:'login:env'});
 const adapter=cliProfileFactory('claude-code-cli/v1',{mode:'local-http-mock',runner:async call=>{captured.model.push(...Object.keys(call.env));return {spawned:true,exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',num_turns:1,usage:{input_tokens:1,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:1},modelUsage:{m:{}}}),stderr:'',timedOut:false,aborted:false,overflow:false};}}).create({id:'p',label:'m',backend:'model-provider',providerKind:'claude-code-cli',protocol:'claude-code-cli/v1',model:'m',endpoint:'cli://x/run',revision:'v1',enabled:true,auth:{method:'cli-login'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:1024,maxOutputTokens:8,maxResponseBytes:1024,timeoutMs:1000}});
 await adapter.invoke({invocationId:'i',workId:'w',instruction:'x',inputReferences:[],maxOutputTokens:8,signal:new AbortController().signal});
 const unique=(names:string[])=>[...new Set(names)].sort();
 assert.deepEqual(unique(captured.status),unique(captured.login),'the status and login children see the same variable names');
 assert.deepEqual(unique(captured.model).filter(name=>name!==CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),unique(captured.status),'the model child sees the same names except the Claude output-token variable');
 for(const group of [captured.status,captured.login,captured.model])for(const name of credentials)assert.ok(!group.includes(name),name+' is never passed');
});

test('a real stand-in executable starts the login for real and turns the connection on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-real-child-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const standIn=join(root,'standin-login');await writeFile(standIn,'#!'+process.execPath+String.fromCharCode(10)+'process.exit(0);'+String.fromCharCode(10));chmodSync(standIn,0o755);
 const discovered={path:standIn,stamp:cliStamp(standIn),searchPath:'',version:'2.1.0 (Claude Code)'};
 // The injected runner only forwards to the real spawnCliRunner (onSpawned rides along), so the spawn and its acknowledgement are real.
 const forward=async(call:CliInvocation):Promise<CliResult>=>{const result=await spawnCliRunner({...call,command:standIn});return {spawned:result.spawned,exitCode:result.exitCode,stdout:'',stderr:'',timedOut:result.timedOut,aborted:result.aborted,overflow:result.overflow};};
 const {post,store,connections}=await loginRoute(t,root,forward,async()=>discovered);
 const response=await post({providerType:'claude-code-cli',commandId:'login:real-child'});
 assert.equal(response.status,200);
 assert.equal((await response.json()).outcome,'login-started','a really spawned login answers login-started');
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID) as {value:{activations:unknown[]}}|null;
 assert.equal(aggregate?.value.activations.length,1,'the connection was turned on');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,true);
});

test('a non-existent executable path refuses with login-not-started and turns nothing on',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-missing-path-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();
 const missing={path:join(root,'never-installed'),stamp:'',searchPath:'',version:'2.1.0 (Claude Code)'};
 // No injected runner: the REAL spawnCliRunner meets a path that does not exist (ENOENT, never spawned).
 const logins=new LoginConnections(undefined,{discover:async()=>missing,rediscover:async()=>missing});
 const connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),await loadHostStartup([]),{secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,transport:async()=>{throw new Error('no HTTP provider may be called');},settings:new InMemoryHostSettings(),loginStatus:async(providerType,signal)=>(await logins.recheck(providerType,signal)).status});
 await connections.restoreSettings();
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const response=await fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerType:'claude-code-cli',commandId:'login:missing-path'})});
 assert.equal(response.status,403);
 assert.deepEqual(await response.json(),{error:'Login command could not be started',outcome:'rejected',reason:'login-not-started'});
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
});

// The real prepare path is macOS-only; elsewhere this mirror of its stamp re-check keeps the real launcher under test.
const prepareMirror=process.platform==='darwin'?undefined:async(policy:LauncherPolicy,call:CliInvocation,onStampRefused?:(policy:LauncherPolicy)=>void)=>async()=>{if(!sameCliStamp(policy.command,policy.stamp??'')){onStampRefused?.(policy);throw new Error('CLI launcher unavailable');}return call;};

test('the real launcher passes the LC_* class to a real model-call child with the same names as status and login',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-real-launcher-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const credentials=['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY'];
 const originals=[...credentials,'LC_ALL','LC_CTYPE'].map(name=>[name,process.env[name]] as [string,string|undefined]);
 t.after(()=>{for(const [name,value] of originals){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
 process.env.LC_ALL='C';process.env.LC_CTYPE='UTF-8';for(const name of credentials)process.env[name]='fixture-never-a-real-credential';
 const standIn=join(root,'standin-env');await writeFile(standIn,'#!'+process.execPath+String.fromCharCode(10)+'console.log(JSON.stringify(Object.keys(process.env).sort()));'+String.fromCharCode(10));chmodSync(standIn,0o755);
 const names=(result:CliResult)=>JSON.parse(result.stdout) as string[];
 let loginSettled!:()=>void;const loginChildDone=new Promise<void>(resolve=>{loginSettled=resolve;});
 const captured={status:[] as string[],login:[] as string[],model:[] as string[]};
 const discovered={path:standIn,stamp:cliStamp(standIn),searchPath:'',version:'2.1.0 (Claude Code)'};
 // start() returns at the spawn acknowledgement, so the test waits for the login child's own exit before comparing what it saw.
 const logins=new LoginConnections(async call=>{const result=await spawnCliRunner({...call,command:standIn});const login=call.args.join(' ')==='auth login';(login?captured.login:captured.status).push(...names(result));if(login)loginSettled();return {spawned:result.spawned,exitCode:0,stdout:'{"loggedIn":false}',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};},{discover:async()=>discovered});
 await logins.list();
 const started=await logins.start({providerType:'claude-code-cli',commandId:'login:real-env'});
 if(started.outcome==='login-started')await loginChildDone;
 const args=cliArgPatterns('claude-code-cli/v1').map(pattern=>typeof pattern==='string'?pattern:'m');
 const policy:LauncherPolicy={command:standIn,stamp:cliStamp(standIn),args,environment:cliLauncherEnvironmentNames('claude-code-cli/v1'),secrets:{},readOnly:true};
 const launcher=new CliLauncher(policy,new InMemorySecretSlots(),{...(prepareMirror?{prepare:prepareMirror}:{})});
 const gathered:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&cliEnvironmentAllowed(key))gathered[key]=value;
 // The real prepare path accepts only a massion-cli-* working directory directly inside the real temporary root (prepareMac).
 const workingDirectory=await mkdtemp(join(realpathSync(tmpdir()),'massion-cli-'));
 const result=await launcher.launch('env-names',{command:standIn,args,stdin:'',cwd:workingDirectory,env:{...gathered,CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV:'8'},timeoutMs:10000,maxOutputBytes:65536,signal:new AbortController().signal});
 captured.model.push(...names(result));
 const unique=(values:string[])=>[...new Set(values)].sort();
 assert.deepEqual(unique(captured.model).filter(name=>name!==CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),unique(captured.status),'the model child (real launcher, real child; src/cli-launcher.ts environment expansion) sees the same names as the status child');
 assert.deepEqual(unique(captured.status),unique(captured.login),'the status and login children see the same names');
 for(const group of [captured.status,captured.login,captured.model]){assert.ok(group.includes('LC_ALL')&&group.includes('LC_CTYPE'),'LC_* reaches the child when set');for(const name of credentials)assert.ok(!group.includes(name),name+' never reaches a child');}
});
