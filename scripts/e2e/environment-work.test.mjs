import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import {hash} from '../../src/domain.ts';
import {canResume} from '../../src/runtime-continuation.ts';

test('native member Work retains real reads, scoped fill, exact owner gates and observed order confirmation without payment',{timeout:180000},async()=>{
 let producer;
 await assert.doesNotReject(async()=>{producer=await import('../ui-contracts/environment-work-fixture.ts');},'The native member Work fixture producer must exist');
 const root=await mkdtemp(join(tmpdir(),'massion-environment-work-test-'));
 try{
  const result=await producer.produceEnvironmentWork(root),{checkpoints,memberId,workId}=result;
  const work=name=>checkpoints[name].snapshot.value.works.find(w=>w.id===workId);
  assert.equal(work('read').assistantSource.memberId,memberId);
  assert.equal(work('read').team.memberId,memberId);
  assert.equal(work('read').runtimeRun.environment.definition.memberId,memberId);
  assert.equal(checkpoints.read.members.members.find(m=>m.id===memberId).name,'퀼');
  const reply=checkpoints.read.chat.segment.messages.find(m=>m.role==='representative'&&m.turnId===result.turnId);
  assert.ok(reply);
  const settled=checkpoints.read.journal.find(op=>op.events[0]?.command?.type==='settle-assistant-turn').events[0].command;
  assert.equal(reply.text,settled.reply);
  assert.equal(checkpoints.read.chat.turns.find(t=>t.id===result.turnId).work.workId,workId);
  assert.equal(work('read').browserSession.pages[0].title,'로컬 주문 자료');
  assert.equal(work('secret').secretRequests[0].state,'open');
  assert.equal(work('submit').secretRequests[0].state,'provided');
  assert.equal(work('submit').execution,'waiting');
  assert.equal(checkpoints.submit.decisions.find(d=>d.state==='open').environment.kind,'action');
  assert.equal(checkpoints.device.decisions.find(d=>d.state==='open').environment.kind,'owner-action');
  assert.equal(work('device').tasks.flatMap(t=>t.environment?.records??[]).some(r=>r.kind==='owner-completed'),false);
  const accepted=work('accepted'),records=accepted.tasks.flatMap(t=>t.environment?.records??[]);
  assert.ok(records.some(r=>r.kind==='owner-completed'));
  assert.ok(records.some(r=>r.kind==='intent-approved'));
  assert.ok(records.some(r=>r.kind==='observed'&&r.observation.facts.orderConfirmed===true));
  assert.equal(accepted.acceptance,'accepted');
  assert.equal(accepted.verdict.status,'passed');
  assert.equal(checkpoints.accepted.artifact.recordChecksum,accepted.record.checksum);
  assert.ok(accepted.assignments.some(a=>a.role==='verifier'&&a.actorId!=='producer'));
  assert.equal(new Set(Object.values(checkpoints).map(c=>c.snapshot.value.works[0].runtimeRun.id)).size,1);
  assert.ok(accepted.browserSession.pages.length>=5);
  assert.ok(accepted.browserSession.pages.slice(1).every(p=>p.tainted===true));
  assert.ok(accepted.browserSession.pages.every(p=>p.address===result.origin));
  assert.equal(result.submissions,1);
  assert.equal(result.paymentCalls,0);
  assert.equal(result.filled,true);
  assert.equal(result.textDidNotConfirm,true);
  assert.equal(result.wrongHashRejected,true);
  const serialized=JSON.stringify(result);
  assert.ok(!serialized.includes('SYNTHETIC-PRIVATE-FIELD'));
  assert.ok(!serialized.includes('iVBOR'));
  assert.ok(!serialized.includes('"status":"paid"'));
  for(const checkpoint of Object.values(checkpoints))validateMissionJournalLineage(checkpoint.journal);
  const journal=checkpoints.accepted.journal;
  assert.throws(()=>validateMissionJournalLineage(journal.filter(op=>!op.aggregateId.startsWith('assistant-conversation:environment:'))),/environment Work journal is absent/);
  for(const kind of ['observe','link']){
   const changed=structuredClone(journal),operation=changed.find(op=>op.events[0]?.command?.type==='record-environment-work'&&op.events[0].command.update.kind===kind),event=operation.events[0];
   if(kind==='observe')event.command.update.observation.binding.revision++;
   else event.command.update.reference.hash=hash('forged-entry');
   operation.fingerprint=hash({actorId:event.actor,command:event.command});
   assert.throws(()=>validateMissionJournalLineage(changed),kind==='observe'?/environment observation journal binding mismatch/:/environment Work entry reference mismatch/);
  }
  for(const [screen,checkpoint] of [['B4','payment'],['B15','submit'],['B7','submitted'],['B8','submitted'],['B7-done','accepted'],['B8-done','accepted']]){
   const {loadFixture}=await import('../ui-contracts/fixture-host.ts');
   const source=await loadFixture(screen,['native-producer-source']);
   const fixture=producer.environmentWorkFixture(source,result);
   const selected=screen==='B15'?result.form:result,stored=fixture.routes['/read-state?mission=intake'].body.snapshot.value.works.find(w=>w.id===selected.workId);
   assert.deepEqual(stored,selected.checkpoints[checkpoint].snapshot.value.works[0]);
   assert.equal(fixture.routes['/assistant/works'].body.works.find(w=>w.workId===selected.workId).memberId,memberId);
   assert.ok(fixture.routes['/assistant/conversation?member='+memberId]);
   assert.ok(fixture.routes['/missions/intake/works/'+selected.workId+'/browser']);
   const prior=source.routes['/read-state?mission=intake'].body.snapshot.value.works;
   const previousMember=source.routes['/assistant/conversation'].body.members.find(m=>m.name==='퀼');
   for(const background of prior.filter(w=>w.title!==stored.title))assert.deepEqual(fixture.routes['/read-state?mission=intake'].body.snapshot.value.works.find(w=>w.id===background.id),JSON.parse(JSON.stringify(background).replaceAll(previousMember.id,memberId)));
  }
  assert.equal(result.form.checkpoints.submit.snapshot.value.works[0].title,'스터디룸 신청');
  assert.equal(result.form.submissions,1);assert.equal(result.form.paymentCalls,0);
  for(const checkpoint of Object.values(result.form.checkpoints))validateMissionJournalLineage(checkpoint.journal);
  const uncertain=result.unknown,unknown=uncertain.checkpoints.unknown.snapshot.value.works.find(w=>w.id===uncertain.workId);
  assert.equal(unknown.execution,'blocked');assert.equal(unknown.acceptance,'pending');assert.equal(unknown.record,undefined);assert.equal(unknown.verdict,undefined);assert.equal(unknown.effects.filter(e=>e.status==='unknown').length,1);assert.equal(canResume(unknown,uncertain.checkpoints.unknown.now),false);
  assert.ok(unknown.effects.find(e=>e.status==='unknown').providerDispatch);assert.ok(unknown.tasks.flatMap(t=>t.environment?.records??[]).some(r=>r.kind==='intent-approved'));assert.ok(!unknown.tasks.flatMap(t=>t.environment?.records??[]).some(r=>r.kind==='observed'&&r.observation.facts.orderConfirmed===true));assert.equal(uncertain.paymentCalls,0);assert.equal(uncertain.submissions,1);
  for(const checkpoint of Object.values(uncertain.checkpoints))validateMissionJournalLineage(checkpoint.journal);
  await producer.saveEnvironmentWorkFixtures(result);
  const {loadFixture}=await import('../ui-contracts/fixture-host.ts');
  assert.deepEqual((await loadFixture('B15')).routes['/read-state?mission=intake'].body.snapshot.value.works.find(w=>w.id===result.form.workId),result.form.checkpoints.submit.snapshot.value.works[0]);
 }finally{await rm(root,{recursive:true,force:true});}
});
