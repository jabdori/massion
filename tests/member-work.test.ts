import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {CommitOutcomeUnknownError,InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {AssistantService,parseAssistantTurn} from '../src/assistant-service.ts';
import {ASSISTANT_ACTOR_ID,assistantWorkId} from '../src/assistant-conversation.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {Application} from '../src/application.ts';
import {apply,createMission} from '../src/domain.ts';
import type {Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createWorkbench} from '../src/server.ts';
import {MEMBERS_ID,MembersService} from '../src/members.ts';
import {SkillsService} from '../src/skills.ts';
import {HostDrainError} from '../src/runtime-lifetime.ts';

// docs/architecture/member-work.md: the Representative hands Work to a member, the member's group runs it, the 1:1 conversation steers it, the host lists Works with their end time. Fixture-class only.
const MODELS=['openai/gpt-rep','openai/gpt-exec','anthropic/claude-check','google/gemini-a','anthropic/claude-b'];
const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'openrouter',baseUrl:'http://127.0.0.1:9999/v1/',models:MODELS}]});
const v1=(reply:string,title?:string)=>JSON.stringify({reply,work:title===undefined?null:{title}});
const v2=(reply:string,title:string,member:string|null)=>JSON.stringify({reply,work:{title,member}});
const steer=(reply:string,workId:string|null)=>JSON.stringify({reply,work:null,steer:workId});

async function setup(t:test.TestContext,providerType='openrouter'){
 const root=await mkdtemp(join(tmpdir(),'massion-member-work-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore(join(root,'artifacts')),script:string[]=[],prompts:any[]=[],calls:string[]=[];let now=Date.now();const start=now,clock=()=>now;let onExecute:((signal:AbortSignal)=>Promise<void>)|undefined;let plan:((steps:string[])=>unknown)|undefined,worker:((prompt:any,signal:AbortSignal)=>Promise<string>)|undefined;
 const completion=(model:string,content:string)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content.split('\n\nInput references')[0]);
  if(Object.hasOwn(prompt,'currentMessage')){prompts.push({model:body.model,prompt});return completion(body.model,script.shift()??v1('Hello.'));}
  calls.push(body.model);
  if(prompt.teamPlanning)return completion(body.model,JSON.stringify(plan?plan(prompt.teamPlanning.steps):{steps:prompt.teamPlanning.steps.map((title:string,i:number)=>({role:i===0?'Research':'Writing',title,dependsOn:i?[i-1]:[],...(title==='Optional comparison'?{skipReason:'No comparison requested'}:{})}))}));
  if(prompt.artifact)return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Answer bounded',reason:'Controlled fixture'}]}));
  if(prompt.step&&worker)return completion(body.model,await worker(prompt,init!.signal as AbortSignal));
  if(onExecute)await onExecute(init!.signal as AbortSignal);
  return completion(body.model,'Answer bounded fixture text');
 };
 const settings=new InMemoryHostSettings();
 const m=createHostConnections(store,artifacts,{manifest:providerType==='openrouter'?manifest:parseHostManifest({...manifest,connections:manifest.connections.map(c=>({...c,providerType}))}),allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings});
 const profile=(model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 const product=new ProductService(store,undefined,m);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},'create-intake');
 const grant=async(id:string,executor:string,verifier:string)=>m.save(()=>m.authorize({id,scope:'local',executorProfileId:profile(executor),verifierProfileId:profile(verifier),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 await grant('grant','openai/gpt-exec','anthropic/claude-check');
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));
 const members=new MembersService(store,()=>'intake',clock),roster=async()=>(await members.read()).members;
 const assistant=new AssistantService(store,product,m,{clock,members:roster});
 await assistant.setSettings({profileId:profile('openai/gpt-rep'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:m.list().configHash});
 const say=async(s:AssistantService,text:string,commandId:string=randomUUID())=>{const view=await s.read();const target=!view.segment?{segment:1,expectedRevision:0}:{segment:view.head,expectedRevision:view.segment.revision};return s.send({commandId,...target,text});};
 const intake=async()=>(await store.load('intake'))!.value as Mission;
 /** Admits one member named Quill through the decision card, after two Representative Works this month. */
 const admit=async(name='Quill')=>{
  const ids:string[]=[];for(const title of ['Discount totals by weekday','Order discount totals']){script.push(v1('On it.',title));await say(assistant,'Please '+title);await assistant.idle();ids.push((await intake()).works.find(w=>w.title===title)!.id);}
  await members.propose({topic:'Data analysis',workIds:ids});await members.decide({commandId:'d-'+name,decisionId:(await members.read()).decisions.at(-1)!.id,answer:'act',member:{name,shape:'drop'}});
  return (await members.read()).members.find(x=>x.name===name)!;
 };
 const chatFor=(member:{id:string;name:string;modelGroup:string},ownerStore?:Store<any>)=>new AssistantService(store,product,m,{clock,member:{id:member.id,name:member.name,modelGroup:member.modelGroup},...(ownerStore?{ownerStore}:{})});
 return {setPlan:(p:typeof plan)=>{plan=p;},setWorker:(w:typeof worker)=>{worker=w;},root,store,artifacts,m,settings,transport,product,assistant,members,script,prompts,calls,say,intake,admit,chatFor,grant,profile,setNow:(v:number)=>{now=v;},setExecutionHook:(hook:(signal:AbortSignal)=>Promise<void>)=>{onExecute=hook;},start};
}

async function runningWork(f:Awaited<ReturnType<typeof setup>>,t:test.TestContext){
 let entered=()=>{},release=()=>{},signal:AbortSignal|undefined;
 const started=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});
 f.setExecutionHook(async s=>{signal=s;entered();s.addEventListener('abort',release,{once:true});await gate;});
 t.after(async()=>{release();await f.assistant.idle();});f.script.push(v2('On it.','Churn causes','Quill'));await f.say(f.assistant,'Find churn causes');await started;f.setNow(Date.now());
 return {work:(await f.intake()).works.at(-1)!,release,signal:()=>signal!};
}

async function confirmLast(chat:AssistantService){const view=await chat.read();return chat.confirmSteer({segment:view.segment!.number,turnId:view.turns.at(-1)!.id});}

test('assistant-turn v2: v1 still parses; a member name is one short line; steer only where the thread allows it',()=>{
 assert.deepEqual(parseAssistantTurn(v1('Hi')),{reply:'Hi',proposal:null});
 assert.deepEqual(parseAssistantTurn(v1('On it','Totals')),{reply:'On it',proposal:{title:'Totals'}});
 assert.deepEqual(parseAssistantTurn(v2('On it','Totals','Quill')),{reply:'On it',proposal:{title:'Totals',member:'Quill'}});
 assert.deepEqual(parseAssistantTurn(v2('On it','Totals',null)),{reply:'On it',proposal:{title:'Totals'}});
 for(const bad of [v2('x','T','a\nb'),v2('x','T','x'.repeat(33)),v2('x','T',''),JSON.stringify({reply:'x',work:{title:'T',member:'Q',extra:1}}),JSON.stringify({reply:'x',work:{title:'T',member:7}})])assert.equal(parseAssistantTurn(bad),null,bad);
 assert.equal(parseAssistantTurn(steer('x','w')),null,'the Representative has no steer field');
 assert.deepEqual(parseAssistantTurn(steer('Sure','assistant-abc'),{steer:true}),{reply:'Sure',proposal:null,steer:'assistant-abc'});
 assert.deepEqual(parseAssistantTurn(steer('Sure',null),{steer:true}),{reply:'Sure',proposal:null});
 assert.equal(parseAssistantTurn(steer('Sure','bad id!'),{steer:true}),null);
});

test('the Representative hands a Work to a member: names are data, the host checks the name and pins the member; the Work runs, lists and ends',async t=>{
 const f=await setup(t),quill=await f.admit();
 f.script.push(v2('Quill will take it.','Churn causes','quill'));const sent=await f.say(f.assistant,'Find churn causes');await f.assistant.idle();
 const prompt=f.prompts.at(-1)!.prompt;assert.deepEqual(prompt.members,[{name:'Quill'}]);assert.doesNotMatch(prompt.instruction,/Quill/);assert.match(prompt.instruction,/assistant-turn\/v2/);
 assert.equal(sent.turn?.outcome?.work.status,'admitted');
 const work=(await f.intake()).works.find(w=>w.title==='Churn causes')!;assert.equal(work.assistantSource?.memberId,quill.id);assert.equal(work.acceptance,'accepted',JSON.stringify({blocker:work.blocker,verdict:work.verdict}));
 assert.ok(Number.isSafeInteger(work.endedAt)&&work.endedAt!>=work.runtimeRun!.ownership!.startedAt,'the accepting command recorded the host time');
 const read=await f.assistant.read(),turn=read.turns.find(x=>x.work?.workId===work.id)!;assert.equal(turn.work!.memberId,quill.id);assert.equal(turn.work!.endedAt,work.endedAt);
 const list=await f.assistant.works();assert.deepEqual(list.works.map(w=>[w.title,w.memberId]),[['Churn causes',quill.id],['Order discount totals',null],['Discount totals by weekday',null]]);
 assert.equal(list.works[0]!.endedAt,work.endedAt);assert.equal(list.works[0]!.segment,1);assert.equal(typeof list.feedId,'string');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('an unknown member name creates no Work and the host picks no one else',async t=>{
 const f=await setup(t);await f.admit();const before=(await f.intake()).works.length,calls=f.calls.length;
 f.script.push(v2('Nova will do it.','Churn causes','Nova'));const sent=await f.say(f.assistant,'Find churn causes');await f.assistant.idle();
 assert.equal(sent.turn?.outcome?.work.status,'not_created');assert.equal(sent.turn?.outcome?.work.diagnostics[0]?.code,'member_unknown');
 assert.equal((await f.intake()).works.length,before);assert.equal(f.calls.length,calls,'no run');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('lineage refuses a member pin the answered proposal did not name',async t=>{
 const f=await setup(t),quill=await f.admit();
 f.script.push(v2('Nova will do it.','Churn causes','Nova'));const sent=await f.say(f.assistant,'Find churn causes');await f.assistant.idle();
 const segment=(await f.store.load('assistant-conversation:1'))!.value,turn=segment.turns.find((x:any)=>x.id===sent.turn!.id),message=segment.messages.find((x:any)=>x.id===turn.messageId);
 const {hash}=await import('../src/domain.ts');const intake=(await f.store.load('intake'))!;
 const forged={type:'admit-work' as const,workId:assistantWorkId(turn.id),title:'Churn causes',budget:8,assistantSource:{segmentId:segment.id,turnId:turn.id,messageId:message.id,messageHash:hash(message),message,representative:{provider:turn.route.provider,model:turn.route.model},memberId:quill.id}};
 assert.equal((await new Application(f.store,[{id:ASSISTANT_ACTOR_ID,roles:['assistant']}]).dispatch({missionId:'intake',commandId:'assistant-work:'+turn.id,expectedRevision:intake.revision,actorId:ASSISTANT_ACTOR_ID,command:forged})).status,'committed');
 assert.throws(()=>validateMissionJournalLineage(f.store.inspect() as any),/member/);
});

test('a member in an owner group runs on that group: executor first, a different-family checker preferred; no grant for it means no Work',async t=>{
 const f=await setup(t),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables and totals.',profileIds:[f.profile('google/gemini-a'),f.profile('anthropic/claude-b')],expectedConfigHash:f.m.list().configHash}));
 assert.equal((await f.members.setGroup({commandId:'g-1',memberId:quill.id,modelGroup:'analysis'},f.m)).status,'committed');
 await assert.rejects(f.members.setGroup({commandId:'g-2',memberId:quill.id,modelGroup:'nope'},f.m),/group/);
 await assert.rejects(f.members.setGroup({commandId:'g-3',memberId:'member-x',modelGroup:'analysis'},f.m),/member/i);
 // The host never widens a grant: nothing authorizes the group's models yet.
 f.script.push(v2('Quill will take it.','Churn causes','Quill'));let sent=await f.say(f.assistant,'Find churn causes');await f.assistant.idle();
 assert.equal(sent.turn?.outcome?.work.status,'not_created');assert.equal(sent.turn?.outcome?.work.diagnostics[0]?.code,'member_grant_missing');
 await f.grant('grant-analysis','google/gemini-a','anthropic/claude-b');const calls=f.calls.length;
 f.script.push(v2('Quill will take it.','Price table','Quill'));sent=await f.say(f.assistant,'Build the price table');await f.assistant.idle();
 assert.equal(sent.turn?.outcome?.run.status,'requested');
 const work=(await f.intake()).works.find(w=>w.title==='Price table')!;assert.equal(work.acceptance,'accepted',JSON.stringify({blocker:work.blocker,verdict:work.verdict}));assert.equal(work.runtimeRun?.authorizationId,'grant-analysis');
 assert.deepEqual(f.calls.slice(calls),['google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a','anthropic/claude-b']);
 assert.equal(work.verdict?.check?.relation,'different-family');assert.deepEqual(work.verdict?.check?.producers.map(p=>p.model),['google/gemini-a','openai/gpt-rep']);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('with no different family in the group the checker comes from another group',async t=>{
 const f=await setup(t),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'solo',name:'Solo',description:'One model.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 await f.members.setGroup({commandId:'g-1',memberId:quill.id,modelGroup:'solo'},f.m);
 await f.grant('grant-solo','google/gemini-a','anthropic/claude-check');const calls=f.calls.length;
 f.script.push(v2('Quill will take it.','Price table','Quill'));await f.say(f.assistant,'Build the price table');await f.assistant.idle();
 assert.deepEqual(f.calls.slice(calls),['google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a','anthropic/claude-check']);
 const work=(await f.intake()).works.find(w=>w.title==='Price table')!;assert.equal(work.verdict?.check?.relation,'different-family');
});

test('set-member-group: a racing identical answer replays; after drain starts the HTTP route refuses and changes nothing',async t=>{
 const f=await setup(t),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables and totals.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 const body={commandId:'g-race',memberId:quill.id,modelGroup:'analysis'};let raced=false;
 const store=new Proxy(f.store,{get(target,key){
  if(key==='lookupOperation'&&!raced)return async(identity:any)=>{raced=true;const r=await target.lookupOperation(identity);assert.equal((await f.members.setGroup(body,f.m)).status,'committed');return r;};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 assert.equal((await new MembersService(store,()=>'intake').setGroup(body,f.m)).status,'replayed');
 assert.equal((await f.members.read()).members[0]!.modelGroup,'analysis');
 await f.m.save(()=>f.m.removeModelGroup({id:'analysis',expectedConfigHash:f.m.list().configHash}));
 assert.equal((await f.members.setGroup(body,f.m)).status,'replayed','a stored answer survives removal of its group');
 await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables and totals.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 let hold=false,held=()=>{},release=()=>{};const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const slow=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===MEMBERS_ID){hold=false;held();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(slow as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:3000});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port;
 assert.equal((await fetch(`http://127.0.0.1:${port}/members/group`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'g-x',memberId:quill.id,modelGroup:'analysis',extra:1})})).status,400);
 assert.equal((await fetch(`http://127.0.0.1:${port}/members/group`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'assistant-g',memberId:quill.id,modelGroup:'default'})})).status,400,'assistant- command IDs are the host\'s');
 hold=true;const response=fetch(`http://127.0.0.1:${port}/members/group`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'g-drain',memberId:quill.id,modelGroup:'default'})});
 await reached;const drain=server.drain();release();
 assert.equal((await response).status,503);await drain;assert.equal((await f.members.read()).members[0]!.modelGroup,'analysis');
});

test('member 1:1 conversation: a remark about its open Work is recorded as that Work\'s steering, the owner\'s exact words, once',async t=>{
 const f=await setup(t),quill=await f.admit();
 const {work}=await runningWork(f,t);
 const chat=f.chatFor(quill),text='Only annual plan customers for the churn work.',commandId='m-steer';
 f.script.push(steer('Annual plans only, then.',work.id));
 const [a,b]=await Promise.all([f.say(chat,text,commandId),f.say(chat,text,commandId)]);
 const prompt=f.prompts.at(-1)!.prompt;assert.deepEqual(prompt.works,[{id:work.id,title:'Churn causes'}]);assert.deepEqual(prompt.member,{name:'Quill'});
 assert.equal(f.prompts.filter(p=>p.prompt.currentMessage===text).length,1,'one model call for the same command');
 assert.deepEqual([a.message.status,b.message.status].sort(),['committed','replayed']);
 await confirmLast(chat);const after=(await f.intake()).works.find(w=>w.id===work.id)!;assert.deepEqual(after.instructions,[{actorId:'local-owner',text}]);assert.equal(after.execution,work.blocker?'blocked':'waiting','steering preserves an existing runtime blocker');
 const read=await chat.read();assert.deepEqual(read.turns[0]!.steer,{missionId:'intake',workId:work.id,status:'recorded',title:'Churn causes'});
 // A Work not in this member's list is never steered.
 f.script.push(steer('Sure.','assistant-000000000000000000000000'));const other=await f.say(chat,'And the other thing.');
 assert.equal((await chat.read()).turns.find(x=>x.id===other.turn!.id)!.steer,undefined);
 assert.equal((await f.intake()).works.find(w=>w.id===work.id)!.instructions!.length,1);
 await f.assistant.idle();validateMissionJournalLineage(f.store.inspect() as any);
});

test('a steer resuming after drain starts goes through the owner store, is refused and settles not recorded; nothing is resent',async t=>{
 const f=await setup(t),quill=await f.admit();
 const {work,release}=await runningWork(f,t);
 let draining=false;const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return (input:any)=>{if(draining)throw new HostDrainError();return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Annual plans only.',work.id));
 const transportCalls=f.prompts.length;
 // Drain starts after the model answered, before the steer commits.
 const intakeLoad=f.store.load.bind(f.store);let armed=true;(f.store as any).load=async(id:string)=>{if(armed&&id==='intake'&&f.prompts.length>transportCalls){armed=false;draining=true;}return intakeLoad(id);};
 const sent=await f.say(chat,'Only annual plan customers.');(f.store as any).load=intakeLoad;
 assert.equal(sent.turn?.status,'answered');
 await assert.rejects(confirmLast(chat),HostDrainError);assert.equal((await chat.read()).turns[0]!.steer?.status,'proposed');assert.equal((await f.intake()).works.find(w=>w.id===work.id)!.instructions,undefined);
 release();await f.assistant.idle();
});

test('Work end time: cancel and block record host time; a journal without it still replays',()=>{
 const owner={id:'owner',roles:['owner' as const]};let mission=createMission({id:'m',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'bounded-text-review/v1'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'w',title:'T',budget:10},owner).value;
 const cancelled=apply(mission,{type:'cancel',workId:'w'},owner,{observedAt:1234});assert.equal(cancelled.value.works[0]!.endedAt,1234);assert.deepEqual((cancelled.events[0] as any).time,{observedAt:1234});
 const blocked=apply(mission,{type:'block-work',workId:'w',blocker:{code:'runtime_unavailable',detail:'Stopped'}},owner,{observedAt:2345});assert.equal(blocked.value.works[0]!.endedAt,2345);
 assert.equal(apply(mission,{type:'cancel',workId:'w'},owner).value.works[0]!.endedAt,undefined,'an earlier journal without time replays');
 assert.throws(()=>apply(mission,{type:'revise-budget',workId:'w',limit:20,reason:'More'},owner,{observedAt:1}),/clock/,'only ending commands take a time');
});

test('the admission card names the Work to hand when the proposal carries it',async t=>{
 const f=await setup(t);const ids:string[]=[];for(const title of ['Discount totals by weekday','Order discount totals']){f.script.push(v1('On it.',title));await f.say(f.assistant,'Please '+title);await f.assistant.idle();ids.push((await f.intake()).works.find(w=>w.title===title)!.id);}
 await assert.rejects(f.members.propose({topic:'Data analysis',workIds:ids,handoff:'a\nb'}),/handoff|fields/i);
 await f.members.propose({topic:'Data analysis',workIds:ids,handoff:'Table totals · total check'});
 assert.deepEqual((await f.members.read()).decisions[0]!.rows.map(r=>r[0]),['이번 달','맡길 일','모델 그룹']);
 assert.equal((await f.members.read()).decisions[0]!.rows[1]![1],'Table totals · total check');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('HTTP: /assistant/works lists Works with member and end time; a query is refused; member threads read their steer lines',async t=>{
 const f=await setup(t),quill=await f.admit();f.script.push(v2('Quill will take it.','Churn causes','Quill'));
 const server=createWorkbench(f.store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:50});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port,url=(p:string)=>`http://127.0.0.1:${port}${p}`;
 const view=await fetch(url('/assistant/conversation')).then(r=>r.json()) as any;
 const posted=await fetch(url('/assistant/messages'),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'m-1',segment:view.head,expectedRevision:view.segment.revision,text:'Find churn causes'})});assert.equal(posted.status,200);
 assert.equal((await fetch(url('/assistant/works?member=x'))).status,400);
 let list:any;for(let i=0;i<200;i++){list=await fetch(url('/assistant/works')).then(r=>r.json());if(list.works[0]?.endedAt)break;await new Promise(r=>setTimeout(r,10));}
 assert.equal(list.works[0].title,'Churn causes');assert.equal(list.works[0].memberId,quill.id);assert.ok(list.works[0].endedAt>=list.works[0].startedAt);assert.equal(list.feedId,(await fetch(url('/assistant/conversation')).then(r=>r.json()) as any).feedId);
});


test('a cached member conversation uses its newly assigned model group on the next message',async t=>{
 const f=await setup(t),quill=await f.admit();
 const server=createWorkbench(f.store,f.root,{connections:f.m,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const view=await fetch(url+'/assistant/conversation?member='+quill.id).then(r=>r.json()) as any;
 await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 await f.members.setGroup({commandId:'switch-group',memberId:quill.id,modelGroup:'analysis'},f.m);
 const response=await fetch(url+'/assistant/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'after-switch',member:quill.id,segment:1,expectedRevision:view.segment?.revision??0,text:'Hello'})});
 assert.equal(response.status,200);assert.equal(f.prompts.at(-1).model,'google/gemini-a');
});

test('member routing checks with the same model in a separate identity when no family is known',async t=>{
 const f=await setup(t,'compatible'),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'solo',name:'Solo',description:'One model.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 await f.members.setGroup({commandId:'solo-group',memberId:quill.id,modelGroup:'solo'},f.m);
 await f.grant('grant-solo','google/gemini-a','google/gemini-a');const before=f.calls.length;
 f.script.push(v2('On it.','Solo task','Quill'));await f.say(f.assistant,'Check a table');await f.assistant.idle();
 const w=(await f.intake()).works.at(-1)!;assert.equal(w.acceptance,'accepted',JSON.stringify({tasks:w.tasks,effects:w.effects.map(e=>({id:e.id,status:e.status})),blocker:w.blocker,turn:(await f.assistant.read()).turns.at(-1)}));assert.equal(w.verdict?.check?.relation,'same-family');
 assert.deepEqual(f.calls.slice(before),['google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a']);assert.notEqual(w.assignments.find(a=>a.role==='executor')!.actorId,w.assignments.find(a=>a.role==='verifier')!.actorId);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('an ambiguous steering commit is not resent even when the same owner message returns',async t=>{
 const f=await setup(t),quill=await f.admit();
 const running=await runningWork(f,t),work=running.work;
 let commits=0;const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events[0].type==='steer'){commits++;throw new CommitOutcomeUnknownError(input,new Error('Lost reply'));}return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Annual plans only.',work.id));await f.say(chat,'Annual plans only.','ambiguous-steer');await confirmLast(chat);await f.say(chat,'Annual plans only.','ambiguous-steer');await confirmLast(chat);
 assert.equal(commits,1);assert.equal((await chat.read()).turns[0]!.steer?.status,'recorded');assert.equal(running.signal().aborted,true);assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'Annual plans only.'}]);
});

test('a duplicate message committed after its replay lookup returns the stored result',async t=>{
 const f=await setup(t);let loads=0;
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(id==='assistant-conversation:1'&&++loads===2)await f.say(f.assistant,'Hello','overlap');return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=new AssistantService(store,f.product,f.m);const result=await chat.send({commandId:'overlap',segment:1,expectedRevision:0,text:'Hello'});
 assert.equal(result.message.status,'replayed');assert.equal(f.prompts.length,1);
});


test('a member steering message interrupts the active provider call after recording the owner instruction',async t=>{
 const f=await setup(t),quill=await f.admit();let entered=()=>{},release=()=>{},signal:AbortSignal|undefined;
 const started=new Promise<void>(r=>{entered=r;}),pending=new Promise<void>(r=>{release=r;});
 f.setExecutionHook(async s=>{signal=s;entered();s.addEventListener('abort',release,{once:true});await pending;});t.after(async()=>{release();await f.assistant.idle();});
 f.script.push(v2('On it.','Churn causes','Quill'));await f.say(f.assistant,'Find churn causes');await started;
 const work=(await f.intake()).works.at(-1)!;f.script.push(steer('Annual plans only.',work.id));const chat=f.chatFor(quill);await f.say(chat,'Annual plans only.');await confirmLast(chat);
 assert.equal(signal?.aborted,true,'the stored steer must interrupt the already running call');
 await f.assistant.idle();const server=createWorkbench(f.store,f.root,{connections:f.m,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const listed=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/works').then(r=>r.json()) as any;const stopped=listed.works.find((w:any)=>w.workId===work.id);assert.equal(stopped.execution,'waiting');assert.ok(Number.isSafeInteger(stopped.endedAt));
 assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'Annual plans only.'}]);
});


test('review 1: only an actively running member Work is offered for steering',async t=>{
 const f=await setup(t),quill=await f.admit();const run=f.product.run.bind(f.product);let release=()=>{};const gate=new Promise<void>(r=>{release=r;});f.product.run=async(...args)=>{await gate;return run(...args);};t.after(async()=>{release();await f.assistant.idle();});
 f.script.push(v2('On it.','Queued task','Quill'));await f.say(f.assistant,'Check this');const w=(await f.intake()).works.at(-1)!;
 f.script.push(steer('Sure.',w.id));const chat=f.chatFor(quill);await f.say(chat,'Use annual plans');
 assert.deepEqual(f.prompts.at(-1).prompt.works,[]);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

test('review 2: a steering commit remains visible when its acknowledgment crosses the turn deadline',async t=>{
 const f=await setup(t),quill=await f.admit(),{work}=await runningWork(f,t);
 const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);const state=(await target.load('assistant-conversation:member:'+quill.id+':1'))!.value;if(input.events[0].type==='steer')f.setNow(state.turns[0].ownership.deadlineAt+1);return result;};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Sure.',work.id));await f.say(chat,'Annual plans');await confirmLast(chat);assert.equal((await chat.read()).turns[0]!.steer?.status,'recorded');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('review 2: restart reads a committed steer even if the host stops before its outcome record',async t=>{
 const f=await setup(t),quill=await f.admit(),{work}=await runningWork(f,t);
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0].type==='record-assistant-steer')throw new Error('Host stopped before outcome');return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=new AssistantService(store,f.product,f.m,{member:quill});f.script.push(steer('Sure.',work.id));await f.say(chat,'Annual plans');assert.equal((await confirmLast(chat)).status,'recorded');
 const before=f.store.inspect().length;assert.equal((await f.chatFor(quill).read()).turns[0]!.steer?.status,'recorded');assert.equal(f.store.inspect().length,before,'restart only reads the recorded identity');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('review 3: an unconfirmed steering write stays unknown and is never resent',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let writes=0;
 const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events[0].type==='steer'){writes++;throw new CommitOutcomeUnknownError(input,new Error('Unconfirmed'));}return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Sure.',running.work.id));await f.say(chat,'Annual plans','lost-steer');await confirmLast(chat);await f.say(chat,'Annual plans','lost-steer');await confirmLast(chat);
 assert.equal((await chat.read()).turns[0]!.steer?.status,'unknown');assert.equal(writes,1);assert.equal(running.signal().aborted,false);
});

test('review 6: another host changes intake while the earlier member Work is still active',async t=>{
 const f=await setup(t);await f.admit();const {work}=await runningWork(f,t);
 await f.product.create({id:'next-intake',purpose:'Next',scope:'local',constraints:[],criteria:{version:1,description:'Check',oracle:'bounded-text-review/v1'}},'next-intake');
 const connections=createHostConnections(f.store,f.artifacts,{manifest,allowLiveExecution:false},{transport:f.transport,settings:f.settings,readEnvironment:()=>undefined});await connections.restoreSettings();const other=new AssistantService(f.store,f.product,connections);
 await other.setSettings({profileId:f.profile('openai/gpt-rep'),outputTokenCap:64,intakeMissionId:'next-intake',expectedConfigHash:connections.list().configHash});
 const list=await other.works();assert.ok(list.works.some(w=>w.workId===work.id&&w.missionId==='intake'&&w.execution==='active'));
});

test('review 7: removal of a member group falls back to default for its conversation and new Work',async t=>{
 const f=await setup(t),quill=await f.admit();await f.m.save(()=>f.m.saveModelGroup({id:'gone',name:'Gone',description:'Tables',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 await f.members.setGroup({commandId:'set-gone',memberId:quill.id,modelGroup:'gone'},f.m);await f.m.save(()=>f.m.removeModelGroup({id:'gone',expectedConfigHash:f.m.list().configHash}));
 const chat=f.chatFor({...quill,modelGroup:'gone'});assert.equal((await f.say(chat,'Hello')).turn?.status,'answered');
 f.script.push(v2('On it.','Fallback task','Quill'));const sent=await f.say(f.assistant,'Check totals');await f.assistant.idle();assert.equal(sent.turn?.outcome?.run.status,'requested');assert.equal((await f.intake()).works.at(-1)!.acceptance,'accepted');
});

test('review 7: member group assignment holds the settings fence through its commit',async t=>{
 const f=await setup(t),quill=await f.admit();await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 let enter=()=>{},release=()=>{};const entered=new Promise<void>(r=>{enter=r;}),gate=new Promise<void>(r=>{release=r;});t.after(release);
 const store=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{enter();await gate;return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const setting=new MembersService(store,()=>'intake').setGroup({commandId:'held-group',memberId:quill.id,modelGroup:'analysis'},f.m);await entered;
 assert.throws(()=>f.m.removeModelGroup({id:'analysis',expectedConfigHash:f.m.list().configHash}),/saving path/);
 await assert.rejects(f.m.save(()=>f.m.removeModelGroup({id:'analysis',expectedConfigHash:f.m.list().configHash})),/being saved/);release();assert.equal((await setting).status,'committed');
});

test('review 8: later cleanup preserves the original end, and every runtime closure records its end',async t=>{
 const f=await setup(t),quill=await f.admit(),{work}=await runningWork(f,t),mission=await f.intake(),owner={id:'local-owner',roles:['owner' as const,'representative' as const]};
 const started=work.runtimeRun!.ownership!.startedAt,ended=started+240000;
 const blocked=apply(mission,{type:'block-work',workId:work.id,blocker:{code:'runtime_unavailable',detail:'Stopped'}},owner,{observedAt:ended,workEndVersion:2}).value;
 assert.equal(apply(blocked,{type:'cancel',workId:work.id},owner,{observedAt:ended+3*86400000,workEndVersion:2}).value.works.at(-1)!.endedAt,ended);
 assert.equal(apply(blocked,{type:'quarantine-runtime',workId:work.id,runId:work.runtimeRun!.id,reason:'Close unknown',acknowledgeUncertainOutcome:true},owner,{observedAt:ended+3*86400000,workEndVersion:2}).value.works.at(-1)!.endedAt,ended);
 blocked.works.at(-1)!.endedAt=started-1;assert.equal(apply(blocked,{type:'cancel',workId:work.id},owner,{observedAt:ended,workEndVersion:2}).value.works.at(-1)!.endedAt,ended);
 const run=work.runtimeRun!,o=run.ownership!;
 const base={workId:work.id,runId:run.id,dispatchId:o.dispatchId,observedAt:o.deadlineAt};
 const commands:import('../src/domain.ts').Command[]=[{type:'expire-runtime',...base},{type:'stop-owned-runtime',...base,hostSessionId:o.hostSessionId},{type:'close-expired-runtime',...base,hostSessionId:o.hostSessionId,deadlineAt:o.deadlineAt,reason:'Timed out',acknowledgeUncertainOutcome:true}];
 for(const command of commands)assert.equal(apply(mission,command,owner,{observedAt:o.deadlineAt,workEndVersion:2}).value.works.at(-1)!.endedAt,o.deadlineAt,command.type);
});

test('review 7: simultaneous identical group commands replay behind the settings fence',async t=>{
 const f=await setup(t),quill=await f.admit();const body={commandId:'group-overlap',memberId:quill.id,modelGroup:'default'};
 const results=await Promise.all([f.members.setGroup(body,f.m),f.members.setGroup(body,f.m)]);
 assert.deepEqual(results.map(r=>r.status).sort(),['committed','replayed']);
});

test('review 8: legacy end-time journals replay their original overwrite rule',async()=>{
 const store=new InMemoryStore<Mission>(),actor={id:'owner',roles:['owner' as const]},app=new Application(store,[actor]);
 await app.create({id:'legacy',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'bounded-text-review/v1'}},actor.id,'create');await app.dispatch({missionId:'legacy',commandId:'admit',expectedRevision:1,actorId:actor.id,command:{type:'admit-work',workId:'w',title:'T',budget:4}});
 const {hash}=await import('../src/domain.ts');
 const commands:import('../src/domain.ts').Command[]=[{type:'block-work',workId:'w',blocker:{code:'runtime_unavailable',detail:'Stopped'}},{type:'cancel',workId:'w'}];
 for(const [i,command] of commands.entries()){
  const snapshot=(await store.load('legacy'))!,time={observedAt:(i+1)*100},result=apply(snapshot.value,command,actor,time);result.value.works[0]!.endedAt=time.observedAt;
  await store.commit({id:'legacy',expectedRevision:snapshot.revision,commandId:'legacy-end-'+i,fingerprint:hash({actorId:actor.id,command,expectedRevision:snapshot.revision}),value:result.value,events:[{type:command.type,actor:actor.id,command,time}],outbox:[]});
 }
 assert.equal((await store.load('legacy'))!.value.works[0]!.endedAt,200);validateMissionJournalLineage(store.inspect());
});

test('review 3: a later confirmed steering receipt interrupts the still-owned local run',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let confirmed=false,writes=0;
 const store=new Proxy(f.store,{get(target,key){
  if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events[0].type==='steer'){writes++;throw new CommitOutcomeUnknownError(input,new Error('Lost reply'));}return result;};
  if(key==='lookupOperation')return async(identity:any)=>!confirmed&&identity.commandId.startsWith('assistant-steer:')?{status:'unknown'}:target.lookupOperation(identity);
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;
 }});
 const chat=new AssistantService(store,f.product,f.m,{member:quill});f.script.push(steer('Sure.',running.work.id));await f.say(chat,'Annual plans');await confirmLast(chat);
 assert.equal((await chat.read()).turns[0]!.steer?.status,'unknown');assert.equal(running.signal().aborted,false);
 confirmed=true;assert.equal((await chat.read()).turns[0]!.steer?.status,'recorded');assert.equal(running.signal().aborted,true);assert.equal(writes,1);
 confirmed=false;assert.equal((await chat.read()).turns[0]!.steer?.status,'recorded','a later unavailable receipt read cannot erase the confirmed outcome');
});

for(const authorized of [true,false])test(`manual Start preserves a deferred member group (${authorized?'authorized':'revoked grant'})`,async t=>{
 const f=await setup(t),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables',profileIds:[f.profile('google/gemini-a'),f.profile('anthropic/claude-b')],expectedConfigHash:f.m.list().configHash}));
 await f.grant('grant-analysis','google/gemini-a','anthropic/claude-b');await f.members.setGroup({commandId:'analysis-group',memberId:quill.id,modelGroup:'analysis'},f.m);
 const occupied=await runningWork(f,t);f.script.push(v2('Quill will take it.','Deferred table','Quill'));const sent=await f.say(f.assistant,'Build another table');
 assert.equal(sent.turn?.outcome?.work.status,'admitted');assert.equal(sent.turn?.outcome?.run.status,'not_started');assert.equal(sent.turn?.outcome?.run.diagnostics[0]?.code,'host_busy');
 const work=(await f.intake()).works.at(-1)!;assert.equal(work.runtimeRun,undefined);occupied.release();await f.assistant.idle();
 if(!authorized)await f.m.save(()=>f.m.revoke({authorizationId:'grant-analysis',expectedConfigHash:f.m.list().configHash}));
 const server=createWorkbench(f.store,f.root,{connections:f.m,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port,revision=(await f.store.load('intake'))!.revision,before=f.calls.length;
 const post=async(path:string,commandId:string)=>fetch(url+'/missions/intake/'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId,workId:work.id,expectedRevision:revision})}).then(r=>r.json()) as Promise<any>;
 const check=await post('preflight','check-deferred');
 if(authorized){assert.equal(check.ready,true);assert.equal(check.selection.choice.executorProfileId,f.profile('google/gemini-a'));assert.equal(check.selection.choice.verifierProfileId,f.profile('anthropic/claude-b'));}
 else{assert.equal(check.ready,false);assert.ok(check.diagnostics.some((d:any)=>d.code==='member_grant_missing'));}
 const result=await post('run','manual-member-start');assert.equal(result.status,authorized?'settled':'blocked');
 if(authorized){assert.deepEqual(f.calls.slice(before),['google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a','anthropic/claude-b']);const after=(await f.intake()).works.find(w=>w.id===work.id)!;assert.equal(after.runtimeRun!.authorizationId,'grant-analysis');assert.equal(after.acceptance,'accepted');}
 else{assert.equal(f.calls.length,before);assert.equal((await f.intake()).works.find(w=>w.id===work.id)!.runtimeRun,undefined);}
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('selection-less sequence resolves each deferred Work through its own member group',async t=>{
 const f=await setup(t),quill=await f.admit();await f.m.save(()=>f.m.saveModelGroup({id:'analysis',name:'Analysis',description:'Tables',profileIds:[f.profile('google/gemini-a'),f.profile('anthropic/claude-b')],expectedConfigHash:f.m.list().configHash}));await f.grant('grant-analysis','google/gemini-a','anthropic/claude-b');await f.members.setGroup({commandId:'sequence-group',memberId:quill.id,modelGroup:'analysis'},f.m);
 const occupied=await runningWork(f,t);for(const member of ['Quill',null]){f.script.push(v2('On it.','Deferred '+(member??'default'),member));const sent=await f.say(f.assistant,'Check another table');assert.equal(sent.turn?.outcome?.run.status,'not_started');}
 occupied.release();await f.assistant.idle();const current=(await f.store.load('intake'))!,{hash,workInputHash}=await import('../src/domain.ts'),works=current.value.works.slice(-2).map((w:any)=>({workId:w.id,inputHash:workInputHash(w),criteriaHash:hash(w.criteria)}));
 const server=createWorkbench(f.store,f.root,{connections:f.m,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const before=f.calls.length;
 const result=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/missions/intake/run-sequence',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'member-sequence',expectedRevision:current.revision,works})}).then(r=>r.json()) as any;
 assert.equal(result.status,'completed');assert.deepEqual(f.calls.slice(before),['google/gemini-a','google/gemini-a','google/gemini-a','google/gemini-a','anthropic/claude-b','openai/gpt-exec','anthropic/claude-check']);validateMissionJournalLineage(f.store.inspect() as any);
});

test('a model-selected steering target is only proposed until the owner explicitly applies it',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),chat=f.chatFor(quill),before=(await f.store.load('intake'))!.revision;
 f.script.push(steer('Sure.',running.work.id));const sent=await f.say(chat,'An unrelated greeting');
 assert.equal((await chat.read()).turns[0]!.steer?.status,'proposed');assert.equal((await f.store.load('intake'))!.revision,before);assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
 const server=createWorkbench(f.store,f.root,{connections:f.m,artifacts:f.artifacts,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const url='http://127.0.0.1:'+(server.address() as {port:number}).port,feed=(await chat.read()).feedId,body={member:quill.id,segment:1,turnId:sent.turn!.id};
 const post=(data:any,feedId=feed)=>fetch(url+'/assistant/steering',{method:'POST',headers:{'content-type':'application/json','x-massion-feed':feedId},body:JSON.stringify(data)});
 assert.equal((await post({...body,text:'Injected text'})).status,400);assert.equal((await post({...body,workId:'other'})).status,400);assert.equal((await post(body,'old-feed')).status,409);assert.equal(running.signal().aborted,false);
 const replies=await Promise.all([post(body),post(body)]);assert.ok(replies.every(r=>r.status===200));assert.equal(running.signal().aborted,true);assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'An unrelated greeting'}]);
 assert.equal((await chat.read()).turns[0]!.steer?.status,'recorded');validateMissionJournalLineage(f.store.inspect() as any);
});

test('an ambiguous owner confirmation never dispatches steering or retries the intent',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let confirmations=0,steers=0;
 const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events[0].type==='steer')steers++;if(input.events[0].type==='confirm-assistant-steer'){confirmations++;throw new CommitOutcomeUnknownError(input,new Error('Lost confirmation acknowledgment'));}return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');await confirmLast(chat);await confirmLast(chat);
 assert.equal(confirmations,1);assert.equal(steers,0);assert.equal((await chat.read()).turns[0]!.steer?.status,'unknown');assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

test('only the owner can confirm a proposed target, and a finished target cannot be applied',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),chat=f.chatFor(quill);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');
 const view=await chat.read(),{AssistantConversation}=await import('../src/assistant-conversation.ts'),model=new AssistantConversation(f.store,[{id:ASSISTANT_ACTOR_ID,roles:['assistant']}],Date.now,'member:'+quill.id);
 await assert.rejects(model.dispatch({segment:1,commandId:'assistant-confirm-steer:'+view.turns[0]!.id,expectedRevision:view.segment!.revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'confirm-assistant-steer',turnId:view.turns[0]!.id,workRevision:(await f.store.load('intake'))!.revision}}),/role/);
 assert.equal(running.signal().aborted,false);running.release();await f.assistant.idle();assert.equal((await confirmLast(chat)).status,'not_recorded');assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

test('HTTP steering confirmation resuming after drain records no owner intent or instruction',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),chat=f.chatFor(quill);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');const view=await chat.read();
 let hold=false,entered=()=>{},release=()=>{};const reached=new Promise<void>(r=>{entered=r;}),gate=new Promise<void>(r=>{release=r;});t.after(release);
 const slow=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id==='intake'){hold=false;entered();await gate;}return target.load(id);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const server=createWorkbench(slow,f.root,{connections:f.m,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());hold=true;
 const response=fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/steering',{method:'POST',headers:{'content-type':'application/json','x-massion-feed':view.feedId},body:JSON.stringify({member:quill.id,segment:1,turnId:view.turns[0]!.id})});await reached;const drain=server.drain();release();assert.equal((await response).status,503);await drain;
 assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);assert.equal(f.store.inspect().filter(op=>(op.events[0] as any)?.type==='confirm-assistant-steer').length,0);
});

test('an unobserved confirmation outcome stays unknown and repeated confirmations are read-only',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let writes=0;
 const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{writes++;if(writes===1)throw new CommitOutcomeUnknownError(input,new Error('Receipt not visible'));return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');await confirmLast(chat);
 assert.equal((await chat.read()).turns[0]!.steer?.status,'unknown');await confirmLast(chat);assert.equal(writes,1);assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

test('member Work cannot run a group reserved for the discriminator after integration',async t=>{
 const f=await setup(t);await f.m.save(()=>f.m.saveModelGroup({id:'decision',name:'Decision',description:'Typed decisions',role:'discriminator',profileIds:[f.profile('google/gemini-a'),f.profile('anthropic/claude-b')],expectedConfigHash:f.m.list().configHash}));await f.grant('decision-grant','google/gemini-a','anthropic/claude-b');
 const resolved=f.m.resolveGroupWork('decision',await f.intake(),{provider:'openrouter',model:'openai/gpt-rep'});assert.equal(resolved.status,'unresolved');if(resolved.status==='unresolved')assert.equal(resolved.diagnostics[0]!.code,'model_group_role');
});

function intercepted(store:Store<any>,methods:Record<string,unknown>):Store<any>{return new Proxy(store,{get(target,key){const value=Object.hasOwn(methods,key)?methods[String(key)]:Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});}

test('confirmation audit: a definite conversation revision conflict releases the proposal for a fresh owner action',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),segmentId='assistant-conversation:member:'+quill.id+':1';let race=false;
 const ownerStore=intercepted(f.store,{load:async(id:string)=>{if(race&&id===segmentId){race=false;await f.say(f.chatFor(quill),'Another message');}return f.store.load(id);}}),chat=f.chatFor(quill,ownerStore);
 f.script.push(steer('A proposal.',running.work.id));const sent=await f.say(chat,'Annual plans'),input={segment:1,turnId:sent.turn!.id};race=true;
 assert.equal((await chat.confirmSteer(input)).status,'not_recorded');assert.equal((await chat.read()).turns.find(t=>t.id===input.turnId)!.steer!.status,'proposed');assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
 assert.equal((await chat.confirmSteer(input)).status,'recorded');assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'Annual plans'}]);
});

test('confirmation audit: an idempotent intent replay never authorizes the Work write',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let intent=0,work=0;
 const ownerStore=intercepted(f.store,{commit:async(input:any)=>{if(input.events[0].type==='steer')work++;const result=await f.store.commit(input);if(input.events[0].type==='confirm-assistant-steer'){intent++;return {...result,status:'replayed'};}return result;}}),chat=f.chatFor(quill,ownerStore);
 f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');assert.equal((await confirmLast(chat)).status,'unknown');assert.equal((await confirmLast(chat)).status,'unknown');assert.equal(intent,1);assert.equal(work,0);assert.equal(running.signal().aborted,false);
});

test('confirmation audit: the segment dispatcher reconciles a committed idempotency-conflict reply',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),chat=f.chatFor(quill);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');const view=await chat.read();
 const store=intercepted(f.store,{commit:async(input:any)=>{const result=await f.store.commit(input);return {status:'conflict',reason:'idempotency',revision:result.revision};}}),{AssistantConversation}=await import('../src/assistant-conversation.ts'),owner=new AssistantConversation(store,[{id:'local-owner',roles:['owner']}],Date.now,'member:'+quill.id);
 const result=await owner.dispatch({segment:1,commandId:'assistant-confirm-steer:'+view.turns[0]!.id,expectedRevision:view.segment!.revision,actorId:'local-owner',command:{type:'confirm-assistant-steer',turnId:view.turns[0]!.id,workRevision:(await f.store.load('intake'))!.revision}});
 assert.equal(result.status,'replayed');assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

for(const outcomeFails of [false,true])test(`confirmation audit: a definite Work conflict remains not recorded (${outcomeFails?'outcome write conflicts':'outcome recorded'})`,async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let interfered=false;
 const store=intercepted(f.store,{commit:async(input:any)=>{if(outcomeFails&&input.events[0].type==='record-assistant-steer')return {status:'conflict',reason:'revision',revision:input.expectedRevision};return f.store.commit(input);}});
 const ownerStore=intercepted(f.store,{commit:async(input:any)=>{const result=await f.store.commit(input);if(!interfered&&input.events[0].type==='confirm-assistant-steer'){interfered=true;await f.product.appendMissionMessage('intake',{commandId:'during-confirm',expectedRevision:(await f.store.load('intake'))!.revision,messageId:'during-confirm',replyTo:null,text:'Another owner note'});}return result;}});
 const chat=new AssistantService(store,f.product,f.m,{member:quill,ownerStore});f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');
 assert.equal((await confirmLast(chat)).status,'not_recorded');assert.equal((await chat.read()).turns[0]!.steer?.status,'not_recorded');assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

test('confirmation audit: a replayed Work receipt is recorded without a second instruction',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let writes=0;
 const ownerStore=intercepted(f.store,{commit:async(input:any)=>{const result=await f.store.commit(input);if(input.events[0].type==='steer'){writes++;return {...result,status:'replayed'};}return result;}}),chat=f.chatFor(quill,ownerStore);f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');
 assert.equal((await confirmLast(chat)).status,'recorded');assert.equal(writes,1);assert.equal((await f.intake()).works.at(-1)!.instructions!.length,1);assert.equal(running.signal().aborted,true);
});

test('confirmation audit: a definite reconciliation conflict is not an unknown Work outcome',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let uncertain=false;
 const store=intercepted(f.store,{lookupOperation:async(identity:any)=>uncertain&&identity.commandId.startsWith('assistant-steer:')?{status:'conflict',reason:'idempotency',revision:1}:f.store.lookupOperation(identity)});
 const ownerStore=intercepted(f.store,{commit:async(input:any)=>{if(input.events[0].type==='steer'){uncertain=true;throw new CommitOutcomeUnknownError(input,new Error('Lost receipt'));}return f.store.commit(input);}}),chat=new AssistantService(store,f.product,f.m,{member:quill,ownerStore});f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');
 assert.equal((await confirmLast(chat)).status,'not_recorded');assert.equal((await chat.read()).turns[0]!.steer?.status,'not_recorded');assert.equal(running.signal().aborted,false);
});

for(const stage of ['confirm-assistant-steer','steer'] as const)test(`confirmation audit: an unclassified ${stage} commit error is reconciled, never called a definite refusal`,async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let writes=0;
 const ownerStore=intercepted(f.store,{commit:async(input:any)=>{if(input.events[0].type===stage){writes++;if(stage==='steer')await f.store.commit(input);throw new Error('Unclassified lost acknowledgment');}return f.store.commit(input);}}),chat=f.chatFor(quill,ownerStore);
 f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');assert.equal((await confirmLast(chat)).status,stage==='steer'?'recorded':'unknown');await confirmLast(chat);assert.equal(writes,1);assert.equal(running.signal().aborted,stage==='steer');
});

for(const stage of ['confirm-assistant-steer','steer'] as const)test(`confirmation audit: a proven transaction rollback at ${stage} is a definite HTTP refusal`,async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),chat=f.chatFor(quill);f.script.push(steer('A proposal.',running.work.id));const sent=await f.say(chat,'Annual plans');let rolledBack=false;
 const {StorageQueryError}=await import('../src/storage.ts'),store=intercepted(f.store,{commit:async(input:any)=>{if(!rolledBack&&input.events[0].type===stage){rolledBack=true;throw new StorageQueryError('Validated transaction rollback');}return f.store.commit(input);}});
 const server=createWorkbench(store,f.root,{connections:f.m,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const post=()=>fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/steering',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({member:quill.id,segment:1,turnId:sent.turn!.id})}).then(async r=>({status:r.status,body:await r.json() as any}));
 const result=await post();if(stage==='confirm-assistant-steer'){assert.equal(result.status,409);assert.equal(result.body.outcome,'rejected');assert.equal((await chat.read()).turns[0]!.steer?.status,'proposed');assert.equal((await post()).body.status,'recorded');}
 else{assert.equal(result.body.status,'not_recorded');assert.equal((await post()).body.status,'not_recorded');assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);assert.equal(running.signal().aborted,false);}
});

for(const uncertain of [false,true])test(`confirmation audit: outcome-record ${uncertain?'uncertainty':'rollback'} preserves the known Work result and correct drain status`,async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),{StorageQueryError}=await import('../src/storage.ts');
 const store=intercepted(f.store,{commit:async(input:any)=>{if(input.events[0].type==='record-assistant-steer')throw uncertain?new CommitOutcomeUnknownError(input,new Error('Lost outcome receipt')):new StorageQueryError('Outcome rolled back');return f.store.commit(input);}}),chat=new AssistantService(store,f.product,f.m,{member:quill});f.script.push(steer('A proposal.',running.work.id));await f.say(chat,'Annual plans');
 assert.equal((await confirmLast(chat)).status,'recorded');assert.equal(running.signal().aborted,true);assert.equal((await f.intake()).works.at(-1)!.instructions!.length,1);
 if(uncertain)await assert.rejects(chat.drain(),/unsettled/);else await chat.drain();
});

test('confirmation audit: a definite revision refusal survives a temporarily unavailable follow-up read',async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t),segment='assistant-conversation:member:'+quill.id+':1';let race=false,failRead=false;
 const store=intercepted(f.store,{readState:async(id?:string)=>{if(failRead&&id===segment){failRead=false;throw new Error('Snapshot temporarily unavailable');}return f.store.readState(id);}});
 const ownerStore=intercepted(f.store,{load:async(id:string)=>{if(race&&id===segment){race=false;f.setNow(Date.now());await f.say(f.chatFor(quill),'Another message');failRead=true;}return f.store.load(id);}}),chat=new AssistantService(store,f.product,f.m,{member:quill,ownerStore});f.script.push(steer('A proposal.',running.work.id));const sent=await f.say(chat,'Annual plans');race=true;
 assert.equal((await chat.confirmSteer({segment:1,turnId:sent.turn!.id})).status,'not_recorded');assert.equal(running.signal().aborted,false);assert.equal((await f.intake()).works.at(-1)!.instructions,undefined);
});

for(const uncertain of [false,true])test(`confirmation audit: a final snapshot read failure preserves ${uncertain?'unknown':'recorded'} instead of rejecting the write`,async t=>{
 const f=await setup(t),quill=await f.admit(),running=await runningWork(f,t);let failRead=false;
 const {StorageQueryError}=await import('../src/storage.ts');
 const store=intercepted(f.store,{commit:async(input:any)=>{if(uncertain&&input.events[0].type==='steer')throw new CommitOutcomeUnknownError(input,new Error('Lost Work receipt'));const result=await f.store.commit(input);if(input.events[0].type==='record-assistant-steer')failRead=true;return result;},readState:async(id?:string)=>{if(failRead&&id?.startsWith('assistant-conversation:member:'))throw new StorageQueryError('Snapshot read refused');return f.store.readState(id);}});
 const chat=new AssistantService(store,f.product,f.m,{member:quill});f.script.push(steer('A proposal.',running.work.id));const sent=await f.say(chat,'Annual plans');
 const server=createWorkbench(store,f.root,{connections:f.m,scheduleIntervalMs:0});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const response=await fetch('http://127.0.0.1:'+(server.address() as {port:number}).port+'/assistant/steering',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({member:quill.id,segment:1,turnId:sent.turn!.id})}),body=await response.json() as any;
 assert.equal(response.status,200);assert.equal(body.status,uncertain?'unknown':'recorded');assert.notEqual(body.outcome,'rejected');assert.equal(running.signal().aborted,!uncertain);
});

test('Q13 member procedure becomes nested workers with retained skips and independent evidence',async t=>{
 const f=await setup(t),member=await f.admit(),skills=new SkillsService(f.store);
 await skills.act({commandId:'procedure',action:'write',memberId:member.id,kind:'procedure',name:'Analysis',body:{description:'Analyze the request',steps:['Read evidence','Optional comparison','Write findings'],verify:'Compare findings with evidence'}});
 f.script.push(v2('On it.','Churn causes','Quill'));await f.say(f.assistant,'Find churn causes');await f.assistant.idle();
 const w=(await f.intake()).works.at(-1)!;
 const steps=w.tasks.filter(task=>(task as any).step);
 assert.equal(steps.length,3,JSON.stringify({blocker:w.blocker,tasks:w.tasks}));
 assert.ok(steps.every(task=>task.parentId===w.id+':executor'));
 assert.equal(steps[1]!.result,'Skipped · No comparison requested');
 assert.ok(steps.every(task=>task.status==='settled'));
 assert.equal(w.acceptance,'accepted',JSON.stringify({tasks:w.tasks,effects:w.effects.map(e=>({id:e.id,status:e.status})),blocker:w.blocker,turn:(await f.assistant.read()).turns.at(-1)}));assert.equal(w.verdict!.check!.producers.length,2);
 assert.ok(w.assignments.filter(a=>steps.some(s=>s.id===a.taskId)).every(a=>a.actorId!==w.assignments.find(a=>a.role==='verifier')!.actorId));
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('Q13 member without a procedure uses the host default, with a fresh team for each Work',async t=>{
 const f=await setup(t);await f.admit();
 for(const title of ['First analysis','Second analysis']){f.script.push(v2('On it.',title,'Quill'));await f.say(f.assistant,title);await f.assistant.idle();}
 const works=(await f.intake()).works.slice(-2);
 for(const w of works){assert.ok(w.tasks.some(task=>(task as any).step),'default workers');assert.equal(w.acceptance,'accepted');}
 assert.ok(works[0]!.tasks.every(task=>!works[1]!.tasks.some(other=>other.id===task.id)));
});


test('Q13 ready workers overlap, dependencies wait, and each provider claim runs once',async t=>{
 const f=await setup(t),member=await f.admit();
 await new SkillsService(f.store).act({commandId:'parallel-procedure',action:'write',memberId:member.id,kind:'procedure',name:'Compare',body:{description:'Compare sources',steps:['Read first','Read second','Compare both'],verify:'Compare result'}});
 f.setPlan(steps=>({steps:steps.map((title,i)=>({title,role:'Research',dependsOn:i===2?[0,1]:[]}))}));
 let release=()=>{},started=()=>{};const gate=new Promise<void>(r=>{release=r;}),both=new Promise<void>(r=>{started=r;});let running=0,seen:string[]=[];
 t.after(async()=>{release();await f.assistant.idle();});
 f.setWorker(async prompt=>{seen.push(prompt.step.title);if(prompt.step.title!=='Compare both'){running++;if(running===2)started();await gate;running--;}else assert.equal(running,0);return 'Answer bounded '+prompt.step.title;});
 f.script.push(v2('On it.','Compare evidence','Quill'));await f.say(f.assistant,'Compare evidence');await both;
 let w=(await f.intake()).works.at(-1)!;assert.equal(w.effects.filter(e=>e.status==='pending').length,2);assert.ok(w.effects.filter(e=>e.status==='pending').every(e=>e.providerDispatch));
 release();await f.assistant.idle();w=(await f.intake()).works.at(-1)!;
 assert.deepEqual(seen,['Read first','Read second','Compare both']);assert.equal(w.acceptance,'accepted');
 assert.equal(new Set(w.effects.map(e=>e.providerDispatch?.id).filter(Boolean)).size,6);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('Q13 invalid plans and unknown worker outcomes never synthesize or check',async t=>{
 for(const invalid of [true,false]){
  const f=await setup(t);await f.admit();
  if(invalid)f.setPlan(()=>({steps:[]}));else f.setWorker(async()=>{throw new Error('lost response');});
  f.script.push(v2('On it.','Analyze evidence','Quill'));await f.say(f.assistant,'Analyze evidence');await f.assistant.idle();
  const w=(await f.intake()).works.at(-1)!;
  assert.equal(w.acceptance,'pending');assert.equal(w.artifact,undefined);assert.equal(w.verdict,undefined);
  assert.ok(invalid?w.blocker?.detail.includes('plan'):w.effects.some(e=>e.status==='unknown'));
  const calls=f.calls.length;await f.product.run('intake',w.id,'second-run',(await f.store.load('intake'))!.revision);assert.equal(f.calls.length,calls);
 }
});
