import test from 'node:test';
import assert from 'node:assert/strict';
import {Application} from '../src/application.ts';
import {InMemoryStore} from '../src/storage.ts';
import type {Mission} from '../src/domain.ts';
const owner={id:'owner',roles:['owner'] as const};
const input={id:'mission',purpose:'Reliable work',scope:'sample',criteria:{version:1,description:'Known oracle',oracle:'test-v1'},constraints:['No network']};
async function app(){const a=new Application(new InMemoryStore<Mission>(),[owner]);await a.create(input,'owner','create');return a;}
const admit={missionId:'mission',commandId:'admit-a',expectedRevision:1,actorId:'owner',command:{type:'admit-work' as const,workId:'a',title:'First work',budget:0}};
test('same command replays original revision and snapshot after subsequent changes',async()=>{
 const a=await app();const first=await a.dispatch(admit);assert.equal(first.status,'committed');
 await a.dispatch({...admit,commandId:'admit-b',expectedRevision:2,command:{...admit.command,workId:'b'}});
 const replay=await a.dispatch(admit);assert.equal(replay.status,'replayed');assert.equal(replay.revision,2);
 assert.equal(replay.value.works.length,1);
 assert.equal((await a.store.load('mission'))?.value.works.length,2);
 const misuse=await a.dispatch({...admit,command:{...admit.command,title:'Different'}});assert.equal(misuse.status,'conflict');
});
test('two clients conflict rather than losing a transition',async()=>{
 const a=await app();const results=await Promise.all([a.dispatch(admit),a.dispatch({...admit,commandId:'admit-b',command:{...admit.command,workId:'b'}})]);
 assert.equal(results.filter(r=>r.status==='committed').length,1);assert.equal(results.filter(r=>r.status==='conflict').length,1);
 assert.equal((await a.store.load('mission'))?.value.works.length,1);
});
test('untrusted actor and malformed action cannot mutate state',async()=>{
 const a=await app();await assert.rejects(a.dispatch({...admit,actorId:'stranger'}),/Unknown actor/);
 await assert.rejects(a.dispatch({...admit,command:{type:'caller-says-passed'} as never}),/Unknown command/);
 assert.equal((await a.store.load('mission'))?.revision,1);
});
test('semantic duplicate ignores JSON property insertion order',async()=>{
 const a=await app();await a.dispatch(admit);
 const second=await a.dispatch({...admit,command:{budget:0,title:'First work',workId:'a',type:'admit-work'}});
 assert.equal(second.status,'replayed');
});
