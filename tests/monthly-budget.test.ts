import test from 'node:test';
import assert from 'node:assert/strict';
import {MonthlyBudgetService,MONTHLY_BUDGET_ID,accountingPeriod} from '../src/monthly-budget.ts';
import {InMemoryStore} from '../src/storage.ts';
import {Application} from '../src/application.ts';
import type {Mission} from '../src/domain.ts';
const now=Date.parse('2026-11-01T00:30:00Z');
function selectedBudget(store:InMemoryStore<Mission>,clock=()=>now){const service=new MonthlyBudgetService(store,clock),admit=service.admit.bind(service);service.admit=input=>admit({...input,selection:input.selection??{executorProfileId:'fixture-executor',verifierProfileId:'fixture-verifier',authorizationId:'fixture',outputTokenCap:Math.max(1,input.amount/2)}});return service;}
async function fixture(limit=100){
 const store=new InMemoryStore<Mission>(),service=selectedBudget(store),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'runtime-representative',roles:['representative']}],()=>now);
 await app.create({id:'mission',purpose:'Budget test',scope:'local',constraints:[],criteria:{version:1,description:'Text',oracle:'bounded-text-review/v1'}},'local-owner','create');
 for(const workId of ['one','two']){const s=(await store.load('mission'))!;await app.dispatch({missionId:'mission',commandId:'admit-'+workId,expectedRevision:s.revision,actorId:'local-owner',command:{type:'admit-work',workId,title:workId,budget:200}});}
 await service.configure({commandId:'configure',expectedRevision:0,limit,timezone:'America/Los_Angeles'});return {store,service,app};
}
test('calendar accounting uses the owner timezone on either side of a month boundary',()=>{
 assert.equal(accountingPeriod(now,'America/Los_Angeles'),'2026-10');assert.equal(accountingPeriod(now,'Asia/Seoul'),'2026-11');
 assert.equal(accountingPeriod(Date.parse('2026-03-08T10:30:00Z'),'America/Los_Angeles'),'2026-03');assert.throws(()=>accountingPeriod(now,'invalid/timezone'));
});
test('overlapping admission reserves once; excess Work waits behind one owner decision across restart',async()=>{
 const {store,service}=await fixture();
 const input={missionId:'mission',workId:'one',runId:'run-one',amount:80};
 const results=await Promise.all([service.admit(input),service.admit(input)]);assert.equal(results.filter(r=>r.status==='reserved').length,1);assert.equal(results.filter(r=>r.status==='replayed').length,1);
 assert.equal((await service.admit({missionId:'mission',workId:'two',runId:'run-two',amount:80})).status,'waiting');
 const s=(await store.load('mission'))!;assert.equal(s.value.works[1]!.execution,'budget-waiting');assert.equal(s.value.works[1]!.runtimeRun,undefined);
 const restarted=selectedBudget(store);assert.equal((await restarted.admit({missionId:'mission',workId:'two',runId:'another-id',amount:80})).status,'waiting');
 const view=await restarted.read();assert.equal(view.decisions.length,1);assert.equal(view.reserved,80);assert.equal(view.cost,null);assert.equal(view.unit,'output-tokens');
 const d=view.decisions[0]!;assert.deepEqual(d.rows,[['지금','100'],['늘린 뒤','160'],['멈춘 일','two']]);assert.equal(d.budget.limit,160);await restarted.decide({commandId:'later',decisionId:d.id,answer:'later',expectedRevision:view.revision});
 assert.equal((await restarted.read()).decisions[0]!.state,'later');assert.equal((await store.load('mission'))!.value.works[1]!.execution,'budget-waiting');
 const deferred=await restarted.read();await restarted.decide({commandId:'reopen',decisionId:d.id,answer:'ask',expectedRevision:deferred.revision});
 const opened=await restarted.read();assert.equal(opened.decisions[0]!.state,'open');
 const body={commandId:'raise',decisionId:d.id,answer:'act',expectedRevision:opened.revision,limit:opened.decisions[0]!.budget.limit};
 const accepted=await restarted.decide(body);assert.equal(accepted.status,'committed');assert.equal((await restarted.decide(body)).status,'replayed');
 assert.equal((await store.load('mission'))!.value.works[1]!.execution,'budget-waiting','the recorded decision alone never invokes or resumes');
 const saved=await store.load(MONTHLY_BUDGET_ID) as any;assert.equal(saved.value.actorId,'local-owner');assert.equal(saved.value.limit,160);
});
test('stale budget changes and non-increases cannot authorize waiting Work',async()=>{
 const {service}=await fixture(1);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});const v=await service.read(),d=v.decisions[0]!;
 assert.equal((await service.configure({commandId:'stale',expectedRevision:0,limit:1000,timezone:v.timezone})).status,'conflict');
 await assert.rejects(service.decide({commandId:'wrong',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:1}),/increase|limit/i);
 assert.equal((await service.read()).limit,1);
});

test('budget journal replay retains owner decisions and rejects tampered limits',async()=>{
 const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');const {store,service}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});
 const v=await service.read();await service.decide({commandId:'defer',decisionId:v.decisions[0]!.id,expectedRevision:v.revision,answer:'later'});validateMissionJournalLineage(store.inspect());
 const corrupt=store.inspect();(corrupt.at(-1)!.value as any).limit=999;assert.throws(()=>validateMissionJournalLineage(corrupt),/transition mismatch/);
});
test('month rollover and a settings increase leave a deferred Work paused',async()=>{
 const {store,service}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});const v=await service.read();await service.decide({commandId:'defer',decisionId:v.decisions[0]!.id,expectedRevision:v.revision,answer:'later'});
 const next=new MonthlyBudgetService(store,()=>Date.parse('2026-12-01T10:00:00Z')),rolled=await next.read();assert.equal(rolled.period,'2026-12');await next.configure({commandId:'settings-increase',expectedRevision:rolled.revision,limit:1000,timezone:rolled.timezone});
 assert.equal((await store.load('mission'))!.value.works[0]!.execution,'budget-waiting');assert.equal((await next.read()).decisions[0]!.state,'later');
});
test('a lost reservation acknowledgment cannot authorize dispatch on a fresh service',async()=>{
 const {store,service}=await fixture();const commit=store.commit.bind(store);let lost=true;store.commit=async input=>{const result=await commit(input);if(input.id===MONTHLY_BUDGET_ID&&lost){lost=false;throw new Error('Lost reservation acknowledgment');}return result;};
 await assert.rejects(service.admit({missionId:'mission',workId:'one',runId:'run',amount:80}),/Lost/);const restarted=selectedBudget(store);assert.equal((await restarted.admit({missionId:'mission',workId:'one',runId:'run',amount:80})).status,'replayed');assert.equal((await store.load('mission'))!.value.works[0]!.runtimeRun,undefined);
});

test('raising one decision releases each of its waiting Works through a new bounded reservation',async()=>{
 const {store,service,app}=await fixture(0);for(const workId of ['one','two'])await service.admit({missionId:'mission',workId,runId:'run-'+workId,amount:80});const v=await service.read(),d=v.decisions[0]!;
 await service.decide({commandId:'raise-both',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});const resumed:string[]=[];
 await service.reconcile(undefined,async(r,revision)=>{const admitted=await service.admit({missionId:r.missionId,workId:r.workId,runId:r.runId,amount:80,selection:r.selection,expectedRevision:revision});assert.equal(admitted.status,'reserved');const {hash,workInputHash}=await import('../src/domain.ts'),s=(await store.load(r.missionId))!,w=s.value.works.find(w=>w.id===r.workId)!;await app.dispatch({missionId:r.missionId,commandId:r.runId,expectedRevision:admitted.reservation!.revision,actorId:'local-owner',command:{type:'activate-runtime',workId:r.workId,run:{id:r.runId,authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:40}}});resumed.push(r.workId);});
 assert.deepEqual(resumed,['one','two']);assert.equal((await service.read()).reserved,160);assert.equal((await store.load('mission'))!.value.works[1]!.execution,'queued');
});

test('an unrelated revision conflict cannot leave a budget-blocked Work looking queued',async()=>{
 const {store,service}=await fixture(0),commit=store.commit.bind(store);let conflict=true;store.commit=async input=>{if(input.id==='mission'&&(input.events[0] as any)?.type==='wait-monthly-budget'&&conflict){conflict=false;return {status:'conflict',revision:input.expectedRevision,reason:'revision'};}return commit(input);};
 assert.equal((await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80})).status,'waiting');assert.equal((await store.load('mission'))!.value.works[0]!.execution,'budget-waiting');
});

test('pending, crashed and unknown Representative/member calls retain their cap until a known settlement',async()=>{
 const {AssistantConversation,ownerMessageId,assistantTurnId,ASSISTANT_ACTOR_ID}=await import('../src/assistant-conversation.ts');
 for(const thread of ['', 'member:member-one'])for(const status of ['pending','crashed','unknown','settled']){
  const {store,service}=await fixture(),commandId='turn-'+status,messageId=ownerMessageId(commandId),turnId=assistantTurnId(messageId),chat=new AssistantConversation(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']}],()=>now,thread);
  await chat.dispatch({segment:1,commandId,expectedRevision:0,actorId:'local-owner',command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:'Fixture request',turn:{id:turnId,status:'pending',route:{profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http',outputTokenCap:60},ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-dispatch',startedAt:now,deadlineAt:now+1000},requestHash:'b'.repeat(64),contextMessageIds:[]}}});
  if(status==='unknown'||status==='settled')await chat.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:status==='unknown'?{type:'settle-assistant-turn',turnId,status:'unknown',usage:{inputTokens:null,outputTokens:null},receipt:'Unresolved fixture call'}:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:2,outputTokens:7},receipt:'Known fixture usage',reply:'Fixture answer',proposal:null}});
  const restarted=new MonthlyBudgetService(store,()=>status==='crashed'?now+3600000:now),view=await restarted.read();assert.equal(view.reserved,status==='settled'?0:60,thread+' '+status);
  assert.equal((await restarted.admit({missionId:'mission',workId:'one',runId:'run',amount:50})).status,status==='settled'?'reserved':'waiting',thread+' '+status);
  assert.equal((await service.read()).cost,null);assert.equal((await restarted.admit({missionId:'mission',workId:'two',runId:'within-remaining-bound',amount:30})).status,'reserved','only the outstanding cap, not the entire monthly budget, is held');
 }
});

test('an owner acceptance cannot miss a Work whose initial pause commit is still in flight',async t=>{
 const {store,service}=await fixture(0),commit=store.commit.bind(store);let hold=true,entered!:()=>void,release!:()=>void;const pending=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);t.after(()=>release());
 store.commit=async input=>{if(hold&&(input.events[0] as any)?.type==='wait-monthly-budget'){hold=false;entered();await gate;}return commit(input);};
 const admission=service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});await pending;const v=await service.read(),d=v.decisions[0]!,resumed:string[]=[];
 try{await service.decide({commandId:'racing-raise',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});await service.reconcile(undefined,async r=>{resumed.push(r.workId);});}finally{release();}
 await admission;assert.deepEqual(resumed,['one']);const work=(await store.load('mission'))!.value.works[0]!;assert.equal(work.execution,'queued');assert.equal(work.monthlyBudgetDecision,undefined);assert.equal(work.runtimeRun,undefined);
});

test('fresh owner-steered Work retains its inputs through both sufficient and exhausted monthly admission',async()=>{
 for(const limit of [100,0]){const {store,service,app}=await fixture(limit),s=(await store.load('mission'))!;await app.dispatch({missionId:'mission',commandId:'steer',expectedRevision:s.revision,actorId:'local-owner',command:{type:'steer',workId:'one',instruction:'Keep this owner instruction'}});const original=(await store.load('mission'))!.value.works[0]!;assert.equal(original.execution,'waiting');
  assert.equal((await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80})).status,limit?'reserved':'waiting');const work=(await store.load('mission'))!.value.works[0]!;assert.deepEqual(work.instructions,original.instructions);assert.equal(work.execution,limit?'waiting':'budget-waiting');}
});

test('a deferred old-period decision offers a current increase after another period raised the shared limit',async()=>{
 const {store,service}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'old-run',amount:150});const old=await service.read(),oldId=old.decisions[0]!.id;await service.decide({commandId:'defer-old',decisionId:oldId,answer:'later',expectedRevision:old.revision});
 const next=new MonthlyBudgetService(store,()=>Date.parse('2026-12-01T10:00:00Z'));await next.admit({missionId:'mission',workId:'two',runId:'new-run',amount:80});const current=await next.read(),newDecision=current.decisions.find(d=>d.id!==oldId)!;await next.decide({commandId:'raise-new',decisionId:newDecision.id,answer:'act',expectedRevision:current.revision,limit:newDecision.budget.limit});
 const raised=await next.read();await next.decide({commandId:'reopen-old',decisionId:oldId,answer:'ask',expectedRevision:raised.revision});const reopened=await next.read(),proposal=reopened.decisions.find(d=>d.id===oldId)!;assert.ok(proposal.budget.limit>reopened.limit!);assert.equal(proposal.rows[0]![1],'80');
 const {applyMonthlyBudget}=await import('../src/monthly-budget.ts'),legacy=(await store.load(MONTHLY_BUDGET_ID))!.value as any;assert.equal(applyMonthlyBudget(legacy,{type:'decide-monthly-budget',decisionId:oldId,answer:'act',limit:150},{id:'local-owner',roles:['owner']},now).value.limit,150,'older accepted command values still replay');await assert.rejects(next.decide({commandId:'stale-old-proposal',decisionId:oldId,answer:'act',expectedRevision:reopened.revision,limit:150}),/reviewed proposal/);
 assert.equal((await next.decide({commandId:'raise-old',decisionId:oldId,answer:'act',expectedRevision:reopened.revision,limit:proposal.budget.limit})).status,'committed');assert.equal((await store.load('mission'))!.value.works[0]!.execution,'budget-waiting');
});

test('steering budget-paused Work is rejected without stranding its original owner decision',async()=>{
 const {store,service,app}=await fixture(0);await service.admit({missionId:'mission',workId:'one',runId:'run',amount:80});const s=(await store.load('mission'))!,before=store.inspect();
 await assert.rejects(app.dispatch({missionId:'mission',commandId:'paused-steer',expectedRevision:s.revision,actorId:'local-owner',command:{type:'steer',workId:'one',instruction:'Changed after pause'}}),/monthly budget|budget.paused/i);assert.deepEqual(store.inspect(),before);
 const v=await service.read(),d=v.decisions[0]!;await service.decide({commandId:'raise-after-refusal',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});const resumed:string[]=[];await service.reconcile(undefined,async r=>{resumed.push(r.workId);});assert.deepEqual(resumed,['one']);
});

test('one unsettled resumed run cannot strand the other Works authorized by the same owner decision',async()=>{
 const {store,service,app}=await fixture(0);for(const workId of ['one','two'])await service.admit({missionId:'mission',workId,runId:'run-'+workId,amount:80});const v=await service.read(),d=v.decisions[0]!;await service.decide({commandId:'raise-all',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});
 const original=Object.assign(new Error('Original run is unsettled; never resend'),{name:'RunUnsettledError'}),attempted:string[]=[];await assert.rejects(service.reconcile(undefined,async r=>{attempted.push(r.workId);const {hash,workInputHash}=await import('../src/domain.ts'),s=(await store.load(r.missionId))!,w=s.value.works.find(w=>w.id===r.workId)!;await app.dispatch({missionId:r.missionId,commandId:'admitted-'+r.workId,expectedRevision:s.revision,actorId:'local-owner',command:{type:'activate-runtime',workId:r.workId,run:{id:'original-'+r.workId,authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:40}}});if(r.workId==='one')throw original;}),e=>e===original);
 assert.deepEqual(attempted,['one','two']);assert.ok((await store.load('mission'))!.value.works.every(w=>w.execution==='queued'&&!w.monthlyBudgetDecision));await service.reconcile(undefined,async r=>{attempted.push(r.workId);});assert.deepEqual(attempted,['one','two']);
});

test('an owner-cancelled waiting Work does not block the budget decision for remaining Work',async()=>{
 const {store,service,app}=await fixture(0);for(const workId of ['one','two'])await service.admit({missionId:'mission',workId,runId:'paused-'+workId,amount:80});const s=(await store.load('mission'))!;await app.dispatch({missionId:'mission',commandId:'stop-one',expectedRevision:s.revision,actorId:'local-owner',command:{type:'cancel',workId:'one'}});const v=await service.read(),d=v.decisions[0]!;
 await service.decide({commandId:'raise-remaining',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});const resumed:string[]=[];await service.reconcile(undefined,async r=>{resumed.push(r.workId);});assert.deepEqual(resumed,['two']);assert.equal((await store.load('mission'))!.value.works[0]!.execution,'cancelled');
});

test('recovery cannot clear the reservation when an original activation wins its Work CAS fence',async()=>{
 const {store,service,app}=await fixture(0),{hash,workInputHash}=await import('../src/domain.ts');await service.admit({missionId:'mission',workId:'one',runId:'paused',amount:80});const v=await service.read(),d=v.decisions[0]!,runId='paused';await service.decide({commandId:'raise-fence',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});let dead=false;const originalCommit=store.commit.bind(store);store.commit=async input=>{if(dead)throw Error('Dead host');return originalCommit(input);};await assert.rejects(service.reconcile(undefined,async()=>{await service.admit({missionId:'mission',workId:'one',runId,amount:80});dead=true;throw Error('Before activation');}));dead=false;store.commit=originalCommit;
 const commit=store.commit.bind(store);let won=false;store.commit=async input=>{if(!won&&input.id==='mission'&&(input.events[0] as any)?.type==='fence-monthly-admission'){won=true;const s=(await store.load('mission'))!,w=s.value.works[0]!;await app.dispatch({missionId:'mission',commandId:runId,expectedRevision:s.revision,actorId:'local-owner',command:{type:'activate-runtime',workId:'one',run:{id:runId,authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:40}}});}return commit(input);};
 let called=0;await service.reconcile(undefined,async()=>{called++;});assert.equal(won,true);assert.equal(called,0);assert.equal((await store.load('mission'))!.value.works[0]!.runtimeRun!.id,runId);assert.equal((await service.read()).reserved,80);
});

test('a stale reconciliation snapshot cannot release a newer admitted runtime',async()=>{
 const {store,service,app}=await fixture(0),{hash,workInputHash}=await import('../src/domain.ts');await service.admit({missionId:'mission',workId:'one',runId:'original-run',amount:80});const v=await service.read(),d=v.decisions[0]!;await service.decide({commandId:'raise-stale-snapshot',decisionId:d.id,answer:'act',expectedRevision:v.revision,limit:d.budget.limit});const stale=await service.snapshot();
 await service.reconcile(undefined,async(r,revision)=>{const admitted=await service.admit({missionId:r.missionId,workId:r.workId,runId:r.runId,amount:r.amount,selection:r.selection,expectedRevision:revision});assert.equal(admitted.status,'reserved');const current=(await store.load(r.missionId))!,w=current.value.works.find(w=>w.id===r.workId)!;await app.dispatch({missionId:r.missionId,commandId:r.runId,expectedRevision:admitted.reservation!.revision,actorId:'local-owner',command:{type:'activate-runtime',workId:r.workId,run:{id:r.runId,authorizationId:'fixture',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:40}}});});
 const before=store.inspect();await service.reconcile(stale);assert.deepEqual(store.inspect(),before);assert.equal((await service.read()).reserved,80);const {validateMissionJournalLineage}=await import('../src/backup-lineage.ts');validateMissionJournalLineage(store.inspect());
});
