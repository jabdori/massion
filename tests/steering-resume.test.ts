import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Application} from '../src/application.ts';
import {ConfiguredTextRuntime,TEXT_REVIEW_ORACLE} from '../src/configured-runtime.ts';
import {fixtureOptions} from './support/steering-resume-fixture.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {InMemoryStore} from '../src/storage.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {hash} from '../src/domain.ts';
import {ASSISTANT_ACTOR_ID,assistantWorkId,assistantTurnId} from '../src/assistant-conversation.ts';
import {memberProcedures} from '../src/internal-teams.ts';
import {validateMissionLineage} from '../src/backup-lineage.ts';
import type {ProviderRequest} from '../src/providers.ts';

const messageId='m:'+'a'.repeat(32),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId);
async function fixture(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'massion-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']}]),artifacts=new TextArtifactStore(join(root,'artifacts')),calls:{id:string;prompt:any}[]=[];
 let hook:((request:ProviderRequest,prompt:any)=>Promise<void>)|undefined;
 const options=fixtureOptions(artifacts,calls,(request,prompt)=>hook?.(request,prompt)??Promise.resolve());
 await app.create({id:'mission',purpose:'Produce a checked answer',scope:'test',constraints:[],criteria:{version:1,description:'Answer the request',oracle:TEXT_REVIEW_ORACLE}},'local-owner','create');
 const team=memberProcedures(null,'assistant');
 const message={id:messageId,ordinal:1,actorId:'local-owner',role:'owner' as const,turnId:null,text:'Answer'};
 await app.dispatch({missionId:'mission',commandId:'assistant-work:'+turnId,expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'admit-work',workId,title:'Answer',budget:300,team,assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'producer'},memberId:'assistant'}}});
 const read=async()=>(await store.load('mission'))!,work=async()=>(await read()).value.works[0];
 const steer=async()=>app.dispatch({missionId:'mission',commandId:'direction',expectedRevision:(await read()).revision,actorId:'local-owner',command:{type:'steer',workId,instruction:'enterprise'}});
 return {root,store,app,artifacts,calls,options,read,work,steer,setHook:(h:typeof hook)=>{hook=h;},runtime:new ConfiguredTextRuntime(store,options)};
}

for(const phase of ['assembly','check'])test('confirmed steering during '+phase+' accepts a fresh revision without repeating workers',async t=>{
 const f=await fixture(t);let changed=false;
 f.setHook(async(_r,p)=>{if(!changed&&(phase==='assembly'?p.stepResults:p.artifact)){changed=true;await f.steer();}});
 const result=await f.runtime.run('mission',workId,'run',(await f.read()).revision);
 assert.equal(result.status,'settled',JSON.stringify(await f.work()));const w=await f.work();assert.equal(await f.artifacts.read(w.artifact),'Answer enterprise');
 assert.equal(f.calls.filter(c=>c.prompt.step).length,2);assert.equal(f.calls.filter(c=>c.prompt.teamPlanning).length,1);
 assert.equal(new Set(f.calls.map(c=>c.id)).size,f.calls.length);assert.equal(w.record.artifact.version,2);
 assert.equal(f.calls.filter(c=>c.prompt.artifact).at(-1)!.prompt.requirements.instructions[0].text,'enterprise');
 validateMissionLineage((await f.read()).value);
});

test('restart reuses a committed worker result and never reserves or invokes it twice',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let crashed=false;
 f.store.commit=async input=>{const e=input.events[0] as any;if(!crashed&&e?.type==='settle-task'&&e.command.taskId===workId+':step:0'){crashed=true;throw Error('Simulated process death before task settlement');}return commit(input);};
 await assert.rejects(f.runtime.run('mission',workId,'run',(await f.read()).revision));f.store.commit=commit;
 const before=await f.work(),resumed=new ConfiguredTextRuntime(f.store,f.options);
 const result=await (resumed as any).resume('mission',workId);assert.equal(result.status,'settled',JSON.stringify(await f.work()));const after=await f.work();
 assert.equal(f.calls.filter(c=>c.prompt.step?.title==='Read inputs').length,1);assert.equal(f.calls.length,7);
 assert.deepEqual(after.runtimeRun.ownership,before.runtimeRun.ownership);assert.equal(after.budget.reserved,70);
 assert.deepEqual(after.effects[1],before.effects[1]);validateMissionLineage((await f.read()).value);
});

for(const boundary of ['activate-runtime','planning-receipt','artifact-receipt','publish-artifact','room-turn','verify','root-settlement'])test('restart continues after committed '+boundary+' without duplicate effects',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let crashed=false;
 f.store.commit=async input=>{const e=input.events[0] as any,c=e?.command;
  const matches=boundary==='planning-receipt'?c?.type==='receipt'&&c.effectId==='run:planning':boundary==='artifact-receipt'?c?.type==='receipt'&&c.effectId==='run:artifact':boundary==='room-turn'?c?.type==='record-room-turn':boundary==='root-settlement'?c?.type==='settle-task'&&c.taskId===workId+':root':c?.type===boundary;
  const result=await commit(input);if(!crashed&&matches){crashed=true;throw Error('Simulated process death after '+boundary);}return result;
 };
 await assert.rejects(f.runtime.run('mission',workId,'run',(await f.read()).revision));assert.ok(crashed);f.store.commit=commit;
 const before=await f.work(),result=await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId);
 assert.equal(result.status,'settled');const w=await f.work();assert.equal(f.calls.length,7);assert.equal(new Set(f.calls.map(c=>c.id)).size,7);assert.equal(w.budget.reserved,70);assert.equal(w.budget.measured,7);assert.deepEqual(w.runtimeRun.ownership,before.runtimeRun.ownership);validateMissionLineage((await f.read()).value);
});

for(const boundary of ['intent','claim','artifact-intent'])test('restart refuses an unresolved '+boundary+' and preserves its receipt and budget',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let crashed=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command,result=await commit(input);if(!crashed&&(boundary==='claim'?c?.type==='claim-provider-dispatch':c?.type==='admit-effect'&&(boundary==='artifact-intent'?c.effect.id==='run:artifact':true))){crashed=true;throw Error('Lost acknowledgment');}return result;};
 await assert.rejects(f.runtime.run('mission',workId,'run',(await f.read()).revision));f.store.commit=commit;
 const before=await f.work(),calls=f.calls.length;assert.equal((await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)).status,'blocked');assert.equal(f.calls.length,calls);assert.deepEqual(await f.work(),before);
});

for(const change of ['config','deadline','cancel','unknown'])test('resume preserves '+change+' fences',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let crashed=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command;if(!crashed&&c?.type==='settle-task'&&c.taskId===workId+':step:0'){crashed=true;throw Error('Crash');}return commit(input);};
 await assert.rejects(f.runtime.run('mission',workId,'run',(await f.read()).revision));f.store.commit=commit;
 const options={...f.options};if(change==='config')options.executor={...options.executor,identity:'changed-producer'};
 if(change==='cancel')await f.app.dispatch({missionId:'mission',commandId:'cancel',expectedRevision:(await f.read()).revision,actorId:'local-owner',command:{type:'cancel',workId}});
 const before=await f.work(),calls=f.calls.length;
 if(change==='deadline'||change==='unknown'){
  const {canResume}=await import('../src/runtime-continuation.ts');if(change==='deadline')assert.equal(canResume(before,before.runtimeRun.ownership.deadlineAt),false);else{before.effects[0].status='unknown';assert.equal(canResume(before,Date.now()),false);}return;
 }
 assert.equal((await new ConfiguredTextRuntime(f.store,options).resume('mission',workId)).status,'blocked');assert.equal(f.calls.length,calls);assert.deepEqual(await f.work(),before);
});

for(const boundary of ['publish-artifact','verify','accept'])test('steering racing '+boundary+' cannot accept the previous request',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let changed=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command;if(!changed&&c?.type===boundary){changed=true;await f.steer();}return commit(input);};
 const result=await f.runtime.run('mission',workId,'run',(await f.read()).revision);assert.equal(result.status,'settled');assert.ok(changed);const w=await f.work();assert.equal(await f.artifacts.read(w.record.artifact),'Answer enterprise');assert.equal(f.calls.filter(c=>c.prompt.step).length,2);validateMissionLineage((await f.read()).value);
});

test('overlapping resumers and a stale original dispatch invoke each effect at most once',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let held=false,entered=()=>{},release=()=>{};
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});t.after(release);
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command;if(!held&&c?.type==='settle-task'&&c.taskId===workId+':step:0'){held=true;entered();await gate;}return commit(input);};
 const original=f.runtime.run('mission',workId,'run',(await f.read()).revision);const observed=original.catch(e=>e);await started;
 const outcomes=await Promise.allSettled([new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId),new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)]);release();await observed;
 assert.ok(outcomes.some(r=>r.status==='fulfilled'&&r.value.status==='settled'));assert.equal((await f.work()).acceptance,'accepted');assert.equal(f.calls.length,7);assert.equal(new Set(f.calls.map(c=>c.id)).size,7);validateMissionLineage((await f.read()).value);
});

test('normal host startup resumes a checkpoint saved before SIGKILL in a different process',async t=>{
 const f=await fixture(t),path=join(f.root,'checkpoint.json'),child=fileURLToPath(new URL('./support/steering-resume-child.ts',import.meta.url));
 await writeFile(path,JSON.stringify({root:f.root,workId,feedId:(await f.store.readState()).feedId,operations:f.store.inspect()}));
 await assert.rejects(promisify(execFile)(process.execPath,[child,path,'crash']),{signal:'SIGKILL'});
 const saved=JSON.parse(await readFile(path,'utf8'));assert.equal(saved.calls.length,2);
 const result=await promisify(execFile)(process.execPath,[child,path,'resume'],{timeout:10000});assert.deepEqual(JSON.parse(result.stdout),{accepted:true,providerCalls:7,distinctDispatches:2});
});

test('a clean shutdown checkpoint resumes without resetting the original deadline',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let stopped=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command,result=await commit(input);if(!stopped&&c?.type==='receipt'&&c.effectId==='run:step:0'){stopped=true;f.runtime.beginDrain();}return result;};
 await f.runtime.run('mission',workId,'run',(await f.read()).revision);f.store.commit=commit;const before=await f.work();assert.equal(before.runtimeInterruption.reason,'host-shutdown');assert.ok(before.effects.every((e:any)=>e.status==='succeeded'));
 assert.equal((await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)).status,'settled');assert.deepEqual((await f.work()).runtimeRun.ownership,before.runtimeRun.ownership);assert.equal(f.calls.length,7);
});

test('drain while resume admission is loading refuses the write and every next effect',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let crashed=false;
 f.store.commit=async input=>{if(!crashed&&(input.events[0] as any)?.type==='activate-runtime'){const result=await commit(input);crashed=true;throw Error('Crash after activation');}return commit(input);};
 await assert.rejects(f.runtime.run('mission',workId,'run',(await f.read()).revision));f.store.commit=commit;
 const resumed=new ConfiguredTextRuntime(f.store,f.options),lookup=f.store.lookupOperation.bind(f.store);f.store.lookupOperation=async input=>{const result=await lookup(input);if(input.fingerprint&&input.commandId!=='run')resumed.beginDrain();return result;};
 const before=await f.work();await assert.rejects(resumed.resume('mission',workId));assert.deepEqual(await f.work(),before);assert.equal(f.calls.length,0);
});

test('the original budget stops an unfunded revision without increasing or releasing uncertain reservations',async t=>{
 const f=await fixture(t);await f.app.dispatch({missionId:'mission',commandId:'budget',expectedRevision:(await f.read()).revision,actorId:'local-owner',command:{type:'revise-budget',workId,limit:70,reason:'Exactly one procedure'}});let changed=false;
 f.setHook(async(_r,p)=>{if(!changed&&p.stepResults){changed=true;await f.steer();}});
 assert.equal((await f.runtime.run('mission',workId,'run',(await f.read()).revision)).status,'blocked');const w=await f.work();assert.equal(w.blocker.code,'budget_exceeded');assert.equal(w.budget.limit,70);assert.equal(w.budget.reserved,40);assert.equal(w.record,undefined);assert.equal(f.calls.length,4);
});

for(const slot of ['executor','verifier'])test('steering immediately after '+slot+' intent completes the original claim before revising',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let changed=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command,result=await commit(input);if(!changed&&c?.type==='admit-effect'&&c.effect.id==='run:'+slot){changed=true;await f.steer();}return result;};
 assert.equal((await f.runtime.run('mission',workId,'run',(await f.read()).revision)).status,'settled');const w=await f.work();assert.equal(await f.artifacts.read(w.artifact),'Answer enterprise');assert.ok(w.effects.every((e:any)=>e.status==='succeeded'));assert.equal(f.calls.filter(c=>c.id==='run:'+slot).length,1);assert.equal(f.calls.filter(c=>c.prompt.step).length,2);
});

test('a clean checkpoint releases its monthly hold only after the original deadline prevents resume',async t=>{
 const f=await fixture(t),commit=f.store.commit.bind(f.store);let stopped=false;
 f.store.commit=async input=>{const c=(input.events[0] as any)?.command,result=await commit(input);if(!stopped&&c?.type==='receipt'&&c.effectId==='run:step:0'){stopped=true;f.runtime.beginDrain();}return result;};
 await f.runtime.run('mission',workId,'run',(await f.read()).revision);f.store.commit=commit;
 const {MonthlyBudgetService}=await import('../src/monthly-budget.ts'),budget=new MonthlyBudgetService(f.store),before=await f.work();assert.equal((await budget.snapshot()).budget!.value.reservations[0]!.state,'reserved');
 t.mock.timers.enable({apis:['Date'],now:before.runtimeRun.ownership.deadlineAt+1});await budget.reconcile();
 const reservation=(await budget.snapshot()).budget!.value.reservations[0]!;assert.equal(reservation.state,'settled');assert.equal(reservation.usage,2);assert.deepEqual(await f.work(),before);assert.equal(f.calls.length,2);
});

for(const mode of ['steer','restart'])test('completed credential repair is reused by '+mode+' without another repair or provider call',async t=>{
 const f=await fixture(t),adapter=f.options.executor.adapter,invoke=adapter.invoke.bind(adapter),ids:string[]=[];let rejected=false,repairs=0,changed=false;
 adapter.invoke=async request=>{ids.push(request.invocationId);if(!rejected){rejected=true;return {status:'failed',output:null,usage:{inputTokens:0,outputTokens:0},reason:'Credential fixture rejection',credentialFailure:{kind:'invalid',code:'invalid_api_key'},credentialBinding:{connectionId:'producer',configHash:'a'.repeat(64),generation:0}};}return invoke(request);};
 f.options.repairCredential=async({blocker})=>{repairs++;await f.app.dispatch({missionId:'mission',commandId:'repair',expectedRevision:(await f.read()).revision,actorId:'local-owner',command:{type:'retry-credential',workId,effectId:blocker.effectId,connectionId:blocker.connectionId,configHash:blocker.configHash,replacementCommandId:'fixture-replacement'}});};
 const runtime=new ConfiguredTextRuntime(f.store,f.options),commit=f.store.commit.bind(f.store);let crashed=false;
 if(mode==='restart')f.store.commit=async input=>{const c=(input.events[0] as any)?.command,result=await commit(input);if(!crashed&&c?.type==='receipt'&&c.effectId==='run:planning:repair'){crashed=true;throw Error('Crash after repaired result');}return result;};
 else f.setHook(async(_r,p)=>{if(!changed&&p.stepResults){changed=true;await f.steer();}});
 if(mode==='restart'){await assert.rejects(runtime.run('mission',workId,'run',(await f.read()).revision));f.store.commit=commit;assert.equal((await new ConfiguredTextRuntime(f.store,f.options).resume('mission',workId)).status,'settled');}
 else assert.equal((await runtime.run('mission',workId,'run',(await f.read()).revision)).status,'settled');
 assert.equal(repairs,1);assert.equal(ids.filter(id=>id==='run:planning').length,1);assert.equal(ids.filter(id=>id==='run:planning:repair').length,1);assert.equal((await f.work()).acceptance,'accepted');validateMissionLineage((await f.read()).value);
});

for(const phase of ['load','commit'])test('steering during assembly revision '+phase+' refreshes the binding without restarting the daemon',async t=>{
 const f=await fixture(t);let changed=false;
 if(phase==='commit'){const commit=f.store.commit.bind(f.store);f.store.commit=async input=>{if(!changed&&(input.events[0] as any)?.type==='begin-runtime-assembly'){changed=true;await f.steer();}return commit(input);};}
 else{const runtime=f.runtime as any,dispatch=runtime.dispatch.bind(runtime);runtime.dispatch=async(missionId:string,command:any,...args:any[])=>{if(!changed&&command.type==='begin-runtime-assembly'){changed=true;await f.steer();}return dispatch(missionId,command,...args);};}
 assert.equal((await f.runtime.run('mission',workId,'run',(await f.read()).revision)).status,'settled');assert.ok(changed);const w=await f.work();assert.equal(await f.artifacts.read(w.artifact),'Answer enterprise');assert.equal(w.artifact.version,1);assert.equal(f.calls.filter(c=>c.prompt.step).length,2);assert.equal(f.calls.filter(c=>c.prompt.stepResults).length,1);validateMissionLineage((await f.read()).value);
});
