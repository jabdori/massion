import test from 'node:test';
import assert from 'node:assert/strict';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {hash,workInputHash} from '../src/domain.ts';
import {STEERING_SCREENS} from '../scripts/ui-contracts/steering-fixture.ts';
import type {Mission} from '../src/domain.ts';

for(const screen of STEERING_SCREENS)test(`${screen} has confirmed enterprise steering and continued real Work state`,async()=>{
 const fixture=await loadFixture(screen),mission=(fixture.routes['/missions/intake']!.body as {value:Mission}).value;
 const source=await loadFixture(screen,['steering-source']),original=(source.routes['/missions/intake']!.body as {value:Mission}).value.works.find(w=>w.title==='이탈 원인 조사')!;
 const work=mission.works.find(w=>w.title==='이탈 원인 조사')!,view=fixture.routes['/assistant/conversation?member=member-quill']!.body as any;
 const turn=view.turns.find((t:any)=>t.steer?.status==='recorded');assert.equal(turn.steer.workId,work.id);assert.equal(turn.steer.title,work.title);
 const times=view.segment.messages.slice(0,4).map((m:any)=>m.at);assert.ok(times.every((at:number,i:number)=>Number.isSafeInteger(at)&&(!i||at>=times[i-1])),'member exchange times follow their displayed chronology');
 assert.equal(work.instructions!.at(-1)!.text,'기업 고객은 따로 봐 줘.');assert.equal(work.runtimeRun!.inputHash,workInputHash(work));
 const initial=(fixture.routes['/read-state?mission=intake']!.body as any).snapshot.value.works.find((w:any)=>w.id===work.id);assert.deepEqual(initial,work);
 assert.ok(work.tasks.some(t=>t.step&&t.endedAt!>=work.instructions!.at(-1)!.at!));assert.ok(!fixture.gaps.some(g=>g.startsWith('Confirmed enterprise steering followed')));
 for(const task of original.tasks.filter(t=>t.step)){const produced=work.tasks.find(t=>t.id===task.id)!;assert.deepEqual(produced.step,task.step);assert.equal(produced.status,task.status);assert.equal(produced.result,task.result);assert.equal(work.effects.filter(e=>e.taskId===task.id).length,task.step!.skipReason||task.status==='queued'?0:1);}
 assert.equal(work.execution,['B7-churn','B18-room-b'].includes(screen)?'active':'settled');
 if(work.execution==='active'){assert.equal(work.endedAt,undefined);assert.ok(work.runtimeRun!.ownership!.deadlineAt>fixture.now);}
 else{assert.equal(work.acceptance,'failed');const route=Object.entries(fixture.routes).find(([path,r])=>path.includes('/rejected-artifact?')&&(r.body as any).workId===work.id)!;assert.ok(route);assert.equal(new URL(route[0],'http://fixture').searchParams.get('binding'),hash(work));assert.equal((route[1].body as any).inputHash,workInputHash(work));}
});
