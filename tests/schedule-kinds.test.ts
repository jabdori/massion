import test from 'node:test';
import assert from 'node:assert/strict';
import {applySchedules,SchedulesService,SCHEDULES_ID,replaySchedules} from '../src/schedules.ts';
import type {SchedulesCommand,SchedulesState} from '../src/schedules.ts';
import {InMemoryStore,CommitOutcomeUnknownError} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {DomainError} from '../src/domain.ts';

const T=Date.UTC(2026,10,6),DAY=86400000,owner={id:'local-owner',roles:['owner' as const]};
const create=(kind:string,id=kind,extra:Record<string,unknown>={})=>({type:'create-schedule',scheduleId:id,kind,minute:540,offset:0,budget:{runs:3},...extra}) as SchedulesCommand;
const apply=(state:SchedulesState|null,c:SchedulesCommand,at=T)=>applySchedules(state,c,owner,{observedAt:at}).value;
const proxy=(store:InMemoryStore<any>,overrides:Record<string,unknown>)=>new Proxy(store,{get(target,key){if(Object.hasOwn(overrides,key))return overrides[key as string];const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as Store<any>;

test('schedule kinds coexist, preserve the briefing singleton and use calendar slots',()=>{
 let state=apply(null,create('briefing'));
 const cases:[string,number,Record<string,unknown>?][]=[['weekly-expenses',Date.UTC(2026,10,9,9)],['weekly-review',Date.UTC(2026,10,9,9)],['price-watch',Date.UTC(2026,10,6,9)],['monthly-subscriptions',Date.UTC(2026,10,30,9)],['meeting-preparation',T+2*DAY,{onceAt:T+2*DAY}],['weekend-groceries',Date.UTC(2026,10,6,9)]];
 for(const [kind,next,extra] of cases){state=apply(state,create(kind,kind,extra));assert.equal(state.schedules.at(-1)!.nextAt,next,kind);}
 assert.equal(state.schedules.length,7);
 assert.throws(()=>apply(state,create('briefing','briefing-2')),/one briefing/i);
 assert.throws(()=>apply(null,create('meeting-preparation')),DomainError);
 assert.throws(()=>apply(null,create('meeting-preparation','m',{onceAt:T})),DomainError);
 assert.throws(()=>apply(null,create('toString')),DomainError);
 assert.throws(()=>apply(null,create('weekly-expenses','x',{request:''})),DomainError);
 assert.throws(()=>apply(null,create('weekly-expenses','x',{request:'x'.repeat(16001)})),DomainError);
});

test('a template produces only its own retained Work turn, replays without rerunning and validates backup lineage',async()=>{
 const store=new InMemoryStore<any>();let calls=0;
 const produce:import('../src/schedules.ts').ScheduleProducer=async(input)=>{calls++;assert.equal(input.kind,'weekly-expenses');assert.equal(input.request,'Group my supplied receipts by category.');assert.match(input.commandId,/^schedule-work:/);return {turnIds:['turn:expenses'],segment:3};};
 const service=new SchedulesService(store,async()=>({turns:[{id:'unrelated',at:T,work:{}}]}),()=>T,store,produce);
 const result=await service.act({commandId:'create-expenses',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:3},request:'Group my supplied receipts by category.'});assert.equal(result.status,'committed');
 const id=(await service.read()).schedules[0]!.id,run={commandId:'run-expenses',action:'run',scheduleId:id};
 assert.equal((await service.act(run)).status,'committed');assert.equal((await service.act(run)).status,'replayed');assert.equal(calls,1);
 const view=(await service.read()).schedules[0]!;assert.deepEqual(view.runs[0]!.turnIds,['turn:expenses']);assert.equal(view.runs[0]!.segment,3);assert.equal(view.runs[0]!.state,'done');
 const ops=store.inspect().filter(o=>o.aggregateId===SCHEDULES_ID);ops.forEach((op,i)=>replaySchedules(op,ops[i-1]));
});

test('overlapping creation looks up identity after load and replays an idempotency commit race',async()=>{
 const inner=new InMemoryStore<any>(),direct=new SchedulesService(inner,async()=>({turns:[]}),()=>T),input={commandId:'same',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:3}};
 let race=true;
 const store=proxy(inner,{commit:async(value:any)=>{if(race){race=false;await direct.act(input);return {status:'conflict',reason:'idempotency',revision:1};}return inner.commit(value);}});
 const service=new SchedulesService(store,async()=>({turns:[]}),()=>T);
 assert.equal((await service.act(input)).status,'replayed');assert.equal((await service.read()).schedules.length,1);
 const loaded=proxy(inner,{load:async(id:string)=>{if(race){race=false;await direct.act({commandId:'pause',action:'pause',scheduleId:(await direct.read()).schedules[0]!.id});}return inner.load(id);}});
 const second=new SchedulesService(loaded,async()=>({turns:[]}),()=>T),id=(await direct.read()).schedules[0]!.id;
 race=true;assert.equal((await second.act({commandId:'pause',action:'pause',scheduleId:id})).status,'replayed');
 const changed=await service.act({...input,kind:'price-watch'});assert.equal(changed.status,'conflict');if(changed.status==='conflict')assert.equal(changed.reason,'idempotency');
});

test('owner creation and run admission are fenced by ownerStore while a started producer can settle',async()=>{
 const inner=new InMemoryStore<any>();let draining=false,produced=0;
 const ownerStore=proxy(inner,{commit:async(value:any)=>{if(draining)throw new Error('draining');return inner.commit(value);}});
 const service=new SchedulesService(inner,async()=>({turns:[]}),()=>T,ownerStore,async()=>{produced++;draining=true;return {turnIds:['turn:one'],segment:1};});
 await service.act({commandId:'create',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:3}});const id=(await service.read()).schedules[0]!.id;
 await service.act({commandId:'run',action:'run',scheduleId:id});assert.equal((await service.read()).schedules[0]!.runs[0]!.state,'done');
 await assert.rejects(service.act({commandId:'create-2',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:3}}),/draining/);
 await assert.rejects(service.act({commandId:'run-2',action:'run',scheduleId:id}),/draining/);assert.equal(produced,1);assert.equal((await service.read()).schedules.length,1);
});

test('unknown producer or commit outcomes are never resent after deadline or restart',async()=>{
 const inner=new InMemoryStore<any>();let now=T,calls=0;
 const producer=async()=>{calls++;return null;},service=new SchedulesService(inner,async()=>({turns:[]}),()=>now,inner,producer);
 await service.act({commandId:'create',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:3}});const id=(await service.read()).schedules[0]!.id,input={commandId:'run',action:'run',scheduleId:id};
 await service.act(input);now+=61000;assert.equal((await service.read()).schedules[0]!.runs[0]!.state,'unknown');
 const restarted=new SchedulesService(inner,async()=>({turns:[]}),()=>now,inner,producer);
 assert.equal((await restarted.act(input)).status,'replayed');assert.equal(calls,1);assert.equal((await restarted.tick()).length,0);
 let unknown=true;const lost=proxy(inner,{commit:async(value:any)=>{const result=await inner.commit(value);if(unknown&&value.commandId.startsWith('assistant-schedule-run:')){unknown=false;throw new CommitOutcomeUnknownError(value);}return result;}});
 const uncertain=new SchedulesService(lost,async()=>({turns:[]}),()=>now,lost,producer);
 const second={...input,commandId:'lost'};await assert.rejects(uncertain.act(second),CommitOutcomeUnknownError);assert.equal(uncertain.unsettled,true);assert.equal((await uncertain.act(second)).status,'replayed');assert.equal(calls,1);
});

test('one-time meeting runs deactivate and month-end slots handle leap years without drift',async()=>{
 const store=new InMemoryStore<any>();let now=T;
 const service=new SchedulesService(store,async()=>({turns:[]}),()=>now,store,async()=>({turnIds:['turn:meeting'],segment:1}));
 await service.act({commandId:'meeting',action:'create',kind:'meeting-preparation',minute:1080,offset:0,onceAt:T+DAY,budget:{runs:1}});now+=DAY;assert.equal((await service.tick()).length,1);const view=(await service.read()).schedules[0]!;assert.equal(view.active,false);assert.equal(view.runs[0]!.state,'done');assert.equal((await service.tick()).length,0);
 const leap=apply(null,create('monthly-subscriptions','leap'),Date.UTC(2028,1,1));assert.equal(leap.schedules[0]!.nextAt,Date.UTC(2028,1,29,9));
});

test('one schedule with a live run does not starve another due schedule',async()=>{
 const store=new InMemoryStore<any>();let now=T,release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),inside=new Promise<void>(r=>entered=r);let calls=0;
 const service=new SchedulesService(store,async()=>({turns:[]}),()=>now,store,async input=>{calls++;if(input.kind==='weekly-expenses'){entered();await gate;}return {turnIds:['turn:'+input.kind],segment:1};});
 await service.act({commandId:'a',action:'create',kind:'weekly-expenses',minute:540,offset:0,budget:{runs:3}});
 await service.act({commandId:'b',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:3}});
 const schedules=(await service.read()).schedules;now=schedules[0]!.nextAt;
 const manual=service.act({commandId:'manual',action:'run',scheduleId:schedules[0]!.id});await inside;
 try{await service.tick();assert.equal((await service.read()).schedules[1]!.runs[0]?.state,'done');assert.equal(calls,2);}finally{release();await manual;}
});

test('non-briefing completion requires a retained Work source and a real conversation segment',()=>{
 const state=apply(null,create('weekly-expenses')),host={id:'assistant-representative',roles:['assistant' as const]};
 const started=applySchedules(state,{type:'start-run',scheduleId:'weekly-expenses',runId:'run-one',manual:true},host,{observedAt:T}).value;
 for(const [turnIds,segment] of [[[],1],[['turn:one'],0],[['turn:one','turn:one'],1]] as [string[],number][])assert.throws(()=>applySchedules(started,{type:'finish-run',scheduleId:'weekly-expenses',runId:'run-one',turnIds,segment},host,{observedAt:T+1}),DomainError);
});

test('creation refuses a request that cannot fit the existing conversation after its localized dispatch prefix',async()=>{
 const store=new InMemoryStore<any>(),service=new SchedulesService(store,async()=>({turns:[]}),()=>T);
 await assert.rejects(service.act({commandId:'too-long',action:'create',kind:'price-watch',minute:540,offset:0,budget:{runs:3},request:'x'.repeat(4096)}),DomainError);
 assert.equal(await store.load(SCHEDULES_ID),null);
});

test('an explicitly malformed template kind cannot fall back to the legacy briefing command',async()=>{
 const store=new InMemoryStore<any>(),service=new SchedulesService(store,async()=>({turns:[]}),()=>T);
 await assert.rejects(service.act({commandId:'null-kind',action:'create',kind:null,minute:540,offset:0,budget:{runs:3}}),DomainError);
 assert.equal(await store.load(SCHEDULES_ID),null);
});
