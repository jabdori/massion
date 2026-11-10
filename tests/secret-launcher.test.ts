import {PermissionsService} from '../src/permissions.ts';
import {InMemoryStore} from '../src/storage.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {InMemorySecretSlots,KeychainSecretSlots} from '../src/secret-slots.ts';
import {CliLauncher,cliSandboxProfile} from '../src/cli-launcher.ts';
import type {LauncherPolicy} from '../src/cli-launcher.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';
import {compileHostBindings,parseHostManifest} from '../src/host-connections.ts';

const ok=(stdout=''):CliResult=>({spawned:true,exitCode:0,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const slot={owner:'connection-fixture',slot:'token'};
const invocation=(args:readonly string[]=['read','item-1']):CliInvocation=>({command:process.execPath,args,stdin:'task',cwd:process.cwd(),env:{LANG:'C',NODE_OPTIONS:'--inspect',PRIVATE_TOKEN:'unrelated'},timeoutMs:1000,maxOutputBytes:16384,signal:new AbortController().signal});
const policy=():LauncherPolicy=>({command:process.execPath,args:['read',/^[a-z][a-z0-9-]{0,31}$/],environment:['LANG'],secrets:{TOOL_TOKEN:slot},readOnly:true,signature:{teamId:'FIXTURE123',identifier:'test.fixture'}});

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

test('launcher scrubs environment, redacts split/encoded output and coalesces identical launches before secret resolution',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel='secret-'+randomUUID();await secrets.set(slot,sentinel);
 let starts=0;const launcher=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{},runner:async call=>{
  starts++;assert.deepEqual(call.env,{LANG:'C',TOOL_TOKEN:sentinel});assert.ok(!JSON.stringify([call.args,call.stdin]).includes(sentinel));
  await new Promise(r=>setTimeout(r,20));return {...ok('before '+sentinel+' after'),stderr:encodeURIComponent(sentinel)};
 }});
 const call=invocation(),[a,b]=await Promise.all([launcher.launch('one',call),launcher.launch('one',call)]);
 assert.equal(starts,1);assert.deepEqual(a,b);assert.ok(!JSON.stringify(a).includes(sentinel));assert.match(a.stdout,/REDACTED/);
 await launcher.launch('one',call);assert.equal(starts,1);
 await assert.rejects(launcher.launch('one',invocation(['read','changed'])),/identity/);
 assert.ok(!JSON.stringify(launcher).includes(sentinel));
});

test('argument patterns reject option injection, extra args and unsigned/unavailable targets before secret access',async()=>{
 const secrets=new InMemorySecretSlots();secrets.read=async()=>assert.fail('rejected before secret read');
 const launcher=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{},runner:async()=>assert.fail('not dispatched')});
 for(const args of [['read','--write'],['write','item'],['read','item','extra'],['read','$(id)'],['read','item\n']])await assert.rejects(launcher.launch(randomUUID(),invocation(args)),/arguments/);
 const denied=new CliLauncher(policy(),secrets,{prepare:async()=>{throw new Error('sensitive-signature-output');}});
 assert.deepEqual(await denied.launch('unsigned',invocation()),{...ok(),spawned:false,exitCode:null});
});

test('post-check executable changes refuse launch and raw runner errors never escape',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel=randomUUID();await secrets.set(slot,sentinel);
 const replaced=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{throw new Error(sentinel);},runner:async()=>assert.fail('replaced binary cannot start')});
 assert.deepEqual(await replaced.launch('replaced',invocation()),{...ok(),spawned:false,exitCode:null});
 const broken=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{},runner:async()=>{throw new Error(sentinel);}});
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

test('real child receives only the declared environment and split stdout cannot expose the delegated value',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel='sentinel-'+randomUUID();await secrets.set(slot,sentinel);
 const script='const s=process.env.TOOL_TOKEN;process.stdout.write(JSON.stringify(Object.keys(process.env))+" "+s.slice(0,8));setTimeout(()=>{process.stdout.write(s.slice(8));process.stderr.write(s);},10)';
 const launcher=new CliLauncher({...policy(),args:['-e',script]},secrets,{prepare:async()=>async()=>{}});
 const result=await launcher.launch('child',invocation(['-e',script]));assert.equal(result.exitCode,0);
 assert.match(result.stdout,/LANG/);assert.match(result.stdout,/TOOL_TOKEN/);assert.doesNotMatch(result.stdout,/NODE_OPTIONS|PRIVATE_TOKEN/);assert.ok(!JSON.stringify(result).includes(sentinel));assert.match(result.stdout,/REDACTED/);assert.equal(result.stderr,'');
});

test('overflow or timeout never returns a secret prefix from truncated output',async()=>{
 const secrets=new InMemorySecretSlots(),sentinel=randomUUID();await secrets.set(slot,sentinel);
 const launcher=new CliLauncher(policy(),secrets,{prepare:async()=>async()=>{},runner:async()=>({...ok(sentinel.slice(0,8)),overflow:true,stderr:sentinel.slice(0,8)})});
 const result=await launcher.launch('truncated',invocation());assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('real macOS signature verification refuses an untrusted team before reading slots', {skip:process.platform!=='darwin'},async()=>{
 const secrets=new InMemorySecretSlots();let reads=0;secrets.read=async()=>{reads++;return 'fixture';};
 const launcher=new CliLauncher({...policy(),command:'/bin/echo',args:['read']},secrets);
 assert.deepEqual(await launcher.launch('bad-team',{...invocation(['read']),command:'/bin/echo'}),{...ok(),spawned:false,exitCode:null});assert.equal(reads,0);
});


test('generated CLI sandbox denies keychain IPC and security execution even with declared Mach services',()=>{
 const empty=cliSandboxProfile(policy(),'/private/tmp/massion-cli-fixture','/Users/fixture');
 assert.ok(empty.includes('(deny default)'));assert.ok(!empty.includes('(allow mach-lookup)'));
 assert.ok(!empty.includes('(allow mach-lookup '),'no service is implicitly allowed');
 const profile=cliSandboxProfile({...policy(),machServices:['com.apple.fixture.required','com.apple.fixture.other']},'/private/tmp/massion-cli-fixture','/Users/fixture');
 assert.ok(profile.includes('(allow mach-lookup (global-name "com.apple.fixture.required"))'));
 assert.ok(profile.includes('(deny mach-lookup (global-name-prefix "com.apple.securityd") (global-name-prefix "com.apple.SecurityServer"))'));
 assert.ok(profile.includes('(deny process-exec (literal "/usr/bin/security"))'));
 assert.ok(profile.indexOf('(deny process-exec (literal "/usr/bin/security"))')>profile.lastIndexOf('(allow process-exec'),'security exec denial follows every process-exec allow');
 for(const allow of profile.matchAll(/\(allow mach-lookup\b/g))assert.ok(profile.indexOf('(deny mach-lookup')>allow.index,'keychain Mach denial follows every Mach allow');
 for(const name of ['com.apple.securityd','com.apple.securityd.xpc','com.apple.SecurityServer','com.apple.SecurityServer.test','com.apple.*','bad"service'])assert.throws(()=>cliSandboxProfile({...policy(),machServices:[name]},'/private/tmp/massion-cli-fixture','/Users/fixture'));
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
