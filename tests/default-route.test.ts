import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {lifetimeFixture} from './support/runtime-lifetime-fixture.ts';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryHostSettings,InMemoryStore,RESTORE_JOURNAL_QUERY,SCHEMA_QUERY,SurrealHostSettings,HOST_SETTINGS_SAVE_QUERY,HOST_SETTINGS_LOAD_QUERY} from '../src/storage.ts';
import type {HostSettingsStore} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {createWorkbench} from '../src/server.ts';
import {DomainError,hash,workInputHash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';

/** Fixture-class only: a local-http-mock manifest and a credential-free chat completion fixture. */
const fixtureManifest=(revision='fixture-v1')=>parseHostManifest({version:1,revision,mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier']}]});
async function setup(t:test.TestContext){
 const f=await lifetimeFixture(t),calls:string[]=[],settings=new InMemoryHostSettings(),hooks:{onCall?:()=>Promise<void>}={};
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);calls.push(body.model);await hooks.onCall?.();const content=prompt.artifact?JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Original bounded',reason:'Controlled exact fixture'}]}):'Original bounded lifetime fixture';return new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:body.model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});};
 const host=(store:HostSettingsStore=settings,revision='fixture-v1')=>createHostConnections(f.store,f.artifacts,{manifest:fixtureManifest(revision),allowLiveExecution:false},{transport,readEnvironment:()=>assert.fail('No credential is read'),settings:store});
 const profile=(m:ReturnType<typeof host>,model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 async function grant(m:ReturnType<typeof host>,id='grant',scope='local',cap=4){await m.save(()=>m.authorize({id,scope,executorProfileId:profile(m,'executor'),verifierProfileId:profile(m,'verifier'),maxOutputTokensPerCall:cap,expectedConfigHash:m.list().configHash}));}
 async function makeDefault(m:ReturnType<typeof host>,id='grant',cap=4){await m.save(()=>m.setDefaultRoute({authorizationId:id,outputTokenCap:cap,expectedConfigHash:m.list().configHash}));}
 return {...f,calls,settings,hooks,host,profile,grant,makeDefault};
}

test('grants, default route and labels survive a restart with identical identities and no startup effect',async t=>{
 const f=await setup(t),m=f.host();await m.restoreSettings();assert.equal(m.list().sessionOnly,false);
 const connection=m.list().connections[0]!;await m.save(()=>m.selectModel(connection.id,{model:'executor',label:'Owner executor',expectedConfigHash:connection.configHash}));
 await f.grant(m);await f.makeDefault(m);const before=m.list();assert.equal(before.persistence!.revision,3);
 const restarted=f.host();assert.equal(restarted.list().grants.length,0);await restarted.restoreSettings();const after=restarted.list();
 assert.equal(after.configHash,before.configHash);assert.deepEqual(after.runtime,before.runtime);assert.deepEqual(after.grants,before.grants);assert.deepEqual(after.persistence,before.persistence);
 assert.equal((after.runtime.connections as any[]).find(p=>p.model==='executor').label,'Owner executor');assert.equal(after.runtime.selectionRequired,false);assert.equal(after.runtime.defaultRoutes[0]!.status,'active');assert.deepEqual(f.calls,[]);
});

test('a run without selection uses the default route; the pin is the route and the result names the source',async t=>{
 const f=await setup(t),m=f.host();await f.grant(m);await f.makeDefault(m);const product=new ProductService(f.store,undefined,m),current=await f.current();
 const check=await product.preflight('mission','fresh',current.revision);assert.equal(check!.ready,true);assert.equal(check!.selection!.source,'default');
 const result=await product.run('mission','fresh','default-run',current.revision) as any;assert.equal(result.status,'settled');assert.equal(result.selection.source,'default');
 const run=(await f.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun!;assert.equal(run.authorizationId,'grant');assert.equal(run.outputTokenCap,4);
 const route=m.configuration().defaultRoutes[0]!;assert.deepEqual(run.connectionBindings,{executor:route.executor,verifier:route.verifier});assert.deepEqual(f.calls,['executor','verifier']);
});

test('no route, another scope or a partial selection never runs and never borrows another grant',async t=>{
 const f=await setup(t),m=f.host(),product=new ProductService(f.store,undefined,m);let current=await f.current();const journal=await f.journal();
 const missing=await product.preflight('mission','fresh',current.revision);assert.equal(missing!.ready,false);assert.equal(missing!.diagnostics.at(-1)!.code,'default_route_missing');
 assert.equal((await product.run('mission','fresh','no-route',current.revision)).status,'blocked');
 await f.grant(m,'other-scope','other');await f.makeDefault(m,'other-scope');await f.grant(m,'local-grant','local');
 const other=await product.run('mission','fresh','other-scope',current.revision);assert.equal(other.status,'blocked');assert.match(other.reason!,/No default route/);
 const partial=await product.preflight('mission','fresh',current.revision,{executorProfileId:f.profile(m,'executor')} as any);assert.equal(partial!.diagnostics.at(-1)!.code,'selection_required');
 assert.deepEqual(await f.journal(),journal);assert.deepEqual(f.calls,[]);
 const explicit={executorProfileId:f.profile(m,'executor'),verifierProfileId:f.profile(m,'verifier'),authorizationId:'local-grant',outputTokenCap:2};current=await f.current();
 assert.equal((await product.run('mission','fresh','explicit',current.revision,explicit)).status,'settled');const pinned=(await f.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun!;assert.equal(pinned.authorizationId,'local-grant');assert.equal(pinned.outputTokenCap,2);
});

test('a stale route is reported and inert, survives restart, and is removed only by revoke',async t=>{
 const f=await setup(t),m=f.host(),product=new ProductService(f.store,undefined,m);await f.grant(m);await f.makeDefault(m);
 const connection=m.list().connections[0]!;await m.save(()=>m.selectModel(connection.id,{model:'executor',label:'Changed label',expectedConfigHash:connection.configHash}));
 const current=await f.current(),stale=await product.preflight('mission','fresh',current.revision);assert.equal(stale!.diagnostics.at(-1)!.code,'default_route_stale');assert.equal((await product.run('mission','fresh','stale',current.revision)).status,'blocked');assert.deepEqual(f.calls,[]);
 const restarted=f.host();await restarted.restoreSettings();assert.equal(restarted.list().grants[0]!.status,'stale');assert.equal(restarted.configuration().defaultRoutes[0]!.status,'stale');
 await restarted.save(()=>restarted.revoke({authorizationId:'grant',expectedConfigHash:restarted.list().configHash}));assert.equal(restarted.configuration().defaultRoutes.length,0);
 await assert.rejects(restarted.save(()=>restarted.authorize({id:'grant',scope:'local',executorProfileId:f.profile(restarted,'executor'),verifierProfileId:f.profile(restarted,'verifier'),maxOutputTokensPerCall:4,expectedConfigHash:restarted.list().configHash})),/already used/);
 const again=f.host();await again.restoreSettings();assert.deepEqual(again.list().revokedAuthorizationIds,['grant']);assert.equal(again.resolveDefault((await f.current()).value).status,'unresolved');
});

test('a default route never lowers its cap to fit the Work budget, and a manifest edit starts an empty scope',async t=>{
 const f=await setup(t),m=f.host(),product=new ProductService(f.store,undefined,m);await f.grant(m,'grant','local',5);await f.makeDefault(m,'grant',5);
 const current=await f.current(),check=await product.preflight('mission','fresh',current.revision);assert.ok(check!.diagnostics.some(d=>d.code==='budget_exceeded'));assert.equal((await product.run('mission','fresh','over',current.revision)).status,'blocked');assert.deepEqual(f.calls,[]);
 const edited=f.host(f.settings,'fixture-v2');await edited.restoreSettings();assert.equal(edited.list().grants.length,0);assert.notEqual(edited.list().persistence!.scope,m.list().persistence!.scope);
});

test('run-sequence without selection resolves one route for every step',async t=>{
 const f=await setup(t),m=f.host(),product=new ProductService(f.store,undefined,m);await f.grant(m);await f.makeDefault(m);const current=await f.current(),w=current.value.works.find(w=>w.id==='fresh')!;
 const result=await product.runSequence('mission',{commandId:'sequence',expectedRevision:current.revision,works:[{workId:'fresh',inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}]}) as any;
 assert.equal(result.status,'completed');assert.equal(result.selection.source,'default');assert.equal(result.selection.choice.authorizationId,'grant');
});

test('live grants restore as live-disabled without the startup option and secret references are never stored',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-live-route-'));t.after(()=>rm(root,{recursive:true,force:true}));const artifacts=new TextArtifactStore(join(root,'artifacts'));
 const manifest=parseHostManifest({version:1,revision:'owner-v1',mode:'https',connections:[{id:'account',label:'Owner account',providerType:'compatible',baseUrl:'https://owner.example/v1/',models:['exec','review'],credential:{ref:'owner-ref',environment:'OWNER_MODEL_SECRET'}}]});
 const settings=new InMemoryHostSettings(),store=new InMemoryStore<Mission>();
 const host=(allowLiveExecution:boolean)=>createHostConnections(store,artifacts,{manifest,allowLiveExecution},{transport:async()=>assert.fail('No send'),readEnvironment:()=>assert.fail('No credential is read'),settings});
 const live=host(true),ids=(live.list().runtime.connections as any[]).map(p=>p.id);await live.save(()=>live.authorize({id:'live-grant',scope:'owner-scope',executorProfileId:ids[0],verifierProfileId:ids[1],maxOutputTokensPerCall:4,expectedConfigHash:live.list().configHash}));await live.save(()=>live.setDefaultRoute({authorizationId:'live-grant',outputTokenCap:4,expectedConfigHash:live.list().configHash}));
 const stored=JSON.stringify([...settings.rows.values()]);assert.doesNotMatch(stored,/owner-ref|OWNER_MODEL_SECRET|secretRef/);
 const off=host(false);await off.restoreSettings();assert.equal(off.list().grants[0]!.status,'live-disabled');assert.equal(off.configuration().authorizations.length,0);assert.equal(off.resolveDefault({scope:'owner-scope'} as Mission).status,'unresolved');
 const on=host(true);await on.restoreSettings();assert.equal(on.list().grants[0]!.status,'active');assert.equal(on.resolveDefault({scope:'owner-scope'} as Mission).status,'resolved');
 const row=[...settings.rows.values()][0]!;(row.value as any).authorizations[0].apiKey='raw';await assert.rejects(host(true).restoreSettings(),/stored document invalid/);
});

test('write conflict adopts stored state; unknown outcomes read back once and fail closed',async t=>{
 const f=await setup(t),a=f.host(),b=f.host();await f.grant(a,'from-a');
 await assert.rejects(f.grant(b,'from-b'),(error:unknown)=>error instanceof DomainError&&error.code==='conflict');assert.deepEqual(b.list().grants.map(g=>g.id),['from-a']);
 let mode:'commit-then-throw'|'commit-then-other'|'other-then-throw'|'throw-unreadable'='commit-then-throw';let readable=true;
 const flaky:HostSettingsStore={load:async scope=>{if(!readable)throw Error('read lost');return f.settings.load(scope);},save:async(scope,revision,writeId,value)=>{if(mode==='commit-then-throw'){await f.settings.save(scope,revision,writeId,value);throw Error('ACK lost');}if(mode==='commit-then-other'){await f.settings.save(scope,revision,writeId,value);await f.settings.save(scope,revision+1,'someone-else',value);throw Error('ACK lost');}if(mode==='other-then-throw'){await f.settings.save(scope,revision,'someone-else',{...(value as any),authorizations:[]});throw Error('ACK lost');}readable=false;throw Error('ACK lost');},loadDiscovery:scope=>f.settings.loadDiscovery(scope),saveDiscovery:(scope,row)=>f.settings.saveDiscovery(scope,row)};
 const c=f.host(flaky);await c.restoreSettings();await f.grant(c,'committed');assert.ok(c.list().grants.some(g=>g.id==='committed'));
 mode='commit-then-other';await assert.rejects(f.grant(c,'superseded'),/later change from elsewhere/);assert.ok(c.list().grants.some(g=>g.id==='superseded'));
 mode='other-then-throw';await assert.rejects(f.grant(c,'lost'),/not applied/);assert.deepEqual(c.list().grants,[]);
 mode='throw-unreadable';await assert.rejects(f.grant(c,'unknown'),/could not be read/);assert.equal(c.list().persistence!.status,'unknown');
 const current=await f.current(),blocked=c.preflight(current,'fresh',current.revision);assert.equal(blocked.diagnostics.at(-1)!.code,'settings_pending');assert.equal(c.resolveDefault(current.value).status,'unresolved');
 readable=true;await assert.rejects(f.grant(c,'after'),/read again/);assert.equal(c.list().persistence!.status,'saved');assert.deepEqual(f.calls,[]);
});

test('a save in flight refuses checks, runs and a second change; the restore guard covers host settings',async t=>{
 const f=await setup(t);let release!:()=>void;const gate=new Promise<void>(r=>release=r);t.after(()=>release());
 const held:HostSettingsStore={...f.settings,load:s=>f.settings.load(s),loadDiscovery:s=>f.settings.loadDiscovery(s),saveDiscovery:(s,r)=>f.settings.saveDiscovery(s,r),save:async(...args)=>{await gate;return f.settings.save(...args);}};
 const m=f.host(held),product=new ProductService(f.store,undefined,m);const pending=f.grant(m);const current=await f.current();
 assert.equal((await product.preflight('mission','fresh',current.revision,{executorProfileId:f.profile(m,'executor'),verifierProfileId:f.profile(m,'verifier'),authorizationId:'grant',outputTokenCap:4}))!.diagnostics.at(-1)!.code,'settings_pending');
 const run=await m.run('mission','fresh','while-saving',current.revision,{executorProfileId:f.profile(m,'executor'),verifierProfileId:f.profile(m,'verifier'),authorizationId:'grant',outputTokenCap:4});assert.equal(run.status,'blocked');
 assert.equal((await product.preflight('mission','fresh',current.revision))!.diagnostics.at(-1)!.code,'settings_pending');assert.equal((await product.run('mission','fresh','default-while-saving',current.revision)).status,'blocked');
 await assert.rejects(f.grant(m,'second'),/being saved/);release();await pending;assert.deepEqual(f.calls,[]);assert.deepEqual(m.list().grants.map(g=>g.id),['grant']);
 assert.match(SCHEMA_QUERY,/massion_host_settings/);assert.match(RESTORE_JOURNAL_QUERY,/SELECT id FROM massion_host_settings LIMIT 1/);
});

test('discovery cache restores only for the same connection hash and never changes a profile hash',async t=>{
 const f=await setup(t),m=f.host(),c=m.list().connections[0]!;await f.settings.saveDiscovery(m.list().persistence!.scope!,{connectionId:c.id,configHash:c.configHash,models:[{id:'executor',label:'Exec model',outputTokenLimit:1024}],hasMore:false});await f.settings.saveDiscovery(m.list().persistence!.scope!,{connectionId:'other',configHash:'0'.repeat(64),models:[],hasMore:false});
 const before=m.list().configHash,restored=f.host();await restored.restoreSettings();assert.equal(restored.list().connections[0]!.discovery,'models-discovered');assert.equal(restored.list().connections[0]!.models[0]!.label,'Exec model');assert.equal(restored.list().configHash,before);
});

test('HTTP: selection must be an object when present; defaults and revoke routes; settings conflict is 409',async t=>{
 const f=await setup(t),m=f.host(),server=createWorkbench(f.store,f.root,{connections:m});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
 const address=server.address() as {port:number},base='http://127.0.0.1:'+address.port;const post=async(path:string,body:unknown)=>{const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const list=()=>fetch(base+'/connections').then(r=>r.json());let catalog=await list();
 assert.equal((await post('/connection-authorizations',{id:'grant',scope:'local',executorProfileId:f.profile(m,'executor'),verifierProfileId:f.profile(m,'verifier'),maxOutputTokensPerCall:4,expectedConfigHash:catalog.configHash})).status,200);catalog=await list();
 assert.equal((await post('/connection-defaults',{authorizationId:'grant',outputTokenCap:4,expectedConfigHash:catalog.configHash})).status,200);catalog=await list();assert.equal(catalog.runtime.defaultRoutes.length,1);assert.equal(catalog.sessionOnly,false);
 const current=await f.current();assert.equal((await post('/missions/mission/preflight',{commandId:'check',expectedRevision:current.revision,workId:'fresh',selection:null})).status,400);
 const check=await post('/missions/mission/preflight',{commandId:'check',expectedRevision:current.revision,workId:'fresh'});assert.equal(check.body.ready,true);assert.equal(check.body.selection.source,'default');
 const ran=await post('/missions/mission/run',{commandId:'http-default',expectedRevision:current.revision,workId:'fresh'});assert.equal(ran.body.status,'settled');assert.equal(ran.body.selection.source,'default');const after=await f.current();
 assert.equal((await post('/missions/mission/run',{commandId:'null-run',expectedRevision:after.revision,workId:'fresh',selection:null})).status,400);assert.equal((await post('/missions/mission/run-sequence',{commandId:'null-sequence',expectedRevision:after.revision,works:[],selection:null})).status,400);
 const revoked=await post('/connection-authorizations/revoke',{authorizationId:'grant',expectedConfigHash:catalog.configHash});assert.equal(revoked.status,200);assert.equal(revoked.body.runtime.defaultRoutes.length,0);
 assert.equal(revoked.body.persistence.status,'saved');assert.equal(revoked.body.persistence.revision,(await f.settings.load(catalog.persistence.scope))!.revision);
 await f.settings.save(catalog.persistence.scope,revoked.body.persistence.revision,'elsewhere',{version:1,selections:[],authorizations:[],defaultRoutes:[],revokedAuthorizationIds:[]});
 assert.equal((await post('/connection-authorizations',{id:'grant-2',scope:'local',executorProfileId:f.profile(m,'executor'),verifierProfileId:f.profile(m,'verifier'),maxOutputTokensPerCall:4,expectedConfigHash:revoked.body.configHash})).status,409);catalog=await list();assert.equal(catalog.grants.length,0);assert.deepEqual(catalog.revokedAuthorizationIds,[]);
 assert.equal((await post('/connection-authorizations/revoke',{authorizationId:'grant',expectedConfigHash:catalog.configHash})).status,400);assert.deepEqual(f.calls,['executor','verifier']);
});

test('an unmanaged host stays session-only even when a settings store is supplied',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-unmanaged-'));t.after(()=>rm(root,{recursive:true,force:true}));const settings=new InMemoryHostSettings(),m=createHostConnections(new InMemoryStore<Mission>(),new TextArtifactStore(join(root,'artifacts')),{allowLiveExecution:false},{transport:async()=>assert.fail('No send'),readEnvironment:()=>assert.fail('No read'),settings});
 await m.restoreSettings();assert.equal(m.list().sessionOnly,true);assert.equal(m.list().persistence,null);assert.equal(settings.rows.size,0);
});

test('another host narrowing the stored settings is read before admission: the old grant and route never run',async t=>{
 const f=await setup(t),a=f.host(),b=f.host();await f.grant(a);await f.makeDefault(a);await b.restoreSettings();const product=new ProductService(f.store,undefined,b);
 await a.save(()=>a.revoke({authorizationId:'grant',expectedConfigHash:a.list().configHash}));assert.equal(b.resolveDefault((await f.current()).value).status,'resolved');
 const current=await f.current(),journal=await f.journal(),result=await product.run('mission','fresh','stale-host',current.revision);assert.equal(result.status,'blocked');assert.match(result.reason!,/changed since this host last read/);
 assert.deepEqual(b.list().grants,[]);assert.deepEqual(b.list().revokedAuthorizationIds,['grant']);assert.equal(b.resolveDefault(current.value).status,'unresolved');assert.deepEqual(await f.journal(),journal);assert.deepEqual(f.calls,[]);
});

test('a default saved by another host is read when this host has none: preflight, run and run-sequence use it',async t=>{
 const f=await setup(t),a=f.host(),b=f.host();await f.grant(a);await b.restoreSettings();const product=new ProductService(f.store,undefined,b);
 assert.equal(b.resolveDefault((await f.current()).value).status,'unresolved');await f.makeDefault(a);
 let current=await f.current();const check=await product.preflight('mission','fresh',current.revision);assert.equal(check!.ready,true);assert.equal(check!.selection!.source,'default');
 const result=await product.run('mission','fresh','other-host-default',current.revision) as any;assert.equal(result.status,'settled');assert.equal(result.selection.source,'default');
 assert.equal((await f.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun!.authorizationId,'grant');assert.deepEqual(f.calls,['executor','verifier']);
 const c=await setup(t),x=c.host(),y=c.host();await c.grant(x);await y.restoreSettings();await c.makeDefault(x);const seq=new ProductService(c.store,undefined,y);
 current=await c.current();const w=current.value.works.find(w=>w.id==='fresh')!;
 const done=await seq.runSequence('mission',{commandId:'seq-other-host',expectedRevision:current.revision,works:[{workId:'fresh',inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}]}) as any;assert.equal(done.status,'completed');
 assert.equal(done.selection.source,'default');assert.equal((await c.current()).value.works.find(w=>w.id==='fresh')!.runtimeRun!.authorizationId,'grant');
});

test('a run requested while the host is busy is refused at entry even when the settings read is slow',async t=>{
 const f=await setup(t);let delay=false,releaseLoad!:()=>void;const gate=new Promise<void>(r=>releaseLoad=r);
 const slow=Object.create(f.settings);slow.load=async(...a:any[])=>{if(delay)await gate;return f.settings.load(...(a as [any]));};
 const m=f.host(slow);await f.grant(m);await f.makeDefault(m);const product=new ProductService(f.store,undefined,m);
 await f.product.admit('mission',{commandId:'admit-second',expectedRevision:(await f.current()).revision,workId:'second',title:'Second step',budget:8});
 let releaseCall!:()=>void,entered!:()=>void;const calling=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>releaseCall=r);f.hooks.onCall=async()=>{f.hooks.onCall=undefined;entered();await held;};
 const current=await f.current(),first=product.run('mission','fresh','first-run',current.revision);await calling;
 const during=await f.current();delay=true;const second=product.run('mission','second','busy-run',during.revision);releaseCall();const done=await first;releaseLoad();const busy=await second;
 assert.equal(done.status,'settled');assert.equal(busy.status,'blocked');assert.equal((await f.current()).value.works.find(w=>w.id==='second')!.runtimeRun,undefined);assert.deepEqual(f.calls,['executor','verifier']);
});

test('a selection-less run or sequence made while busy is refused even when the Mission read is slow',async t=>{
 for(const kind of ['run','sequence'] as const){
  const f=await setup(t),m=f.host();await f.grant(m);await f.makeDefault(m);let delay=false,releaseLoad!:()=>void;const gate=new Promise<void>(r=>releaseLoad=r);
  const store=Object.create(f.store);store.load=async(...a:any[])=>{if(delay)await gate;return f.store.load(...(a as [any]));};const product=new ProductService(store,undefined,m);
  const created=await f.product.create({id:'other',purpose:'Another Mission',scope:'local',constraints:[],criteria:{version:1,description:'Original bounded lifetime fixture',oracle:'bounded-text-review/v1'}},'create-other');
  await f.product.admit('other',{commandId:'admit-other',expectedRevision:(created as any).revision,workId:'second',title:'Second step',budget:8});
  let releaseCall!:()=>void,entered!:()=>void;const calling=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>releaseCall=r);f.hooks.onCall=async()=>{f.hooks.onCall=undefined;entered();await held;};
  const first=product.run('mission','fresh','first-run',(await f.current()).revision);await calling;const other=(await f.store.load('other'))!;delay=true;
  const w=other.value.works.find(w=>w.id==='second')!;
  const second=kind==='run'?product.run('other','second','busy-run',other.revision):product.runSequence('other',{commandId:'busy-seq',expectedRevision:other.revision,works:[{workId:'second',inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}]});
  releaseCall();assert.equal((await first).status,'settled');releaseLoad();const busy=await second as any;
  assert.match(JSON.stringify(busy).slice(0,4000)+JSON.stringify(busy.results??''),/already owned another Work/);
  assert.equal((await f.store.load('other'))!.value.works.find(w=>w.id==='second')!.runtimeRun,undefined);assert.deepEqual(f.calls,['executor','verifier']);
 }
});

test('run-sequence: a default changed between steps stops at the configuration guard and never switches route',async t=>{
 const f=await setup(t),m=f.host(),other=f.host(),product=new ProductService(f.store,undefined,m);await f.grant(m);await f.grant(m,'alt');await f.makeDefault(m);await other.restoreSettings();
 await f.product.admit('mission',{commandId:'admit-second',expectedRevision:(await f.current()).revision,workId:'second',title:'Second step',budget:8});
 let changed=false;f.hooks.onCall=async()=>{if(changed)return;changed=true;await other.save(()=>other.setDefaultRoute({authorizationId:'alt',outputTokenCap:4,expectedConfigHash:other.list().configHash}));};
 const current=await f.current(),works=['fresh','second'].map(id=>{const w=current.value.works.find(w=>w.id===id)!;return {workId:id,inputHash:workInputHash(w),criteriaHash:hash(w.criteria)};});
 const result=await product.runSequence('mission',{commandId:'guarded',expectedRevision:current.revision,works}) as any;
 assert.equal(result.status,'stopped');assert.deepEqual(result.completedWorkIds,['fresh']);assert.equal(result.results[1].status,'blocked');assert.match(result.reason,/changed since this host last read/);assert.equal(result.selection.choice.authorizationId,'grant');
 const after=(await f.current()).value;assert.equal(after.works.find(w=>w.id==='fresh')!.runtimeRun!.authorizationId,'grant');assert.equal(after.works.find(w=>w.id==='second')!.runtimeRun,undefined);assert.deepEqual(f.calls,['executor','verifier']);
});

test('stored routes are unique per scope, grant modes match the manifest, and a default may check on the same profile',async t=>{
 const f=await setup(t),m=f.host();await f.grant(m);await f.makeDefault(m);const row=[...f.settings.rows.values()][0]!,original=structuredClone(row.value) as any;
 (row.value as any).defaultRoutes.push(structuredClone(original.defaultRoutes[0]));await assert.rejects(f.host().restoreSettings(),/stored document invalid/);
 row.value={...structuredClone(original),authorizations:[{...original.authorizations[0],mode:'live'}]};await assert.rejects(f.host().restoreSettings(),/stored document invalid/);
 row.value=structuredClone(original);const fresh=f.host();await fresh.restoreSettings();const same=f.profile(fresh,'executor');
 await fresh.save(()=>fresh.authorize({id:'same',scope:'other',executorProfileId:same,verifierProfileId:same,maxOutputTokensPerCall:4,expectedConfigHash:fresh.list().configHash}));
 await fresh.save(()=>fresh.setDefaultRoute({authorizationId:'same',outputTokenCap:4,expectedConfigHash:fresh.list().configHash}));const route=fresh.list().runtime.defaultRoutes.find((r:any)=>r.authorizationId==='same')!;assert.equal(route.status,'active');assert.equal(route.check,'same-family');
});

test('SurrealHostSettings: committed, conflict, invalid write result, NONE and field mapping over a fake transport',async()=>{
 const sent:{sql:string;vars:Record<string,unknown>}[]=[];let reply:unknown[]=[];const settings=new SurrealHostSettings({query:async(sql,vars)=>{sent.push({sql,vars});return reply;}},()=>new Date('2026-01-01T00:00:00.000Z'));
 reply=[null];assert.equal(await settings.load('scope'),null);assert.equal(sent[0]!.sql,HOST_SETTINGS_LOAD_QUERY);assert.doesNotMatch(HOST_SETTINGS_LOAD_QUERY,/\bvalue\b/);
 reply=[{revision:2,writeId:'w',updatedAt:'t',settings:{version:1}}];assert.deepEqual(await settings.load('scope'),{revision:2,writeId:'w',updatedAt:'t',value:{version:1}});
 reply=[{revision:2,writeId:'w',updatedAt:'t'}];await assert.rejects(settings.load('scope'),/Invalid stored host settings/);
 reply=[null,{status:'committed',revision:3,updatedAt:'2026-01-01T00:00:00.000Z'},null];assert.deepEqual(await settings.save('scope',2,'w2',{version:1}),{status:'committed',revision:3,updatedAt:'2026-01-01T00:00:00.000Z'});
 const vars=sent.at(-1)!.vars;assert.equal(sent.at(-1)!.sql,HOST_SETTINGS_SAVE_QUERY);assert.deepEqual({expectedRevision:vars.expectedRevision,writeId:vars.writeId,settings:vars.settings,scope:vars.scope},{expectedRevision:2,writeId:'w2',settings:{version:1},scope:'scope'});assert.match(HOST_SETTINGS_SAVE_QUERY,/settings: \$settings/);
 reply=[{status:'conflict',revision:5}];assert.deepEqual(await settings.save('scope',2,'w3',{}),{status:'conflict',revision:5});
 reply=[{status:'committed',revision:5,updatedAt:'t'}];await assert.rejects(settings.save('scope',2,'w4',{}),/Invalid host settings write result/);
 reply=[{status:'committed',revision:1,updatedAt:'t'},{status:'committed',revision:1,updatedAt:'t'}];await assert.rejects(settings.save('scope',0,'w5',{}),/one transaction RETURN/);
});

test('SurrealHostSettings on an actual database: round trip and two concurrent writers commit once',{skip:!process.env.SURREAL_TEST_RUNTIME&&'Owned disposable actual SurrealDB required'},async t=>{
 const f=await lifetimeFixture(t,true);assert.ok(f.transport);const a=new SurrealHostSettings(f.transport),b=new SurrealHostSettings(f.transport),scope='manifest:'+'0'.repeat(64);
 assert.equal(await a.load(scope),null);const outcomes=await Promise.allSettled([a.save(scope,0,'writer-a',{version:1,from:'a'}),b.save(scope,0,'writer-b',{version:1,from:'b'})]);
 const committed=outcomes.filter(o=>o.status==='fulfilled'&&o.value.status==='committed') as PromiseFulfilledResult<{status:'committed';revision:number}>[];assert.equal(committed.length,1);assert.equal(committed[0]!.value.revision,1);
 const row=(await b.load(scope))!;assert.equal(row.revision,1);assert.ok(['writer-a','writer-b'].includes(row.writeId));assert.deepEqual(row.value,{version:1,from:row.writeId==='writer-a'?'a':'b'});
 assert.deepEqual(await a.save(scope,0,'late',{version:1}),{status:'conflict',revision:1});assert.equal((await a.save(scope,1,'next',{version:1})).status,'committed');
});
