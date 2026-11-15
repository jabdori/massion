import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryStore} from '../src/storage.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbench} from '../src/server.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {ADOPTION_ID,AdoptionService,adoptionDecision,adoptionRevisionId,applyAdoption,calibrationPaused,effectiveAdoption,replayAdoption} from '../src/adoption.ts';
import type {AdoptionOutcome} from '../src/adoption.ts';

// docs/architecture/decisions/0008-owner-control-of-self-modification.md: one pure decision, one versioned owner setting, review by default, and Auto alone expires.
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

test('the setting is versioned, owner-only, and only auto-adopt expires',async()=>{
 const store=new InMemoryStore<any>();let now=T0;const clock=()=>now,service=new AdoptionService(store,clock);
 // An installation without the aggregate (an old journal) means the default mode: review.
 assert.deepEqual(effectiveAdoption(null,'skill',now),{mode:'review',revision:null});
 assert.throws(()=>applyAdoption(null,{type:'set-adoption-mode',revisionId:'rev-x',target:'default',mode:'review'},host,{observedAt:now}),/role/,'no host actor issues the setting command');
 await assert.rejects(service.act({commandId:'assistant-x',action:'set-mode',target:'default',mode:'review'}),/reserved/);
 await assert.rejects(service.act({commandId:'c-none',action:'set-mode',target:'default',mode:'auto-adopt'}),/expiry/,'there is no "never"');
 await assert.rejects(service.act({commandId:'c-expiry',action:'set-mode',target:'default',mode:'review',expiresAt:now+DAY}),/Only auto-adopt/);
 await assert.rejects(service.act({commandId:'c-resume',action:'resume',target:'skill'}),/Exact adoption fields/,'resuming moved to the skills aggregate, ordered by the change sequence');
 await service.act({commandId:'c-review',action:'set-mode',target:'default',mode:'review'});
 await service.act({commandId:'c-auto',action:'set-mode',target:'default',mode:'auto-threshold'});
 const read=await service.read();assert.deepEqual(read.revisions.map(r=>[r.id,r.target,r.mode,r.actor]),[[adoptionRevisionId('c-review'),'default','review','local-owner'],[adoptionRevisionId('c-auto'),'default','auto-threshold','local-owner']]);
 // A per-target override beats the organization default.
 await service.act({commandId:'c-skill',action:'set-mode',target:'skill',mode:'auto-adopt',expiresAt:now+DAY});
 const withOverride=(await store.load(ADOPTION_ID))!.value;
 assert.deepEqual(effectiveAdoption(withOverride,'skill',now),{mode:'auto-adopt',revision:adoptionRevisionId('c-skill')});
 assert.deepEqual(effectiveAdoption(withOverride,'memory',now),{mode:'auto-threshold',revision:adoptionRevisionId('c-auto')});
 // Expiry means review, and the fact is recorded once.
 now+=DAY;
 assert.equal((await service.effective('skill')).mode,'review');
 assert.deepEqual(((await store.load(ADOPTION_ID))!.value).expiries,[{revisionId:adoptionRevisionId('c-skill'),at:now}]);
 // One-way: with the wall clock set back before the expiry, the recorded revision still never grants auto-adopt again.
 now-=2*DAY;
 assert.deepEqual(await service.effective('skill'),{mode:'review',revision:adoptionRevisionId('c-skill')});
 assert.equal(((await store.load(ADOPTION_ID))!.value).expiries.length,1,'the expiry is not recorded twice');
});

test('a host clock set back cannot extend an unrecorded auto-adopt grant: the high-water mark decides',async()=>{
 const store=new InMemoryStore<any>();let now=T0;const clock=()=>now,service=new AdoptionService(store,clock);
 await service.act({commandId:'c-auto',action:'set-mode',target:'skill',mode:'auto-adopt',expiresAt:now+2*DAY});
 now+=3*DAY;await service.act({commandId:'c-review',action:'set-mode',target:'default',mode:'review'});
 now-=2*DAY; // the wall clock is back before the expiry, the journal is not
 const effective=await service.effective('skill');assert.equal(effective.mode,'review');assert.equal(effective.expiredRevision,adoptionRevisionId('c-auto'),'the expiry is recorded even with the wall clock back');
 const v=(await store.load(ADOPTION_ID))!.value;assert.equal(v.highWaterAt,T0+3*DAY);assert.equal(v.expiries.length,1);
});

test('calibration counts at most the ten most recent automatic adoptions',()=>{
 assert.equal(calibrationPaused([false,false,false,false,true]),false,'one failure among five counted keeps adopting');
 assert.equal(calibrationPaused([false,false,false,true]),true,'one failure with fewer than five counted pauses');
 assert.equal(calibrationPaused([true,true]),true,'two failures pause at any count');
 assert.equal(calibrationPaused([true,...Array.from({length:9},()=>false)]),false,'one failure among ten counted keeps adopting');
 assert.equal(calibrationPaused([...Array.from({length:10},()=>false),true,...Array.from({length:9},()=>false)]),false,'only the ten most recent count');
});

test('backup lineage replays adoption operations and refuses a forged step',async()=>{
 const store=new InMemoryStore<any>();let now=T0;const clock=()=>now,service=new AdoptionService(store,clock);
 await service.act({commandId:'c-auto',action:'set-mode',target:'skill',mode:'auto-adopt',expiresAt:now+DAY});
 now+=DAY;await service.effective('skill');
 const ops=store.inspect().filter(o=>o.aggregateId===ADOPTION_ID) as any[];assert.equal(ops.length,2);validateMissionJournalLineage(ops);
 assert.throws(()=>replayAdoption({...ops[0],commandId:'assistant-forged'},undefined),/identity/,'an owner revision needs a caller command ID');
 const forged=structuredClone(ops[1]);forged.events[0].actor='local-owner';assert.throws(()=>replayAdoption(forged,ops[0]),/actor|fingerprint/);
});

test('HTTP: the owner sets the mode over the adoption route; a host identity is refused',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-adoption-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>();const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:50,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const url=(p:string)=>`http://127.0.0.1:${(server.address() as {port:number}).port}${p}`,post=(path:string,body:unknown)=>fetch(url(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const view=await fetch(url('/assistant/adoption')).then(r=>r.json()) as any;assert.equal(view.revision,0);assert.deepEqual(view.revisions,[]);
 assert.equal((await post('/assistant/adoption',{commandId:'c-none',action:'set-mode',target:'skill',mode:'auto-adopt'})).status,400,'auto-adopt without an expiry is refused');
 assert.equal((await post('/assistant/adoption',{commandId:'assistant-x',action:'set-mode',target:'skill',mode:'review'})).status,400);
 assert.equal((await post('/assistant/adoption',{commandId:'c-auto',action:'set-mode',target:'skill',mode:'auto-adopt',expiresAt:Date.now()+DAY})).status,200);
 const after=await fetch(url('/assistant/adoption')).then(r=>r.json()) as any;assert.equal(after.revisions.length,1);assert.equal(after.revisions[0].mode,'auto-adopt');
});
