import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext,Script} from 'node:vm';
import {workbenchPage} from '../src/workbench.ts';
import type {Mission} from '../src/domain.ts';

const fixtureMission=(id='mission:test'):Mission=>({id,version:1,purpose:'Inspect durable work',scope:'test',constraints:['Do not execute providers'],criteria:{version:1,description:'Evidence is inspectable',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]});
function work(mission:Mission,title='A bounded responsibility') {
 return {id:'work:test',title,missionVersion:1,criteria:mission.criteria,execution:'queued' as const,acceptance:'pending' as const,tasks:[],attempts:[{id:'attempt:1',number:1,criteria:mission.criteria,status:'queued' as const,modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:['explicit@1'],budget:{limit:12,reserved:0,measured:0}};
}

import {harness,reply,settle,selectionField,SharedWebLocks} from './support/workbench-client.ts';
import type {Node,Reply,Handler} from './support/workbench-client.ts';

test('workbench has usable labeled forms and no dynamic HTML sinks',()=>{
 assert.match(workbenchPage,/Create a Mission/);assert.match(workbenchPage,/Run development fixture/);
 assert.match(workbenchPage,/manual-review\/v1/);assert.match(workbenchPage,/aria-live="polite"/);
 assert.doesNotMatch(workbenchPage,/innerHTML|insertAdjacentHTML|document\.write\(/);
 new Script(workbenchPage.match(/<script>([\s\S]*)<\/script>/)![1]!);
});

test('acceptance guidance describes both methods and preserves the explicit execution boundary',()=>{
 const hint=workbenchPage.match(/<p id="criteria-oracle-hint" class="hint">([^<]+)<\/p>/)![1]!;
 assert.match(hint,/Saved with the selected acceptance method/);
 assert.match(hint,/Manual review uses manual-review\/v1, which this client cannot execute/);
 assert.match(hint,/Bounded text uses bounded-text-review\/v1 with independent model review during an explicitly requested Work run/);
 assert.match(hint,/Selecting a method or creating a Mission does not start execution or mark Work accepted/);
 assert.match(workbenchPage,/<select id="criteria-oracle" aria-describedby="criteria-oracle-hint">/);
 assert.doesNotMatch(workbenchPage,/Saved as manual-review\/v1/);
});

for(const oracle of ['manual-review/v1','bounded-text-review/v1'])test(`Mission creation preserves ${oracle} without execution or acceptance`,async()=>{
 let mission:Mission|undefined;
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:[],cursor:0});
  const body=JSON.parse(options.body);
  if(path==='/missions'){
   mission={...fixtureMission(body.id),criteria:body.criteria};
   return reply({status:'committed',revision:1,value:mission},201);
  }
  if(path==='/missions/'+encodeURIComponent(mission!.id)+'/work'){
   mission!.works.push({...work(mission!),id:body.workId,title:body.title});
   return reply({status:'committed',revision:2,value:mission},201);
  }
  throw new Error('Unexpected '+path);
 });await settle();
 app.node('purpose').value='Inspect selected criteria';app.node('scope').value='Project';app.node('criteria').value='A reviewable result';
 // Selection changes are side-effect-free, including switching back to either method.
 for(const selected of [oracle,oracle==='manual-review/v1'?'bounded-text-review/v1':'manual-review/v1',oracle]){
  app.node('criteria-oracle').value=selected;await app.node('criteria-oracle').fire('change');await settle();
  assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);
 }
 await app.submit('mission-form');
 const created=JSON.parse(app.node('snapshot-json').textContent);
 assert.equal(created.value.criteria.oracle,oracle);assert.deepEqual(created.value.works,[]);
 assert.equal(JSON.parse(app.calls.find(call=>call.path==='/missions')!.options.body).criteria.oracle,oracle);
 assert.deepEqual(app.calls.filter(call=>call.options.method==='POST').map(call=>call.path),['/missions']);
 app.node('work-title').value='Admitted responsibility';await app.submit('work-form');
 const admitted=JSON.parse(app.node('snapshot-json').textContent).value.works[0];
 assert.equal(admitted.criteria.oracle,oracle);assert.equal(admitted.execution,'queued');assert.equal(admitted.acceptance,'pending');assert.equal(admitted.record,undefined);
 assert.match(app.node('work-list').textContent,/Acceptance: pending/);assert.doesNotMatch(app.node('work-list').textContent,/Acceptance: accepted/);
 assert.deepEqual(app.calls.filter(call=>call.options.method==='POST').map(call=>call.path),['/missions','/missions/'+encodeURIComponent(mission!.id)+'/work']);
});

test('Mission submit has stable IDs, blocks duplicate writes and renders host text safely',async()=>{
 let resolvePost!:(result:Reply)=>void;let submitted:any;
 const app=harness(async(path,options)=>{
  if(path==='/events?after=0')return reply({events:[],cursor:0});
  if(path==='/missions'){submitted=JSON.parse(options.body);return new Promise<Reply>(resolve=>{resolvePost=resolve;});}
  throw new Error('Unexpected '+path);
 });await settle();
 app.node('purpose').value='<img src=x onerror=alert(1)>';app.node('scope').value='Project';app.node('constraints').value='First\n Second\n\n';app.node('criteria').value='A reviewable result';
 const first=app.node('mission-form').fire('submit');await settle();await app.node('mission-form').fire('submit');
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(app.node('mission-fields').disabled,true);
 assert.equal(submitted.id,'mission:uuid-1');assert.equal(submitted.commandId,'uuid-2');assert.deepEqual(submitted.constraints,['First','Second']);assert.equal(submitted.criteria.oracle,'manual-review/v1');
 resolvePost(reply({status:'committed',revision:1,value:{...fixtureMission(submitted.id),purpose:submitted.purpose}},201));await first;await settle();
 assert.equal(app.node('mission-purpose').textContent,submitted.purpose);assert.equal(app.node('mission-purpose').children.length,0);
 assert.equal(app.storage.get('massion.workbench.mission'),submitted.id);assert.equal(app.node('mission-fields').disabled,false);
 assert.match(app.node('provider-notice').textContent,/unavailable/);
});

test('manually entered Mission survives reload and failed refresh clears stale JSON and controls',async()=>{
 let fail=false;const mission=fixtureMission();mission.works.push(work(mission));
 const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):fail?reply({error:'Store unavailable'},503):reply({revision:3,value:mission}));await settle();
 app.node('mission-id').value=mission.id;await app.submit('load-form');
 assert.equal(app.storage.get('massion.workbench.mission'),mission.id);assert.match(app.node('snapshot-json').textContent,/Inspect durable work/);
 assert.match(app.node('work-list').textContent,/Attempts1/);assert.match(app.node('work-list').textContent,/explicit@1/);assert.match(app.node('work-list').textContent,/Provider unavailable/);
 fail=true;await app.submit('load-form');
 assert.equal(app.node('snapshot-json').textContent,'');assert.equal(app.node('work-list').children.length,0);assert.equal(app.node('mission-panel').hidden,true);assert.equal(app.node('work-fields').disabled,true);assert.match(app.node('status').textContent,/Refresh failed/);
});

test('Work admission uses the current revision and conflict refresh never retries the write',async()=>{
 const mission=fixtureMission();let revision=2;let submitted:any;
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:[],cursor:0});
  if(options.method==='POST'){submitted=JSON.parse(options.body);revision=4;return reply({status:'conflict',revision:4},409);}
  return reply({revision,value:mission});
 },{'massion.workbench.mission':mission.id});await settle();
 app.node('work-title').value='Build the report';app.node('work-budget').value='12.5';await app.submit('work-form');
 assert.equal(submitted.expectedRevision,2);assert.equal(submitted.budget,12.5);assert.equal(submitted.workId,'work:uuid-2');
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);assert.equal(app.node('revision').textContent,'Revision 4');assert.match(app.node('status').textContent,/not retried/);
});

test('unknown write stays blocked until an exact durable command receipt arrives',async()=>{
 const mission=fixtureMission();let command:any;let seen=false;let createdWork=false;
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:seen?[{cursor:1,aggregateId:mission.id,revision:2,commandId:command.commandId,events:[{type:'admit-work'}]}]:[],cursor:seen?1:0});
  if(options.method==='POST'){command=JSON.parse(options.body);createdWork=true;throw new Error('Connection lost');}
  return reply({revision:createdWork?2:1,value:createdWork?{...mission,works:[{...work(mission),id:command.workId}]}:mission});
 },{'massion.workbench.mission':mission.id});await settle();
 app.node('work-title').value='Do bounded work';await app.submit('work-form');
 assert.equal(app.node('operation-notice').hidden,false);assert.match(app.node('operation-notice').textContent,/Outcome unknown/);
 assert.equal(app.node('work-fields').disabled,true);assert.equal(app.node('mission-fields').disabled,true);
 await app.submit('work-form');assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);
 seen=true;await app.tick();
 assert.equal(app.node('operation-notice').hidden,true);assert.equal(app.node('work-fields').disabled,false);assert.equal(app.storage.get('massion.workbench.cursor'),'1');assert.match(app.node('event-list').textContent,/admit work/);
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);
});

test('unknown reconciliation advances across event pages without replaying commands',async()=>{
 const mission=fixtureMission();let command:any;let posted=false;let page=0;
 const app=harness((path,options)=>{
  if(options.method==='POST'){command=JSON.parse(options.body);posted=true;throw new Error('Lost response');}
  if(path.startsWith('/events')){
   if(!posted)return reply({events:[],cursor:0});page++;
   const cursor=page;return reply({events:[{cursor,aggregateId:page===1?'mission:other':mission.id,revision:2,commandId:page===1?'another-command':command.commandId,events:[{type:'admit-work'}]}],cursor});
  }
  return reply({revision:1,value:mission});
 },{'massion.workbench.mission':mission.id});await settle();app.node('work-title').value='Bounded';await app.submit('work-form');
 assert.equal(app.node('operation-notice').hidden,false);await app.tick();
 assert.ok(app.calls.some(call=>call.path==='/events?after=1'));assert.equal(app.node('operation-notice').hidden,true);
});

test('cursor ahead of the host safely resets and reconnects from durable history',async()=>{
 const mission=fixtureMission();
 const app=harness(path=>path==='/events?after=99'?reply({error:'Cursor is ahead'},409):path.startsWith('/events')?reply({events:[{cursor:1,aggregateId:mission.id,revision:1,commandId:'created',events:[{type:'mission-created'}]}],cursor:1}):reply({revision:1,value:mission}),{'massion.workbench.mission':mission.id,'massion.workbench.cursor':'99'});await settle();
 assert.equal(app.storage.get('massion.workbench.cursor'),'0');await app.tick();assert.equal(app.storage.get('massion.workbench.cursor'),'1');assert.match(app.node('event-list').textContent,/mission created/);
});

test('steer and cancel send only explicit commands and terminal Work loses controls',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission));let revision=1;const commands:any[]=[];
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:[],cursor:0});
  if(options.method==='POST'){const body=JSON.parse(options.body);commands.push(body);mission.works[0]!.execution=body.command.type==='cancel'?'cancelled':'waiting';return reply({status:'committed',revision:++revision,value:mission});}
  return reply({revision,value:mission});
 },{'massion.workbench.mission':mission.id});await settle();
 const input=app.all().find(node=>node.id==='steer-work:test')!;input.value='Stay within the approved scope';await input.fire('input');
 await app.all().find(node=>node.className==='steer-form')!.fire('submit');await settle();
 assert.equal(commands[0].command.instruction,'Stay within the approved scope');assert.equal(commands[0].expectedRevision,1);assert.match(app.node('work-list').textContent,/Execution: waiting/);
 await app.all().find(node=>node.textContent==='Cancel Work')!.fire('click');await settle();
 assert.equal(commands[1].command.type,'cancel');assert.equal(commands[1].expectedRevision,2);assert.equal(app.all().filter(node=>node.hasAttribute('data-write')).length,0);assert.match(app.node('work-list').textContent,/Execution: cancelled/);
});

test('an unknown fixture response never becomes a success or permits a blind fixture rerun',async()=>{
 const app=harness((path,options)=>{if(options.method==='POST')throw new Error('Connection lost');return reply({events:[],cursor:0});});await settle();
 await app.node('run-fixture').fire('click');await settle();assert.match(app.node('status').textContent,/Fixture outcome unknown/);assert.equal(app.node('run-fixture').disabled,true);
 runInContext('controls()',app.context);assert.equal(app.node('run-fixture').disabled,true);
});

test('known rolled-back contention is a rejected write, not an unresolved commit',async()=>{
 const mission=fixtureMission();
 const app=harness((path,options)=>options.method==='POST'?reply({outcome:'rejected',retryable:true,error:'Rolled back'},503):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:2,value:mission}),{'massion.workbench.mission':mission.id});await settle();
 app.node('work-title').value='A bounded responsibility';await app.submit('work-form');
 assert.equal(app.node('operation-notice').hidden,true);assert.equal(app.node('work-fields').disabled,false);assert.match(app.node('status').textContent,/confirmed a transaction rollback/);assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);
});

test('blocked Work renders its actual gate and persisted steering without claiming it resumed',async()=>{
 const mission=fixtureMission();mission.works.push({...work(mission),execution:'blocked',blocker:{code:'provider_unavailable',detail:'No authorized adapter is configured.'},instructions:[{actorId:'owner',text:'Keep the current budget.'}]});
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:[],cursor:0});
  if(options.method==='POST'){const body=JSON.parse(options.body);mission.works[0]!.instructions!.push({actorId:'owner',text:body.command.instruction});return reply({status:'committed',revision:2,value:mission});}
  return reply({revision:1,value:mission});
 },{'massion.workbench.mission':mission.id});await settle();
 assert.match(app.node('work-list').textContent,/Execution: blocked/);assert.match(app.node('work-list').textContent,/No authorized adapter is configured/);assert.match(app.node('work-list').textContent,/Latest owner instruction: Keep the current budget/);
 const input=app.all().find(node=>node.id==='steer-work:test')!;input.value='Stay bounded';await input.fire('input');await app.all().find(node=>node.className==='steer-form')!.fire('submit');await settle();
 assert.match(app.node('work-list').textContent,/Execution: blocked/);assert.match(app.node('work-list').textContent,/Latest owner instruction: Stay bounded/);assert.doesNotMatch(app.node('status').textContent,/Work is waiting/);
});

test('pending identity is persisted before transmission and reload recovers read-only until an exact receipt',async()=>{
 const mission=fixtureMission();let resolvePost!:(value:Reply)=>void;let submitted:any;
 const first=harness((path,options)=>{
  if(options.method==='POST'){
   submitted=JSON.parse(options.body);
   const pending=JSON.parse(first.storage.get('massion.workbench.pending')!);
   assert.deepEqual(pending,{commandId:submitted.commandId,missionId:mission.id,reconcileCursor:0});
   assert.equal(Object.keys(pending).length,3);
   return new Promise<Reply>(resolve=>{resolvePost=resolve;});
  }
  return path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission});
 },{'massion.workbench.mission':mission.id});await settle();
 first.node('work-title').value='Private user text must not enter browser recovery storage';
 const inFlight=first.node('work-form').fire('submit');await settle();
 assert.ok(first.storage.has('massion.workbench.pending'));assert.doesNotMatch(first.storage.get('massion.workbench.pending')!,/Private|title|budget/);
 let matching=false;
 const reloaded=harness(path=>{
  if(path.startsWith('/events'))return reply({events:matching?[{cursor:1,aggregateId:mission.id,revision:2,commandId:submitted.commandId,events:[{type:'admit-work'}]}]:[],cursor:matching?1:0});
  return reply({revision:2,value:{...mission,works:[{...work(mission),id:submitted.workId}]}});
 },Object.fromEntries(first.storage));await settle();
 assert.equal(reloaded.node('mission-fields').disabled,true);assert.equal(reloaded.node('work-fields').disabled,true);assert.equal(reloaded.node('operation-notice').hidden,false);
 assert.equal(reloaded.calls.filter(call=>call.options.method==='POST').length,0);
 assert.ok(reloaded.storage.has('massion.workbench.pending'),'snapshot evidence alone cannot clear the pending identity');
 matching=true;await reloaded.tick();
 assert.equal(reloaded.node('work-fields').disabled,false);assert.equal(reloaded.storage.has('massion.workbench.pending'),false);assert.equal(reloaded.calls.filter(call=>call.options.method==='POST').length,0);
 resolvePost(reply({status:'committed',revision:2,value:mission}));await inFlight;await settle();
 assert.equal(first.storage.has('massion.workbench.pending'),false,'confirmed HTTP response clears the saved reference');
});

test('reload after a lost response retains the command lock through absent and unrelated receipts',async()=>{
 const mission=fixtureMission();let submitted:any;
 const first=harness((path,options)=>{if(options.method==='POST'){submitted=JSON.parse(options.body);throw new Error('Lost response');}return path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission});},{'massion.workbench.mission':mission.id});await settle();first.node('work-title').value='Bounded';await first.submit('work-form');
 const reloaded=harness(path=>path.startsWith('/events')?reply({events:[{cursor:1,aggregateId:'mission:different',revision:1,commandId:submitted.commandId,events:[{type:'admit-work'}]}],cursor:1}):reply({error:'Read unavailable'},503),Object.fromEntries(first.storage));await settle();
 assert.equal(reloaded.node('mission-fields').disabled,true);assert.equal(reloaded.node('operation-notice').hidden,false);assert.ok(reloaded.storage.has('massion.workbench.pending'));assert.equal(reloaded.calls.filter(call=>call.options.method==='POST').length,0);
});

test('unreadable or corrupted recovery references lock writes without leaking stored text',async()=>{
 const invalid=[JSON.stringify({commandId:'command:test',missionId:'mission:test',reconcileCursor:-1}),JSON.stringify({commandId:'command:test',missionId:'mission:test',reconcileCursor:Number.MAX_SAFE_INTEGER+1}),'{invalid',JSON.stringify({commandId:'secret<script>',missionId:'mission:test',reconcileCursor:0})];
 for(const saved of invalid){
  const app=harness(path=>reply({events:[],cursor:0}),{'massion.workbench.pending':saved});await settle();
  assert.equal(app.node('mission-fields').disabled,true);assert.match(app.node('operation-notice').textContent,/unreadable/);assert.doesNotMatch(app.node('operation-notice').textContent,/secret<script>/);assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);
 }
 const unreadable=harness(()=>reply({events:[],cursor:0}),{},'read');await settle();assert.equal(unreadable.node('mission-fields').disabled,true);assert.match(unreadable.node('operation-notice').textContent,/unavailable/);
});

test('a failed pending-reference save blocks transmission while reads remain available',async()=>{
 const mission=fixtureMission();
 const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission}),{'massion.workbench.mission':mission.id},'write');await settle();
 app.node('work-title').value='Bounded';await app.submit('work-form');
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);assert.match(app.node('operation-notice').textContent,/No command was sent/);assert.equal(app.node('load-mission').disabled,false);assert.equal(app.node('mission-fields').disabled,true);
});

test('an in-flight fixture marker survives reload and never triggers automatic execution',async()=>{
 let resolvePost!:(reply:Reply)=>void;
 const first=harness((path,options)=>options.method==='POST'?new Promise<Reply>(resolve=>{resolvePost=resolve;}):reply({events:[],cursor:0}));await settle();
 const pending=first.node('run-fixture').fire('click');await settle();assert.equal(first.storage.get('massion.workbench.fixture-pending'),'pending');
 const reloaded=harness(()=>reply({events:[],cursor:0}),Object.fromEntries(first.storage));await settle();
 assert.equal(reloaded.node('run-fixture').disabled,true);assert.match(reloaded.node('operation-notice').textContent,/host logs/);assert.equal(reloaded.calls.filter(call=>call.options.method==='POST').length,0);
 await reloaded.node('run-fixture').fire('click');assert.equal(reloaded.calls.filter(call=>call.options.method==='POST').length,0);
 resolvePost(reply({error:'Ambiguous outcome'},500));await pending;assert.equal(first.storage.get('massion.workbench.fixture-pending'),'pending');
});

test('an explicit identity conflict clears pending rejection but is not mislabeled as a revision race',async()=>{
 const mission=fixtureMission();
 const app=harness((path,options)=>options.method==='POST'?reply({status:'conflict',reason:'idempotency',revision:1},409):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission}),{'massion.workbench.mission':mission.id});await settle();
 app.node('work-title').value='Bounded';await app.submit('work-form');
 assert.equal(app.storage.has('massion.workbench.pending'),false);assert.match(app.node('status').textContent,/Command identity conflict/);assert.doesNotMatch(app.node('status').textContent,/Revision conflict/);assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);
});

test('two simultaneous tabs cannot overwrite pending identities or clear a newer different-Mission command',async()=>{
 const storage=new Map<string,string>();const locks=new SharedWebLocks();const commands:any[]=[];
 let completeFirst!:(value:Reply)=>void,completeSecond!:(value:Reply)=>void,receipt=false;
 const handler:Handler=(path,options)=>{
  if(options.method==='POST'){
   const body=JSON.parse(options.body);commands.push(body);
   assert.equal(JSON.parse(storage.get('massion.workbench.pending')!).commandId,body.commandId);
   return new Promise<Reply>(resolve=>{if(commands.length===1)completeFirst=resolve;else completeSecond=resolve;});
  }
  if(path.startsWith('/events'))return reply({events:receipt?[{cursor:1,aggregateId:commands[0].id,revision:1,commandId:commands[0].commandId,events:[{type:'mission-created'}]}]:[],cursor:receipt?1:0});
  return reply({revision:1,value:fixtureMission(decodeURIComponent(path.slice('/missions/'.length)))});
 };
 const first=harness(handler,{},undefined,{storage,locks,identity:'client-a'});
 const second=harness(handler,{},undefined,{storage,locks,identity:'client-b'});await settle();
 for(const app of [first,second]){app.node('purpose').value='A separate purpose';app.node('scope').value='Scope';app.node('criteria').value='Inspect evidence';}
 // These submissions overlap before the lock callback executes; they are not sequential claims.
 const firstRequest=first.node('mission-form').fire('submit');const collision=second.node('mission-form').fire('submit');await settle();await collision;
 assert.equal(commands.length,1);assert.equal(commands[0].id,'mission:client-a-1');assert.match(second.node('status').textContent,/Another tab/);
 assert.equal(JSON.parse(storage.get('massion.workbench.pending')!).commandId,commands[0].commandId);
 // Once the atomic claim lock is free, the saved marker still blocks the other client.
 await second.submit('mission-form');assert.equal(commands.length,1);assert.equal(second.node('mission-fields').disabled,true);
 receipt=true;await second.tick();assert.equal(storage.has('massion.workbench.pending'),false);assert.equal(second.node('mission-fields').disabled,false);
 // A receipt can settle A before its original HTTP response returns. B may now submit.
 const secondRequest=second.node('mission-form').fire('submit');await settle();assert.equal(commands.length,2);assert.notEqual(commands[1].id,commands[0].id);
 const secondMarker=storage.get('massion.workbench.pending');
 completeFirst(reply({status:'committed',revision:1,value:fixtureMission(commands[0].id)},201));await firstRequest;await settle();
 assert.equal(storage.get('massion.workbench.pending'),secondMarker,'late cleanup of A must preserve B');
 assert.equal(first.node('mission-fields').disabled,true,'the earlier tab observes the newer pending identity');
 completeSecond(reply({status:'committed',revision:1,value:fixtureMission(commands[1].id)},201));await secondRequest;await settle();
 assert.equal(storage.has('massion.workbench.pending'),false);assert.equal(commands.length,2);
});

test('missing Web Locks fails closed for mutations while snapshots can still be read',async()=>{
 const mission=fixtureMission();
 const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission}),{'massion.workbench.mission':mission.id},undefined,{noLocks:true});await settle();
 assert.equal(app.node('mission-panel').hidden,false);assert.equal(app.node('mission-fields').disabled,true);assert.equal(app.node('work-fields').disabled,true);assert.equal(app.node('run-fixture').disabled,true);assert.match(app.node('operation-notice').textContent,/Web Locks unavailable/);assert.equal(app.node('load-mission').disabled,false);
 app.node('work-title').value='A bounded request';await app.submit('work-form');assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);
});

test('owner quarantine form requires reason and explicit uncertainty acknowledgement and binds original run',async()=>{
 const mission=fixtureMission();const w:Mission['works'][number]={...work(mission),execution:'cancelled',runtimeRun:{id:'run-original',authorizationId:'mock',criteriaHash:'a'.repeat(64),inputHash:'b'.repeat(64),mode:'mock-http',outputTokenCap:4},effects:[{id:'effect',taskId:'task',status:'pending',target:'mock',authority:'mock'}]};mission.works.push(w);let submitted:any;
 const app=harness((path,options)=>{if(path.startsWith('/events'))return reply({events:[],cursor:0});if(options.method==='POST'){submitted=JSON.parse(options.body);return reply({status:'committed',revision:4,value:{...mission,works:[{...w,execution:'cancelled',runtimeRecovery:{runId:'run-original',actorId:'local-owner',reason:submitted.command.reason,pendingEffectIds:['effect'],unknownEffectIds:[]},effects:[{...w.effects[0],status:'unknown'}]}]}});}return reply({revision:3,value:mission});});await settle();app.node('mission-id').value=mission.id;await app.submit('load-form');
 const form=app.all().find(node=>node.className==='quarantine-form');assert.ok(form);const reason=app.all().find(node=>node.id==='quarantine-reason-'+w.id)!;const acknowledgement=app.all().find(node=>node.id==='quarantine-ack-'+w.id)!;
 await form.fire('submit');await settle();assert.equal(submitted,undefined);reason.value='<script>Owner inspected uncertain output</script>';await form.fire('submit');await settle();assert.equal(submitted,undefined);
 (acknowledgement as Node&{checked:boolean}).checked=true;await form.fire('submit');await settle();const actual=JSON.parse(app.calls.find(call=>call.options.method==='POST')!.options.body);assert.equal(actual.expectedRevision,3);assert.deepEqual(actual.command,{type:'quarantine-runtime',workId:w.id,runId:'run-original',reason:reason.value,acknowledgeUncertainOutcome:true});
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,1);assert.match(app.node('work-list').textContent,/Permanently quarantined/);assert.match(app.node('work-list').textContent,/<script>Owner inspected uncertain output<\/script>/);assert.equal(app.all().some(node=>node.className==='quarantine-form'),false);
});
test('quarantine controls are absent for unconfigured and accepted Work',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission),{...work(mission),id:'accepted',acceptance:'accepted',runtimeRun:{id:'run',authorizationId:'mock',criteriaHash:'a'.repeat(64),inputHash:'b'.repeat(64),mode:'mock-http',outputTokenCap:4}});
 const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:3,value:mission}));await settle();app.node('mission-id').value=mission.id;await app.submit('load-form');assert.equal(app.all().some(node=>node.className==='quarantine-form'),false);
});

test('selected run unlocks owner controls after durable admission while HTTP completion remains pending',async()=>{
 const mission=fixtureMission();mission.criteria.oracle='bounded-text-review/v1';mission.works.push(work(mission));let revision=2,command:any,finish!:(value:Reply)=>void,admitted=false;
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({events:admitted?[{cursor:1,aggregateId:mission.id,revision:3,commandId:command.commandId,events:[{type:'activate-runtime'}]}]:[],cursor:admitted?1:0});
  if(path.endsWith('/run')){command=JSON.parse(options.body);return new Promise(resolve=>{finish=resolve;});}
  if(options.method==='POST'){const b=JSON.parse(options.body);assert.equal(b.command.type,'cancel');assert.equal(b.expectedRevision,3);mission.works[0]!.execution='cancelled';revision=4;return reply({status:'committed',revision,value:structuredClone(mission)});}
  return reply({revision,value:structuredClone(mission)});
 });await settle();app.node('mission-id').value=mission.id;await app.submit('load-form');
 runInContext(`runtimeConfiguration={connections:[{id:'a',label:'A',backend:'model-provider',providerKind:'fixture',model:'exact',protocol:'test',endpoint:'http://127.0.0.1:1234',auth:{method:'none'},limits:{maxOutputTokens:8},usage:{inputTokens:'reported'},diagnostics:[]}],authorizations:[{id:'grant',scope:'test',mode:'mock-http',maxOutputTokensPerCall:8}]};renderMission();`,app.context);
 const find=(id:string)=>app.all().find(n=>n.id===id)!;find('executor-profile-work:test').value='a';find('verifier-profile-work:test').value='a';find('authorization-work:test').value='grant';find('output-cap-work:test').value='4';
 const form=app.all().find(n=>n.className==='execution-form')!;const pending=form.fire('submit');await settle();assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,1);const duplicate=form.fire('submit');await settle();await duplicate;assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,1);
 mission.works[0]!.runtimeRun={id:command.commandId,authorizationId:'grant',criteriaHash:'a'.repeat(64),inputHash:'b'.repeat(64),mode:'mock-http',outputTokenCap:4};mission.works[0]!.execution='active';revision=3;admitted=true;await app.tick();
 assert.equal(app.all().some(n=>n.className==='execution-form'),false);const cancel=app.all().find(n=>n.textContent==='Cancel Work')!;assert.equal(cancel.disabled,false);await cancel.fire('click');await settle();assert.equal(app.calls.filter(c=>c.options.method==='POST').length,2);assert.equal(app.node('revision').textContent,'Revision 4');
 finish(reply({status:'cancelled',snapshot:{revision:3,value:{...mission,works:[{...mission.works[0]!,execution:'active'}]}}}));await pending;await settle();assert.equal(app.node('revision').textContent,'Revision 4','late run response must not overwrite cancellation');
});

test('late admitted run error does not steal navigation to an earlier Mission',async()=>{
 const first=fixtureMission('first');first.works.push(work(first));const second=fixtureMission('second');let finish!:(value:Reply)=>void,command:any,admitted=false;
 const app=harness((path,options)=>{
  if(path.endsWith('/run')){command=JSON.parse(options.body);return new Promise(resolve=>{finish=resolve;});}
  if(path.startsWith('/events'))return reply({events:admitted?[{cursor:1,aggregateId:'first',revision:3,commandId:command.commandId,events:[{type:'activate-runtime'}]}]:[],cursor:admitted?1:0});
  return reply({revision:path.endsWith('first')?3:1,value:path.endsWith('first')?first:second});
 });await settle();app.node('mission-id').value='first';await app.submit('load-form');const running=runInContext(`write('/missions/first/run',{commandId:'run-background',expectedRevision:2,workId:'work:test',selection:{}},'first','Run finished')`,app.context);await settle();admitted=true;await app.tick();
 app.node('mission-id').value='second';await app.submit('load-form');assert.equal(app.node('loaded-id').textContent,'second');const priorFirstReads=app.calls.filter(c=>c.path==='/missions/first').length;
 finish(reply({outcome:'admitted-unsettled',error:'Synthetic connection loss'},503));await running;await settle();assert.equal(app.node('loaded-id').textContent,'second');assert.equal(app.calls.filter(c=>c.path==='/missions/first').length,priorFirstReads);
});

test('known run rollback after navigation clears only its pending marker without waiting for an impossible receipt',async()=>{
 const first=fixtureMission('first'),second=fixtureMission('second');let finish!:(value:Reply)=>void;
 const app=harness((path)=>{if(path.endsWith('/run'))return new Promise(resolve=>{finish=resolve;});if(path.startsWith('/events'))return reply({events:[],cursor:0});return reply({revision:1,value:path.endsWith('first')?first:second});});await settle();app.node('mission-id').value='first';await app.submit('load-form');
 const running=runInContext(`write('/missions/first/run',{commandId:'rejected-run',expectedRevision:1,workId:'work',selection:{}},'first','Run finished')`,app.context);await settle();assert.equal(app.storage.has('massion.workbench.pending'),true);app.node('mission-id').value='second';await app.submit('load-form');
 finish(reply({outcome:'rejected',error:'Rolled back transaction'},503));await running;await settle();assert.equal(app.storage.has('massion.workbench.pending'),false);assert.equal(app.node('loaded-id').textContent,'second');assert.equal(app.node('mission-fields').disabled,false);
});


const selectionConfiguration={connections:[{id:'a',label:'Fixture connection',backend:'model-provider',providerKind:'fixture',model:'exact',protocol:'test',endpoint:'http://127.0.0.1:1234',auth:{method:'none'},limits:{maxOutputTokens:8},usage:{inputTokens:'reported'},diagnostics:[]}],authorizations:[{id:'grant',scope:'test',mode:'mock-http',maxOutputTokensPerCall:8}]};
function configureSelection(app:ReturnType<typeof harness>) {runInContext('runtimeConfiguration='+JSON.stringify(selectionConfiguration)+';renderMission();',app.context);}

async function selectExecution(app:ReturnType<typeof harness>,cap='4') {for(const [id,value] of [['executor-profile-work:test','a'],['verifier-profile-work:test','a'],['authorization-work:test','grant'],['output-cap-work:test',cap]]){const field=selectionField(app,id!);field.value=value!;await field.fire('change');}}

test('execution plan preserves explicit empty choices and explains both output reservations before submission',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission));const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:2,value:mission}),{'massion.workbench.mission':mission.id});await settle();configureSelection(app);
 for(const role of ['executor-profile','verifier-profile','authorization','output-cap'])assert.equal(selectionField(app,role+'-work:test').value,'');
 assert.match(selectionField(app,'execution-plan-work:test').textContent,/available Work budget of 12 output tokens/);
 await selectExecution(app);assert.match(selectionField(app,'execution-plan-work:test').textContent,/8 needed for two calls/);assert.match(selectionField(app,'execution-plan-work:test').textContent,/not bound money/);
 await selectExecution(app,'7');assert.match(selectionField(app,'execution-plan-work:test').textContent,/Insufficient Work budget/);
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('selection check ignores older choices, suppresses duplicates and displays only exact Work revision proof',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission));const checks:((value:Reply)=>void)[]=[];
 const app=harness(path=>path.endsWith('/preflight')?new Promise<Reply>(resolve=>checks.push(resolve)):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:2,value:mission}),{'massion.workbench.mission':mission.id});await settle();configureSelection(app);await selectExecution(app);
 const check=app.all().find(node=>node.textContent==='Check selection')!;const first=check.fire('click');await settle();await check.fire('click');assert.equal(checks.length,1);
 await selectExecution(app,'5');const second=check.fire('click');await settle();assert.equal(checks.length,2);
 checks[1]!(reply({ready:true,revision:2,workId:'work:test',diagnostics:[]}));await second;assert.match(selectionField(app,'selection-check-work:test').textContent,/Checked at revision 2/);
 checks[0]!(reply({ready:false,revision:2,workId:'work:test',diagnostics:[{message:'Obsolete failure'}]}));await first;assert.doesNotMatch(selectionField(app,'selection-check-work:test').textContent,/Obsolete/);
 const changed=selectionField(app,'output-cap-work:test');changed.value='6';await changed.fire('input');assert.match(selectionField(app,'selection-check-work:test').textContent,/Not checked/);
 const third=check.fire('click');await settle();checks[2]!(reply({ready:true,revision:1,workId:'work:test',diagnostics:[]}));await third;assert.match(selectionField(app,'selection-check-work:test').textContent,/did not confirm this exact Work revision/);
 assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,0);assert.equal(app.storage.has('massion.workbench.pending'),false);
});

test('navigation and refreshed Work invalidate old check and detached run handlers',async()=>{
 const first=fixtureMission('first'),second=fixtureMission('second');first.works.push(work(first));second.works.push(work(second));let finish!:(value:Reply)=>void;
 const app=harness(path=>path.endsWith('/preflight')?new Promise<Reply>(resolve=>{finish=resolve;}):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:2,value:path.endsWith('first')?first:second}),{'massion.workbench.mission':'first'});await settle();configureSelection(app);await selectExecution(app);
 const oldForm=app.all().find(node=>node.className==='execution-form')!;const oldCheck=app.all().find(node=>node.textContent==='Check selection')!;const pending=oldCheck.fire('click');await settle();
 app.node('mission-id').value='second';await app.submit('load-form');const status=app.node('status').textContent;
 finish(reply({ready:true,revision:2,workId:'work:test',diagnostics:[]}));await pending;await oldForm.fire('submit');assert.equal(app.node('status').textContent,status);assert.equal(app.node('loaded-id').textContent,'second');assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,0);
 assert.match(selectionField(app,'selection-check-work:test').textContent,/Not checked/);
});


test('online catalog refresh rerenders same-revision choices and invalidates checks without freezing Run',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission));let providerOffline=false;
 const app=harness((path,options)=>{
  if(path==='/health')return reply({status:'ready'});
  if(path==='/providers')return providerOffline?reply({error:'Catalog unavailable'},503):reply({providers:[],selection:{status:'unavailable',reason:'Explicit choice required'},runtime:structuredClone(selectionConfiguration)});
  if(path.startsWith('/events'))return reply({events:[],cursor:0});
  if(path.endsWith('/preflight'))return reply({ready:true,revision:2,workId:'work:test',diagnostics:[]});
  if(path.endsWith('/run'))return reply({status:'blocked',snapshot:{revision:2,value:mission},reason:'Synthetic blocked response'});
  return reply({revision:2,value:mission});
 },{'massion.workbench.mission':mission.id},undefined,{network:true});await settle();await selectExecution(app);
 await app.all().find(n=>n.textContent==='Check selection')!.fire('click');assert.match(selectionField(app,'selection-check-work:test').textContent,/Checked at revision 2/);
 const oldForm=app.all().find(n=>n.className==='execution-form')!;
 await runInContext('connect()',app.context);await settle();
 assert.equal(selectionField(app,'executor-profile-work:test').value,'a');assert.match(selectionField(app,'selection-check-work:test').textContent,/Not checked/);
 await oldForm.fire('submit');assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,0);
 await app.all().find(n=>n.textContent==='Check selection')!.fire('click');assert.equal(app.calls.filter(c=>c.path.endsWith('/preflight')).length,2);
 await app.all().find(n=>n.className==='execution-form')!.fire('submit');assert.equal(app.calls.filter(c=>c.path.endsWith('/run')).length,1);
 providerOffline=true;await runInContext('connect()',app.context);await settle();assert.equal(app.all().some(n=>n.className==='execution-form'),false);assert.match(app.node('provider-notice').textContent,/could not be confirmed/);assert.match(app.node('work-budget-label').textContent,/host units/);assert.match(app.node('work-budget-hint').textContent,/Confirm host runtime units/);
});

test('Mission links load authoritative state with fresh storage and navigation remains read-only',async()=>{
 const handler:Handler=path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:fixtureMission(decodeURIComponent(path.slice('/missions/'.length)))});
 const app=harness(handler,{'massion.workbench.mission':'old'},undefined,{fragment:'#mission=mission%3Alink'});await settle();assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'mission:link');assert.equal(app.node('mission-link').attributes.get('href'),'#mission=mission%3Alink');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
 const maximum=':'.repeat(128);const boundary=harness(handler,{},undefined,{fragment:'#mission='+encodeURIComponent(maximum)});await settle();assert.equal(JSON.parse(boundary.node('snapshot-json').textContent).value.id,maximum);
 await app.navigateFragment('#mission=second');assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'second');assert.equal(app.node('mission-link').attributes.get('href'),'#mission=second');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('malformed Mission links never create paths or writes and absent snapshots expose no link',async()=>{
 for(const fragment of ['#mission=','%','https://attacker.example','#mission=%ZZ','#mission=..%2Fsecret','#mission=good&run=true','#mission='+ 'a'.repeat(129),'#mission='+ '%41'.repeat(129)]){
  const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({},404),{},undefined,{fragment});await settle();assert.equal(app.calls.some(c=>c.path.startsWith('/missions/')),false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);assert.equal(app.node('mission-link').hidden,true);
 }
 const missing=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({error:'Missing'},404),{},undefined,{fragment:'#mission=missing'});await settle();assert.equal(missing.node('mission-link').hidden,true);
});

test('Mission links cannot replace pending recovery identity or unlock uncertain writes',async()=>{
 const marker=JSON.stringify({commandId:'uncertain',missionId:'pending',reconcileCursor:0});const app=harness(path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:fixtureMission(path.slice('/missions/'.length))}),{'massion.workbench.pending':marker},undefined,{fragment:'#mission=another'});await settle();assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'pending');assert.equal(app.storage.get('massion.workbench.pending'),marker);assert.equal(app.node('mission-fields').disabled,true);
 await app.navigateFragment('#mission=another');assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'another');assert.equal(app.storage.get('massion.workbench.pending'),marker);assert.equal(app.node('mission-fields').disabled,true);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('explicit Mission loading keeps the address and reload aligned with the validated snapshot',async()=>{
 const handler:Handler=path=>path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:fixtureMission(path.slice('/missions/'.length))});const app=harness(handler,{},undefined,{fragment:'#mission=first'});await settle();app.node('mission-id').value='second';await app.submit('load-form');assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'second');assert.equal(app.fragment(),'#mission=second');const reload=harness(handler,Object.fromEntries(app.storage),undefined,{fragment:app.fragment()});await settle();assert.equal(JSON.parse(reload.node('snapshot-json').textContent).value.id,'second');assert.equal(reload.calls.filter(c=>c.options.method==='POST').length,0);
});

test('rejected fragment navigation restores the visible Mission through command rejection',async()=>{
 let release!:(value:Reply)=>void;const handler:Handler=(path,init)=>init.method==='POST'?new Promise<Reply>(resolve=>release=resolve):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:fixtureMission(path.slice('/missions/'.length))});const app=harness(handler,{},undefined,{fragment:'#mission=first'});await settle();await app.navigateFragment('#mission=%ZZ');assert.equal(app.fragment(),'#mission=first');assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'first');
 const pending=runInContext("write('/missions/first/commands',{commandId:'rejected',expectedRevision:1,command:{type:'steer',workId:'missing',text:'Synthetic rejected command'}},'first','Changed')",app.context);await settle();assert.equal(typeof release,'function');await app.navigateFragment('#mission=second');assert.equal(app.fragment(),'#mission=first');release(reply({error:'Definite rejection'},400));await pending;await settle();assert.equal(app.fragment(),'#mission=first');assert.equal(JSON.parse(app.node('snapshot-json').textContent).value.id,'first');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,1);const reload=harness(handler,Object.fromEntries(app.storage),undefined,{fragment:app.fragment()});await settle();assert.equal(JSON.parse(reload.node('snapshot-json').textContent).value.id,'first');assert.equal(reload.calls.filter(c=>c.options.method==='POST').length,0);
});

test('failed explicit Mission navigation removes the stale address with the discarded snapshot',async()=>{
 const handler:Handler=path=>path.startsWith('/events')?reply({events:[],cursor:0}):path==='/missions/first'?reply({revision:1,value:fixtureMission('first')}):reply({error:'Missing'},404);const app=harness(handler,{},undefined,{fragment:'#mission=first'});await settle();app.node('mission-id').value='missing';await app.submit('load-form');assert.equal(app.node('mission-panel').hidden,true);assert.equal(app.node('mission-link').hidden,true);assert.equal(app.fragment(),'');const reloaded=harness(handler,Object.fromEntries(app.storage),undefined,{fragment:app.fragment()});await settle();assert.equal(reloaded.calls.some(c=>c.path==='/missions/first'),false);assert.equal(reloaded.node('mission-panel').hidden,true);assert.equal(reloaded.calls.filter(c=>c.options.method==='POST').length,0);
});

test('connection loss blocks new writes until permissions and current Mission refresh while drafts survive',async()=>{
 const mission=fixtureMission();mission.works.push(work(mission));let revision=1,eventsDown=false,providersDown=false,missionDown=false;const submissions:any[]=[];
 const handler:Handler=(path,init)=>{if(path==='/health')return reply({status:'ready'});if(path==='/providers')return providersDown?reply({error:'Unavailable'},503):reply({providers:[],selection:{status:'unavailable',reason:'No model'},runtime:null});if(path==='/connections')return reply({},503);if(path.startsWith('/events'))return eventsDown?reply({error:'Lost connection'},503):reply({events:[],cursor:0});if(init.method==='POST'){submissions.push(JSON.parse(init.body));return reply({status:'committed',revision:++revision,value:mission},201);}return missionDown?reply({error:'Read unavailable'},503):reply({revision,value:mission});};
 const app=harness(handler,{},undefined,{network:true,fragment:'#mission=mission%3Atest'});await settle();app.node('work-title').value='Retain my Work draft';const steer=app.all().find(n=>n.className==='steer-form')!.children.find(n=>n.tagName==='TEXTAREA')!;steer.value='Retain my direction';await steer.fire('input');eventsDown=true;await app.tick();assert.equal(app.node('sync-notice').hidden,false);assert.equal(app.node('work-fields').disabled,true);assert.equal(app.node('mission-fields').disabled,true);assert.equal(app.node('load-mission').disabled,false);await app.submit('work-form');await app.node('run-fixture').fire('click');assert.equal(submissions.length,0);assert.equal(app.storage.has('massion.workbench.pending'),false);
 eventsDown=false;providersDown=true;await app.tick();assert.equal(app.node('work-fields').disabled,true);providersDown=false;missionDown=true;await app.tick();assert.equal(app.node('work-fields').disabled,true);missionDown=false;revision=2;await app.tick();assert.equal(app.node('sync-notice').hidden,true);assert.equal(app.node('work-fields').disabled,false);assert.equal(app.node('work-title').value,'Retain my Work draft');assert.equal(app.all().find(n=>n.className==='steer-form')!.children.find(n=>n.tagName==='TEXTAREA')!.value,'Retain my direction');assert.equal(JSON.parse(app.node('snapshot-json').textContent).revision,2);assert.equal(submissions.length,0);await app.submit('work-form');assert.equal(submissions.length,1);assert.equal(submissions[0].expectedRevision,2);
});

test('a later offline event fences an in-flight reconnect and successful sync cannot clear unknown receipt locks',async()=>{
 const mission=fixtureMission();let hold=false,release!:(value:Reply)=>void;const providers=()=>reply({providers:[],selection:{status:'unavailable',reason:'No model'},runtime:null});const handler:Handler=path=>path==='/health'?reply({status:'ready'}):path==='/providers'?hold?new Promise<Reply>(resolve=>release=resolve):providers():path==='/connections'?reply({},503):path.startsWith('/events')?reply({events:[],cursor:0}):reply({revision:1,value:mission});const app=harness(handler,{},undefined,{network:true,fragment:'#mission=mission%3Atest'});await settle();hold=true;await app.windowEvent('offline');await app.tick();assert.equal(typeof release,'function');await app.windowEvent('offline');hold=false;release(providers());await settle();assert.equal(app.node('mission-fields').disabled,true);await app.tick();assert.equal(app.node('mission-fields').disabled,false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
 const marker=JSON.stringify({commandId:'unconfirmed',missionId:mission.id,reconcileCursor:0});const pending=harness(handler,{'massion.workbench.pending':marker},undefined,{network:true});await settle();await pending.windowEvent('offline');await pending.tick();assert.equal(pending.node('sync-notice').hidden,true);assert.equal(pending.node('mission-fields').disabled,true);assert.equal(pending.storage.get('massion.workbench.pending'),marker);assert.equal(pending.calls.filter(c=>c.options.method==='POST').length,0);
});

test('instruction drafts and conflict comparisons are scoped to Mission plus Work identities',async()=>{
 const one=fixtureMission('mission:one'),two=fixtureMission('mission:two');one.works=[work(one)];two.works=[work(two)];one.works[0]!.instructions=[{actorId:'owner',text:'Current first Mission direction'}];
 const states=new Map([[one.id,{revision:2,value:one}],[two.id,{revision:2,value:two}]]);
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({cursor:0,events:[]});
  if(options.method==='POST')return reply({status:'conflict',reason:'revision',revision:2},409);
  return reply(states.get(decodeURIComponent(path.slice('/missions/'.length))));
 },{},undefined,{fragment:'#mission=mission%3Aone'});await settle();
 const input=selectionField(app,'steer-work:test');input.value='Private first Mission draft';await input.fire('input');await app.all().find(node=>node.className==='steer-form')!.fire('submit');await settle();
 assert.match(app.node('work-list').textContent,/Private first Mission draft/);assert.match(app.node('work-list').textContent,/owner: Current first Mission direction/);
 const writes=app.calls.filter(call=>call.options.method==='POST').length;
 await app.navigateFragment('#mission=mission%3Atwo');assert.equal(selectionField(app,'steer-work:test').value,'');assert.equal(app.all().some(node=>node.className==='instruction-conflict'),false);
 selectionField(app,'steer-work:test').value='Second Mission draft';await selectionField(app,'steer-work:test').fire('input');
 await app.navigateFragment('#mission=mission%3Aone');assert.equal(selectionField(app,'steer-work:test').value,'Private first Mission draft');assert.match(app.node('work-list').textContent,/Current first Mission direction/);assert.equal(app.calls.filter(call=>call.options.method==='POST').length,writes);
 await app.navigateFragment('#mission=mission%3Atwo');assert.equal(selectionField(app,'steer-work:test').value,'Second Mission draft');
});

test('late exact steering receipt clears conflict but preserves a draft edited after transmission',async()=>{
 const mission=fixtureMission();mission.works=[work(mission)];mission.works[0]!.instructions=[{actorId:'owner',text:'Current direction'}];let revision=2,posts=0,receipt:any,visible=false;
 const app=harness((path,options)=>{
  if(path.startsWith('/events'))return reply({cursor:visible?1:0,events:visible?[receipt]:[]});
  if(options.method==='POST'){
   ++posts;const body=JSON.parse(options.body);
   if(posts===1){revision=3;return reply({status:'conflict',reason:'revision',revision},409);}
   mission.works[0]!.instructions!.push({actorId:'owner',text:body.command.instruction});revision=4;receipt={cursor:1,aggregateId:mission.id,commandId:body.commandId,revision,events:[{type:'steer'}]};throw new Error('Response lost after commit');
  }
  return reply({revision,value:mission});
 },{},undefined,{fragment:'#mission=mission%3Atest'});await settle();
 const form=()=>app.all().find(node=>node.className==='steer-form')!;
 let input=selectionField(app,'steer-work:test');input.value='Submitted direction';await input.fire('input');await form().fire('submit');await settle();assert.equal(posts,1);
 await form().fire('submit');await settle();assert.equal(posts,2);assert.equal(app.node('operation-notice').hidden,false);
 input=selectionField(app,'steer-work:test');input.value='A new unsent draft';await input.fire('input');visible=true;await app.tick();
 assert.equal(app.node('operation-notice').hidden,true);assert.equal(selectionField(app,'steer-work:test').value,'A new unsent draft');assert.equal(app.all().some(node=>node.className==='instruction-conflict'),false);assert.match(app.node('work-list').textContent,/Latest owner instruction: Submitted direction/);await app.tick();assert.equal(posts,2);
});
