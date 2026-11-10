import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStepResult,validateProgressNote,workProgressNote} from '../src/member-progress.ts';
import {createMission} from '../src/domain.ts';
import {roomTelemetryWork} from '../scripts/ui-contracts/room-telemetry-fixtures.ts';

test('step result envelopes retain original structured bytes and reject malformed marked declarations',()=>{
 const result='{"format":"massion-facts/v1","items":[{"label":"Files","value":3}]}',progressNote={summary:'Read the supplied files.',caption:'Reading complete'};
 assert.deepEqual(parseStepResult(JSON.stringify({format:'massion-step/v1',result,progressNote})),{result,progressNote});
 assert.deepEqual(parseStepResult(result),{result});assert.deepEqual(parseStepResult('Ordinary text'),{result:'Ordinary text'});
 for(const v of [{format:'massion-step/v1',result,progressNote,extra:1},{format:'massion-step/v1',result,progressNote:null},{format:'massion-step/v1',result:'',progressNote},{format:'massion-step/v1',result:'x'.repeat(16001),progressNote}])assert.throws(()=>parseStepResult(JSON.stringify(v)),/bounded/);
 for(const summary of ['x\u2028y','x\u2029y','x\t','\u200b','\ud800'])assert.throws(()=>validateProgressNote({summary}),/wording/);
});

test('progress projections exclude skipped and checking seats and clear stale or unknown work',()=>{
 const m=createMission({id:'intake',purpose:'Read',scope:'local',constraints:[],criteria:{version:1,description:'Read',oracle:'fixture'}},{id:'local-owner',roles:['owner']}),{work}=roomTelemetryWork(m,'pricing');
 const note=workProgressNote(work);assert.ok(note?.summary);
 const last=work.tasks.find(t=>t.step&&t.progress?.wording)!;
 work.assignments=work.assignments.filter(a=>a.taskId!==last.id);assert.equal(workProgressNote(work),null);
 work.assignments.push({id:'wrong-seat',actorId:'checker',role:'verifier',taskId:last.id,model:{provider:'fixture',model:'fixture',reason:'fixture',configVersion:'v1',evidenceClass:'fixture'},extensionVersion:'v1'});assert.equal(workProgressNote(work),null);
 work.assignments.at(-1)!.role='executor';last.step!.skipReason='Already supplied';assert.equal(workProgressNote(work),null);delete last.step!.skipReason;
 for(const acceptance of ['stale','accepted'] as const){work.acceptance=acceptance;assert.equal(workProgressNote(work),null);}work.acceptance='pending';
 work.effects.push({id:'unknown',taskId:last.id,status:'unknown',target:'fixture',authority:'fixture'});assert.equal(workProgressNote(work),null);
});

test('a later boundary without wording clears an older narrative rather than reviving it',()=>{
 const m=createMission({id:'intake',purpose:'Read',scope:'local',constraints:[],criteria:{version:1,description:'Read',oracle:'fixture'}},{id:'local-owner',roles:['owner']}),{work}=roomTelemetryWork(m,'pricing'),previous=work.tasks.find(t=>t.progress?.wording)!,next=work.tasks.find(t=>t.step&&t!==previous&&!t.step.skipReason)!;
 next.status='active';next.progress={done:0,total:1,at:previous.progress!.at+1};assert.equal(workProgressNote(work),null);
});
