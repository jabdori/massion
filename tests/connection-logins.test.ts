import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
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
  case 'logged-out':return provider==='claude-code-cli'?{spawned:true,exitCode:0,stdout:'{"loggedIn":false}',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:1,stdout:'',stderr:'Not logged in',timedOut:false,aborted:false,overflow:false};
  case 'api-key':return {spawned:true,exitCode:0,stdout:'{"loggedIn":true,"authMethod":"api-key"}',stderr:'',timedOut:false,aborted:false,overflow:false};
  case 'status-failed':return {spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:false,overflow:false};
  case 'unrecognised':return provider==='claude-code-cli'?{spawned:true,exitCode:0,stdout:'not json',stderr:'',timedOut:false,aborted:false,overflow:false}:{spawned:true,exitCode:0,stdout:'Something else',stderr:'',timedOut:false,aborted:false,overflow:false};
  default:return {spawned:true,exitCode:null,stdout:'',stderr:'',timedOut:true,aborted:false,overflow:false};
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
  ['status-failed','absent','unreadable','failed'],
  ['unrecognised','unknown','unreadable','unrecognised-output'],
  ['timed-out','unknown','unreadable','timed-out'],
  ...(provider==='claude-code-cli'?[['api-key','absent','logged-out',undefined]]:[])
 ] as [string,string,string,string|undefined][]){
  const standIn={path:'/stand-in/'+provider+'/'+behavior,stamp:'',searchPath:'',version:versions[provider]};
  const logins=new LoginConnections(async()=>stateAnswer(provider,behavior),{discover:async p=>p===provider&&behavior!=='missing'?standIn:null,rediscover:async p=>p===provider&&behavior!=='missing'?standIn:null});
  const server=createWorkbench(new InMemoryStore<any>(),root,{connections:new ConnectionWorkbench(new InMemoryStore<any>(),new TextArtifactStore(root),{transport:async()=>{throw new Error('no model transport permitted');}}),logins,scheduleIntervalMs:0});
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
  const entry=((await (await fetch(origin+'/connections')).json()) as {logins:{providerType:string}[]}).logins.find(l=>l.providerType===provider);
  assert.deepEqual(entry,{providerType:provider,kind:'cli-login',status,state,...(reason?{unreadableReason:reason}:{}),...(behavior==='missing'?{}:{executablePath:standIn.path,version:versions[provider]})},provider+' '+behavior+' keeps status within today\'s closed set, so an older client still works');
 }
});

const isLoginCommand=(call:CliInvocation)=>call.args.join(' ')==='auth login'||call.args.join(' ')==='login';
const loginRoute=async(t:test.TestContext,root:string,answer:(call:CliInvocation)=>CliResult)=>{
 const calls:CliInvocation[]=[];const standIn=(provider:string)=>({path:'/stand-in/'+provider,stamp:'',searchPath:'',version:provider==='claude-code-cli'?'2.1.0 (Claude Code)':'codex-cli 0.1.0'});
 const logins=new LoginConnections(async call=>{calls.push({...call,env:{...call.env}});return answer(call);},{discover:async provider=>standIn(provider),rediscover:async provider=>standIn(provider)});
 const store=new InMemoryStore<any>(),connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),await loadHostStartup([]),{secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,transport:async()=>{throw new Error('no HTTP provider may be called');},settings:new InMemoryHostSettings(),loginStatus:async(providerType,signal)=>(await logins.recheck(providerType,signal)).status});
 await connections.restoreSettings();
 const server=createWorkbench(store,root,{connections,logins,scheduleIntervalMs:0});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 return {calls,origin,post:(body:unknown)=>fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
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
 assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'started',outcome:'login-started'},'an older client still reads today\'s status field');
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
 assert.deepEqual(await response.json(),{providerType:'claude-code-cli',status:'started',outcome:'login-started'});
 assert.equal(calls.filter(isLoginCommand).length,1,'the person asked for the login, so it starts');
});
