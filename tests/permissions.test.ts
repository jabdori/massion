import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';
import {PERMISSIONS_ID,PermissionsService,applyPermissions,replayPermissions} from '../src/permissions.ts';

// docs/architecture/settings.md, Permission rules: only the owner writes; the second kind of decision is never allowed.
const owner={id:'local-owner',roles:['owner' as const]},host={id:'assistant-representative',roles:['assistant' as const]},time={observedAt:Date.UTC(2026,10,6)};

test('the owner adds and removes allow rules; the second kind, duplicates and non-owners are refused',()=>{
 let s=applyPermissions(null,{type:'allow-rule',ruleId:'rule-a',what:'Post the weekly summary to #weekly',kind:'send'},owner,time).value;
 assert.equal(s.id,PERMISSIONS_ID);assert.deepEqual(s.rules.map(r=>[r.id,r.kind,r.at]),[['rule-a','send',time.observedAt]]);
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'post the weekly summary to #WEEKLY',kind:'send'},owner,time),/already/);
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'Swap the checking model',kind:'check-rules' as any},owner,time),/kind/,'checking rules stay asked');
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'Widen network',kind:'widen' as any},owner,time),/kind/);
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'x',kind:['spend'] as any},owner,time),/kind/,'a kind is a string');
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'Delete old drafts',kind:'delete'},host,time),/role/,'no host or agent path');
 assert.throws(()=>applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:' two\nlines',kind:'delete'},owner,time),/fields/);
 s=applyPermissions(s,{type:'allow-rule',ruleId:'rule-b',what:'Delete drafts older than 7 days',kind:'delete'},owner,time).value;
 s=applyPermissions(s,{type:'remove-rule',ruleId:'rule-a'},owner,time).value;assert.deepEqual(s.rules.map(r=>r.id),['rule-b']);
 assert.throws(()=>applyPermissions(s,{type:'remove-rule',ruleId:'rule-a'},owner,time),/Unknown rule/);
});

test('the service derives the rule ID from the command ID, so a resent Add commits once, and lineage replays only owner commands',async()=>{
 const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>time.observedAt);
 const first=await service.act({commandId:'c-1',action:'allow',what:'Hand reviews to my laptop',kind:'delegate'});assert.equal(first.status,'committed');
 assert.equal((await service.act({commandId:'c-1',action:'allow',what:'Hand reviews to my laptop',kind:'delegate'})).revision,first.revision,'replayed, not a second rule');
 await assert.rejects(service.act({commandId:'assistant-rule',action:'allow',what:'x',kind:'send'}),/reserved/);
 await assert.rejects(service.act({commandId:'c-x',action:'allow',what:'x',kind:'send',extra:1}),/fields/);
 const view=await service.read();assert.deepEqual(view.ask.map(a=>a.label),['Spend money','Send as me','Delete','Hand to a new member','Change check rules']);
 assert.deepEqual(view.allow.map(r=>[r.what,r.label]),[['Hand reviews to my laptop','Hand to a new member']]);
 await service.act({commandId:'c-2',action:'remove',ruleId:view.allow[0]!.id});assert.deepEqual((await service.read()).allow,[]);
 const ops=store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID) as any[];assert.equal(ops.length,2);
 validateMissionJournalLineage(ops);
 assert.throws(()=>replayPermissions({...ops[0],commandId:'c-9'},undefined),/identity/,'the rule ID follows from the command ID');
 const forged=structuredClone(ops[0]);forged.events[0].actor=host.id;assert.throws(()=>replayPermissions(forged,undefined),/actor|fingerprint/);
});

test('an overlapping resend replays the first result instead of a digest conflict or a duplicate-rule error',async()=>{
 let tick=time.observedAt;const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>tick++),add={commandId:'c-1',action:'allow',what:'Pay the toner invoice',kind:'spend'};
 const both=await Promise.all([service.act(add),service.act(add)]);assert.deepEqual(both.map(r=>r.status).sort(),['committed','replayed']);assert.equal(both[0]!.revision,both[1]!.revision);
 const remove={commandId:'c-2',action:'remove',ruleId:(await service.read()).allow[0]!.id};
 const removed=await Promise.all([service.act(remove),service.act(remove)]);assert.deepEqual(removed.map(r=>r.status).sort(),['committed','replayed']);
 assert.equal(store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID).length,2);
});

test('HTTP: GET lists both columns; POST takes exact fields through feed admission and refuses host command IDs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'massion-permissions-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createWorkbench(new InMemoryStore<any>() as Store<Mission>,root,{drainTimeoutMs:50,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const url=(p:string)=>`http://127.0.0.1:${(server.address() as {port:number}).port}${p}`,post=(body:unknown,headers:Record<string,string>={})=>fetch(url('/assistant/permissions'),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 let view=await fetch(url('/assistant/permissions')).then(r=>r.json()) as any;assert.equal(view.ask.length,5);assert.deepEqual(view.allow,[]);assert.equal(typeof view.feedId,'string');
 assert.equal((await post({commandId:'c-1',action:'allow',what:'Pay the toner invoice',kind:'spend'})).status,201);
 assert.equal((await post({commandId:'assistant-x',action:'allow',what:'x',kind:'spend'})).status,400);
 assert.equal((await post({commandId:'c-2',action:'allow',what:'x',kind:'check-rules'})).status,400);
 assert.equal((await post({commandId:'c-3',action:'allow',what:'y',kind:'send'},{'x-massion-feed':'feed:other'})).status,409,'feed admission');
 assert.equal((await fetch(url('/assistant/permissions?x=1'))).status,400);
 view=await fetch(url('/assistant/permissions')).then(r=>r.json()) as any;assert.deepEqual(view.allow.map((r:any)=>[r.what,r.kind]),[['Pay the toner invoice','spend']]);
 assert.equal((await post({commandId:'c-4',action:'remove',ruleId:view.allow[0].id})).status,200);
});
