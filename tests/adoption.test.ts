import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createWorkbench} from '../src/server.ts';
import {tempRoot} from './support/temp-root.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {ADOPTION_ID,AdoptionService,adoptionDecision,adoptionRevisionId,applyAdoption,calibrationPaused,effectiveAdoption,replayAdoption} from '../src/adoption.ts';
import type {AdoptionOutcome} from '../src/adoption.ts';

// docs/architecture/decisions/0008-owner-control-of-self-modification.md: one pure decision, one versioned owner setting, and a per-target default that is exactly today's behaviour until the choosing screen exists. No mode expires.
const DAY=86400000,T0=Date.UTC(2026,10,16,9,0),owner={id:'local-owner',roles:['owner' as const]},host={id:'assistant-representative',roles:['assistant' as const]};

test('the adoption decision covers every cell of mode, candidate nature, check result and pause',()=>{
 const natures=[['ordinary',{replacesOwnerWritten:false,widensPermissionsOrScope:false}],['owner-written',{replacesOwnerWritten:true,widensPermissionsOrScope:false}],['widening',{replacesOwnerWritten:false,widensPermissionsOrScope:true}]] as const;
 const checks=['scan-failed','worse','same-family','supported','none'] as const;
 // Per key (mode, or mode paused) the outcome for [ordinary, owner-written, widening] of each check. The paused rows are their own expectations, not the review rows.
 const expected:Record<string,Record<string,[AdoptionOutcome,AdoptionOutcome,AdoptionOutcome]>>={
  review:{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['ask','ask','ask'],'none':['unchecked','ask','ask']},
  'auto-threshold':{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['adopt','ask','ask'],'none':['unchecked','ask','ask']},
  'auto-adopt':{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['adopt','ask','ask'],'none':['adopt','ask','ask']},
  'review+paused':{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['ask','ask','ask'],'none':['unchecked','ask','ask']},
  'auto-threshold+paused':{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['ask','ask','ask'],'none':['unchecked','ask','ask']},
  'auto-adopt+paused':{'scan-failed':['reject','reject','reject'],'worse':['reject','reject','reject'],'same-family':['unchecked','ask','ask'],'supported':['ask','ask','ask'],'none':['unchecked','ask','ask']}};
 const modes=['review','auto-threshold','auto-adopt'] as const;
 for(const mode of modes)for(const paused of [false,true])for(const check of checks)for(const [index,[nature,candidate]] of natures.entries())
  assert.equal(adoptionDecision({target:'skill',candidate,check:{kind:check},mode,paused}),expected[mode+(paused?'+paused':'')]![check]![index],mode+' '+nature+' '+check+' paused='+paused);
});

test("the setting is versioned and owner-only; with no revision the state is unset (no mode) and no mode expires",async()=>{
 const store=new InMemoryStore<any>();let now=T0;const clock=()=>now,service=new AdoptionService(store,clock);
 // An installation without the aggregate (an old journal) is unset: no mode at all, which is main's behaviour, distinct from the three modes (ADR 0008 §3).
 for(const target of ['skill','memory','app','organization'] as const)assert.deepEqual(effectiveAdoption(null,target),{mode:null,revision:null},target);
 assert.throws(()=>applyAdoption(null,{type:'set-adoption-mode',revisionId:'rev-x',target:'default',mode:'review'},host,{observedAt:now}),/role/,'no host actor issues the setting command');
 await assert.rejects(service.act({commandId:'assistant-x',action:'set-mode',target:'default',mode:'review'}),/reserved/);
 await assert.rejects(service.act({commandId:'c-expiry',action:'set-mode',target:'default',mode:'auto-adopt',expiresAt:now+DAY}),/Exact adoption fields/,'a set-mode carrying expiresAt is refused like any unknown field');
 await assert.rejects(service.act({commandId:'c-resume',action:'resume',target:'skill'}),/Exact adoption fields/,'resuming moved to the skills aggregate, ordered by the change sequence');
 await service.act({commandId:'c-review',action:'set-mode',target:'default',mode:'review'});
 await service.act({commandId:'c-auto',action:'set-mode',target:'default',mode:'auto-threshold'});
 const read=await service.read();assert.deepEqual(read.revisions.map(r=>[r.id,r.target,r.mode,r.actor]),[[adoptionRevisionId('c-review'),'default','review','local-owner'],[adoptionRevisionId('c-auto'),'default','auto-threshold','local-owner']]);
 // A per-target override beats the organization default.
 await service.act({commandId:'c-skill',action:'set-mode',target:'skill',mode:'auto-adopt'});
 const withOverride=(await store.load(ADOPTION_ID))!.value;
 assert.deepEqual(effectiveAdoption(withOverride,'skill'),{mode:'auto-adopt',revision:adoptionRevisionId('c-skill')});
 assert.deepEqual(effectiveAdoption(withOverride,'memory'),{mode:'auto-threshold',revision:adoptionRevisionId('c-auto')});
 // Auto-adopt chosen long ago is still auto-adopt: no clock is consulted, so there is no time-based fallback.
 now+=365*DAY;
 assert.deepEqual(effectiveAdoption(withOverride,'skill'),{mode:'auto-adopt',revision:adoptionRevisionId('c-skill')});
 assert.deepEqual(await service.decision('skill'),{mode:'auto-adopt',revision:adoptionRevisionId('c-skill'),aggregateRevision:3});
});

test('an aggregate of the older expiry shape fails closed on every path: read, decision and write',async()=>{
 const shapes:{name:string;value:unknown}[]=[
  {name:'expiries',value:{kind:'adoption',id:ADOPTION_ID,revisions:[],expiries:[]}},
  {name:'highWaterAt',value:{kind:'adoption',id:ADOPTION_ID,revisions:[],highWaterAt:0}},
  {name:'a revision expiresAt',value:{kind:'adoption',id:ADOPTION_ID,revisions:[{id:'rev-1',at:T0,actor:'local-owner',target:'default',mode:'auto-adopt',expiresAt:T0+DAY}]}}];
 for(const {name,value} of shapes){
  const store=new InMemoryStore<any>();
  await store.commit({id:ADOPTION_ID,expectedRevision:0,commandId:'seed-old-'+name,fingerprint:'seed',value,events:[],outbox:[]});
  const service=new AdoptionService(store,()=>T0);
  await assert.rejects(()=>service.read(),/Unknown adoption state fields/,name+' is not read');
  await assert.rejects(()=>service.decision('skill'),/Unknown adoption state fields/,name+' is not decided under any mode');
  assert.throws(()=>applyAdoption(value as never,{type:'set-adoption-mode',revisionId:'rev-2',target:'default',mode:'review'},owner,{observedAt:T0}),/Unknown adoption state fields/,name+' is not written');
 }
});

test('calibration counts at most the ten most recent automatic adoptions',()=>{
 assert.equal(calibrationPaused([false,false,false,false,true]),false,'one failure among five counted keeps adopting');
 assert.equal(calibrationPaused([false,false,false,true]),true,'one failure with fewer than five counted pauses');
 assert.equal(calibrationPaused([true,true]),true,'two failures pause at any count');
 assert.equal(calibrationPaused([true,...Array.from({length:9},()=>false)]),false,'one failure among ten counted keeps adopting');
 assert.equal(calibrationPaused([...Array.from({length:10},()=>false),true,...Array.from({length:9},()=>false)]),false,'only the ten most recent count');
});

test('backup lineage replays adoption operations and refuses a forged step',async()=>{
 const store=new InMemoryStore<any>();const now=T0;const clock=()=>now,service=new AdoptionService(store,clock);
 await service.act({commandId:'c-auto',action:'set-mode',target:'skill',mode:'auto-adopt'});
 await service.act({commandId:'c-review',action:'set-mode',target:'default',mode:'review'});
 const ops=store.inspect().filter(o=>o.aggregateId===ADOPTION_ID) as any[];assert.equal(ops.length,2);validateMissionJournalLineage(ops);
 assert.throws(()=>replayAdoption({...ops[0],commandId:'assistant-forged'},undefined),/identity/,'an owner revision needs a caller command ID');
 const forged=structuredClone(ops[1]);forged.events[0].actor='assistant-representative';assert.throws(()=>replayAdoption(forged,ops[0]),/actor/,'only the owner issues the setting command');
});

test('HTTP: the owner sets the mode over the adoption route; a host identity and an expiry field are refused',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-adoption-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:50,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const url=(p:string)=>'http://127.0.0.1:'+(server.address() as {port:number}).port+p,post=(path:string,body:unknown)=>fetch(url(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const view=await fetch(url('/assistant/adoption')).then(r=>r.json()) as any;assert.equal(view.revision,0);assert.deepEqual(view.revisions,[]);
 assert.equal((await post('/assistant/adoption',{commandId:'assistant-x',action:'set-mode',target:'skill',mode:'review'})).status,400);
 assert.equal((await post('/assistant/adoption',{commandId:'c-expiry',action:'set-mode',target:'skill',mode:'auto-adopt',expiresAt:Date.now()+DAY})).status,400,'a set-mode carrying expiresAt is refused');
 assert.equal((await post('/assistant/adoption',{commandId:'c-auto',action:'set-mode',target:'skill',mode:'auto-adopt'})).status,200,'auto-adopt needs no expiry');
 const after=await fetch(url('/assistant/adoption')).then(r=>r.json()) as any;assert.equal(after.revisions.length,1);assert.equal(after.revisions[0].mode,'auto-adopt');
});
