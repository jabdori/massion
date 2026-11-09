import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as lifecycleModule from '../src/connection-lifecycle.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {DomainError} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';

async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'connection-lifecycle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<Mission>(),secrets=new InMemorySecretSlots();let writes=0,reads=0;
 const set=secrets.set.bind(secrets);secrets.set=async(slot,key)=>{assert.deepEqual(slot,{owner:'account',slot:'api-key'});writes++;await set(slot,key);};secrets.read=async()=>{reads++;assert.fail('Replacement and read models cannot read secrets');};
 const manifest=parseHostManifest({version:1,revision:'lifecycle-v1',mode:'https',connections:[{id:'account',label:'Owner API',providerType:'compatible',baseUrl:'https://fixture.example/v1/',models:['fixture'],credential:{ref:'key-ref',slot:'api-key'}}]});
 const connections=createHostConnections(store,new TextArtifactStore(root),{manifest,allowLiveExecution:false},{secrets,readEnvironment:()=>assert.fail('No environment access'),transport:async()=>new Response('{"data":[{"id":"fixture"}]}',{headers:{'content-type':'application/json'}})});
 const connection=connections.list().connections[0]!,command={commandId:'replace-one',connectionId:connection.id,expectedConfigHash:connection.configHash};
 return {store,secrets,connections,command,writes:()=>writes,reads:()=>reads};
}

test('key replacement writes the exact manifest slot once and never reads or persists key bytes',async t=>{
 assert.equal(typeof lifecycleModule.ConnectionLifecycle,'function','Connection lifecycle command service is available');
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections),apiKey='fixture-secret-never-persist';
 const result=await service.replaceKey({...f.command,apiKey});assert.equal(result.status,'completed');assert.equal(f.writes(),1);
 assert.equal((await service.read()).connections[0]!.canReplaceKey,true);
 const replay=await service.replaceKey({...f.command,apiKey:'different-fixture-secret'});assert.equal(replay.status,'completed');assert.equal(f.writes(),1);assert.equal(f.reads(),0);
 assert.doesNotMatch(JSON.stringify([result,replay,await service.read(),f.store.inspect()]),/fixture-secret|api-key|key-ref/);
});

function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}

test('unknown key write is redacted and never resent by a replay, new identity or fresh service',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);let writes=0;
 f.secrets.set=async()=>{writes++;throw Error('fixture-secret-from-keychain');};
 assert.equal((await service.replaceKey({...f.command,apiKey:'fixture-secret-value'})).status,'unknown');
 const fresh=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);
 assert.equal((await fresh.replaceKey({...f.command,apiKey:'fixture-secret-value'})).status,'unknown');
 await assert.rejects(fresh.replaceKey({...f.command,commandId:'replace-another',apiKey:'fixture-secret-value'}),/unresolved/);
 assert.equal(writes,1);assert.doesNotMatch(JSON.stringify([await fresh.read(),f.store.inspect()]),/fixture-secret/);
});

test('invalid key, stale binding and extra client facts are rejected before intent or effects',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);
 for(const body of [{...f.command,apiKey:''},{...f.command,apiKey:'bad\nkey'},{...f.command,apiKey:'é'},{...f.command,apiKey:'x'.repeat(1025)},{...f.command,apiKey:'valid',expectedConfigHash:'0'.repeat(64)},{...f.command,apiKey:'valid',restart:'required'}])await assert.rejects(service.replaceKey(body),e=>e instanceof Error&&e.name==='Error'&&'code' in e);
 assert.equal(f.writes(),0);assert.equal(f.store.inspect().length,0);
});

test('an overlapping command paused after load replays the stored result instead of applying the reducer again',async t=>{
 const f=await fixture(t),loaded=deferred(),release=deferred();let held=false;
 const slow=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{const result=await target.load(id);if(!held){held=true;loaded.resolve();await release.promise;}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const second=new lifecycleModule.ConnectionLifecycle(slow,f.connections).replaceKey({...f.command,apiKey:'fixture-second'});await loaded.promise;
 const first=await new lifecycleModule.ConnectionLifecycle(f.store,f.connections).replaceKey({...f.command,apiKey:'fixture-first'});release.resolve();
 assert.equal(first.status,'completed');assert.equal((await second).status,'completed');assert.equal(f.writes(),1);
});

test('typed host facts expose expiry, update and restart without executing maintenance',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{clock:()=>100,observe:async()=>({status:'expired',update:'available',restart:'required',source:'host'})});
 const result=await service.recheck(f.command);assert.equal(result.status,'completed');assert.deepEqual(result.observation,{status:'expired',update:'available',restart:'required',source:'host',observedAt:100});
 assert.deepEqual((await service.read()).connections[0]!.observation,result.observation);assert.equal(f.writes(),0);
});

test('latest admitted recheck wins when host responses complete out of order',async t=>{
 const f=await fixture(t),started=deferred(),release=deferred();
 const old=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{observe:async()=>{started.resolve();await release.promise;return {status:'expired',update:'unknown',restart:'unknown',source:'host'};}});
 const pending=old.recheck(f.command);await started.promise;
 const fresh=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{observe:async()=>({status:'detected',update:'current',restart:'not-required',source:'host'})});
 assert.equal((await fresh.recheck({...f.command,commandId:'newer-check'})).status,'completed');release.resolve();assert.equal((await pending).status,'stale');
 assert.equal((await fresh.read()).connections[0]!.observation!.status,'detected');
});

test('drain during an asynchronous state load rejects admission without persisting intent or a key',async t=>{
 const f=await fixture(t),loaded=deferred(),release=deferred();let held=false;
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{const result=await target.load(id);if(!held){held=true;loaded.resolve();await release.promise;}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const service=new lifecycleModule.ConnectionLifecycle(store,f.connections),pending=service.replaceKey({...f.command,apiKey:'fixture-key'});await loaded.promise;service.beginDrain();release.resolve();await assert.rejects(pending,/draining/);await service.drain();assert.equal(f.writes(),0);assert.equal(f.store.inspect().length,0);
});

test('drain stops waiting for a trusted observer that ignores abort and discards its late response',async t=>{
 const f=await fixture(t),started=deferred(),release=deferred();t.after(()=>release.resolve());
 const service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{observe:async()=>{started.resolve();await release.promise;return {status:'expired',update:'available',restart:'required',source:'host'};}});
 const pending=service.recheck(f.command);await started.promise;service.beginDrain();
 const result=await Promise.race([pending,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Observer was not interrupted')),100);timer.unref();})]);assert.equal(result.status,'unknown');await service.drain();const before=f.store.inspect();release.resolve();await new Promise(r=>setImmediate(r));assert.deepEqual(f.store.inspect(),before);
});

test('feed replacement during intent load cannot write or expose stale credentials in the replacement database',async t=>{
 const f=await fixture(t),other=new InMemoryStore<Mission>(),loaded=deferred(),release=deferred();let current=f.store,held=false;
 const store=new Proxy(f.store,{get(_target,key){if(key==='load')return async(id:string)=>{const result=await current.load(id);if(!held){held=true;loaded.resolve();await release.promise;}return result;};const v=Reflect.get(current,key);return typeof v==='function'?v.bind(current):v;}});
 const service=new lifecycleModule.ConnectionLifecycle(store,f.connections),pending=service.replaceKey({...f.command,apiKey:'fixture-key'});await loaded.promise;current=other;release.resolve();
 await assert.rejects(pending,/Database|feed/i);assert.equal(f.writes(),0);assert.equal(other.inspect().length,0);
});

test('discovery invalidates a previous same-binding request before it can overwrite newer metadata',async t=>{
 const f=await fixture(t),started=deferred(),release=deferred();let requests=0;
 const compiled=await import('../src/connection-workbench.ts');const manager=new compiled.ConnectionWorkbench(f.store,new TextArtifactStore(tmpdir()),{transport:async()=>{const n=++requests;if(n===1){started.resolve();await release.promise;}return new Response(JSON.stringify({data:[{id:n===1?'old-model':'new-model'}]}),{headers:{'content-type':'application/json'}});},allowFixture:true});
 manager.connect({id:'api',label:'API',providerType:'compatible',baseUrl:'http://127.0.0.1:12345/v1/',mode:'local-http-mock'});const connection=manager.list().connections[0]!,old=manager.discover(connection.id,connection.configHash);await started.promise;
 assert.equal((await manager.discover(connection.id,connection.configHash)).status,'listed');release.resolve();assert.equal((await old).status,'stale');assert.equal(manager.list().connections[0]!.models[0]!.id,'new-model');
});

test('connection aggregate has a reserved identity and strictly replays non-secret intent and observation events',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{clock:()=>101,observe:async()=>({status:'expired',update:'available',restart:'required',source:'host'})});
 await service.replaceKey({...f.command,apiKey:'fixture-secret'});await service.recheck({...f.command,commandId:'observe'});
 const operations=f.store.inspect() as unknown as import('../src/storage.ts').Operation<lifecycleModule.ConnectionLifecycleState>[];
 assert.match(operations[0]!.aggregateId,/^assistant-conversation:/);assert.equal(operations[0]!.value.kind,'connection-lifecycle');
 assert.equal(typeof lifecycleModule.replayConnectionLifecycle,'function');
 for(let n=0;n<operations.length;n++)lifecycleModule.replayConnectionLifecycle(operations[n]!,operations[n-1]);
 const last=operations.at(-1)!,prior=operations.at(-2)!;
 for(const change of [((o:typeof last)=>{o.value.attempts.at(-1)!.observation!.status='detected';}),((o:typeof last)=>{(o.events[0] as any).apiKey='fixture-secret';}),((o:typeof last)=>{o.outbox=[{value:'forged'}];}),((o:typeof last)=>{o.commandId='forged';}),((o:typeof last)=>{o.fingerprint='0'.repeat(64);}),((o:typeof last)=>{o.expectedRevision=0;})]){const bad=structuredClone(last);change(bad);assert.throws(()=>lifecycleModule.replayConnectionLifecycle(bad,prior));}
 assert.equal(lifecycleModule.isConnectionLifecycleState(last.value),true);assert.equal(lifecycleModule.isConnectionLifecycleState({...last.value,apiKey:'forged'}),false);
});

test('environment and CLI bindings reject key editing without reading their credentials',async t=>{
 const f=await fixture(t);
 for(const kind of ['environment','cli']){
  const manifest=parseHostManifest({version:1,revision:'readonly',mode:'https',connections:[kind==='cli'?{id:'readonly',label:'Codex',providerType:'codex-cli',baseUrl:'cli://codex/',models:['fixture']}:{id:'readonly',label:'Environment',providerType:'compatible',baseUrl:'https://fixture.example/v1/',models:['fixture'],credential:{ref:'key-ref',environment:'FIXTURE_SECRET'}}]});
  const manager=createHostConnections(f.store,new TextArtifactStore(tmpdir()),{manifest,allowLiveExecution:false},{secrets:f.secrets,readEnvironment:()=>assert.fail('No read'),transport:async()=>assert.fail('No request')});
  const service=new lifecycleModule.ConnectionLifecycle(f.store,manager),c=manager.list().connections[0]!;
  assert.equal((await service.read()).connections[0]!.canReplaceKey,false);await assert.rejects(service.replaceKey({commandId:kind,connectionId:c.id,expectedConfigHash:c.configHash,apiKey:'fixture-key'}),/editable secret slot/);
 }
 assert.equal(f.writes(),0);assert.equal(f.store.inspect().length,0);
});

test('default model discovery failure remains unavailable and success never proves inference validity',async t=>{
 const f=await fixture(t);f.secrets.read=async()=> 'fixture-value';
 const result=await new lifecycleModule.ConnectionLifecycle(f.store,f.connections).recheck(f.command);
 assert.equal(result.status,'completed');assert.equal(result.observation!.status,'unverified');assert.equal(result.observation!.update,'unknown');assert.equal(result.observation!.restart,'unknown');
 const manager=createHostConnections(f.store,new TextArtifactStore(tmpdir()),{manifest:parseHostManifest({version:1,revision:'fail',mode:'https',connections:[{id:'fail',label:'Fail',providerType:'compatible',baseUrl:'https://fixture.example/v1/',models:['fixture'],credential:{ref:'fail',slot:'api-key'}}]}),allowLiveExecution:false},{secrets:f.secrets,readEnvironment:()=>assert.fail('No environment read'),transport:async()=>new Response('{"error":"expired-key-untrusted"}',{status:401})}),c=manager.list().connections[0]!;
 const failure=await new lifecycleModule.ConnectionLifecycle(f.store,manager).recheck({commandId:'failed-check',connectionId:c.id,expectedConfigHash:c.configHash});
 assert.equal(failure.observation!.status,'unavailable');assert.equal(failure.observation!.restart,'unknown');assert.doesNotMatch(JSON.stringify(f.store.inspect()),/expired-key-untrusted/);
});

test('untrusted extra observer data is discarded instead of reaching state, events or errors',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{observe:async()=>({status:'expired',update:'available',restart:'required',source:'host',raw:'fixture-secret'} as any)});
 assert.equal((await service.recheck(f.command)).status,'unknown');assert.doesNotMatch(JSON.stringify([await service.read(),f.store.inspect()]),/fixture-secret/);
});

test('a lost intent commit acknowledgment yields unknown and a later replay never writes the key',async t=>{
 const f=await fixture(t);let intercepted=false;
 const {CommitOutcomeUnknownError}=await import('../src/storage.ts');
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(!intercepted){intercepted=true;throw new CommitOutcomeUnknownError(input);}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const service=new lifecycleModule.ConnectionLifecycle(store,f.connections);assert.equal((await service.replaceKey({...f.command,apiKey:'fixture-key'})).status,'unknown');
 assert.equal((await service.replaceKey({...f.command,apiKey:'fixture-key'})).status,'unknown');assert.equal(f.writes(),0);
});

test('a definite ownerStore rejection is propagated before any effect',async t=>{
 const f=await fixture(t),{HostDrainError}=await import('../src/runtime-lifetime.ts');
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async()=>{throw new HostDrainError();};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 await assert.rejects(new lifecycleModule.ConnectionLifecycle(store,f.connections).replaceKey({...f.command,apiKey:'fixture-key'}),HostDrainError);assert.equal(f.writes(),0);assert.equal(f.store.inspect().length,0);
});

test('idempotency conflict at settlement replays its persisted result with one secret write',async t=>{
 const f=await fixture(t);
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.commandId.startsWith('assistant-connection-lifecycle:'))return {status:'conflict',reason:'idempotency',revision:result.revision};return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 assert.equal((await new lifecycleModule.ConnectionLifecycle(store,f.connections).replaceKey({...f.command,apiKey:'fixture-key'})).status,'completed');assert.equal(f.writes(),1);
});

test('login recheck bypasses an older status read, invokes only official status and never opens login',async()=>{
 const {LoginConnections}=await import('../src/connection-logins.ts');const started=deferred(),release=deferred();let calls=0;
 const logins=new LoginConnections(async call=>{assert.deepEqual(call.args,['login','status']);const n=++calls;if(n===1){started.resolve();await release.promise;}return {spawned:true,exitCode:n===1?1:0,stdout:'',stderr:n===1?'Not logged in':'Logged in using ChatGPT',timedOut:false,aborted:false,overflow:false};});
 assert.equal(typeof logins.recheck,'function','Fresh provider-specific status is supported');
 const old=logins.recheck('codex-cli');await started.promise;assert.equal((await logins.recheck('codex-cli')).status,'detected');release.resolve();assert.equal((await old).status,'absent');await logins.drain();
});

test('a known key replacement refusal is rejected and does not permanently block a later owner command',async t=>{
 const f=await fixture(t),started=deferred(),release=deferred();
 const saving=f.connections.save(async()=>{started.resolve();await release.promise;});await started.promise;
 const service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);await assert.rejects(service.replaceKey({...f.command,apiKey:'fixture-key'}),DomainError);assert.equal(f.writes(),0);
 release.resolve();await saving;assert.equal((await service.replaceKey({...f.command,commandId:'after-refusal',apiKey:'fixture-key'})).status,'completed');assert.equal(f.writes(),1);
});

test('feed replacement after a key write reports unknown, never an explicit rejection or secret readback',async t=>{
 const f=await fixture(t),other=new InMemoryStore<Mission>();let current=f.store,writes=0;
 const store=new Proxy(f.store,{get(_target,key){const v=Reflect.get(current,key);return typeof v==='function'?v.bind(current):v;}});
 f.secrets.set=async()=>{writes++;current=other;};
 const result=await new lifecycleModule.ConnectionLifecycle(store,f.connections).replaceKey({...f.command,apiKey:'fixture-key'});assert.equal(result.status,'unknown');assert.equal(writes,1);assert.equal(other.inspect().length,0);
});

test('a read held across database replacement refuses facts from the previous feed',async t=>{
 const f=await fixture(t);await new lifecycleModule.ConnectionLifecycle(f.store,f.connections,{observe:async()=>({status:'expired',update:'available',restart:'required',source:'host'})}).recheck(f.command);
 const other=new InMemoryStore<Mission>(),loaded=deferred(),release=deferred();let current=f.store,held=false;
 const store=new Proxy(f.store,{get(_target,key){if(key==='load')return async(id:string)=>{const result=await current.load(id);if(!held){held=true;loaded.resolve();await release.promise;}return result;};const v=Reflect.get(current,key);return typeof v==='function'?v.bind(current):v;}});
 const pending=new lifecycleModule.ConnectionLifecycle(store,f.connections).read();await loaded.promise;current=other;release.resolve();await assert.rejects(pending,/Database.*changed|feed/i);
});

test('declared empty and saved slots expose actual storage presence without secret readback',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);
 assert.equal((await service.read()).connections[0]!.credentialStorage,'missing');assert.equal(await f.connections.credentialStored(f.command.connectionId,f.command.expectedConfigHash),'missing');
 await service.replaceKey({...f.command,apiKey:'fixture-secret-metadata'});assert.equal((await service.read()).connections[0]!.credentialStorage,'saved');
 await f.secrets.delete({owner:'account',slot:'api-key'});assert.equal((await service.read()).connections[0]!.credentialStorage,'missing');assert.equal(f.reads(),0);assert.doesNotMatch(JSON.stringify([await service.read(),f.store.inspect()]),/fixture-secret-metadata/);
});

test('unsupported or failed presence checks stay unknown and stale bindings never probe metadata',async t=>{
 const f=await fixture(t),service=new lifecycleModule.ConnectionLifecycle(f.store,f.connections);let checks=0;
 f.secrets.has=async()=>{checks++;throw Error('private-metadata-error');};assert.equal((await service.read()).connections[0]!.credentialStorage,'unknown');
 await assert.rejects(f.connections.credentialStored(f.command.connectionId,'0'.repeat(64)),/Connection changed/);assert.equal(checks,1);
 (f.secrets as {has?:unknown}).has=undefined;assert.equal((await service.read()).connections[0]!.credentialStorage,'unknown');assert.equal(f.reads(),0);
});

test('a database replacement during metadata lookup refuses the previous feed read',{timeout:1000},async t=>{
 const f=await fixture(t),other=new InMemoryStore<Mission>(),started=deferred(),release=deferred();let current=f.store;
 f.secrets.has=async()=>{started.resolve();await release.promise;return true;};
 const store=new Proxy(f.store,{get(_target,key){const v=Reflect.get(current,key);return typeof v==='function'?v.bind(current):v;}}),pending=new lifecycleModule.ConnectionLifecycle(store,f.connections).read();await started.promise;current=other;release.resolve();await assert.rejects(pending,/Database.*changed|feed/i);assert.equal(f.reads(),0);
});
