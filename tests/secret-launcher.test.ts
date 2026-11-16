import {PermissionsService} from '../src/permissions.ts';
import {InMemoryStore} from '../src/storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {chmodSync,writeFileSync} from 'node:fs';
import {mkdtemp,realpath,rm,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemorySecretSlots,KeychainSecretSlots} from '../src/secret-slots.ts';
import {CliLauncher,cliStamp} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';
import {compileHostBindings,parseHostManifest} from '../src/host-connections.ts';

const ok=(stdout=''):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const slot={owner:'connection-fixture',slot:'token'};
const invocation=(args:readonly string[]=['read','item-1']):CliInvocation=>({command:process.execPath,args,stdin:'task',cwd:process.cwd(),env:{LANG:'C',NODE_OPTIONS:'--inspect',PRIVATE_TOKEN:'unrelated'},timeoutMs:1000,maxOutputBytes:16384,signal:new AbortController().signal});
const policy=():LauncherPolicy=>({command:process.execPath,args:['read',/^[a-z][a-z0-9-]{0,31}$/],environment:['LANG'],secrets:{},readOnly:true,signature:{teamId:'FIXTURE123',identifier:'test.fixture'}});

test('slots isolate owners, serialize without values, and remove values',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel=randomUUID();await secrets.set(slot,sentinel);
 assert.equal(await secrets.read(slot),sentinel);assert.equal(await secrets.read({...slot,owner:'other'}),undefined);
 assert.ok(!JSON.stringify(secrets).includes(sentinel));await secrets.delete(slot);assert.equal(await secrets.read(slot),undefined);
 await assert.rejects(secrets.set({...slot,slot:'token\nadd-generic-password'},sentinel));
});

test('keychain writes use stdin only, bounded hex data and generic errors, never argv/env/log output',async()=>{
 const seen:CliInvocation[]=[],sentinel='sentinel-'+randomUUID()+' "\\';
 const keychain=new KeychainSecretSlots(async call=>{seen.push(call);return ok(call.args.includes('find-generic-password')?sentinel+'\n':'');},'darwin');
 await keychain.set(slot,sentinel);assert.equal(await keychain.read(slot),sentinel);await keychain.delete(slot);
 assert.deepEqual(seen[0]!.args,['-i']);assert.ok(seen[0]!.stdin.includes(Buffer.from(sentinel).toString('hex')));
 for(const call of seen){assert.equal(call.command,'/usr/bin/security');assert.ok(!JSON.stringify([call.args,call.env]).includes(sentinel));assert.deepEqual(call.env,{});}
 assert.ok(!JSON.stringify(keychain).includes(sentinel));
 const failed=new KeychainSecretSlots(async()=>{throw new Error(sentinel);},'darwin');
 await assert.rejects(failed.set(slot,sentinel),e=>e instanceof Error&&!String(e.stack).includes(sentinel)&&!e.cause);
 await assert.rejects(keychain.set(slot,'x'.repeat(2000)),/Secret/);
 const unavailable=new KeychainSecretSlots(async()=>{assert.fail('must not fall back');},'linux');await assert.rejects(unavailable.read(slot),/unavailable/);
});

test('launcher scrubs the environment and coalesces identical launches',async()=>{
 let starts=0;const launcher=new CliLauncher(policy(),new InMemorySecretSlots(),{prepare:async()=>async()=>{},runner:async call=>{
  starts++;assert.deepEqual(call.env,{LANG:'C'});
  await new Promise(r=>setTimeout(r,20));return ok('answer');
 }});
 const call=invocation(),[a,b]=await Promise.all([launcher.launch('one',call),launcher.launch('one',call)]);
 assert.equal(starts,1);assert.deepEqual(a,b);assert.equal(a.exitCode,0);
 await launcher.launch('one',call);assert.equal(starts,1);
 await assert.rejects(launcher.launch('one',invocation(['read','changed'])),/identity/);
});

test('argument patterns reject option injection and extra args, and a raw prepare failure never escapes',async()=>{
 const secrets=new InMemorySecretSlots();
 const launcher=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{},runner:async()=>assert.fail('not dispatched')});
 for(const args of [['read','--write'],['write','item'],['read','item','extra'],['read','$(id)'],['read','item\n']])await assert.rejects(launcher.launch(randomUUID(),invocation(args)),/arguments/);
 const denied=new CliLauncher(policy(),secrets,{prepare:async()=>{throw new Error('sensitive-signature-output');}});
 assert.deepEqual(await denied.launch('unsigned',invocation()),{...ok(),spawned:false,exitCode:null});
});

test('a post-prepare refusal runs nothing and raw runner errors never escape',async()=>{
 const sentinel=randomUUID();
 const replaced=new CliLauncher(policy(),new InMemorySecretSlots(),{prepare:async()=>async()=>{throw new Error(sentinel);},runner:async()=>assert.fail('replaced binary cannot start')});
 assert.deepEqual(await replaced.launch('replaced',invocation()),{...ok(),spawned:false,exitCode:null});
 const broken=new CliLauncher(policy(),new InMemorySecretSlots(),{prepare:async()=>async()=>{},runner:async()=>{throw new Error(sentinel);}});
 const result=await broken.launch('broken',invocation());assert.equal(result.spawned,true);assert.equal(result.exitCode,null);assert.ok(!JSON.stringify(result).includes(sentinel));
});

test('slot manifests resolve only the exact host binding and expose no values in configuration',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel=randomUUID();await secrets.set(slot,sentinel);
 const manifest=parseHostManifest({version:1,revision:'slots-v1',mode:'https',connections:[{id:slot.owner,label:'Fixture',providerType:'compatible',baseUrl:'https://fixture.example/v1/',models:['fixture'],credential:{ref:'credential-ref',slot:slot.slot}}]});
 const permissions=new PermissionsService(new InMemoryStore()),host=compileHostBindings(manifest,()=>assert.fail('slot must never read environment'),()=>false,secrets,{permissions}),connection=host.bindings.connections[0]!.input;
 const {kind,state,...binding}=host.secretSource(connection.id)!;await permissions.act({commandId:'grant',action:'grant-secret',...binding});
 assert.equal(await host.resolveCredential({secretRef:'credential-ref',profileId:connection.id,endpoint:connection.baseUrl+'models',signal:new AbortController().signal}),sentinel);
 assert.ok(!JSON.stringify([manifest,host.bindings]).includes(sentinel));
 await assert.rejects(host.resolveCredential({secretRef:'credential-ref',profileId:connection.id,endpoint:'https://other.example/v1/models',signal:new AbortController().signal}));
});

test('real macOS signature verification refuses an untrusted team before any spawn', {skip:process.platform!=='darwin'},async()=>{
 const launcher=new CliLauncher({...policy(),command:'/bin/echo',args:['read']},new InMemorySecretSlots());
 assert.deepEqual(await launcher.launch('bad-team',{...invocation(['read']),command:'/bin/echo'}),{...ok(),spawned:false,exitCode:null});
});

test('a policy without a signature still enforces arguments, environment and the discovery stamp',async t=>{
 const root=await mkdtemp(join(await realpath(tmpdir()),'massion-cli-stamp-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const target=join(root,'cli');writeFileSync(target,'fixture');chmodSync(target,0o755);
 const cwd=await mkdtemp(join(await realpath(tmpdir()),'massion-cli-'));
 const seen:CliInvocation[]=[];
 const policy=():LauncherPolicy=>({command:target,args:['read',/^[a-z][a-z0-9-]{0,31}$/],environment:['LANG','PATH'],secrets:{},readOnly:true,stamp:cliStamp(target)});
 const call=(args:readonly string[]=['read','item-1']):CliInvocation=>({command:target,args,stdin:'',cwd,env:{LANG:'C',PATH:'/usr/bin:/bin',NODE_OPTIONS:'--inspect',PRIVATE_TOKEN:'unrelated'},timeoutMs:2000,maxOutputBytes:16384,signal:new AbortController().signal});
 const discovered=new CliLauncher(policy(),new InMemorySecretSlots(),{runner:async invocation=>{seen.push({...invocation,env:{...invocation.env}});return ok('answer');}});
 const result=await discovered.launch('found',call());
 assert.equal(result.exitCode,0,'prepareMac skips verifySignedCli when no signature is pinned');
 assert.equal(seen[0]!.env.LANG,'C');assert.equal(seen[0]!.env.PATH,'/usr/bin:/bin');assert.equal(seen[0]!.env.NODE_OPTIONS,undefined);assert.equal(seen[0]!.env.PRIVATE_TOKEN,undefined);
 writeFileSync(target,'replaced');await utimes(target,new Date(),new Date(Date.now()+5000));
 assert.equal((await discovered.launch('replaced',call())).spawned,false,'the pre-exec stamp re-check refuses a replaced discovery target');
 const rediscovered=new CliLauncher({...policy(),stamp:cliStamp(target)},new InMemorySecretSlots(),{runner:async invocation=>{seen.push({...invocation,env:{...invocation.env}});return ok('answer');}});
 assert.equal((await rediscovered.launch('again',call())).exitCode,0,'one rediscovery with the fresh stamp runs again');
});



test('keychain creation removes creator trust and permits only an explicitly named host',async()=>{
 const seen:CliInvocation[]=[],runner:import('../src/cli-agent-providers.ts').CliRunner=async call=>{seen.push(call);return ok();},sentinel=randomUUID();
 await new KeychainSecretSlots(runner,'darwin').set(slot,sentinel);
 assert.ok(seen[0]!.stdin.includes('-T ""'),'default ACL must not trust the security CLI or the Node interpreter');
 const host='/Applications/Massion App.app/Contents/MacOS/Massion';
 await new KeychainSecretSlots(runner,'darwin',host).set(slot,sentinel);
 assert.ok(seen[1]!.stdin.includes('-T '+JSON.stringify(host)));
 for(const call of seen){assert.ok(!call.stdin.includes('-A'));assert.ok(!call.stdin.includes('-T "/usr/bin/security"'));assert.ok(!call.stdin.includes('-T '+JSON.stringify(process.execPath)));assert.ok(!JSON.stringify(call.args).includes(sentinel));}
 for(const host of ['/usr/bin/security',process.execPath,'relative/host','/host\nextra'])assert.throws(()=>new KeychainSecretSlots(runner,'darwin',host));
});
