import test from 'node:test';
import type {TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,realpath,rm,utimes,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {tempRoot} from './support/temp-root.ts';
import {dirname,join} from 'node:path';
import {subscriptionCliHost} from '../src/subscription-cli-host.ts';
import {cliArgPatterns} from '../src/cli-agent-providers.ts';
import type {SubscriptionDiscoveryAdapters} from '../src/subscription-cli-discovery.ts';
import {cliStamp,sameCliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {InMemoryHostSettings} from '../src/storage.ts';
import {loadHostStartup,createHostConnections} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {ProductService} from '../src/product.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';
import type {SubscriptionCliProvider} from '../src/subscription-cli-host.ts';

const ok=(stdout:string):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const executable=async(path:string,body='')=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,body);chmodSync(path,0o755);};
// The real prepare path is macOS-only (the launcher refuses elsewhere); on other platforms this mirror of its stamp re-check keeps the host wiring under test.
const prepareMirror=process.platform==='darwin'?undefined:async(policy:LauncherPolicy,call:CliInvocation,onStampRefused?:(policy:LauncherPolicy)=>void)=>async()=>{if(!sameCliStamp(policy.command,policy.stamp??'')){onStampRefused?.(policy);throw new Error('CLI launcher unavailable');}return call;};
const adaptersFor=(root:string,answers:(call:CliInvocation)=>CliResult):SubscriptionDiscoveryAdapters=>({home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second'),join(root,'third')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner:async call=>answers(call)});

test('launchers appear after discovery, carry the resolved command, and disappear when rediscovery finds nothing',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-appear-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'first','claude'),'#!/bin/sh\n');await executable(join(root,'second','codex'),'#!/bin/sh\n');
 const environment:Record<string,string>={'MASSION_CLAUDE_CLI_TEAM_ID':'IGNORED','MASSION_CLAUDE_CLI_IDENTIFIER':'ignored.too'};
 const host=subscriptionCliHost(name=>environment[name],new InMemorySecretSlots(),adaptersFor(root,call=>ok(call.command.endsWith('claude')?'2.1.0 (Claude Code)':'codex-cli 0.1.0')));
 assert.equal(host.run['claude-code-cli/v1'],undefined,'nothing runs before the host first needs the CLI');
 assert.equal((await host.discover('claude-code-cli'))?.path,await import('node:fs/promises').then(fs=>fs.realpath(join(root,'first','claude'))));
 assert.equal(host.run['claude-code-cli/v1']!.command,await import('node:fs/promises').then(fs=>fs.realpath(join(root,'first','claude'))));
 assert.equal(host.searchPaths['claude-code-cli/v1']!(),[join(root,'first'),join(root,'second'),join(root,'third'),'/usr/bin','/bin'].join(':'));
 await host.discover('codex-cli');
 assert.equal(host.run['codex-cli/v1']!.command,await import('node:fs/promises').then(fs=>fs.realpath(join(root,'second','codex'))));
 assert.equal((await host.discover('claude-code-cli'))?.path,host.run['claude-code-cli/v1']!.command,'discovery is cached per provider');
 await rm(join(root,'first','claude'),{force:true});
 assert.equal(await host.rediscover('claude-code-cli'),null,'the removed file is not found again');
 assert.equal(host.run['claude-code-cli/v1'],undefined,'the launcher disappears when rediscovery finds nothing');
});

test('a configured path that fails --version leaves no launcher and never falls back to discovery',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-configured-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'configured','claude'));await executable(join(root,'first','claude'));
 const host=subscriptionCliHost(name=>name==='MASSION_CLAUDE_CLI_COMMAND'?join(root,'configured','claude'):undefined,new InMemorySecretSlots(),adaptersFor(root,call=>ok(call.command.endsWith(join(root,'first','claude'))?'2.1.0 (Claude Code)':'some other tool 9.9')));
 assert.equal(await host.discover('claude-code-cli'),null);
 assert.equal(host.run['claude-code-cli/v1'],undefined);
 assert.equal((await host.rediscover('claude-code-cli')),null,'rediscovery repeats the configured path, not the folders');
});

test('a file replaced after discovery is refused, then rediscovery rebuilds the launcher once',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-replace-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const claude=join(root,'first','claude');await executable(claude,'one');
 let runs=0;const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner:async call=>{runs++;return ok('2.1.0 (Claude Code)');}});
 const first=await host.discover('claude-code-cli');
 await executable(claude,'two');await utimes(claude,new Date(),new Date(Date.now()+2000));
 const launcher=host.run['claude-code-cli/v1']!;
 const args=cliArgPatterns('claude-code-cli/v1').map(pattern=>typeof pattern==='string'?pattern:'claude-sonnet-5-5');
 const refused=await launcher.launch('replaced',{command:launcher.command,args,stdin:'',cwd:'/',env:{},timeoutMs:1000,maxOutputBytes:1024,signal:new AbortController().signal});
 assert.equal(refused.spawned,false,'the pre-exec stamp re-check refuses the replaced file');
 const again=await host.rediscover('claude-code-cli');
 assert.equal(runs,2,'rediscovery re-ran --version for the changed file');
 assert.ok(again);
 assert.notEqual(again!.stamp,first!.stamp);
 assert.ok(host.run['claude-code-cli/v1'],'rediscovery installs a launcher for the same resolved file');
});

test('a not-found CLI reads absent, recheck rediscovers, and a replaced file is executed only after one rediscovery',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-logins-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const claude=join(root,'first','claude');await executable(claude,'one');
 const resolved=await import('node:fs/promises').then(fs=>fs.realpath(claude));
 let versionRuns=0;const runnerCalls:CliInvocation[]=[];
 const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner:async()=>{versionRuns++;return ok('2.1.0 (Claude Code)');}});
 const logins=new LoginConnections(async call=>{runnerCalls.push({...call,env:{...call.env}});return ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));},{discover:host.discover,rediscover:host.rediscover});
 const codex=await logins.recheck('codex-cli');
 assert.equal(codex.status,'absent','a CLI that discovery cannot find reads absent');
 assert.deepEqual(codex,{providerType:'codex-cli',kind:'cli-login',status:'absent',state:'cli-not-found'},'no executable means no path or version is reported');
 const first=await logins.recheck('claude-code-cli');
 assert.equal(first.status,'detected');
 assert.equal(first.state,'logged-in');
 assert.equal(first.version,'2.1.0 (Claude Code)','the entry carries the validated version line');
 assert.deepEqual(runnerCalls.map(call=>[call.command,call.args]),[[resolved,['auth','status','--json']]],'exactly one status call on the resolved path');
 runnerCalls.length=0;
 await writeFile(claude,'two');await utimes(claude,new Date(),new Date(Date.now()+4000));
 const second=await logins.recheck('claude-code-cli');
 assert.equal(second.status,'detected','the replaced file runs again after rediscovery');
 assert.deepEqual(runnerCalls.map(call=>[call.command,call.args]),[[resolved,['auth','status','--json']]],'the replaced file is executed exactly once, and only after rediscovery');
 assert.equal(versionRuns,2,'exactly one rediscovery ran --version again before the replaced file executed');
 const unconfigured=new LoginConnections();
 assert.deepEqual((await unconfigured.list()).map(s=>[s.status,s.state]),[['unknown','unknown'],['unknown','unknown']],'without a discovery source the host capability itself is unknown');
});

test('the stamp re-check on a changed file rediscovers once and refuses when it fails again',async()=>{
 let stamp='0';const paths:string[]=[];
 const logins=new LoginConnections(async call=>{paths.push(call.command);return ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));},{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp,searchPath:'',version:'2.1.0 (Claude Code)'}:null,rediscover:async providerType=>{stamp=cliStamp(process.execPath);return providerType==='claude-code-cli'?{path:process.execPath,stamp,searchPath:'',version:'2.1.0 (Claude Code)'}:null;}});
 assert.equal((await logins.list())[0]!.status,'detected');
 assert.deepEqual(paths,[process.execPath]);
 stamp='0';
 const again=new LoginConnections(async call=>{paths.push(call.command);return ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));},{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:'0',searchPath:'',version:'2.1.0 (Claude Code)'}:null});
 assert.equal((await again.list())[0]!.status,'unknown','a still-mismatched rediscovery refuses before exec');
 assert.deepEqual(paths,[process.execPath],'nothing was executed after the failed re-check');
});

test('a stamp-refused model call stays refused and the next call uses the launcher built by one rediscovery',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-model-rediscover-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const claude=join(root,'first','claude');await executable(claude,'one');
 let versionRuns=0;const runnerCommands:string[]=[];
 const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner:async()=>{versionRuns++;return ok('2.1.0 (Claude Code)');},launcher:{...(prepareMirror?{prepare:prepareMirror}:{}),runner:async call=>{runnerCommands.push(call.command);return ok('model');}}});
 await host.discover('claude-code-cli');
 const cwd=await mkdtemp(join(await import('node:fs/promises').then(fs=>fs.realpath(tmpdir())),'massion-cli-'));
 const args=cliArgPatterns('claude-code-cli/v1').map(pattern=>typeof pattern==='string'?pattern:'claude-sonnet-5-5');
 const call={command:host.run['claude-code-cli/v1']!.command,args,stdin:'',cwd,env:{PATH:'/usr/bin:/bin'},timeoutMs:2000,maxOutputBytes:16384,signal:new AbortController().signal};
 assert.equal((await host.run['claude-code-cli/v1']!.launch('first',call)).exitCode,0);
 await writeFile(claude,'two');await utimes(claude,new Date(),new Date(Date.now()+4000));
 assert.equal((await host.run['claude-code-cli/v1']!.launch('refused',call)).spawned,false,'the refused model call itself stays refused');
 const deadline=Date.now()+2000;
 while(versionRuns<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(versionRuns,2,'exactly one rediscovery was triggered by the stamp refusal');
 assert.equal((await host.run['claude-code-cli/v1']!.launch('after',call)).exitCode,0,'the next call uses the rediscovered launcher');
 assert.equal(runnerCommands.length,2,'only the first and the last call reached the runner');
});

test('only the latest discovery installs its result and touches the cache',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-latest-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=join(root,'first','claude'),second=join(root,'second','claude'),third=join(root,'third','claude');
 await executable(first,'A');await executable(second,'B');
 // Only probes of the first folder wait; their Nth call is gated so completion order is the test's choice.
 const firstGates=Array.from({length:4},()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};});
 let phase=0,firstCalls=0;
 const versionRunner=async(call:CliInvocation)=>{
  if(!call.command.endsWith(join('first','claude')))return ok('2.1.0 (Claude Code)');
  const n=firstCalls++;await firstGates[n]!.promise;
  return phase===0?ok(n===0?'2.1.0 (Claude Code)':'some other tool 9.9'):n===0?Promise.reject(new Error('probe failure')):ok('some other tool 9.9');
 };
 const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second'),join(root,'third')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner});
 const {realpath}=await import('node:fs/promises');
 const firstResolved=await realpath(first),secondResolved=await realpath(second);
 // Discovery #1 (first folder, succeeds late) and rediscovery #2 (first folder refused, second found) overlap.
 const older=host.discover('claude-code-cli');
 while(firstCalls<1)await new Promise(resolve=>setTimeout(resolve,5));
 const newer=host.rediscover('claude-code-cli');
 while(firstCalls<2)await new Promise(resolve=>setTimeout(resolve,5));
 firstGates[1]!.resolve();
 assert.equal((await newer)?.path,secondResolved);
 firstGates[0]!.resolve();
 assert.equal((await older)?.path,firstResolved,'the older discovery still reports its own result');
 assert.equal(host.run['claude-code-cli/v1']!.command,secondResolved,'a late older result cannot overwrite the newer launcher');
 assert.equal((await host.discover('claude-code-cli'))?.path,secondResolved,'the cache keeps the newer result');
 // A late older REJECTION must not delete the cache entry the newer success installed.
 phase=1;firstCalls=0;
 await rm(second,{force:true});await executable(third,'C');
 const thirdResolved=await realpath(third);
 let runnerCalls=0;
 const host2=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second'),join(root,'third')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner:async(call:CliInvocation)=>{runnerCalls++;return versionRunner(call);}});
 const failing=host2.rediscover('claude-code-cli'); // its first-folder probe waits on the gate, then rejects
 failing.catch(()=>{});
 while(firstCalls<1)await new Promise(resolve=>setTimeout(resolve,5));
 const succeeding=host2.rediscover('claude-code-cli'); // first refused by shape, third found at once
 assert.equal((await succeeding)?.path,thirdResolved);
 assert.equal(host2.run['claude-code-cli/v1']!.command,thirdResolved,'the newer success installed');
 const callsAfterSuccess=runnerCalls;
 firstGates[2]!.resolve();
 await assert.rejects(failing);
 assert.equal((await host2.discover('claude-code-cli'))?.path,thirdResolved,'the late older rejection kept the newer cache entry');
 assert.equal(runnerCalls,callsAfterSuccess,'no probe ran again: the cache was not deleted');
});

test('a workbench model call reads the launcher discovery installed, before and after a stamp refusal',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-workbench-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=join(root,'first','claude'),second=join(root,'second','claude');
 await executable(first,'one');
 let releaseDiscovery!:()=>void;const discoveryHeld=new Promise<void>(resolve=>releaseDiscovery=resolve);
  let versionRuns=0,refuseFirstByShape=false;
 const claudeResult=JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({reply:'4',work:null}),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}});
 const executed:string[]=[];
 const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second'),join(root,'third')],loginShell:()=>undefined,readEnvironment:()=>undefined,
  versionRunner:async call=>{versionRuns++;if(versionRuns===1)await discoveryHeld;if(refuseFirstByShape&&call.command===await realPathFirst())return ok('some other tool 9.9');return ok('2.1.0 (Claude Code)');},
  launcher:{...(prepareMirror?{prepare:prepareMirror}:{}),runner:async call=>{executed.push(call.command);return ok(claudeResult);}}});
 const store=new InMemoryStore<any>(),startup=await loadHostStartup([]);
 const transport=async()=>{throw new Error('no HTTP provider may be called');};
 const connections=createHostConnections(store,new TextArtifactStore(join(root,'artifacts')),startup,{secrets:new InMemorySecretSlots(),readEnvironment:()=>undefined,transport,settings:new InMemoryHostSettings(),cliLaunchers:host.run,cliSearchPaths:host.searchPaths,loginStatus:async providerType=>providerType==='claude-code-cli'?'detected' as const:'absent' as const});
 await connections.restoreSettings();
 const discovering=host.discover('claude-code-cli');
 connections.list(); // the connection list is read while discovery has not finished
 releaseDiscovery();
 await discovering;
  const {realpath:realPath}=await import('node:fs/promises');
  const firstResolved=await realPath(first);
  const realPathFirst=()=>realPath(first);
 const assistant=new AssistantService(store,new ProductService(store,undefined,connections),connections);
 const firstSend=await assistant.send({commandId:'q-1',segment:1,expectedRevision:0,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(firstSend.turn?.status,'answered');
 assert.equal(executed.length,1);
 assert.equal(executed[0],firstResolved,'the model call ran the discovered CLI itself, unwrapped');
  await writeFile(first,'two');await utimes(first,new Date(),new Date(Date.now()+4000));
 await executable(second,'two');
  const secondResolved=await realPath(second);
 const view=await assistant.read();
  refuseFirstByShape=true;
 const refused=await assistant.send({commandId:'q-2',segment:1,expectedRevision:view.segment!.revision,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(refused.turn?.status,'failed','the refused model call itself stays refused');
 const deadline=Date.now()+2000;
 while(versionRuns<2&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
 assert.ok(versionRuns>=2,'the stamp refusal triggered rediscovery');
 await new Promise(resolve=>setTimeout(resolve,20));
 const after=await assistant.read();
 const third=await assistant.send({commandId:'q-3',segment:1,expectedRevision:after.segment!.revision,text:'2+2? Reply with just the numeral.'},undefined,'owner-typed');
 assert.equal(third.turn?.status,'answered');
 assert.equal(executed.length,2);
 assert.equal(executed[1],secondResolved,'the next model call ran the newly discovered file itself, unwrapped');
});

async function restartedSend(t:TestContext,{found=true,priorLauncher=false}={}){
 const root=await mkdtemp(join(tempRoot(),'cli-host-send-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const claude=join(root,'first','claude');await executable(claude);
 await executable(join(root,'first','codex'));
 const store=new InMemoryStore<any>(),startup=await loadHostStartup([]),settings=new InMemoryHostSettings(),secrets=new InMemorySecretSlots();
 const artifacts=new TextArtifactStore(join(root,'artifacts'));
 const options={secrets,settings,readEnvironment:()=>undefined,transport:async()=>{throw new Error('Unexpected HTTP provider call');}};
 const initial=createHostConnections(store,artifacts,startup,options);
 await initial.restoreSettings();
 await initial.turnOnConnection('login-before-restart',initial.connectionIdForProvider('claude-code-cli')!,'login-started');
 const probeStarted=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),other=Promise.withResolvers<void>();
 const calls:{command:string;text:string}[]=[],probes:string[]=[],lookups:{provider:SubscriptionCliProvider;promise:unknown}[]=[];
 const result=JSON.stringify({type:'result',subtype:'success',is_error:false,result:JSON.stringify({reply:'4',work:null}),num_turns:1,usage:{input_tokens:2,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:4},modelUsage:{'claude-sonnet-5-5':{}}});
 let prime=priorLauncher;
 const host=subscriptionCliHost(()=>undefined,secrets,{...adaptersFor(root,()=>ok('')),versionRunner:async call=>{
  probes.push(call.command);if(call.command.endsWith('/codex')){await other.promise;return ok('codex-cli 0.1.0');}
  if(prime){prime=false;return ok('2.1.0 (Claude Code)');}
  probeStarted.resolve();await release.promise;return ok(found?'2.1.0 (Claude Code)':'invalid version');
 },launcher:{...(prepareMirror?{prepare:prepareMirror}:{}),runner:async call=>{
  calls.push({command:call.command,text:JSON.parse(call.stdin).currentMessage});return ok(result);
 }}});
 const connections=createHostConnections(store,artifacts,startup,{...options,cliLaunchers:host.run,cliSearchPaths:host.searchPaths,cliDiscovery:(provider:SubscriptionCliProvider)=>{
  const promise=host.existingDiscovery(provider);lookups.push({provider,promise});return promise;
 }});
 await connections.restoreSettings();
 assert.equal(connections.list().representative?.status,'active');
 if(priorLauncher){
  await host.discover('claude-code-cli');
  assert.ok(host.run['claude-code-cli/v1']);
  void host.rediscover('claude-code-cli').catch(()=>{});
 }
 const logins=new LoginConnections(async call=>ok(call.command.endsWith('/codex')?'Logged in using ChatGPT':JSON.stringify({loggedIn:true,authMethod:'claude.ai'})),{discover:host.discover});
 const server=createWorkbench(store,root,{connections,logins,artifacts,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{release.resolve();other.resolve();await server.drain();});
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const post=async(commandId:string,expectedRevision=0,signal?:AbortSignal)=>{
  const response=await fetch(origin+'/assistant/messages',{method:'POST',headers:{'content-type':'application/json',connection:'close'},body:JSON.stringify({commandId,segment:1,expectedRevision,text:commandId}),signal});
  return {status:response.status,body:await response.json() as any};
 };
 const listed=fetch(origin+'/connections',{headers:{connection:'close'}}).then(response=>response.json());
 void listed.catch(()=>{});
 await probeStarted.promise;
 return {store,connections,server,post,host,calls,probes,lookups,release,other,claude:await realpath(claude)};
}

const unavailableReceipt='{"status":"failed","reason":"cli_unavailable_not_started","outputSha256":null,"warnings":0}';

test('restart: a send waits for the selected CLI and answers with its discovered executable',{timeout:5000},async t=>{
 const f=await restartedSend(t),sent=f.post('first-after-restart');
 const before=await Promise.race([sent.then(({body})=>[body.turn?.status,body.turn?.settlement?.reason,f.calls.length]),delay(100,'pending')]);
 assert.deepEqual(before,'pending','no cli_unavailable_not_started settlement while discovery is pending');
 assert.equal(await f.store.load(segmentId(1)),null,'no turn is recorded before discovery finishes');
 const releasedAt=Date.now();f.release.resolve();
 const {status,body}=await sent;
 assert.deepEqual([status,body.turn?.status,body.turn?.reply],[200,'answered','4']);
 assert.deepEqual(f.calls,[{command:f.claude,text:'first-after-restart'}],'only the selected CLI is called while Codex is still pending');
 const turn=(await f.store.load(segmentId(1)))!.value.turns[0];
 assert.ok(turn.ownership.startedAt>=releasedAt,'the turn deadline starts after discovery');
 assert.equal(turn.ownership.deadlineAt-turn.ownership.startedAt,120000);
});

test('restart: discovery without an executable preserves the exact unavailable receipt',{timeout:5000},async t=>{
 const f=await restartedSend(t,{found:false,priorLauncher:true}),sent=f.post('missing-cli');
 await t.waitFor(()=>assert.ok(f.lookups.length>0));
 f.release.resolve();
 const {status,body}=await sent;
 assert.deepEqual([status,body.turn?.status,body.turn?.settlement?.reason,f.calls.length],[200,'failed','cli_unavailable_not_started',0]);
 assert.equal((await f.store.load(segmentId(1)))!.value.turns[0].receipt,unavailableReceipt);
});

test('restart: an API-key send never reads CLI discovery',{timeout:5000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'api-send-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),secrets=new InMemorySecretSlots(),artifacts=new TextArtifactStore(join(root,'artifacts'));
 const discovery=t.mock.fn((provider:SubscriptionCliProvider)=>undefined);
 const connections=createHostConnections(store,artifacts,await loadHostStartup([]),{secrets,cliDiscovery:discovery,readEnvironment:()=>undefined,transport:async url=>{
  const data=String(url).endsWith('/models')?{data:[{id:'test-model'}]}:{id:'fixture',object:'chat.completion',created:1,model:'test-model',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({reply:'API answer',work:null})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}};
  return new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
 }});
 const openai=connections.list().connections.find(c=>c.providerType==='openai')!;
 const lifecycle=new ConnectionLifecycle(store,connections);
 assert.equal((await lifecycle.replaceKey({commandId:'key-for-api',connectionId:openai.id,expectedConfigHash:openai.configHash,apiKey:'fixture-key'})).status,'completed');
 await connections.discover(openai.id,openai.configHash);
 const {profileId}=await connections.save(()=>connections.selectModel(openai.id,{model:'test-model',label:'Test model',expectedConfigHash:openai.configHash}));
 assert.equal(await connections.firstRepresentativeFromSelection(profileId),true);
 const assistant=new AssistantService(store,new ProductService(store,undefined,connections),connections);
 const result=await assistant.send({commandId:'api-send',segment:1,expectedRevision:0,text:'Hello'});
 assert.equal(discovery.mock.callCount(),0,'an API-key route never asks for an existing discovery');
 assert.equal(result.turn?.reply,'API answer');
});

test('restart: concurrent sends share discovery and a revision retry calls in order',{timeout:5000},async t=>{
 const f=await restartedSend(t),first=f.post('first'),shared=f.host.existingDiscovery('claude-code-cli');
 await t.waitFor(()=>assert.equal(f.lookups.length,1));
 const second=f.post('second');
 await t.waitFor(()=>assert.equal(f.lookups.length,2));
 assert.deepEqual(f.lookups.map(lookup=>lookup.provider),['claude-code-cli','claude-code-cli']);
 for(const lookup of f.lookups)assert.equal(lookup.promise,shared,'both sends wait on the exact same discovery promise');
 assert.equal(await f.store.load(segmentId(1)),null);
 f.release.resolve();
 const [a,b]=await Promise.all([first,second]);
 assert.deepEqual([a.status,b.status],[200,409]);
 assert.equal(a.body.turn?.status,'answered');
 const retry=await f.post('second',(await f.store.load(segmentId(1)))!.revision);
 assert.deepEqual([retry.status,retry.body.turn?.status],[200,'answered']);
 assert.deepEqual(f.calls,[{command:f.claude,text:'first'},{command:f.claude,text:'second'}]);
 assert.equal(f.probes.filter(path=>path===f.claude).length,1);
});

test('restart: a hung rediscovery times out with the unavailable receipt',{timeout:5000},async t=>{
 const f=await restartedSend(t,{priorLauncher:true});
 t.mock.timers.enable({apis:['setTimeout']});
 const assistant=new AssistantService(f.store,new ProductService(f.store,undefined,f.connections),f.connections);
 const sent=assistant.send({commandId:'timeout-cli',segment:1,expectedRevision:0,text:'Hello'});
 await t.waitFor(()=>assert.ok(f.lookups.length>0));
 t.mock.timers.tick(8999);
 assert.equal(await f.store.load(segmentId(1)),null,'the wait still holds just before its bound');
 t.mock.timers.tick(1);
 const result=await Promise.race([sent,delay(100,'still waiting')]);
 t.mock.timers.reset();
 assert.notEqual(result,'still waiting','the send finishes at the bound while rediscovery is still pending');
 assert.deepEqual(f.calls,[],'the previous launcher is not used after the bound');
 assert.equal((await f.store.load(segmentId(1)))!.value.turns[0].receipt,unavailableReceipt);
});

test('restart: host drain interrupts discovery wait before a turn is stored',{timeout:5000},async t=>{
 const f=await restartedSend(t),sent=f.post('drain-during-wait');
 await t.waitFor(()=>assert.ok(f.lookups.length>0));
 const draining=f.server.drain();
 try{
  const response=await Promise.race([sent,delay(500,'still waiting')]);
  assert.notEqual(response,'still waiting','drain rejects the send before shared discovery finishes');
  if(typeof response==='string')throw new Error(response);
  assert.deepEqual([response.status,response.body.outcome],[503,'rejected']);
  assert.equal(await f.store.load(segmentId(1)),null);
  assert.deepEqual(f.calls,[]);
 }finally{f.release.resolve();f.other.resolve();}
 assert.deepEqual(await draining,{status:'drained',timedOut:false});
});

test('restart: a disconnected request stops waiting before a turn is stored',{timeout:5000},async t=>{
 const f=await restartedSend(t),disconnect=new AbortController(),settled=Promise.withResolvers<void>();
 const resolve=f.connections.resolveRepresentative.bind(f.connections);
 t.mock.method(f.connections,'resolveRepresentative',async (signal?:AbortSignal)=>{
  try{return await resolve(signal);}finally{settled.resolve();}
 });
 const sent=f.post('disconnect-during-wait',0,disconnect.signal);
 await t.waitFor(()=>assert.ok(f.lookups.length>0));
 const aborted=assert.rejects(sent,{name:'AbortError'});
 disconnect.abort();
 await aborted;
 assert.equal(await Promise.race([settled.promise.then(()=> 'settled'),delay(500,'still waiting')]),'settled','the server stops waiting even though discovery is pending');
 assert.equal(await f.store.load(segmentId(1)),null);
 assert.deepEqual(f.calls,[]);
});

test('concurrent discovery of both providers installs both, and a rejection clears only its own cache',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-concurrent-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const first=join(root,'first','claude'),second=join(root,'second','codex');
 await executable(first);await executable(second);
 const {realpath}=await import('node:fs/promises');
 const firstResolved=await realpath(first),secondResolved=await realpath(second);
 // Claude probes wait on a gate so the two providers overlap; codex answers at once. claudePhase 1 rejects.
 const claudeGates=Array.from({length:2},()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};});
 let claudePhase=0,claudeCalls=0;
 const versionRunner=async(call:CliInvocation)=>{
  if(!call.command.endsWith('claude'))return ok('codex-cli 0.1.0');
  const n=claudeCalls++;
  if(claudePhase===2)return ok('2.1.0 (Claude Code)');
  await claudeGates[n]!.promise;
  return claudePhase===0?ok('2.1.0 (Claude Code)'):Promise.reject(new Error('probe failure'));
 };
 const host=subscriptionCliHost(()=>undefined,new InMemorySecretSlots(),{home:()=>join(root,'home'),fixedFolders:()=>[join(root,'first'),join(root,'second')],loginShell:()=>undefined,readEnvironment:()=>undefined,versionRunner});
 // The same path LoginConnections.list() uses: both providers discovered at once through Promise.all.
 const logins=new LoginConnections(async()=>({spawned:false,exitCode:null,stdout:'',stderr:'',timedOut:false,aborted:true,overflow:false}),{discover:host.discover,rediscover:host.rediscover});
 const listing=logins.list();
 while(claudeCalls<1)await new Promise(resolve=>setTimeout(resolve,5));
 claudeGates[0]!.resolve();
 await listing;
 assert.equal(host.run['claude-code-cli/v1']!.command,firstResolved,'the provider that started FIRST still installs');
 assert.equal(host.run['codex-cli/v1']!.command,secondResolved,'the provider that finished first installs');
 assert.ok(host.searchPaths['claude-code-cli/v1']?.()?.includes(join(root,'first')));
 assert.ok(host.searchPaths['codex-cli/v1']?.()?.includes(join(root,'second')));
 // Cross-provider rejection race: claude rejects late while codex succeeds at once.
 claudePhase=1;claudeCalls=0;
 const rejected=host.rediscover('claude-code-cli');
 rejected.catch(()=>{});
 while(claudeCalls<1)await new Promise(resolve=>setTimeout(resolve,5));
 const succeeded=await host.rediscover('codex-cli');
 assert.equal(succeeded?.path,secondResolved);
 claudeGates[1]!.resolve();
 await assert.rejects(rejected);
 claudePhase=2;
 const callsBefore=claudeCalls;
 const again=await host.discover('claude-code-cli');
 assert.equal(again?.path,firstResolved);
 assert.ok(claudeCalls>callsBefore,'the rejected provider\'s cache entry was removed, so discovery ran again');
 assert.equal(host.run['codex-cli/v1']!.command,secondResolved,'the other provider stayed installed');
});

test('POST /connection-login keeps every refusal status and adds its machine-readable reason',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();
 const logins=new LoginConnections(undefined,{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:cliStamp(process.execPath),searchPath:'/discovered',version:'2.1.0 (Claude Code)'}:null});
 const server=createWorkbench(store,root,{logins,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.drain());
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const post=(body:unknown)=>fetch(origin+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const missing=await post({providerType:'codex-cli',commandId:'login:missing'});assert.equal(missing.status,403);assert.equal((await missing.json()).reason,'cli-not-found');
 const unknown=await post({providerType:'other-cli',commandId:'login:unknown'});assert.equal(unknown.status,400);assert.equal((await unknown.json()).reason,'unknown-provider');
 const invalid=await post({providerType:'claude-code-cli',commandId:'login:invalid',extra:1});assert.equal(invalid.status,400);assert.equal((await invalid.json()).reason,'invalid-fields');
 const started=await post({providerType:'claude-code-cli',commandId:'login:start'});assert.equal(started.status,200);assert.equal((await started.json()).status,'started');
 const conflict=await post({providerType:'claude-code-cli',commandId:'login:again'});assert.equal(conflict.status,409);assert.equal((await conflict.json()).reason,'already-started');
 const server2=createWorkbench(new InMemoryStore<any>(),root,{scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server2.listen(0,'127.0.0.1',resolve));t.after(()=>server2.drain());
 const origin2='http://127.0.0.1:'+(server2.address() as {port:number}).port;
 const disabled=await fetch(origin2+'/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerType:'claude-code-cli',commandId:'login:1'})});
 assert.equal(disabled.status,503);assert.equal((await disabled.json()).reason,'logins-not-enabled');
});

