import test from 'node:test';
import assert from 'node:assert/strict';
import {readTelemetryReviewFixture} from '../scripts/ui-contracts/read-telemetry-review-fixture.ts';
import {hash} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';

test('review captures bind pending/acknowledged notes and created/skipped Records to command-produced facts',async()=>{
 for(const kind of ['pending','acknowledged','created','skipped'] as const){
  const {fixture,workId}=await readTelemetryReviewFixture(kind),mission=(fixture.routes['/missions/intake']!.body as {value:Mission}).value,work=mission.works.find(w=>w.id===workId)!;
  if(kind==='pending'||kind==='acknowledged'){
   const note=mission.conversations!.find(c=>c.workId===workId)!.messages.find(m=>m.stepNote)!,task=work.tasks.find(t=>t.id===note.stepNote!.taskId)!;
   assert.equal(task.procedureEdit?.messageId,kind==='pending'?undefined:note.id);assert.equal(task.step!.title,'테스트 돌리기');assert.equal(task.status,'queued');
  }else if(kind==='created'){
   assert.equal(work.acceptance,'accepted');assert.ok(work.record!.createdAt!>=work.verdict!.checkedAt!);const {checksum,...record}=work.record!;assert.equal(checksum,hash(record));
  }else{assert.equal(work.verdict!.status,'failed');assert.ok(Number.isSafeInteger(work.verdict!.checkedAt));assert.equal(work.record,undefined);}
 }
});
