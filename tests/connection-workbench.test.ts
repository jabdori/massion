import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import {ConnectionWorkbench} from '../src/connection-workbench.ts';
import {ConnectionLifecycle} from '../src/connection-lifecycle.ts';
import {DomainError} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';

function fixture(store=new InMemoryStore<Mission>()){
 const settings=new InMemoryHostSettings();
 const hooks:{replace?:()=>Promise<void>}={};let requests=0,writes=0;
 const host=()=>new ConnectionWorkbench(store,new TextArtifactStore(tmpdir()),{
  settings,hostBindings:{revision:'fixture-v1',bindingHash:'fixture-binding',connections:['account','other'].map(id=>({input:{id,label:id,providerType:'compatible',baseUrl:'https://fixture.example/v1/',mode:'https',secretRef:id},models:['fixture-model']}))},
  resolveCredential:async()=> 'fixture-key',replaceableConnectionIds:['account'],
  replaceCredential:async()=>{writes++;await hooks.replace?.();},
  transport:async()=>{requests++;return new Response(JSON.stringify({data:[{id:'fixture-model',display_name:'Cached fixture',max_tokens:128}],has_more:true}),{headers:{'content-type':'application/json'}});}
 });
 const connections=host(),connection=connections.list().connections[0]!;
 const command={commandId:'replace-one',connectionId:connection.id,expectedConfigHash:connection.configHash,apiKey:'fixture-replacement-key'};
 const discover=(id=connection.id)=>{const c=connections.list().connections.find(c=>c.id===id)!;return connections.discover(c.id,c.configHash);};
 return {settings,store,hooks,host,connections,command,discover,requests:()=>requests,writes:()=>writes};
}

test('key replacement invalidates only its persisted discovery across a fresh workbench restore',async()=>{
 const f=fixture();assert.equal((await f.discover()).status,'listed');await f.discover('other');
 const cached=f.host();await cached.restoreSettings();assert.equal(cached.list().connections[0]!.models[0]!.label,'Cached fixture');
 const before=f.connections.list(),service=new ConnectionLifecycle(f.store,f.connections);
 assert.equal((await service.replaceKey(f.command)).status,'completed');assert.equal(f.writes(),1);
 assert.deepEqual(f.connections.list().connections[0]!.models,[]);assert.equal(f.connections.list().connections[0]!.discovery,'not-requested');
 const restarted=f.host();await restarted.restoreSettings();const after=restarted.list();
 assert.deepEqual(after.connections[0]!.models,[]);
 assert.deepEqual(after.connections[1]!.models,before.connections[1]!.models);
 assert.equal(after.connections[0]!.configHash,before.connections[0]!.configHash);assert.equal(after.configHash,before.configHash);
 assert.deepEqual(after.runtime,before.runtime);assert.equal(f.requests(),2);
 const rows=await f.settings.loadDiscovery(after.persistence!.scope!);
 assert.equal(rows.find(row=>row.connectionId==='account')!.hasMore,false);
 assert.doesNotMatch(JSON.stringify([after,rows,[...f.settings.rows.values()],f.store.inspect()]),/fixture-replacement-key/);
});

test('an unknown credential write still invalidates persisted discovery and never resends on replay',async()=>{
 const f=fixture();await f.discover();f.hooks.replace=async()=>{throw new DomainError('private-keychain-detail');};
 const service=new ConnectionLifecycle(f.store,f.connections);
 assert.equal((await service.replaceKey(f.command)).status,'unknown');
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().connections[0]!.models,[]);
 assert.equal((await new ConnectionLifecycle(f.store,restarted).replaceKey(f.command)).status,'unknown');assert.equal(f.writes(),1);
 assert.doesNotMatch(JSON.stringify(f.store.inspect()),/private-keychain-detail|fixture-replacement-key/);
});

test('failed discovery invalidation refuses the credential write and permits a new command after recovery',async()=>{
 const f=fixture();await f.discover();const before=f.connections.list().connections[0]!,save=f.settings.saveDiscovery.bind(f.settings);
 f.settings.saveDiscovery=async()=>{throw Error('private-settings-detail');};
 const service=new ConnectionLifecycle(f.store,f.connections);
 await assert.rejects(service.replaceKey(f.command),error=>error instanceof DomainError&&!error.message.includes('private-settings-detail'));
 assert.equal(f.writes(),0);assert.equal((await service.read()).connections[0]!.credentialWriteStatus,'idle');
 assert.deepEqual(f.connections.list().connections[0]!.models,before.models);assert.equal(f.connections.list().connections[0]!.discovery,before.discovery);
 const unchanged=f.host();await unchanged.restoreSettings();assert.deepEqual(unchanged.list().connections[0]!.models,before.models);
 f.settings.saveDiscovery=save;
 assert.equal((await service.replaceKey({...f.command,commandId:'after-recovery'})).status,'completed');assert.equal(f.writes(),1);
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().connections[0]!.models,[]);
});

test('drain while discovery invalidation is pending prevents the credential write',{timeout:1000},async()=>{
 const f=fixture();await f.discover();const save=f.settings.saveDiscovery.bind(f.settings);
 let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),gate=new Promise<void>(r=>release=r);
 f.settings.saveDiscovery=async(...args)=>{started();await gate;await save(...args);};
 const service=new ConnectionLifecycle(f.store,f.connections),pending=service.replaceKey(f.command);
 await Promise.race([entered,pending.then(()=>assert.fail('Replacement must await discovery invalidation'))]);
 f.connections.beginDrain();release();await assert.rejects(pending,DomainError);await f.connections.drain();
 assert.equal(f.writes(),0);assert.equal((await service.read()).connections[0]!.credentialWriteStatus,'idle');
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().connections[0]!.models,[]);
});

test('discovery cannot repopulate the old account cache while a credential write is pending',async()=>{
 const f=fixture();await f.discover();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 f.hooks.replace=async()=>{entered();await held;};const replacing=new ConnectionLifecycle(f.store,f.connections).replaceKey(f.command);await started;
 try{await assert.rejects(f.discover(),/saving|pending|settings/i);assert.equal(f.requests(),1);}finally{release();await replacing;}
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().connections[0]!.models,[]);
});

test('key replacement waits for an old discovery cache write and discards its late result',async()=>{
 const f=fixture(),save=f.settings.saveDiscovery.bind(f.settings);let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 f.settings.saveDiscovery=async(...args)=>{if((args[1] as {models:unknown[]}).models.length){entered();await held;}await save(...args);};
 const discovery=f.discover();await started;const replacing=new ConnectionLifecycle(f.store,f.connections).replaceKey(f.command);
 try{await new Promise(r=>setImmediate(r));assert.equal(f.writes(),0,'old metadata must settle before invalidation and the credential write');}finally{release();}
 assert.equal((await discovery).status,'stale');assert.equal((await replacing).status,'completed');assert.equal(f.writes(),1);
 const restarted=f.host();await restarted.restoreSettings();assert.deepEqual(restarted.list().connections[0]!.models,[]);
});

test('database replacement during cache invalidation cannot write a key for the previous feed',async()=>{
 const original=new InMemoryStore<Mission>(),replacement=new InMemoryStore<Mission>();let active=original;
 const store=new Proxy(original,{get(_target,key){const value=Reflect.get(active,key);return typeof value==='function'?value.bind(active):value;}}),f=fixture(store),save=f.settings.saveDiscovery.bind(f.settings);
 await f.discover();f.settings.saveDiscovery=async(...args)=>{await save(...args);active=replacement;};
 await new ConnectionLifecycle(store,f.connections).replaceKey(f.command).catch(()=>undefined);
 assert.equal(f.writes(),0);assert.equal(replacement.inspect().length,0);
});
