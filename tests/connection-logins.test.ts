import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync,realpathSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir,userInfo} from 'node:os';
import {tempRoot} from './support/temp-root.ts';
import {bothLoginStartsEntered} from './support/login-start-entries.ts';
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
import {CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV,applyCliAccountEnvironment,cliArgPatterns,cliEnvironmentAllowed,cliLauncherEnvironmentNames,cliProfileFactory} from '../src/cli-agent-providers.ts';

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

test('a detection attempt writes one outcome line per provider, only when the outcome changes',async()=>{
 const standIn=(provider:string)=>({path:'/stand-in/'+provider,stamp:'',searchPath:'',version:provider==='claude-code-cli'?'2.1.0 (Claude Code)':'codex-cli 0.1.0'});
 for(const provider of ['claude-code-cli','codex-cli'] as const)for(const [behavior,expected] of [
  ['missing','cli-not-found'],
  ['discovery-failed','cli-not-found'],
  ['logged-out','logged-out'],
  ['logged-in','detected'],
  ['status-failed','failed'],
  ['aborted','failed'],
  ['unrecognised','unrecognised-output'],
  ['timed-out','timed-out'],
 ] as [string,string][]){
  let current=behavior;const lines:string[]=[];
  const discover=async(p:string)=>{if(p!==provider||current==='missing')return null;if(current==='discovery-failed')throw new Error('discovery failed');return standIn(p);};
  const logins=new LoginConnections(async()=>stateAnswer(provider,current),{discover,rediscover:discover,writeDetectionOutcome:line=>lines.push(line)});
  const own=()=>lines.map(line=>(JSON.parse(line) as {cliDetection:{time:number;provider:string;outcome:string}}).cliDetection).filter(entry=>entry.provider===provider);
  await logins.list();
  assert.equal(own().length,1,provider+' '+behavior+': exactly one line for the provider after the first attempt');
  const raw=lines.map(line=>JSON.parse(line) as Record<string,unknown>&{cliDetection?:{provider:string}}).find(entry=>entry.cliDetection?.provider===provider)!;
  assert.deepEqual(Object.keys(raw),['cliDetection'],provider+' '+behavior+': the line is one JSON object under one event name');
  const line=own()[0]!;
  assert.deepEqual(Object.keys(line),['time','provider','outcome'],provider+' '+behavior+': the line carries nothing but the time, the provider and the reason code');
  assert.equal(line.provider,provider);
  assert.equal(line.outcome,expected);
  assert.ok(typeof line.time==='number'&&Number.isInteger(line.time),provider+' '+behavior+': time is epoch milliseconds as an integer, not a string');
  await logins.list();
  assert.equal(own().length,1,provider+' '+behavior+': the same outcome on a later read is not written again');
  current=behavior==='logged-in'?'timed-out':'logged-in';
  await logins.recheck(provider);
  assert.equal(own().length,2,provider+' '+behavior+': a changed outcome writes a second line');
  assert.equal(own()[1]!.outcome,current==='logged-in'?'detected':'timed-out');
  await logins.recheck(provider);
  assert.equal(own().length,2,provider+' '+behavior+': the repeated new outcome is not written again either');
 }
 // Without a discovery source the state keeps its own existing name, and no child is ever started on that path.
 const bare:string[]=[];
 const host=new LoginConnections(undefined,{writeDetectionOutcome:line=>bare.push(line)});
 assert.deepEqual((await host.list()).map(entry=>entry.state),['unknown','unknown']);
 assert.deepEqual(bare.map(line=>(JSON.parse(line) as {cliDetection:{provider:string;outcome:string}}).cliDetection.outcome),['unknown','unknown']);
});

test('a failing outcome writer is ignored and every returned value stays as it is',async()=>{
 const standIn=(provider:string)=>({path:'/stand-in/'+provider,stamp:'',searchPath:'',version:provider==='claude-code-cli'?'2.1.0 (Claude Code)':'codex-cli 0.1.0'});
 let written=0;
 const logins=new LoginConnections(async call=>call.command.includes('claude')?stateAnswer('claude-code-cli','logged-out'):stateAnswer('codex-cli','logged-in'),{discover:async p=>standIn(p),writeDetectionOutcome:()=>{written++;throw new Error('standard error is gone');}});
 assert.deepEqual((await logins.list()).map(entry=>[entry.providerType,entry.status,entry.state]),[['claude-code-cli','absent','logged-out'],['codex-cli','detected','logged-in']]);
 const again=await logins.recheck('claude-code-cli');
 assert.deepEqual([again.providerType,again.status,again.state],['claude-code-cli','absent','logged-out']);
 assert.equal(written,2,'both providers attempted their write; the failing write changed nothing and suppressed nothing');
});

test('a status read that never returns is recorded and logged as timed-out by the wrapper deadline',async()=>{
 const standIn={path:'/stand-in/claude-code-cli',stamp:'',searchPath:'',version:'2.1.0 (Claude Code)'};
 const lines:string[]=[];
 // The runner never settles, so only the tool wrapper's own 3 s deadline can end the read; that is the real packaged timeout path.
 const logins=new LoginConnections(()=>new Promise<CliResult>(()=>{}),{discover:async p=>p==='claude-code-cli'?standIn:null,writeDetectionOutcome:line=>lines.push(line)});
 const status=await logins.recheck('claude-code-cli');
 assert.deepEqual([status.status,status.state,status.unreadableReason],['unknown','unreadable','timed-out'],'a hung status runner is classified by the wrapper deadline, not as a plain failure');
 assert.equal(lines.length,1);
 const entry=(JSON.parse(lines[0]!) as {cliDetection:{time:number;provider:string;outcome:string}}).cliDetection;
 assert.deepEqual([entry.provider,entry.outcome],['claude-code-cli','timed-out']);
 assert.ok(typeof entry.time==='number'&&Number.isInteger(entry.time),'time is epoch milliseconds as an integer, not a string');
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
 return {calls,origin,store,connections,logins,post:(body:unknown)=>fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:t.signal})};
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
 let armed=false,discoveryEntries=0;
 const firstDiscovery=Promise.withResolvers<void>(),hold=Promise.withResolvers<void>();
 t.after(()=>hold.resolve());
 const gatedDiscover=async(provider:string)=>{discoveryEntries++;if(armed){firstDiscovery.resolve();await hold.promise;}return {path:'/stand-in/'+provider,stamp:'',searchPath:'',version:'2.1.0 (Claude Code)'};};
 const route=await loginRoute(t,root,answer,gatedDiscover,gatedDiscover);
 const postPair=async(first:unknown,second:unknown,beforeOpen?:()=>void)=>{
  const entered=bothLoginStartsEntered(t,route.logins);
  armed=true;
  let discoveriesWhileHeld=0;
  const [firstResponse,secondResponse]=await Promise.all([
   route.post(first),
   firstDiscovery.promise.then(()=>route.post(second)),
   entered.then(()=>{discoveriesWhileHeld=discoveryEntries;beforeOpen?.();hold.resolve();}),
  ]);
  return {firstResponse,secondResponse,discoveriesWhileHeld};
 };
 return {...route,postPair,discoveryCount:()=>discoveryEntries};
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

test('two requests with different command ids for one provider: exactly one login starts',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-different-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let logins=0;
 const finishLogin=Promise.withResolvers<void>();t.after(()=>finishLogin.resolve());
 // The login child acknowledges its spawn and then stays unfinished, like a real interactive login.
 const suite=await laneSuite(t,root,async call=>{if(isLoginCommand(call)){logins++;call.onSpawned?.();await finishLogin.promise;}return loggedOutStatus(call);});
 const {firstResponse,secondResponse,discoveriesWhileHeld}=await suite.postPair(
  {providerType:'claude-code-cli',commandId:'login:lane-a'},
  {providerType:'claude-code-cli',commandId:'login:lane-b'},
 );
 assert.equal(firstResponse.status,200);assert.equal((await firstResponse.json()).outcome,'login-started');
 assert.equal(secondResponse.status,409,'the second command finds the first unresolved record');assert.equal((await secondResponse.json()).reason,'already-started','the second command finds the first unresolved record');
 assert.equal(logins,1,'the login command spawned exactly once');
 assert.equal(discoveriesWhileHeld,1,'only one request entered the deciding section while the gate held');
 assert.equal(suite.discoveryCount(),2,'one deciding section ran its two discovery calls; the second request never entered the section');
 await oneActivation(suite);
});

// Not a lane test: after a refusal the record is removed and any later request re-decides from the same state, so
// serialization is unobservable here. What this pins is the spawn fact: nothing is answered started before the login
// command really spawned (src/connection-logins.ts, the started acknowledgement await inside #decide).
test('a start whose login could not spawn is refused again the same way and nothing is activated',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-not-started-replay-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {post,store,connections}=await loginRoute(t,root,call=>call.args.includes('status')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false});
 for(let attempt=0;attempt<2;attempt++){
  const response=await post({providerType:'claude-code-cli',commandId:'login:not-started'});
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'Login command could not be started',outcome:'rejected',reason:'login-not-started'});
 }
 const aggregate=await store.load(CONNECTION_ACTIVATION_ID);
 assert.ok(!(aggregate&&(aggregate as {value?:{activations?:unknown[]}}).value?.activations?.length),'no activation in the aggregate');
 assert.equal(connections.list().connections.find(c=>c.providerType==='claude-code-cli')!.on,false,'nothing was turned on');
});

test('the same command id already logged in: both answer already-logged-in through one deciding section',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-already-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let statusReads=0;
 const suite=await laneSuite(t,root,call=>{if(call.args.includes('status')){statusReads++;return {spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false};}return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};});
 const command={providerType:'claude-code-cli',commandId:'login:lane-settled'};
 const {firstResponse,secondResponse,discoveriesWhileHeld}=await suite.postPair(command,command);
 for(const response of [firstResponse,secondResponse]){assert.equal(response.status,200);assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'settled',outcome:'already-logged-in'});}
 assert.equal(statusReads,1,'one status read: the second request replays the settled record');
 assert.equal(discoveriesWhileHeld,1,'only one request entered the deciding section while the gate held');
 assert.equal(suite.discoveryCount(),2,'one deciding section ran; the second never entered');
 await oneActivation(suite);
});

test('a drain that begins while the first request is in discovery refuses both requests the same way',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const suite=await laneSuite(t,root,loggedOutStatus);
 const command={providerType:'claude-code-cli',commandId:'login:lane-drain'};
 const {firstResponse,secondResponse}=await suite.postPair(command,command,()=>suite.logins.beginDrain());
 for(const response of [firstResponse,secondResponse]){assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'Login host is draining',outcome:'rejected',reason:'draining'});}
 assert.equal(suite.discoveryCount(),1,'the first request stopped before its status read and the second never entered the section');
 await noActivation(suite);
});

test('a refused start does not block the next request for the same provider',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-chain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const missing=async()=>null;
 const {post}=await loginRoute(t,root,loggedOutStatus,missing,missing);
 const first=await post({providerType:'claude-code-cli',commandId:'login:chain-a'});
 assert.equal(first.status,403);assert.equal((await first.json()).reason,'cli-not-found');
 const second=await post({providerType:'claude-code-cli',commandId:'login:chain-b'});
 assert.equal(second.status,403);assert.equal((await second.json()).reason,'cli-not-found','the lane still runs after a refusal');
});

test('a failed spawn throws and the queued login for the same provider still starts',{timeout:10000},async t=>{
 const spawning=Promise.withResolvers<void>(),failedSpawn=Promise.withResolvers<CliResult>();
 const refuseSpawn=()=>failedSpawn.resolve(stateAnswer('claude-code-cli','status-failed'));
 t.after(refuseSpawn);
 let attempts=0;
 const logins=new LoginConnections(async call=>{
  if(isLoginCommand(call)&&++attempts===1){spawning.resolve();return failedSpawn.promise;}
  return loggedOutStatus(call);
 });
 const entered=bothLoginStartsEntered(t,logins);
 const first=logins.start({providerType:'claude-code-cli',commandId:'login:failed-spawn'});
 const next=spawning.promise.then(()=>logins.start({providerType:'claude-code-cli',commandId:'login:after-failed-spawn'}));
 const replies=Promise.allSettled([first,next]);
 await entered;
 refuseSpawn();
 await assert.rejects(first,{code:'denied',message:'Login command could not be started'});
 const deadline=new AbortController();
 try{
  const [,reply]=await Promise.race([replies,delay(5000,undefined,{signal:deadline.signal}).then(()=>assert.fail('the next login start was blocked after the first threw'))]);
  assert.deepEqual(reply,{status:'fulfilled',value:{providerType:'claude-code-cli',status:'settled',outcome:'login-started'}},'the queued request starts after the failed spawn');
 }finally{deadline.abort();}
});

test('the same command id for two providers at once: one decides, the other gets the identity conflict',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-cross-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let logins=0;const finishLogin=Promise.withResolvers<void>();t.after(()=>finishLogin.resolve());
 const answer=async(call:CliInvocation):Promise<CliResult>=>{
  if(isLoginCommand(call)){logins++;call.onSpawned?.();await finishLogin.promise;}
  else if(call.command.includes('codex'))return stateAnswer('codex-cli','logged-out');
  return loggedOutStatus(call);
 };
 const suite=await laneSuite(t,root,answer);
 const first={providerType:'claude-code-cli',commandId:'login:cross'},second={providerType:'codex-cli',commandId:'login:cross'};
 const {firstResponse,secondResponse,discoveriesWhileHeld}=await suite.postPair(first,second);
 const statuses=[firstResponse.status,secondResponse.status].sort();
 assert.deepEqual(statuses,[200,409],'one provider decides, the other is refused');
 const refused=[firstResponse,secondResponse].find(response=>response.status===409)!;
 assert.equal((await refused.json()).reason,'command-id-reused','the second provider meets the first record: identity conflict');
 const accepted={providerType:'claude-code-cli',status:'started',outcome:'login-started'};
 assert.deepEqual(await firstResponse.json(),accepted);
 assert.deepEqual(await suite.logins.start(first),accepted,'the command id replays the winning provider\'s stored start');
 await assert.rejects(suite.logins.start(second),{code:'conflict',message:'Login command identity conflict'});
 assert.equal(logins,1,'at most one login command started');
 assert.equal(discoveriesWhileHeld,1,'only one request entered the deciding section while the gate held');
 assert.equal(suite.discoveryCount(),2,'one deciding section ran; the other request never entered one');
 const aggregate=await suite.store.load(CONNECTION_ACTIVATION_ID) as {value:{activations:unknown[]}}|null;
 assert.equal(aggregate?.value.activations.length,1,'one activation was stored');
});

test('at the capacity limit two simultaneous new command ids accept exactly one',{timeout:10000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-lane-capacity-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const suite=await laneSuite(t,root,loggedOutStatus);
 for(let index=0;index<63;index++)await suite.logins.start({providerType:'claude-code-cli',commandId:'login:fill-'+index});
 const baseline=suite.discoveryCount();
 const {firstResponse,secondResponse,discoveriesWhileHeld}=await suite.postPair(
  {providerType:'claude-code-cli',commandId:'login:cap-a'},
  {providerType:'claude-code-cli',commandId:'login:cap-b'},
 );
 const statuses=[firstResponse.status,secondResponse.status].sort();
 assert.deepEqual(statuses,[200,400],'one command is accepted, the other hits the capacity limit');
 const refused=[firstResponse,secondResponse].find(response=>response.status===400)!;
 assert.equal((await refused.json()).reason,'capacity');
 assert.deepEqual(await firstResponse.json(),{providerType:'claude-code-cli',status:'settled',outcome:'login-started'});
 assert.equal(discoveriesWhileHeld,baseline+1,'only the first of the pair entered the deciding section while the gate held');
});

// Sequential by design (no entry gate needed): a FINISHED record is replayed before the drain check, so a duplicate
// of a start that already succeeded is never told draining (src/connection-logins.ts #decide: the prior lookup first).
test('a finished record is replayed even while the host is draining',async t=>{
 const root=await mkdtemp(join(tempRoot(),'login-replay-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const {post,logins}=await loginRoute(t,root,()=>({spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:'',timedOut:false,aborted:false,overflow:false}));
 const first=await post({providerType:'claude-code-cli',commandId:'login:replay'});
 assert.equal(first.status,200);assert.equal((await first.json()).outcome,'already-logged-in');
 logins.beginDrain();
 const second=await post({providerType:'claude-code-cli',commandId:'login:replay'});
 assert.equal(second.status,200);
 assert.deepEqual(await second.json(),{providerType:'claude-code-cli',status:'settled',outcome:'already-logged-in'},'the stored record answers; only a NEW decision is refused for draining');
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

test('status and login children take USER and LOGNAME from the OS account lookup, never from the core environment; a failed lookup keeps the inherited values',async t=>{
 const originals=['USER','LOGNAME'].map(name=>[name,process.env[name]] as [string,string|undefined]);
 t.after(()=>{for(const [name,value] of originals){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
 const standIn={path:'/stand-in/claude',stamp:'',searchPath:'/discovered',version:'2.1.0 (Claude Code)'};
 const capture=(account:()=>string)=>{
  const environments:Record<string,string>[]=[];
  const logins=new LoginConnections(async call=>{environments.push({...call.env});return call.args.includes('--json')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};},{discover:async()=>standIn,account});
  return {environments,logins};
 };
 // A packaged start: the core environment has neither name, and the account lookup fills both in every child.
 delete process.env.USER;delete process.env.LOGNAME;
 {
  const {environments,logins}=capture(()=>'fixture-account');
  await logins.list();
  // An instantly-settled fake runner lets the record settle before start() returns; the outcome still proves the login child launched.
  assert.equal((await logins.start({providerType:'claude-code-cli',commandId:'login:account-env'})).outcome,'login-started');
  // list() runs two status children; start() re-reads the status once more, then launches the login child.
  assert.equal(environments.length,4);
  for(const env of environments){assert.equal(env.USER,'fixture-account');assert.equal(env.LOGNAME,'fixture-account');}
 }
 // A development start with different inherited values: the OS account wins over both.
 process.env.USER='fixture-inherited-user';process.env.LOGNAME='fixture-inherited-logname';
 {
  const {environments,logins}=capture(()=>'fixture-account');
  const statuses=await logins.list();
  assert.equal(statuses.find(entry=>entry.providerType==='claude-code-cli')!.state,'logged-out');
  for(const env of environments){assert.equal(env.USER,'fixture-account','the account name overrides the inherited USER');assert.equal(env.LOGNAME,'fixture-account','the account name overrides the inherited LOGNAME');}
 }
 // A failed lookup leaves the two names as inherited: absent when the core environment has neither (exactly main), and the status child still starts and is read.
 delete process.env.USER;delete process.env.LOGNAME;
 {
  const {environments,logins}=capture(()=>{throw new Error('account lookup failed');});
  const statuses=await logins.list();
  assert.equal(statuses.find(entry=>entry.providerType==='claude-code-cli')!.state,'logged-out','the child started and its output was read');
  for(const env of environments){assert.equal(env.USER,undefined);assert.equal(env.LOGNAME,undefined);}
 }
 // The same failed lookup with inherited values present: the child receives exactly the inherited values (exactly main).
 process.env.USER='fixture-inherited-user';process.env.LOGNAME='fixture-inherited-logname';
 {
  const {environments,logins}=capture(()=>{throw new Error('account lookup failed');});
  const statuses=await logins.list();
  assert.equal(statuses.find(entry=>entry.providerType==='claude-code-cli')!.state,'logged-out','the child started and its output was read');
  for(const env of environments){assert.equal(env.USER,'fixture-inherited-user','a failed lookup keeps the inherited USER');assert.equal(env.LOGNAME,'fixture-inherited-logname','a failed lookup keeps the inherited LOGNAME');}
 }
});

test('with no injected account, the status child takes USER and LOGNAME from the real OS account lookup, never from the core environment',async t=>{
 let username:string;try{username=userInfo().username;}catch{return t.skip('the OS account lookup is unavailable');}
 const fixtureUser='fixture-not-the-account-user',fixtureLogname='fixture-not-the-account-logname';
 if(username===fixtureUser||username===fixtureLogname)return t.skip('the real account name collides with a fixture string');
 const originals=['USER','LOGNAME'].map(name=>[name,process.env[name]] as [string,string|undefined]);
 t.after(()=>{for(const [name,value] of originals){if(value===undefined)delete process.env[name];else process.env[name]=value;}});
 process.env.USER=fixtureUser;process.env.LOGNAME=fixtureLogname;
 const standIn={path:'/stand-in/claude',stamp:'',searchPath:'/discovered',version:'2.1.0 (Claude Code)'};
 const environments:Record<string,string>[]=[];
 const logins=new LoginConnections(async call=>{environments.push({...call.env});return call.args.includes('--json')?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};},{discover:async()=>standIn});
 const statuses=await logins.list();
 assert.equal(statuses.find(entry=>entry.providerType==='claude-code-cli')!.state,'logged-out','the status child started and its output was read');
 // Strict equality through assert.ok with a static message: a failure must never print the real account name.
 for(const env of environments){
  assert.ok(env.USER===username,'the status child USER is the OS account name, not the inherited environment value');
  assert.ok(env.LOGNAME===username,'the status child LOGNAME is the OS account name, not the inherited environment value');
  assert.ok(env.USER!==fixtureUser,'the status child USER is not the inherited USER');
  assert.ok(env.LOGNAME!==fixtureLogname,'the status child LOGNAME is not the inherited LOGNAME');
 }
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
 const gathered:Record<string,string>={};for(const [key,value] of Object.entries(process.env))if(value!==undefined&&cliEnvironmentAllowed(key))gathered[key]=value;applyCliAccountEnvironment(gathered);
 // The real prepare path accepts only a massion-cli-* working directory directly inside the real temporary root (prepareMac).
 const workingDirectory=await mkdtemp(join(realpathSync(tmpdir()),'massion-cli-'));
 const result=await launcher.launch('env-names',{command:standIn,args,stdin:'',cwd:workingDirectory,env:{...gathered,CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV:'8'},timeoutMs:10000,maxOutputBytes:65536,signal:new AbortController().signal});
 captured.model.push(...names(result));
 const unique=(values:string[])=>[...new Set(values)].sort();
 assert.deepEqual(unique(captured.model).filter(name=>name!==CLAUDE_CODE_MAX_OUTPUT_TOKEN_ENV),unique(captured.status),'the model child (real launcher, real child; src/cli-launcher.ts environment expansion) sees the same names as the status child');
 assert.deepEqual(unique(captured.status),unique(captured.login),'the status and login children see the same names');
 for(const group of [captured.status,captured.login,captured.model]){assert.ok(group.includes('LC_ALL')&&group.includes('LC_CTYPE'),'LC_* reaches the child when set');for(const name of credentials)assert.ok(!group.includes(name),name+' never reaches a child');}
});
