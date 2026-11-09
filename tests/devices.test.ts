import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryStore,CommitOutcomeUnknownError} from '../src/storage.ts';
import {DevicesService} from '../src/devices.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const admission={id:'effect-decision:remote',state:'done',effect:{kind:'external-member',missionId:'intake',workId:'work',effectId:'effect-decision:remote',status:'unknown',answer:'act',request:{kind:'external-member',adapterId:'remote',deviceId:'laptop',deviceName:'내 노트북',agentId:'codex',agentName:'Codex',instruction:'Read the repository',scope:'repository'}}};
function fixture(){const store=new InMemoryStore<any>(),calls:string[]=[],adapter={id:'remote',async inspect(){return {status:'offline' as const};},async connect(){calls.push('connect');return {status:'connected' as const};},async disconnect(){calls.push('disconnect');return {status:'offline' as const};}};const service=new DevicesService(store,store,async()=>[admission],[adapter]);return {store,calls,adapter,service};}

test('device commands require the existing external-member admission and replay overlapping identities once',async()=>{
 const f=fixture();const results=await Promise.all([1,2].map(()=>f.service.act({commandId:'connect',deviceId:'laptop',action:'connect'})));
 assert.ok(results.every(r=>r.status==='committed'||r.status==='replayed'));assert.deepEqual(f.calls,['connect']);
 await f.service.act({commandId:'connect',deviceId:'laptop',action:'connect'});assert.deepEqual(f.calls,['connect']);
 await assert.rejects(f.service.act({commandId:'connect',deviceId:'laptop',action:'disconnect'}),/identity|conflict/i);
 const denied=new DevicesService(f.store,f.store,async()=>[{...admission,effect:{...admission.effect,answer:'later'}}],[f.adapter]);
 await assert.rejects(denied.act({commandId:'other',deviceId:'laptop',action:'connect'}),/admission|decision/i);
});

test('unknown device operation remains fenced across restart and cannot invoke another adapter effect',async()=>{
 const f=fixture();f.adapter.connect=async()=>{f.calls.push('connect');throw Error('Lost reply');};
 await f.service.act({commandId:'connect',deviceId:'laptop',action:'connect'});
 const restarted=new DevicesService(f.store,f.store,async()=>[admission],[f.adapter]);
 assert.equal((await restarted.read()).devices[0]!.status,'unknown');
 await restarted.act({commandId:'connect',deviceId:'laptop',action:'connect'});
 await assert.rejects(restarted.act({commandId:'again',deviceId:'laptop',action:'connect'}),/unknown|unresolved/i);assert.deepEqual(f.calls,['connect']);
 validateMissionJournalLineage(f.store.inspect());
});

test('drain and an unknown claim commit prevent a device effect',async()=>{
 for(const unknown of [false,true]){const f=fixture(),owner=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(unknown){await target.commit(input);throw new CommitOutcomeUnknownError(input);}throw new HostDrainError();};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}),service=new DevicesService(f.store,owner,async()=>[admission],[f.adapter]);
  await assert.rejects(service.act({commandId:'connect',deviceId:'laptop',action:'connect'}),unknown?CommitOutcomeUnknownError:HostDrainError);assert.deepEqual(f.calls,[]);
  if(unknown){const restarted=new DevicesService(f.store,f.store,async()=>[admission],[f.adapter]);await restarted.act({commandId:'connect',deviceId:'laptop',action:'connect'});assert.deepEqual(f.calls,[]);}
 }
});

test('device read derives names from admission and preserves offline status without inferring delivery',async()=>{
 const f=fixture(),view=await f.service.read();assert.deepEqual(view.devices.map(d=>[d.id,d.name,d.agent,d.status]),[['laptop','내 노트북','Codex','offline']]);
 assert.equal(view.devices[0]!.decisionId,admission.id);assert.equal(view.devices[0]!.available,true);
 const unavailable=new DevicesService(f.store,f.store,async()=>[admission]);assert.equal((await unavailable.read()).devices[0]!.status,'unavailable');
});

test('device admission, invocation and settlement cannot cross a database replacement',async()=>{
 for(const phase of ['admission','invocation','settlement']){
  const f=fixture(),replacement=new InMemoryStore<any>();let active=f.store;
  const store=new Proxy(f.store,{get(_target,key){if(key==='commit')return async(input:any)=>{const result=await active.commit(input);if(phase==='invocation'&&input.events[0].type==='claim-device')active=replacement;return result;};const value=Reflect.get(active,key);return typeof value==='function'?value.bind(active):value;}});
  const admissions=async()=>{if(phase==='admission')active=replacement;return [admission];};
  f.adapter.connect=async()=>{f.calls.push('connect');if(phase==='settlement')active=replacement;return {status:'connected'};};
  const service=new DevicesService(store,store,admissions,[f.adapter]);
  await assert.rejects(service.act({commandId:'connect',deviceId:'laptop',action:'connect'}),/database|feed/i);
  assert.equal(f.calls.length,phase==='settlement'?1:0,phase);assert.equal(replacement.inspect().length,0,phase);
 }
});
