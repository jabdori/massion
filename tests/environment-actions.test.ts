import test from 'node:test';
import assert from 'node:assert/strict';
import {EnvironmentActions} from '../src/environment-actions.ts';
import type {EnvironmentAction,EnvironmentObservation,EnvironmentAdapter,ActionInput,OwnerWait,EnvironmentGate} from '../src/environment.ts';
import {InMemoryStore,CommitOutcomeUnknownError,withAdmissionFeed} from '../src/storage.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {hash} from '../src/domain.ts';
import {exportPortableBackup,parsePortableBackup} from '../src/portable-backup.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';

class FakeEnvironment implements EnvironmentAdapter {
 observation:EnvironmentObservation={binding:{environment:'fixture',surface:'surface',origin:'fixture://local',generation:1,revision:1},structure:[{id:'control',role:'button',label:'Continue',operations:['click','type','key','select','scroll','submit'],gates:[{kind:'irreversible-submit'}]}],facts:{confirmed:false},image:{handle:'image-1',expiresAt:2000}};
 delivered:EnvironmentAction[]=[];reads=0;secretBytes:Uint8Array|undefined;beforeAct?:()=>void;holdRead?:()=>Promise<void>;
 async observe(_signal:AbortSignal):Promise<EnvironmentObservation>{this.reads++;const observation=structuredClone(this.observation);await this.holdRead?.();return observation;}
 async act(action:EnvironmentAction,context:Parameters<EnvironmentAdapter['act']>[1]){
  const current=()=>{assert.ok(!context.signal.aborted);assert.deepEqual(action.binding,this.observation.binding);const node=this.observation.structure.find(e=>e.id===action.element);assert.ok(node&&node.operations.includes(action.input.kind));const gates=structuredClone(node.gates);if(action.input.kind==='submit'&&!gates.length)gates.push({kind:'irreversible-submit'});assert.deepEqual(action.gates,gates);};
  this.beforeAct?.();current();let bytes:Uint8Array|undefined;
  try{if(action.input.kind==='type'){assert.ok(context.secret);bytes=await context.secret();this.secretBytes=bytes;current();assert.ok(bytes.length>0);}this.delivered.push(structuredClone(action));}
  finally{bytes?.fill(0);}
 }
 change(patch:Partial<EnvironmentObservation>={}){this.observation={...this.observation,...patch,binding:{...this.observation.binding,...patch.binding,revision:this.observation.binding.revision+1}};}
}
const wait:OwnerWait={kind:'confirm-on-device',who:'Owner',what:'Confirm request',where:'Own device',fact:'confirmed',from:false,to:true,timeoutMs:10000,maxPolls:3,intervalMs:1000};
function setup(gates:EnvironmentGate[]=[{kind:'irreversible-submit'}]){
 const store=new InMemoryStore<any>(),adapter=new FakeEnvironment();adapter.observation.structure[0]!.gates=gates;let now=1000;
 const create=(ownerStore=store)=>new EnvironmentActions(store,ownerStore,adapter,{owner:'local-owner',environment:'fixture',clock:()=>now,callTimeoutMs:20,resolveSecret:async()=>new TextEncoder().encode('fixture-private-value')});
 const service=create();return {store,adapter,service,create,tick:(ms=1000)=>{now+=ms;},read:async()=>service.state(),propose:(input:ActionInput={kind:'click'})=>service.propose('step','control',input)};
}

test('every action operation is bound to its element and exact approval hash; changed approvals are rejected',async()=>{
 const inputs:ActionInput[]=[{kind:'click'},{kind:'type',secret:{owner:'local-owner',slot:'login'}},{kind:'key',key:'Enter'},{kind:'select',option:'one'},{kind:'scroll',x:0,y:100},{kind:'submit'}];
 for(const input of inputs){const s=setup();const entry=await s.propose(input);assert.equal(entry.status,'waiting');await assert.rejects(s.service.answer('tampered','step',hash('changed'),'approve'),/hash/i);await s.service.answer('approve','step',entry.hash,'approve');await s.service.execute('step',hash('changed')).then(()=>assert.fail('tampering accepted'),()=>{});await s.service.execute('step',entry.hash);assert.equal(s.adapter.delivered.length,1);assert.deepEqual(s.adapter.delivered[0]!.input,input);assert.equal((await s.read()).entries[0]!.status,'delivered');validateMissionJournalLineage(s.store.inspect());}
});

test('all sensitive gates require explicit answers, and payment intents remain non-executable',async()=>{
 const gates:EnvironmentGate[]=[{kind:'account-creation'},{kind:'personal-data-submission'},{kind:'terms-acceptance'},{kind:'irreversible-submit'},{kind:'payment',intent:{kind:'payment-intent',payee:'Fixture recipient',amountMinor:100,currency:'USD',purpose:'Fixture service',sourceReference:'work:fixture'}}];
 for(const gate of gates){const s=setup([gate]),entry=await s.propose();await assert.rejects(s.service.execute('step',entry.hash),/approval|waiting/i);await s.service.answer('approve','step',entry.hash,'approve');if(gate.kind==='payment'){await assert.rejects(s.service.execute('step',entry.hash),/payment/i);assert.equal(s.adapter.delivered.length,0);}else{await s.service.execute('step',entry.hash);assert.equal(s.adapter.delivered.length,1);}}
});

test('overlapping identical owner commands and execution claims replay without delivering twice',async()=>{
 const s=setup(),entry=await s.propose();await Promise.all([1,2].map(()=>s.service.answer('approve','step',entry.hash,'approve')));
 await Promise.all([1,2].map(()=>s.service.execute('step',entry.hash)));await s.create().execute('step',entry.hash);assert.equal(s.adapter.delivered.length,1);
 await assert.rejects(s.service.answer('approve','step',entry.hash,'decline'),/identity|conflict/i);validateMissionJournalLineage(s.store.inspect());
});

test('surface, origin, generation and policy changes between approval and act invalidate the action',async()=>{
 for(const field of ['surface','origin','generation','policy'] as const){const s=setup(),entry=await s.propose();await s.service.answer('approve','step',entry.hash,'approve');if(field==='policy')s.adapter.observation.structure[0]!.gates=[];else if(field==='generation')s.adapter.observation.binding.generation++;else s.adapter.observation.binding[field]+='-changed';await s.service.execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'invalidated');}
});

test('navigation during adapter dispatch is unknown and never retried',async()=>{
 for(const change of ['generation','policy']){const s=setup([]),entry=await s.propose();s.adapter.beforeAct=()=>{if(change==='generation')s.adapter.observation.binding.generation++;else s.adapter.observation.structure[0]!.gates=[{kind:'account-creation'}];};await s.service.execute('step',entry.hash);assert.equal((await s.read()).entries[0]!.status,'unknown');await s.create().execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);}
});

test('a lost claim response authorizes neither initial dispatch nor restart replay',async()=>{
 const s=setup([]),entry=await s.propose();const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events[0].command.type==='claim')throw new CommitOutcomeUnknownError(input);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 await assert.rejects(s.create(owner).execute('step',entry.hash),CommitOutcomeUnknownError);await s.create().execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'unknown');
});

test('owner writes and claims use the drain-aware store and reject a replaced database feed',async()=>{
 for(const type of ['answer','claim']){const s=setup(),entry=await s.propose();if(type==='claim')await s.service.answer('approve','step',entry.hash,'approve');const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0].command.type===type)throw new HostDrainError();return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});const service=s.create(owner);await assert.rejects(type==='answer'?service.answer('approve','step',entry.hash,'approve'):service.execute('step',entry.hash),HostDrainError);assert.equal(s.adapter.delivered.length,0);}
 const s=setup(),entry=await s.propose();await assert.rejects(withAdmissionFeed('replaced',()=>s.service.answer('approve','step',entry.hash,'approve')),/feed/i);
});

test('owner wait survives restart; page claims cannot complete it, only the pinned fact transition can',async()=>{
 const s=setup(),entry=await s.service.wait('step',wait);s.adapter.observation.structure[0]!.label='confirmed';await s.service.poll('step');assert.equal((await s.read()).entries[0]!.status,'waiting');assert.equal(s.adapter.delivered.length,0);
 s.tick();const restarted=s.create();s.adapter.change({facts:{confirmed:true}});await restarted.poll('step');assert.equal((await s.read()).entries[0]!.status,'completed');assert.equal((await s.read()).entries[0]!.polls,2);assert.equal((await s.read()).entries[0]!.hash,entry.hash);validateMissionJournalLineage(s.store.inspect());
});

test('human checks and enter-value waits are read-only; approval waits require owner authority',async()=>{
 for(const kind of ['human-check','enter-value'] as const){const s=setup();await s.service.wait('step',{...wait,kind});await s.service.poll('step');assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'waiting');}
 const s=setup(),entry=await s.service.wait('step',{kind:'approve',who:'Owner',what:'Approve step',where:'Fixture surface',timeoutMs:10000});await assert.rejects(s.service.poll('step'),/approval/i);await s.service.answer('approve','step',entry.hash,'approve');assert.equal((await s.read()).entries[0]!.status,'completed');
});

test('decline, cancel, elapsed deadlines and poll limits are durable terminal states',async()=>{
 for(const answer of ['decline','cancel'] as const){const s=setup(),entry=await s.service.wait('step',wait);await s.service.answer(answer,'step',entry.hash,answer);await s.create().poll('step');assert.equal((await s.read()).entries[0]!.status,answer==='decline'?'declined':'cancelled');assert.equal(s.adapter.reads,1);}
 for(const expired of [true,false]){const s=setup();await s.service.wait('step',{...wait,maxPolls:1});if(expired)s.tick(10001);await s.service.poll('step');if(!expired){s.tick();await s.create().poll('step');}assert.equal((await s.read()).entries[0]!.status,'timed-out');assert.equal(s.adapter.reads,expired?1:2);}
});

test('a late poll cannot overwrite cancellation or a newer poll reservation',async()=>{
 const s=setup(),entry=await s.service.wait('step',wait);let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);s.adapter.holdRead=async()=>{entered();await new Promise<void>(r=>release=r);};const polling=s.service.poll('step');await ready;await s.service.answer('cancel','step',entry.hash,'cancel');release();await polling;assert.equal((await s.read()).entries[0]!.status,'cancelled');
});

test('secret fill persists references only, masks subsequent observations, and erases boundary bytes',async()=>{
 const s=setup([]),entry=await s.propose({kind:'type',secret:{owner:'local-owner',slot:'login'}});await s.service.execute('step',entry.hash);assert.ok(s.adapter.secretBytes?.every(byte=>byte===0));assert.ok(!JSON.stringify(s.store.inspect()).includes('fixture-private-value'));assert.ok(!JSON.stringify(s.adapter.delivered).includes('fixture-private-value'));const observation=await s.create().observe();assert.deepEqual(observation.structure,[]);assert.equal(observation.image,null);assert.deepEqual(observation.facts,{});
 const other=setup([]);await assert.rejects(other.propose({kind:'type',secret:{owner:'another-owner',slot:'login'}}),/owner/i);await assert.rejects(other.propose({kind:'type',value:'literal-secret'} as any),/fields|secret/i);
});

test('malformed observations and wait bounds fail closed without recording untrusted bytes',async()=>{
 const s=setup();s.adapter.observation.structure[0]!.gates=[{kind:'invented'} as any];await assert.rejects(s.propose());assert.equal(s.store.inspect().length,0);
 for(const patch of [{maxPolls:0},{timeoutMs:86400001},{intervalMs:0},{from:true,to:true}]){const x=setup();await assert.rejects(x.service.wait('step',{...wait,...patch}));assert.equal(x.store.inspect().length,0);}
});

test('submit without a declared policy still requires approval, and caller mutation cannot change retained input',async()=>{
 const s=setup([]),input:ActionInput={kind:'select',option:'one'},entry=await s.propose(input);input.option='two';await s.service.execute('step',entry.hash);assert.equal((s.adapter.delivered[0]!.input as Extract<ActionInput,{kind:'select'}>).option,'one');
 const submit=setup([]),proposal=await submit.propose({kind:'submit'});assert.equal(proposal.status,'waiting');await assert.rejects(submit.service.execute('step',proposal.hash),/approval/i);
});

test('secret boundary rechecks navigation after resolving; a lost action reply remains unknown after restart',async()=>{
 const s=setup([]),entry=await s.propose({kind:'type',secret:{owner:'local-owner',slot:'login'}});let bytes:Uint8Array|undefined;
 const service=new EnvironmentActions(s.store,s.store,s.adapter,{owner:'local-owner',environment:'fixture',clock:()=>1000,resolveSecret:async()=>{s.adapter.observation.binding.generation++;bytes=new TextEncoder().encode('private-fixture');return bytes;}});
 await service.execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.ok(bytes?.every(b=>b===0));assert.equal((await s.read()).entries[0]!.status,'unknown');assert.ok(!JSON.stringify(s.store.inspect()).includes('private-fixture'));
 const x=setup([]),action=await x.propose();let release!:()=>void,calls=0;x.adapter.act=async()=>{calls++;await new Promise<void>(r=>release=r);};await x.service.execute('step',action.hash);assert.equal((await x.read()).entries[0]!.status,'unknown');release();await x.create().execute('step',action.hash);assert.equal(calls,1);await assert.rejects(x.service.propose('next','control',{kind:'click'}),/unresolved/i);
});

test('a newer poll wins over an older response and parallel polls consume only one reservation',async()=>{
 const s=setup();await s.service.wait('step',wait);let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);let first=true;
 s.adapter.holdRead=async()=>{if(first){first=false;entered();await new Promise<void>(r=>release=r);}};const older=s.service.poll('step');await ready;s.tick();s.adapter.change({facts:{confirmed:true}});await s.create().poll('step');release();await older;assert.equal((await s.read()).entries[0]!.status,'completed');assert.equal((await s.read()).entries[0]!.polls,2);
 const x=setup();await x.service.wait('step',wait);await Promise.all([x.service.poll('step'),x.service.poll('step')]);assert.equal((await x.read()).entries[0]!.polls,1);assert.equal(x.adapter.reads,2);
});

test('out-of-order public observations are discarded and elapsed deadlines are visible without new events',async()=>{
 const s=setup();let release!:()=>void,entered!:()=>void,first=true;const ready=new Promise<void>(r=>entered=r);
 s.adapter.holdRead=async()=>{if(first){first=false;entered();await new Promise<void>(r=>release=r);}};const old=s.service.observe();await ready;s.adapter.change();await s.service.observe();release();await assert.rejects(old,/stale/i);
 const x=setup();await x.service.wait('step',wait);const count=x.store.inspect().length;x.tick(10001);assert.equal((await x.read()).entries[0]!.status,'timed-out');assert.equal(x.store.inspect().length,count);
});

test('portable replay detects tampered requests, counters, decisions and taint without adapter calls',async()=>{
 const s=setup(),entry=await s.propose();await s.service.answer('approve','step',entry.hash,'approve');await s.service.execute('step',entry.hash);validateMissionJournalLineage(s.store.inspect());
 for(const field of ['hash','polls','status'] as const){const operations=s.store.inspect(),last=operations.at(-1)!;last.value.entries[0][field]=field==='hash'?hash('forged'):field==='polls'?4:'waiting';assert.throws(()=>validateMissionJournalLineage(operations),/environment|transition/i);}
 const x=setup([]),action=await x.propose({kind:'type',secret:{owner:'local-owner',slot:'login'}});await x.service.execute('step',action.hash);const operations=x.store.inspect();operations.at(-1)!.value.tainted=false;assert.throws(()=>validateMissionJournalLineage(operations),/transition/i);
});

test('a pending owner wait exports and parses as inert portable history without image artifacts',async()=>{
 const s=setup();await s.service.wait('step',wait);await s.service.poll('step');const operations=[...s.store.inspect()];
 const serialized=await exportPortableBackup({exportJournal:async()=>({schemaVersion:2,head:operations.length,operations})},new TextArtifactStore('/private/tmp/ru1-no-artifacts'));
 const backup=parsePortableBackup(serialized);assert.deepEqual(backup.artifacts,[]);assert.deepEqual(backup.blobs,[]);assert.ok(!serialized.includes('image-1'));assert.equal((backup.journal.operations.at(-1)!.value as any).entries[0].polls,1);
 const restored=new InMemoryStore<any>();for(const op of operations)await restored.commit({id:op.aggregateId,expectedRevision:op.expectedRevision,commandId:op.commandId,fingerprint:op.fingerprint,value:op.value,events:op.events,outbox:op.outbox});
 const replacement=new EnvironmentActions(restored,restored,s.adapter,{owner:'local-owner',environment:'fixture'});await assert.rejects(replacement.poll('step'),/feed/i);
});

test('read-only polling is bounded by the remaining wait deadline, not a longer adapter timeout',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:1000});
 const store=new InMemoryStore<any>(),adapter=new FakeEnvironment();const service=new EnvironmentActions(store,store,adapter,{owner:'local-owner',environment:'fixture',callTimeoutMs:1000});
 await service.wait('step',{...wait,timeoutMs:30});let aborted=false,entered!:()=>void;const ready=new Promise<void>(r=>entered=r);adapter.observe=async signal=>{signal.addEventListener('abort',()=>{aborted=true;});entered();return new Promise(()=>{});};const polling=service.poll('step');await ready;t.mock.timers.tick(30);assert.equal(aborted,true);await polling;assert.equal((await service.state()).entries[0]!.status,'timed-out');
});

test('adapter observation errors cannot expose private page values through a public error',async()=>{
 const s=setup([]),entry=await s.propose({kind:'type',secret:{owner:'local-owner',slot:'login'}});await s.service.execute('step',entry.hash);s.adapter.observe=async()=>{throw new Error('fixture-private-value');};
 await assert.rejects(s.service.observe(),error=>error instanceof Error&&!String(error.stack).includes('fixture-private-value')&&!error.cause);
});

test('observing another surface permanently invalidates an approval even after returning to its original binding',async()=>{
 for(const field of ['surface','origin','generation'] as const){const s=setup(),entry=await s.propose();await s.service.answer('approve','step',entry.hash,'approve');const original=structuredClone(s.adapter.observation.binding);if(field==='generation')s.adapter.observation.binding.generation++;else s.adapter.observation.binding[field]+='-changed';await s.service.observe();s.adapter.observation.binding=original;await s.create().execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'invalidated');validateMissionJournalLineage(s.store.inspect());}
});

test('expired waits and ready actions retire durably before admitting the next step',async()=>{
 for(const kind of ['action','wait'] as const){const s=setup([]);if(kind==='action')await s.propose();else await s.service.wait('step',wait);s.tick(300001);assert.equal((await s.read()).entries[0]!.status,'timed-out');await s.create().propose('next','control',{kind:'click'});const state=await s.read();assert.equal(state.entries[0]!.status,'timed-out');assert.equal(state.entries[1]!.status,'ready');validateMissionJournalLineage(s.store.inspect());}
});

test('replacing a live environment with an empty feed cannot erase secret taint',async()=>{
 const first=new InMemoryStore<any>();let active=first;const proxy=new Proxy(first,{get(_target,key){const value=Reflect.get(active,key);return typeof value==='function'?value.bind(active):value;}}),adapter=new FakeEnvironment();adapter.observation.structure[0]!.gates=[];
 const service=new EnvironmentActions(proxy,proxy,adapter,{owner:'local-owner',environment:'fixture',clock:()=>1000,resolveSecret:async()=>new TextEncoder().encode('private-fixture')});const entry=await service.propose('step','control',{kind:'type',secret:{owner:'local-owner',slot:'login'}});await service.execute('step',entry.hash);active=new InMemoryStore();const reads=adapter.reads;await assert.rejects(service.observe(),/feed/i);assert.equal(adapter.reads,reads);assert.equal(active.inspect().length,0);
});

test('an observation started before proposal invalidates an approval created while the adapter read is pending',async()=>{
 const s=setup();let release!:()=>void,entered!:()=>void,first=true;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),read=s.adapter.observe.bind(s.adapter);
 s.adapter.observe=async signal=>{if(!first)return read(signal);first=false;entered();await gate;return structuredClone(s.adapter.observation);};
 const observing=s.service.observe();await ready;const entry=await s.propose();await s.service.answer('approve','step',entry.hash,'approve');const original=structuredClone(s.adapter.observation.binding);s.adapter.observation.binding.surface='other';release();await observing;s.adapter.observation.binding=original;
 await s.create().execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'invalidated');validateMissionJournalLineage(s.store.inspect());
});

test('observation reconciliation retries against an approval committed during its store write',async()=>{
 const s=setup(),original=structuredClone(s.adapter.observation.binding);s.adapter.observation.binding.surface='other';let release!:()=>void,entered!:()=>void,held=false;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const owner=new Proxy(s.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(!held&&input.events[0].command.type==='observe'&&input.events[0].command.binding.surface==='other'){held=true;entered();await gate;}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const service=s.create(owner),observing=service.observe();await ready;s.adapter.observation.binding=original;const entry=await service.propose('step','control',{kind:'click'});await service.answer('approve','step',entry.hash,'approve');release();await observing;
 await service.execute('step',entry.hash);assert.equal(s.adapter.delivered.length,0);assert.equal((await s.read()).entries[0]!.status,'invalidated');validateMissionJournalLineage(s.store.inspect());
});
