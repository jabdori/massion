import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {KeychainSecretSlots} from '../src/secret-slots.ts';
import type {SecretSlot} from '../src/secret-slots.ts';
import {compileHostBindings,createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {AppsService} from '../src/apps.ts';
import {SourceSecretSlots} from '../src/source-secret-slots.ts';
import {sourceHash} from '../src/secret-sources.ts';
import {InMemoryStore} from '../src/storage.ts';
import {PermissionsService} from '../src/permissions.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createWorkbench} from '../src/server.ts';
import {grantConnectionSecrets} from './support/secret-grants.ts';
import type {Mission} from '../src/domain.ts';
import type {CliInvocation,CliResult} from '../src/cli-agent-providers.ts';

const slot:SecretSlot={owner:'account',slot:'api-key'};
const models=()=>new Response('{"data":[{"id":"fixture"}]}',{headers:{'content-type':'application/json'}});
const manifest=()=>parseHostManifest({version:1,revision:'memory-v1',mode:'https',connections:[{id:'account',label:'Owner API',providerType:'compatible',baseUrl:'https://fixture.example/v1/',models:['fixture'],credential:{ref:'key-ref',slot:'api-key'}}]});
const result=(stdout='',exitCode=0):CliResult=>({spawned:true,exitCode,stdout,stderr:'',timedOut:false,aborted:false,overflow:false});
const setCommand=/^add-generic-password -U -s massion:(\S+) -a (\S+) -T ".*" -X ([0-9a-f]+)$/;

/** Counting stand-in for /usr/bin/security; items live in test memory only, no real keychain. */
function fakeKeychain(seed:[string,string,string][]=[]){
 const items=new Map(seed.map(([owner,s,value])=>[JSON.stringify([owner,s]),value]));
 const reads:CliInvocation[]=[],checks:CliInvocation[]=[],writes:CliInvocation[]=[],deletes:CliInvocation[]=[];
 const secrets=new KeychainSecretSlots(async call=>{
  if(call.args[0]==='find-generic-password'){(call.args.includes('-w')?reads:checks).push(call);const value=items.get(JSON.stringify([call.args[2]!.slice(8),call.args[4]!]));return value===undefined?result('',44):result(call.args.includes('-w')?value+'\n':'');}
  if(call.args[0]==='delete-generic-password'){deletes.push(call);items.delete(JSON.stringify([call.args[2]!.slice(8),call.args[4]!]));return result();}
  writes.push(call);const write=setCommand.exec(call.stdin.trim())!;items.set(JSON.stringify([write[1],write[2]]),Buffer.from(write[3]!,'hex').toString());return result();
 },'darwin');
 return {secrets,items,reads:()=>reads.length,checks:()=>checks.length,writes:()=>writes.length,deletes:()=>deletes.length};
}
async function manager(fake:ReturnType<typeof fakeKeychain>,transport:(url:string,init:RequestInit)=>Promise<Response>=async()=>models()){
 const store=new InMemoryStore<Mission>(),connections=createHostConnections(store,new TextArtifactStore(tempRoot()),{manifest:manifest(),allowLiveExecution:false},{secrets:fake.secrets,readEnvironment:()=>assert.fail('No environment credentials'),transport});
 await grantConnectionSecrets(store,connections);const connection=connections.list().connections[0]!;
 return {store,connections,connection};
}

test('model requests read one keychain value per host run; discovery and recheck add no read',async t=>{
 const root=await mkdtemp(join(tempRoot(),'secret-memory-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),fake=fakeKeychain([['account','api-key','sentinel-model-key']]);
 const host=compileHostBindings(manifest(),()=>assert.fail('Slot connections never read the environment'),()=>false,fake.secrets,{permissions:new PermissionsService(store)});
 const connections=createHostConnections(store,new TextArtifactStore(tempRoot()),{manifest:manifest(),allowLiveExecution:false},{secrets:fake.secrets,readEnvironment:()=>assert.fail('No environment credentials'),transport:async()=>models()});
 await grantConnectionSecrets(store,connections);
 const connection=connections.list().connections[0]!,profile=connections.list().runtime.connections[0]!;assert.ok('endpoint' in profile&&typeof profile.endpoint==='string');
 const request={secretRef:'key-ref',profileId:profile.id,endpoint:profile.endpoint,signal:new AbortController().signal};
 for(let n=0;n<4;n++)assert.equal(await host.resolveCredential(request),'sentinel-model-key');
 assert.equal(fake.reads(),1,'four model requests start the runner for one read');
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'listed');assert.equal(fake.reads(),1,'discovery after requests adds no read');
 const recheck=await new ConnectionLifecycle(store,connections).recheck({commandId:'recheck-one',connectionId:connection.id,expectedConfigHash:connection.configHash});
 assert.equal(recheck.status,'completed');assert.equal(fake.reads(),1,'recheck after requests adds no read');assert.equal(fake.checks(),0);
});

test('repeated settings lifecycle reads start the presence runner only once',async()=>{
 const fake=fakeKeychain([['account','api-key','sentinel-settings-key']]);
 const {store,connections}=await manager(fake);
 for(let n=0;n<3;n++)assert.equal((await new ConnectionLifecycle(store,connections).read()).connections[0]!.credentialStorage,'saved');
 assert.equal(fake.checks(),1);assert.equal(fake.reads(),0);
});

test('repeated app settings reads add no runner start after the connect write',async()=>{
 const fake=fakeKeychain(),store=new InMemoryStore<any>(),service=new AppsService(store,{secrets:fake.secrets,clock:()=>100});
 await service.act({commandId:'install',action:'install',catalogId:'github'});
 await service.decide({commandId:'approve',decisionId:(await service.decisions(null))[0]!.id,answer:'act'});
 await service.act({commandId:'reconnect',action:'reconnect',appId:'app-github'});
 assert.equal((await service.connect({commandId:'save',decisionId:(await service.decisions(null)).find(d=>d.state==='open')!.id,token:'sentinel-app-token'})).status,'committed');
 for(let n=0;n<3;n++)assert.deepEqual((await service.read()).apps[0]!.credential,{slot:'github-token',state:'saved',at:100,connectionId:'save'});
 assert.equal(fake.writes(),1);assert.equal(fake.checks(),0,'presence answers from the value the connect wrote');
});

test('replacing a key serves the next request the new value only',async()=>{
 const fake=fakeKeychain([['account','api-key','sentinel-old-key']]),sent:string[]=[];
 const {store,connections,connection}=await manager(fake,async(_url,init)=>{sent.push(new Headers(init.headers).get('authorization')!);return models();});
 const service=new ConnectionLifecycle(store,connections);
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'listed');
 assert.equal((await service.replaceKey({commandId:'replace-one',connectionId:connection.id,expectedConfigHash:connection.configHash,apiKey:'sentinel-new-key'})).status,'completed');
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'listed');
 assert.deepEqual(sent,['Bearer sentinel-old-key','Bearer sentinel-new-key']);assert.equal(fake.reads(),1);assert.equal(fake.writes(),1);
});

test('deleting the stored slot fails the next request as no credential and sends nothing',async()=>{
 const fake=fakeKeychain([['account','api-key','sentinel-deleted-key']]);let sends=0;
 const {connections,connection}=await manager(fake,async()=>{sends++;return models();});
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'listed');assert.equal(sends,1);
 await fake.secrets.delete(slot);
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'unavailable');assert.equal(sends,1);assert.equal(fake.reads(),1,'remembered absence adds no runner start');
});

test('failed reads keep nothing and the next request starts the runner again',async()=>{
 const outcomes:CliResult[]=[{...result('sentinel-value\n'),timedOut:true},{...result(),aborted:true},result('',1),result('sentinel-value\n')];
 let calls=0;const secrets=new KeychainSecretSlots(async()=>outcomes[calls++]!,'darwin');
 for(let n=0;n<3;n++)await assert.rejects(secrets.read(slot),/Secret slot unavailable/);
 assert.equal(secrets.heldCount(),0);
 assert.equal(await secrets.read(slot),'sentinel-value');assert.equal(calls,4);assert.equal(secrets.heldCount(),1);
 let shared=0;const failing=new KeychainSecretSlots(async()=>{shared++;return {...result(),timedOut:true};},'darwin');
 const both=await Promise.allSettled([failing.read(slot),failing.read(slot)]);
 assert.ok(both.every(r=>r.status==='rejected'));assert.equal(shared,1);assert.equal(failing.heldCount(),0);
});

test('two concurrent first requests share one runner start',async()=>{
 const fake=fakeKeychain([['account','api-key','sentinel-shared-key']]);
 const [a,b]=await Promise.all([fake.secrets.read(slot),fake.secrets.read(slot)]);
 assert.deepEqual([a,b],['sentinel-shared-key','sentinel-shared-key']);assert.equal(fake.reads(),1);assert.equal(fake.secrets.heldCount(),1);
});

test('host drain empties the holder',async t=>{
 const root=await mkdtemp(join(tempRoot(),'secret-memory-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const fake=fakeKeychain([['account','api-key','sentinel-drain-key']]);
 const {store,connections,connection}=await manager(fake),server=createWorkbench(store,root,{connections,secretSlots:fake.secrets,scheduleIntervalMs:0});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 assert.equal((await connections.discover(connection.id,connection.configHash)).status,'listed');assert.equal(fake.secrets.heldCount(),1);
 await server.drain();assert.equal(fake.secrets.heldCount(),0);
});

test('held values reach no serialization, response, journal or error',async()=>{
 const fake=fakeKeychain([['account','api-key','sentinel-never-exposed']]);
 const {store,connections}=await manager(fake),lifecycleRead=await new ConnectionLifecycle(store,connections).read();
 const failing=new KeychainSecretSlots(async()=>result('sentinel-error-leak\n',1),'darwin');
 await assert.rejects(failing.read(slot),error=>error instanceof Error&&error.message==='Secret slot unavailable'&&!String(error.stack).includes('sentinel-error-leak'));
 assert.ok(!JSON.stringify(fake.secrets).includes('sentinel-never-exposed'));
 assert.doesNotMatch(JSON.stringify([lifecycleRead,store.inspect()]),/sentinel-never-exposed|sentinel-error-leak/);
});

test('an imported value is written through the host and later reads start no runner',async()=>{
 const fake=fakeKeychain(),store=new InMemoryStore<any>(),permissions=new PermissionsService(store),source={kind:'import' as const,vendor:'onepassword' as const,reference:'op://v/i/f'};
 const slots=new SourceSecretSlots(fake.secrets,[{secret:slot,source}],permissions,{kind:'connection',id:'binding'},'model-provider',{onepassword:{read:async()=>'sentinel-imported-value'}});
 await permissions.act({commandId:'grant',action:'grant-secret',secret:slot,sourceHash:sourceHash(source),consumer:{kind:'connection',id:'binding'},purpose:'model-provider'});
 assert.equal(await slots.read(slot),'sentinel-imported-value');assert.equal(await slots.read(slot),'sentinel-imported-value');
 assert.equal(fake.writes(),1);assert.equal(fake.reads(),0);
});

test('set and delete update the holder at once; absence is remembered until the next host write',async()=>{
 const fake=fakeKeychain();
 assert.equal(await fake.secrets.read(slot),undefined);
 assert.equal(await fake.secrets.read(slot),undefined);assert.equal(await fake.secrets.has(slot),false);
 assert.equal(fake.reads(),1);assert.equal(fake.checks(),0);
 await fake.secrets.set(slot,'sentinel-replaced');
 assert.equal(await fake.secrets.read(slot),'sentinel-replaced');assert.equal(await fake.secrets.has(slot),true);
 assert.equal(fake.reads(),1);assert.equal(fake.writes(),1);
 await fake.secrets.delete(slot);
 assert.equal(await fake.secrets.read(slot),undefined);assert.equal(await fake.secrets.has(slot),false);
 assert.equal(fake.reads(),1);assert.equal(fake.deletes(),1);
 fake.items.set(JSON.stringify([slot.owner,slot.slot]),'added-outside-massion');
 assert.equal(await fake.secrets.read(slot),undefined,'a value added outside Massion is not seen until restart');
});

test('a read overlapping a replacement cannot remember the superseded value',async()=>{
 const items=new Map([[JSON.stringify([slot.owner,slot.slot]),'sentinel-old']]);
 let reads=0,started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{started=r;}),held=new Promise<void>(r=>{release=r;});
 const secrets=new KeychainSecretSlots(async call=>{
  if(call.args.includes('-w')){reads++;const value=items.get(JSON.stringify([call.args[2]!.slice(8),call.args[4]!]))!;started();await held;return result(value+'\n');}
  const write=setCommand.exec(call.stdin.trim())!;items.set(JSON.stringify([write[1],write[2]]),Buffer.from(write[3]!,'hex').toString());return result();
 },'darwin');
 const slow=secrets.read(slot);await entered;
 await secrets.set(slot,'sentinel-new');release();
 assert.equal(await slow,'sentinel-old');
 assert.equal(await secrets.read(slot),'sentinel-new');assert.equal(reads,1,'the superseded read is not remembered and no new start is needed');
});
