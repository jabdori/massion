import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tempRoot} from './support/temp-root.ts';
import {join} from 'node:path';
import {InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
import {hash} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {createWorkbench} from '../src/server.ts';
import {PERMISSIONS_ID,PermissionsService,replayPermissions,ruleId} from '../src/permissions.ts';

// docs/architecture/settings.md: the permissions aggregate holds secret grants; the rule commands were removed and replay from old journals as inert history.
const time={observedAt:Date.UTC(2026,10,6)},binding={secret:{owner:'fixture',slot:'api-key'},sourceHash:'a'.repeat(64),consumer:{kind:'connection' as const,id:'fixture-connection'},purpose:'Fixture connection grant'};

test('the service derives the grant ID from the command ID, so a resent grant commits once, and lineage replays it',async()=>{
 const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>time.observedAt);
 const first=await service.act({commandId:'c-1',action:'grant-secret',...binding});assert.equal(first.status,'committed');
 assert.equal((await service.act({commandId:'c-1',action:'grant-secret',...binding})).revision,first.revision,'replayed, not a second grant');
 await assert.rejects(service.act({commandId:'assistant-grant',action:'grant-secret',...binding}),/Exact secret permission fields required/);
 await assert.rejects(service.act({commandId:'c-x',action:'grant-secret',...binding,extra:1}),/fields/);
 const view=await service.read();assert.deepEqual(view,{revision:1,secrets:[{id:ruleId('c-1'),secret:binding.secret,sourceHash:binding.sourceHash,consumer:binding.consumer,purpose:binding.purpose,at:time.observedAt}]});
 const revoked=await service.act({commandId:'c-2',action:'revoke-secret',grantId:ruleId('c-1')});assert.equal(revoked.status,'committed');assert.deepEqual(await service.read(),{revision:2,secrets:[]});
 const ops=store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID) as any[];assert.equal(ops.length,2);
 validateMissionJournalLineage(ops);
 assert.throws(()=>replayPermissions({...ops[0],commandId:'c-9'},undefined),/identity/,'the grant ID follows from the command ID');
 const forged=structuredClone(ops[0]);forged.events[0].actor='secret-host';assert.throws(()=>replayPermissions(forged,undefined),/actor|fingerprint/);
});

test('an overlapping resend replays the first result instead of a digest conflict or a duplicate-grant error',async()=>{
 let tick=time.observedAt;const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>tick++);
 const both=await Promise.all([service.act({commandId:'c-1',action:'grant-secret',...binding}),service.act({commandId:'c-1',action:'grant-secret',...binding})]);
 assert.deepEqual(both.map(r=>r.status).sort(),['committed','replayed']);assert.equal(both[0]!.revision,both[1]!.revision);
 const revoke={commandId:'c-2',action:'revoke-secret',grantId:ruleId('c-1')};
 const removed=await Promise.all([service.act(revoke),service.act(revoke)]);assert.deepEqual(removed.map(r=>r.status).sort(),['committed','replayed']);
 assert.equal(store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID).length,2);
});

test('the action value decides the command: a wrong action with otherwise exact keys is refused and dispatches nothing',async()=>{
 const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>time.observedAt);
 assert.equal((await service.act({commandId:'c-1',action:'grant-secret',...binding})).status,'committed');
 await assert.rejects(service.act({commandId:'c-2',action:'allow',secret:binding.secret,sourceHash:binding.sourceHash,consumer:binding.consumer,purpose:binding.purpose}),/Exact secret permission fields required/);
 await assert.rejects(service.act({commandId:'c-3',action:'remove',grantId:ruleId('c-1')}),/Exact secret permission fields required/,'main refused this shape; it must not revoke');
 assert.deepEqual(store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID).map(o=>o.commandId),['c-1'],'nothing was dispatched');
 assert.deepEqual((await service.read()).secrets?.map(g=>g.id),[ruleId('c-1')],'the grant survives');
 assert.equal((await service.act({commandId:'c-4',action:'revoke-secret',grantId:ruleId('c-1')})).status,'committed');
 assert.deepEqual((await service.read()).secrets,[]);
});

test('a rule operation stored before the removal replays as inert history and keeps its lineage checks',()=>{
 const add={type:'allow-rule',ruleId:ruleId('c-1'),what:'Pay the toner invoice',kind:'spend'},remove={type:'remove-rule',ruleId:ruleId('c-1')};
 const operations:any[]=[
  {aggregateId:PERMISSIONS_ID,revision:1,expectedRevision:0,commandId:'c-1',fingerprint:hash({actorId:'local-owner',command:add}),value:{kind:'permissions',id:PERMISSIONS_ID,rules:[{id:add.ruleId,what:add.what,kind:add.kind,at:time.observedAt}]},events:[{type:'allow-rule',actor:'local-owner',command:add,time}],outbox:[]},
  {aggregateId:PERMISSIONS_ID,revision:2,expectedRevision:1,commandId:'c-2',fingerprint:hash({actorId:'local-owner',command:remove}),value:{kind:'permissions',id:PERMISSIONS_ID,rules:[]},events:[{type:'remove-rule',actor:'local-owner',command:remove,time}],outbox:[]}
 ];
 validateMissionJournalLineage(operations as any);
 assert.throws(()=>replayPermissions({...operations[0],commandId:'c-9'},undefined),/identity/,'a forged rule identity still fails');
 assert.throws(()=>replayPermissions({...operations[0],fingerprint:hash({actorId:'local-owner',command:remove})},undefined),/fingerprint/);
});

test('a legacy journal mixing rule operations and secret grants replays, and the grants come out right',async()=>{
 const store=new InMemoryStore<any>(),service=new PermissionsService(store,()=>time.observedAt);
 const add={type:'allow-rule',ruleId:ruleId('c-1'),what:'Pay the toner invoice',kind:'spend'},remove={type:'remove-rule',ruleId:ruleId('c-1')};
 const grantCommand={type:'grant-secret',id:ruleId('c-2'),secret:binding.secret,sourceHash:binding.sourceHash,consumer:binding.consumer,purpose:binding.purpose};
 const rule={id:add.ruleId,what:add.what,kind:add.kind,at:time.observedAt},granted={id:grantCommand.id,secret:binding.secret,sourceHash:binding.sourceHash,consumer:binding.consumer,purpose:binding.purpose,at:time.observedAt};
 const commit=(commandId:string,command:unknown,value:unknown,expectedRevision:number)=>store.commit({id:PERMISSIONS_ID,expectedRevision,commandId,fingerprint:hash({actorId:'local-owner',command}),value:value as never,events:[{type:(command as {type:string}).type,actor:'local-owner',command,time}],outbox:[]});
 await commit('c-1',add,{kind:'permissions',id:PERMISSIONS_ID,rules:[rule]},0);
 await commit('c-2',grantCommand,{kind:'permissions',id:PERMISSIONS_ID,rules:[rule],secretGrants:[granted]},1);
 assert.deepEqual((await service.read()).secrets?.map(g=>g.id),[ruleId('c-2')]);
 await commit('c-3',remove,{kind:'permissions',id:PERMISSIONS_ID,rules:[],secretGrants:[granted]},2);
 await commit('c-4',{type:'revoke-secret',grantId:ruleId('c-2')},{kind:'permissions',id:PERMISSIONS_ID,rules:[],secretGrants:[]},3);
 validateMissionJournalLineage(store.inspect().filter(o=>o.aggregateId===PERMISSIONS_ID));
 assert.deepEqual(await service.read(),{revision:4,secrets:[]});
});

test('a recorded secret grant that really differs from its command still fails replay',()=>{
 const command={type:'grant-secret',id:ruleId('c-1'),secret:binding.secret,sourceHash:binding.sourceHash,consumer:binding.consumer,purpose:binding.purpose};
 const operation={aggregateId:PERMISSIONS_ID,revision:1,expectedRevision:0,commandId:'c-1',fingerprint:hash({actorId:'local-owner',command}),value:{kind:'permissions',id:PERMISSIONS_ID,rules:[],secretGrants:[{...command,purpose:'A different purpose',at:time.observedAt}]},events:[{type:'grant-secret',actor:'local-owner',command,time}],outbox:[]};
 assert.throws(()=>validateMissionJournalLineage([operation as any]),/command\/state transition/);
});

test('HTTP: GET reads the grant list; POST grants and revokes through feed admission and refuses host command IDs; the removed rule actions answer as an unknown action',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-permissions-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const server=createWorkbench(new InMemoryStore<any>() as Store<Mission>,root,{drainTimeoutMs:50,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port,url=(p:string)=>base+p,post=(body:unknown,headers:Record<string,string>={})=>fetch(url('/assistant/permissions'),{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
 let view=await fetch(url('/assistant/permissions')).then(r=>r.json()) as any;assert.equal(view.revision,0);assert.equal('ask' in view,false);assert.equal('allow' in view,false);assert.equal(typeof view.feedId,'string');
 assert.equal((await post({commandId:'assistant-x',action:'grant-secret',...binding})).status,400);
 assert.equal((await post({commandId:'c-3',action:'grant-secret',...binding},{'x-massion-feed':'feed:other'})).status,409,'feed admission');
 assert.equal((await fetch(url('/assistant/permissions?x=1'))).status,400);
 assert.equal((await post({commandId:'c-1',action:'grant-secret',...binding})).status,200);
 view=await fetch(url('/assistant/permissions')).then(r=>r.json()) as any;assert.deepEqual(view.secrets.map((g:any)=>[g.secret.owner,g.consumer.id]),[['fixture','fixture-connection']]);
 assert.equal((await post({commandId:'c-2',action:'revoke-secret',grantId:ruleId('c-1')})).status,200);
 // The removed rule actions answer exactly what an action the route does not know answers: 400 {error:'Exact secret permission fields required', feedId}.
 const refused=await post({commandId:'c-9',action:'nobody-knows',what:'Pay the toner invoice',kind:'spend'});
 assert.equal(refused.status,400);const refusedBody=await refused.json();assert.equal(refusedBody.error,'Exact secret permission fields required');assert.equal(typeof refusedBody.feedId,'string');
 for(const action of ['allow','remove']){const answer=await post({commandId:'c-9',action,what:'Pay the toner invoice',kind:'spend'});assert.equal(answer.status,400);const body=await answer.json();assert.deepEqual([body.error,typeof body.feedId],[refusedBody.error,'string']);}
});

test('HTTP: a grant resuming after drain starts is refused and stores no grant',async t=>{
 const root=await mkdtemp(join(tempRoot(),'massion-permissions-drain-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const raw=new InMemoryStore<any>();let hold=false,held=()=>{},release=()=>{};const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(raw,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===PERMISSIONS_ID){hold=false;held();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,root,{drainTimeoutMs:3000,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 hold=true;const response=fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/permissions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'c-drain',action:'grant-secret',...binding})});
 await reached;const drain=server.drain();release();
 assert.equal((await response).status,503);assert.equal((await drain).status,'drained');assert.deepEqual(await new PermissionsService(raw).read(),{revision:0});
});
