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
import {HostDrainError} from '../src/runtime-lifetime.ts';

// docs/architecture/member-work.md: the Representative hands Work to a member, the member's group runs it, the 1:1 conversation steers it, the host lists Works with their end time. Fixture-class only.
const MODELS=['openai/gpt-rep','openai/gpt-exec','anthropic/claude-check','google/gemini-a','anthropic/claude-b'];
const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'openrouter',baseUrl:'http://127.0.0.1:9999/v1/',models:MODELS}]});
const v1=(reply:string,title?:string)=>JSON.stringify({reply,work:title===undefined?null:{title}});
const v2=(reply:string,title:string,member:string|null)=>JSON.stringify({reply,work:{title,member}});
const steer=(reply:string,workId:string|null)=>JSON.stringify({reply,work:null,steer:workId});

async function setup(t:test.TestContext,providerType='openrouter'){
 const root=await mkdtemp(join(tmpdir(),'massion-member-work-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore(join(root,'artifacts')),script:string[]=[],prompts:any[]=[],calls:string[]=[];let now=Date.now();const start=now,clock=()=>now;let onExecute:((signal:AbortSignal)=>Promise<void>)|undefined;
 const completion=(model:string,content:string)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);
  if(Object.hasOwn(prompt,'currentMessage')){prompts.push({model:body.model,prompt});return completion(body.model,script.shift()??v1('Hello.'));}
  calls.push(body.model);
  if(prompt.artifact)return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Answer bounded',reason:'Controlled fixture'}]}));
  if(onExecute)await onExecute(init!.signal as AbortSignal);
  return completion(body.model,'Answer bounded fixture text');
 };
 const m=createHostConnections(store,artifacts,{manifest:providerType==='openrouter'?manifest:parseHostManifest({...manifest,connections:manifest.connections.map(c=>({...c,providerType}))}),allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings:new InMemoryHostSettings()});
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
 return {root,store,artifacts,m,product,assistant,members,script,prompts,calls,say,intake,admit,chatFor,grant,profile,setNow:(v:number)=>{now=v;},setExecutionHook:(hook:(signal:AbortSignal)=>Promise<void>)=>{onExecute=hook;},start};
}

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
 assert.deepEqual(f.calls.slice(calls),['google/gemini-a','anthropic/claude-b']);
 assert.equal(work.verdict?.check?.relation,'different-family');assert.deepEqual(work.verdict?.check?.producers.map(p=>p.model),['google/gemini-a','openai/gpt-rep']);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('with no different family in the group the checker comes from another group',async t=>{
 const f=await setup(t),quill=await f.admit();
 await f.m.save(()=>f.m.saveModelGroup({id:'solo',name:'Solo',description:'One model.',profileIds:[f.profile('google/gemini-a')],expectedConfigHash:f.m.list().configHash}));
 await f.members.setGroup({commandId:'g-1',memberId:quill.id,modelGroup:'solo'},f.m);
 await f.grant('grant-solo','google/gemini-a','anthropic/claude-check');const calls=f.calls.length;
 f.script.push(v2('Quill will take it.','Price table','Quill'));await f.say(f.assistant,'Build the price table');await f.assistant.idle();
 assert.deepEqual(f.calls.slice(calls),['google/gemini-a','anthropic/claude-check']);
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
 // Hold the run so the Work stays open while the owner talks to Quill.
 f.script.push(v2('Quill will take it.','Churn causes','Quill'));
 const admitted=new AssistantService(f.store,f.product,f.m,{clock:()=>Date.now(),members:async()=>(await f.members.read()).members});
 const product=f.product as any,run=product.run.bind(product);let releaseRun=()=>{};const gate=new Promise<void>(r=>{releaseRun=r;});product.run=async(...args:any[])=>{await gate;return run(...args);};
 await f.say(admitted,'Find churn causes');const work=(await f.intake()).works.find(w=>w.title==='Churn causes')!;
 const chat=f.chatFor(quill),text='Only annual plan customers for the churn work.',commandId='m-steer';
 f.script.push(steer('Annual plans only, then.',work.id));
 const [a,b]=await Promise.all([f.say(chat,text,commandId),f.say(chat,text,commandId)]);
 const prompt=f.prompts.at(-1)!.prompt;assert.deepEqual(prompt.works,[{id:work.id,title:'Churn causes'}]);assert.deepEqual(prompt.member,{name:'Quill'});
 assert.equal(f.prompts.filter(p=>p.prompt.currentMessage===text).length,1,'one model call for the same command');
 assert.deepEqual([a.message.status,b.message.status].sort(),['committed','replayed']);
 const after=(await f.intake()).works.find(w=>w.id===work.id)!;assert.deepEqual(after.instructions,[{actorId:'local-owner',text}]);assert.equal(after.execution,work.blocker?'blocked':'waiting','steering preserves an existing runtime blocker');
 const read=await chat.read();assert.deepEqual(read.turns[0]!.steer,{missionId:'intake',workId:work.id,status:'recorded',title:'Churn causes'});
 // A Work not in this member's list is never steered.
 f.script.push(steer('Sure.','assistant-000000000000000000000000'));const other=await f.say(chat,'And the other thing.');
 assert.equal((await chat.read()).turns.find(x=>x.id===other.turn!.id)!.steer,undefined);
 assert.equal((await f.intake()).works.find(w=>w.id===work.id)!.instructions!.length,1);
 releaseRun();await admitted.idle();validateMissionJournalLineage(f.store.inspect() as any);
});

test('a steer resuming after drain starts goes through the owner store, is refused and settles not recorded; nothing is resent',async t=>{
 const f=await setup(t),quill=await f.admit();
 f.script.push(v2('Quill will take it.','Churn causes','Quill'));
 const product=f.product as any,run=product.run.bind(product);let releaseRun=()=>{};const gate=new Promise<void>(r=>{releaseRun=r;});product.run=async(...args:any[])=>{await gate;return run(...args);};
 const admitted=new AssistantService(f.store,f.product,f.m,{members:async()=>(await f.members.read()).members});await f.say(admitted,'Find churn causes');
 const work=(await f.intake()).works.find(w=>w.title==='Churn causes')!;
 let draining=false;const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return (input:any)=>{if(draining)throw new HostDrainError();return target.commit(input);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Annual plans only.',work.id));
 const transportCalls=f.prompts.length;
 // Drain starts after the model answered, before the steer commits.
 const intakeLoad=f.store.load.bind(f.store);let armed=true;(f.store as any).load=async(id:string)=>{if(armed&&id==='intake'&&f.prompts.length>transportCalls){armed=false;draining=true;}return intakeLoad(id);};
 const sent=await f.say(chat,'Only annual plan customers.');(f.store as any).load=intakeLoad;
 assert.equal(sent.turn?.status,'answered');
 assert.equal((await chat.read()).turns[0]!.steer?.status,'not_recorded');assert.equal((await f.intake()).works.find(w=>w.id===work.id)!.instructions,undefined);
 releaseRun();await admitted.idle();
});

test('Work end time: cancel and block record host time; a journal without it still replays',()=>{
 const owner={id:'owner',roles:['owner' as const]};let mission=createMission({id:'m',purpose:'p',scope:'s',constraints:[],criteria:{version:1,description:'d',oracle:'bounded-text-review/v1'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'w',title:'T',budget:10},owner).value;
 const cancelled=apply(mission,{type:'cancel',workId:'w'},owner,{observedAt:1234});assert.equal(cancelled.value.works[0]!.endedAt,1234);assert.deepEqual((cancelled.events[0] as any).time,{observedAt:1234});
 const blocked=apply(mission,{type:'block-work',workId:'w',blocker:{code:'runtime_unavailable',detail:'Stopped'}},owner,{observedAt:2345});assert.equal(blocked.value.works[0]!.endedAt,2345);
 assert.equal(apply(mission,{type:'cancel',workId:'w'},owner).value.works[0]!.endedAt,undefined,'an earlier journal without time replays');
 assert.throws(()=>apply(mission,{type:'steer',workId:'w',instruction:'x'},owner,{observedAt:1}),/clock/,'only ending commands take a time');
});

test('the admission card names the Work to hand when the proposal carries it',async t=>{
 const f=await setup(t);const ids:string[]=[];for(const title of ['Discount totals by weekday','Order discount totals']){f.script.push(v1('On it.',title));await f.say(f.assistant,'Please '+title);await f.assistant.idle();ids.push((await f.intake()).works.find(w=>w.title===title)!.id);}
 await assert.rejects(f.members.propose({topic:'Data analysis',workIds:ids,handoff:'a\nb'}),/handoff|fields/i);
 await f.members.propose({topic:'Data analysis',workIds:ids,handoff:'Table totals · total check'});
 assert.deepEqual((await f.members.read()).decisions[0]!.rows.map(r=>r[0]),['This month','Work to hand','Model group']);
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
 const w=(await f.intake()).works.at(-1)!;assert.equal(w.acceptance,'accepted');assert.equal(w.verdict?.check?.relation,'same-family');
 assert.deepEqual(f.calls.slice(before),['google/gemini-a','google/gemini-a']);assert.notEqual(w.assignments.find(a=>a.role==='executor')!.actorId,w.assignments.find(a=>a.role==='verifier')!.actorId);
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('an ambiguous steering commit is not resent even when the same owner message returns',async t=>{
 const f=await setup(t),quill=await f.admit();
 const product=f.product as any,run=product.run.bind(product);let release=()=>{};const gate=new Promise<void>(r=>{release=r;});product.run=async(...args:any[])=>{await gate;return run(...args);};t.after(async()=>{release();await f.assistant.idle();});
 f.script.push(v2('On it.','Churn causes','Quill'));await f.say(f.assistant,'Find churn causes');const work=(await f.intake()).works.at(-1)!;
 let commits=0;const ownerStore=new Proxy(f.store,{get(target,key){if(key==='commit')return async(input:any)=>{commits++;await target.commit(input);throw new CommitOutcomeUnknownError(input,new Error('Lost reply'));};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const chat=f.chatFor(quill,ownerStore);f.script.push(steer('Annual plans only.',work.id));await f.say(chat,'Annual plans only.','ambiguous-steer');await f.say(chat,'Annual plans only.','ambiguous-steer');
 assert.equal(commits,1);assert.equal((await chat.read()).turns[0]!.steer?.status,'not_recorded');assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'Annual plans only.'}]);
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
 const work=(await f.intake()).works.at(-1)!;f.script.push(steer('Annual plans only.',work.id));await f.say(f.chatFor(quill),'Annual plans only.');
 assert.equal(signal?.aborted,true,'the stored steer must interrupt the already running call');
 assert.deepEqual((await f.intake()).works.at(-1)!.instructions,[{actorId:'local-owner',text:'Annual plans only.'}]);
});
