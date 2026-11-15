import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync,writeFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,rm,utimes,writeFile} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {dirname,join} from 'node:path';
import {subscriptionCliHost} from '../src/subscription-cli-host.ts';
import {cliArgPatterns} from '../src/cli-agent-providers.ts';
import type {SubscriptionDiscoveryAdapters} from '../src/subscription-cli-discovery.ts';
import {cliStamp} from '../src/cli-launcher.ts';
import {LoginConnections} from '../src/connection-logins.ts';
import {createWorkbench} from '../src/server.ts';
import {InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';

const ok=(stdout:string):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const executable=async(path:string,body='')=>{await mkdir(dirname(path),{recursive:true});await writeFile(path,body);chmodSync(path,0o755);};
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
});

test('a configured path that fails --version leaves no launcher and never falls back to discovery',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-configured-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await executable(join(root,'configured','claude'));await executable(join(root,'first','claude'));
 const host=subscriptionCliHost(()=>'MASSION_CLAUDE_CLI_COMMAND'===undefined?undefined:join(root,'configured','claude'),new InMemorySecretSlots(),adaptersFor(root,call=>ok(call.command.endsWith(join(root,'first','claude'))?'2.1.0 (Claude Code)':'some other tool 9.9')));
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
 const commands:string[]=[],paths:string[]=[];let discoveries=0;
 const discover=async()=>{discoveries++;const found=discoveries===1?{path:join(root,'first','claude'),stamp:cliStamp(join(root,'first','claude')),searchPath:'/discovered/search'}:null;return found;};
 const logins=new LoginConnections(async call=>{commands.push(call.args.join(' '));paths.push(call.command);return call.command.endsWith('claude')?ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'})):{...ok(''),exitCode:1,stderr:'Not logged in'};},{discover:async providerType=>providerType==='claude-code-cli'?discover():null});
 await executable(join(root,'first','claude'),'x');
 assert.deepEqual((await logins.list()).map(s=>s.status),['detected','absent'],'not found reads absent with discovery wired');
 assert.deepEqual(paths,[join(root,'first','claude')],'a not-found CLI is never executed by bare name');
 assert.equal((commands.join(' ')).includes('auth status'),true);
 const unconfigured=new LoginConnections();
 assert.deepEqual((await unconfigured.list()).map(s=>s.status),['unknown','unknown'],'without a discovery source the host capability itself is unknown');
});

test('the stamp re-check on a changed file rediscovers once and refuses when it fails again',async()=>{
 let stamp='0';const paths:string[]=[];
 const logins=new LoginConnections(async call=>{paths.push(call.command);return ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));},{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp,searchPath:''}:null,rediscover:async providerType=>{stamp=cliStamp(process.execPath);return providerType==='claude-code-cli'?{path:process.execPath,stamp,searchPath:''}:null;}});
 assert.equal((await logins.list())[0]!.status,'detected');
 assert.deepEqual(paths,[process.execPath]);
 stamp='0';
 const again=new LoginConnections(async call=>{paths.push(call.command);return ok(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));},{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:'0',searchPath:''}:null});
 assert.equal((await again.list())[0]!.status,'unknown','a still-mismatched rediscovery refuses before exec');
 assert.deepEqual(paths,[process.execPath],'nothing was executed after the failed re-check');
});

test('POST /connection-login keeps every refusal status and adds its machine-readable reason',async t=>{
 const root=await mkdtemp(join(tempRoot(),'cli-host-route-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();
 const logins=new LoginConnections(undefined,{discover:async providerType=>providerType==='claude-code-cli'?{path:process.execPath,stamp:cliStamp(process.execPath),searchPath:'/discovered'}:null});
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

