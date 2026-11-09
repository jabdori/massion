import test from 'node:test';
import assert from 'node:assert/strict';
import {AppsService,APPS_ID} from '../src/apps.ts';
import {FeedAdmissionError,InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const ref={owner:'app-github',slot:'github-token'};
class MetadataOnlySlots extends InMemorySecretSlots {
 override async read():Promise<string|undefined>{assert.fail('App settings must never read secret values');}
}
async function setup(){
 const store=new InMemoryStore<any>(),slots=new MetadataOnlySlots(),service=new AppsService(store,{secrets:slots,clock:()=>100});
 await service.act({commandId:'install',action:'install',catalogId:'github'});
 await service.decide({commandId:'approve',decisionId:(await service.decisions(null))[0]!.id,answer:'act'});
 await service.act({commandId:'reconnect',action:'reconnect',appId:ref.owner});
 const input={commandId:'save',decisionId:(await service.decisions(null)).find(d=>d.state==='open')!.id,token:'private-presence-sentinel'};
 assert.equal((await service.connect(input)).status,'committed');
 return {store,slots,service,input};
}
async function restore(store:InMemoryStore<any>){
 const restored=new InMemoryStore<any>();
 for(const op of store.inspect())assert.equal((await restored.commit({id:op.aggregateId,expectedRevision:op.expectedRevision,commandId:op.commandId,fingerprint:op.fingerprint,value:op.value,events:op.events,outbox:op.outbox})).status,'committed');
 return restored;
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

test('deleted app slot overrides the saved receipt without changing history or replaying the save',async()=>{
 const f=await setup();assert.deepEqual((await f.service.read()).apps[0]!.credential,{slot:ref.slot,state:'saved',at:100,connectionId:'save'});
 const journal=f.store.inspect();await f.slots.delete(ref);
 assert.equal((await f.service.read()).apps[0]!.credential!.state,'missing');
 assert.equal((await f.service.connect(f.input)).status,'replayed');assert.equal(await f.slots.has(ref),false);
 assert.deepEqual(f.store.inspect(),journal);validateMissionJournalLineage(journal as any);
 assert.ok(!JSON.stringify([journal,await f.service.read()]).includes(f.input.token));
 await f.service.act({commandId:'reconnect-after-delete',action:'reconnect',appId:ref.owner});
 assert.ok((await f.service.decisions(null)).some(d=>d.state==='open'&&d.connection?.slot===ref.slot));
});

test('fresh service over a restored app journal reports missing on a machine without its secret slot',async()=>{
 const f=await setup(),store=await restore(f.store),slots=new MetadataOnlySlots(),service=new AppsService(store,{secrets:slots});
 assert.notEqual((await store.readState()).feedId,(await f.store.readState()).feedId);
 assert.equal((await service.read()).apps[0]!.credential!.state,'missing');
 assert.equal((await store.load(APPS_ID))!.value.apps[0].credential.state,'saved');
 assert.equal((await service.connect(f.input)).status,'replayed');assert.equal(await slots.has(ref),false);
});

test('metadata failures project unknown without exposing errors or certifying the saved receipt',async()=>{
 const f=await setup(),secrets={set:f.slots.set.bind(f.slots),has:async()=>{throw Error('private-metadata-sentinel');}},service=new AppsService(f.store,{secrets});
 const journal=f.store.inspect(),read=await service.read();assert.equal(read.apps[0]!.credential!.state,'unknown');
 assert.ok(!JSON.stringify(read).includes('sentinel'));assert.deepEqual(f.store.inspect(),journal);
});

test('pending connection still fences reconnect when the slot is absent or present after restart',async()=>{
 const f=await setup();await f.service.act({commandId:'retry',action:'reconnect',appId:ref.owner});
 const decision=(await f.service.decisions(null)).find(d=>d.state==='open')!,secrets={set:async()=>{throw Error('unresolved write');},has:f.slots.has.bind(f.slots)};
 const service=new AppsService(f.store,{secrets});assert.equal((await service.connect({commandId:'pending-save',decisionId:decision.id,token:'private-pending-sentinel'})).status,'unknown');
 for(const present of [false,true]){
  if(present)await f.slots.set(ref,'private-present-sentinel');else await f.slots.delete(ref);
  const restarted=new AppsService(f.store,{secrets:f.slots});
  assert.deepEqual((await restarted.read()).apps[0]!.credential,{slot:ref.slot,state:'unknown',connectionId:'pending-save'});
  await assert.rejects(restarted.act({commandId:'blocked-reconnect',action:'reconnect',appId:ref.owner}),/pending|unknown/i);
 }
});

test('presence retains observed expiry and absence overrides it without claiming validity',async()=>{
 const f=await setup();await f.service.expireCredential({commandId:'assistant-app-expiry',appId:ref.owner,connectionId:'save'});
 assert.equal((await f.service.read()).apps[0]!.credential!.state,'expired');await f.slots.delete(ref);
 assert.equal((await f.service.read()).apps[0]!.credential!.state,'missing');
});

test('set-only adapters keep their existing saved receipt projection',async()=>{
 const f=await setup(),service=new AppsService(f.store,{secrets:{set:f.slots.set.bind(f.slots)}});await f.slots.delete(ref);
 assert.equal((await service.read()).apps[0]!.credential!.state,'saved');
});

test('delayed presence cannot return an old snapshot after database feed replacement',{timeout:1000},async()=>{
 const f=await setup(),replacement=await restore(f.store),entered=deferred(),release=deferred();let current=f.store;
 const store=new Proxy(f.store,{get(_target,key){const value=Reflect.get(current,key);return typeof value==='function'?value.bind(current):value;}});
 const secrets={set:f.slots.set.bind(f.slots),has:async()=>{entered.resolve();await release.promise;return false;}},service=new AppsService(store,{secrets});
 const reading=service.read();await entered.promise;current=replacement;release.resolve();
 await assert.rejects(reading,FeedAdmissionError);
});

test('delayed presence rereads an app source changed in the same feed',{timeout:1000},async()=>{
 const f=await setup(),entered=deferred(),release=deferred();
 const secrets={set:f.slots.set.bind(f.slots),has:async()=>{entered.resolve();await release.promise;return false;}},service=new AppsService(f.store,{secrets});
 const reading=service.read();await entered.promise;await f.service.act({commandId:'disable-during-read',action:'disable',appId:ref.owner});release.resolve();
 const view=await reading;assert.equal(view.apps[0]!.enabled,false);assert.equal(view.revision,(await f.store.load(APPS_ID))!.revision);
});

test('app revision churn bounds the metadata rereads without returning stale data',async()=>{
 const f=await setup();let probes=0;
 const service=new AppsService(f.store,{secrets:{set:f.slots.set.bind(f.slots),has:async()=>{probes++;await f.service.act({commandId:'churn-'+probes,action:probes%2?'disable':'enable',appId:ref.owner});return true;}}});
 await assert.rejects(service.read(),/App state changed/i);assert.equal(probes,3);
});

test('an install overlapping the empty catalog read returns the settled installed app',async()=>{
 const store=new InMemoryStore<any>(),installer=new AppsService(store);let memberReads=0;
 const service=new AppsService(store,{members:async()=>{if(++memberReads===1){await installer.act({commandId:'install-overlap',action:'install',catalogId:'github'});await installer.decide({commandId:'approve-overlap',decisionId:(await installer.decisions(null))[0]!.id,answer:'act'});}return [];}});
 const view=await service.read();assert.equal(view.apps[0]!.id,ref.owner);assert.equal(view.apps[0]!.enabled,true);assert.equal(memberReads,2);
});

test('drain interrupts a presence adapter that ignores cancellation without accepting its late answer',{timeout:1000},async t=>{
 const f=await setup(),entered=deferred(),release=deferred();t.after(()=>release.resolve());const service=new AppsService(f.store,{secrets:{set:f.slots.set.bind(f.slots),has:async()=>{entered.resolve();await release.promise;return false;}}});
 const before=f.store.inspect(),reading=service.read();await entered.promise;service.beginDrain();const view=await Promise.race([reading,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error('Presence read ignored shutdown')),100);timer.unref();})]);
 assert.equal(view.apps[0]!.credential!.state,'unknown');release.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(view.apps[0]!.credential!.state,'unknown');assert.deepEqual(f.store.inspect(),before);
});
