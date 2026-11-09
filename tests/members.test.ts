import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHostConnections,parseHostManifest} from '../src/host-connections.ts';
import {InMemoryHostSettings,InMemoryStore} from '../src/storage.ts';
import type {Store} from '../src/storage.ts';
import {ProductService} from '../src/product.ts';
import {AssistantService} from '../src/assistant-service.ts';
import {segmentId} from '../src/assistant-conversation.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';
import {DomainError} from '../src/domain.ts';
import type {Actor,Mission} from '../src/domain.ts';
import {TextArtifactStore} from '../src/text-artifacts.ts';
import {createWorkbench} from '../src/server.ts';
import {MEMBERS_ID,MembersService,applyMembers,memberThread,replayMembers} from '../src/members.ts';
import type {MembersCommand,MembersState} from '../src/members.ts';

// docs/architecture/members.md: admission through one decision card, identity in the member, one 1:1 conversation per member. Fixture-class only.
const manifest=parseHostManifest({version:1,revision:'fixture-v1',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['executor','verifier','representative']}]});
const turn=(reply:string,title?:string)=>JSON.stringify({reply,work:title===undefined?null:{title}});
const owner={id:'local-owner',roles:['owner' as const]},host={id:'assistant-representative',roles:['assistant' as const]};
const T0=Date.UTC(2026,10,5,1,0);

async function setup(t:test.TestContext){
 const root=await mkdtemp(join(tmpdir(),'massion-members-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const store=new InMemoryStore<any>(),artifacts=new TextArtifactStore(join(root,'artifacts')),script:string[]=[],prompts:any[]=[];const start=Date.now();let now=start;const clock=()=>now;
 const completion=(model:string,content:string)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
 const transport=async(_url:string|URL|Request,init?:RequestInit)=>{
  const body=JSON.parse(String(init!.body)),prompt=JSON.parse(body.messages[0].content);
  if(Object.hasOwn(prompt,'currentMessage')){prompts.push({model:body.model,prompt});return completion(body.model,script.shift()??turn('Hello.'));}
  if(prompt.artifact)return completion(body.model,JSON.stringify({artifactSha256:prompt.binding.artifactSha256,criteriaVersion:prompt.criteria.version,criteriaHash:prompt.binding.criteriaHash,verdict:'passed',checks:[{criterion:prompt.criteria.description,passed:true,quote:'Answer bounded',reason:'Controlled fixture'}]}));
  return completion(body.model,'Answer bounded fixture text');
 };
 const m=createHostConnections(store,artifacts,{manifest,allowLiveExecution:false},{transport,readEnvironment:()=>'fixture-only-not-a-secret',settings:new InMemoryHostSettings()});
 const profile=(model:string)=>(m.list().runtime.connections as any[]).find(p=>p.model===model).id as string;
 const product=new ProductService(store,undefined,m);
 await product.create({id:'intake',purpose:'Owner requests',scope:'local',constraints:[],criteria:{version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'}},'create-intake');
 await m.save(()=>m.authorize({id:'grant',scope:'local',executorProfileId:profile('executor'),verifierProfileId:profile('verifier'),maxOutputTokensPerCall:4,expectedConfigHash:m.list().configHash}));
 await m.save(()=>m.setDefaultRoute({authorizationId:'grant',outputTokenCap:4,expectedConfigHash:m.list().configHash}));
 const assistant=new AssistantService(store,product,m,{clock});
 await assistant.setSettings({profileId:profile('representative'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:m.list().configHash});
 const members=new MembersService(store,()=>'intake',clock);
 /** Owner message to the head segment of a thread. */
 const say=async(s:AssistantService,text:string)=>{const view=await s.read();const target=!view.segment?{segment:1,expectedRevision:0}:{segment:view.head,expectedRevision:view.segment.revision};return s.send({commandId:randomUUID(),...target,text});};
 /** Two Representative Works run this month, so the producer has something true to count. */
 const works=async()=>{const ids:string[]=[];for(const title of ['Discount totals by weekday','Order discount totals']){script.push(turn('On it.',title));const r=await say(assistant,'Please '+title);await assistant.idle();const found=(await store.load("intake"))!.value.works.find((w:any)=>w.title===title);if(!found)throw new Error(JSON.stringify(r));ids.push(found.id);}return ids;};
 return {root,store,artifacts,m,product,assistant,members,script,prompts,say,works,start,setNow:(v:number)=>{now=v;},profile};
}
const apply=(state:MembersState|null,command:MembersCommand,actor:Actor=owner,at=T0)=>applyMembers(state,command,actor,{observedAt:at}).value;
const proposal=(decisionId='decision:1',topic='Data analysis'):MembersCommand=>({type:'propose-member',decisionId,topic,works:[{title:'Discount totals by weekday'},{title:'Order discount totals'}],count:4});

test('members reducer: only the Representative proposes, one decision is open at a time, Later waits 30 days for the same topic',()=>{
 assert.throws(()=>apply(null,proposal(),owner),/role/i);
 let s=apply(null,proposal(),host);assert.equal(s.id,MEMBERS_ID);assert.deepEqual(s.decisions.map(d=>[d.id,d.state,d.at]),[['decision:1','open',T0]]);
 assert.throws(()=>apply(s,proposal('decision:2','Coding'),host),/open/);
 assert.throws(()=>apply(s,{type:'defer-member',decisionId:'decision:1'},host),/role/i);
 s=apply(s,{type:'defer-member',decisionId:'decision:1'});assert.equal(s.decisions[0]!.state,'later');
 assert.throws(()=>apply(s,proposal('decision:2','data ANALYSIS'),host,T0+29*86400000),/30 days|deferred/);
 s=apply(s,proposal('decision:2','Coding'),host,T0+1000);
 assert.throws(()=>apply(s,{type:'reopen-member',decisionId:'decision:1'}),/open/,'Ask again waits while another decision is open');
 s=apply(s,{type:'defer-member',decisionId:'decision:2'});s=apply(s,{type:'reopen-member',decisionId:'decision:1'});assert.equal(s.decisions[0]!.state,'open');
 s=apply(s,{type:'defer-member',decisionId:'decision:1'},owner,T0+2000);
 assert.throws(()=>apply(s,proposal('decision:3','Data analysis'),host,T0+2000+30*86400000-1),/30 days/);
 assert.equal(apply(s,proposal('decision:3','Data analysis'),host,T0+2000+30*86400000).decisions.at(-1)!.state,'open');
});

test('members reducer: admission needs the owner, an open decision, a unique name and one of eight shapes; identity holds home, skills, procedures and model group',()=>{
 let s=apply(null,proposal(),host);const admit=(over:Record<string,unknown>={})=>({type:'admit-member',decisionId:'decision:1',memberId:'member-a',name:'셈',shape:'drop',...over}) as MembersCommand;
 assert.throws(()=>apply(s,admit(),host),/role/i);
 for(const bad of [{name:''},{name:'a\nb'},{name:'x'.repeat(33)},{name:'하나'},{shape:'star'},{decisionId:'decision:9'}])assert.throws(()=>apply(s,admit(bad)),DomainError,JSON.stringify(bad));
 s=apply(s,admit(),owner,T0+5);
 assert.deepEqual(s.members,[{id:'member-a',name:'셈',look:{shape:'drop',color:'agent-1'},home:'members/member-a',modelGroup:'default',skills:[],procedures:[],decisionId:'decision:1',admittedAt:T0+5}]);
 assert.deepEqual([s.decisions[0]!.state,s.decisions[0]!.memberId],['done','member-a']);
 assert.throws(()=>apply(s,admit()),/open/,'a decided card admits once');
 s=apply(s,proposal('decision:2','Coding'),host);assert.throws(()=>apply(s,admit({decisionId:'decision:2',memberId:'member-b',name:'셈'})),/name/);
 s=apply(s,admit({decisionId:'decision:2',memberId:'member-b',name:'주노',shape:'round'}));assert.equal(s.members[1]!.look.color,'agent-2');
});

test('producer: rows come from Representative Works run this month; the card is the conversation-cards shape; Later, Ask again and Add member answer it',async t=>{
 const f=await setup(t),ids=await f.works();
 await assert.rejects(f.members.propose({topic:'Data analysis',workIds:[ids[0]]}),/two/);
 await assert.rejects(f.members.propose({topic:'Data analysis',workIds:[ids[0],'unknown-work']}),/Work/);
 f.setNow(f.start+40*86400000);await assert.rejects(f.members.propose({topic:'Data analysis',workIds:ids}),/month/);f.setNow(f.start+1000);
 const r=await f.members.propose({topic:'Data analysis',workIds:ids});assert.equal(r.status,'committed');
 const view=await f.members.read();const card=view.decisions[0]!;
 // Rows follow the Work ID order that also keys the proposal.
 const titles=(ids[0]!<ids[1]!?['Discount totals by weekday','Order discount totals']:['Order discount totals','Discount totals by weekday']).join(' · ');
 assert.deepEqual(card,{id:card.id,at:f.start+1000,title:'Data analysis',question:'Data analysis 일이 이번 달 2번 있었어요. 맡을 구성원을 추가할까요?',rows:[['이번 달',titles],['모델 그룹','기본']],action:'Add member',form:'member',state:'open'});
 assert.equal((await f.members.propose({topic:'Data analysis',workIds:ids})).status,'replayed');
 assert.equal((await f.members.propose({topic:'Data analysis',workIds:[...ids].reverse()})).status,'replayed','the same Works in another order are the same proposal');
 await f.members.decide({commandId:'d-1',decisionId:card.id,answer:'later'});assert.equal((await f.members.read()).decisions[0]!.state,'later');
 await f.members.decide({commandId:'d-2',decisionId:card.id,answer:'ask'});assert.equal((await f.members.read()).decisions[0]!.state,'open');
 await assert.rejects(f.members.decide({commandId:'d-3',decisionId:card.id,answer:'act'}),/name/,'no autonomy: act needs a name and a shape');
 const act={commandId:'d-4',decisionId:card.id,answer:'act',member:{name:'셈',shape:'drop'}};
 await f.members.decide(act);assert.equal((await f.members.decide(act)).status,'replayed','a lost answer replays, admitting once');
 const after=await f.members.read();assert.equal(after.decisions[0]!.memberId,after.members[0]!.id);assert.deepEqual(after.members.map(m=>[m.name,m.look.shape]),[['셈','drop']]);assert.deepEqual([after.decisions[0]!.state,after.decisions[0]!.line],['done','구성원 추가됨: 셈']);
});

test('an identical answer racing a committed one replays instead of refusing the answered decision',async t=>{
 const f=await setup(t),ids=await f.works();await f.members.propose({topic:'Data analysis',workIds:ids});
 const card=(await f.members.read()).decisions[0]!,act={commandId:'d-race',decisionId:card.id,answer:'act',member:{name:'셈',shape:'drop'}};
 // The racing request's first lookup sees nothing; the other request commits right after it.
 let raced=false;const store=new Proxy(f.store,{get(target,key){
  if(key==='lookupOperation'&&!raced)return async(identity:any)=>{raced=true;const r=await target.lookupOperation(identity);assert.equal((await f.members.decide(act)).status,'committed');return r;};
  const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 assert.equal((await new MembersService(store,()=>'intake').decide(act)).status,'replayed');
 assert.deepEqual((await f.members.read()).members.map(m=>m.name),['셈'],'admitted once');
});

test('1:1 conversation: one thread per member through its model group, the member named as data, no Work admitted; lineage replays it',async t=>{
 const f=await setup(t),ids=await f.works();await f.members.propose({topic:'Data analysis',workIds:ids});
 await f.members.decide({commandId:'d-1',decisionId:(await f.members.read()).decisions[0]!.id,answer:'act',member:{name:'셈',shape:'drop'}});
 const member=(await f.members.read()).members[0]!;
 const chat=new AssistantService(f.store,f.product,f.m,{member:{id:member.id,name:member.name,modelGroup:member.modelGroup}});
 const before=f.prompts.length,worksBefore=(await f.store.load('intake'))!.value.works.length;
 f.script.push(turn('Sure, weekday totals next.','Weekday totals'));const sent=await f.say(chat,'Use won for amounts from now on.');
 assert.equal(sent.turn?.status,'answered');assert.equal(sent.turn?.reply,'Sure, weekday totals next.');assert.equal(sent.turn?.outcome,undefined,'a member reply admits no Work');
 assert.equal((await f.store.load('intake'))!.value.works.length,worksBefore);
 const prompt=f.prompts[before]!;assert.deepEqual(prompt.prompt.member,{name:'셈'});assert.doesNotMatch(prompt.prompt.instruction,/셈/);
 const id=segmentId(1,memberThread(member.id));assert.equal(id,'assistant-conversation:member:'+member.id+':1');assert.ok(await f.store.load(id));
 const read=await chat.read();assert.equal(read.segment?.messages.length,2);
 const main=await f.assistant.read();assert.ok(!main.segment?.messages.some(m=>m.text==='Use won for amounts from now on.'),'the Representative thread is separate');
 validateMissionJournalLineage(f.store.inspect() as any);
});

test('lineage: a proposal must carry the host command ID and its derived decision ID; an admission its derived member ID',async t=>{
 const f=await setup(t),ids=await f.works();await f.members.propose({topic:'Data analysis',workIds:ids});
 await f.members.decide({commandId:'d-1',decisionId:(await f.members.read()).decisions[0]!.id,answer:'act',member:{name:'셈',shape:'drop'}});
 const [proposed,admitted]=f.store.inspect().filter(o=>o.aggregateId===MEMBERS_ID) as any[];
 assert.match(proposed.commandId,/^assistant-member-proposal:/);replayMembers(proposed,undefined);replayMembers(admitted,proposed);
 assert.throws(()=>replayMembers({...proposed,commandId:'p-1'},undefined),/identity/,'a caller-chosen proposal ID is not the host\'s');
 assert.throws(()=>replayMembers({...admitted,commandId:'d-2'},proposed),/identity/,'the member ID follows from the answer\'s command ID');
 assert.throws(()=>replayMembers({...admitted,commandId:'assistant-member-proposal:x'},proposed),/identity/);
});

test('HTTP: decisions, proposals and member threads take exact fields; the conversation read lists members and decisions',async t=>{
 const f=await setup(t),ids=await f.works();
 const server=createWorkbench(f.store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:50});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port,url=(p:string)=>`http://127.0.0.1:${port}${p}`;
 const post=(path:string,body:unknown)=>fetch(url(path),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await post('/members/proposals',{topic:'Data analysis',workIds:ids})).status,404,'only the host proposes; no caller can write a Representative proposal');
 await f.members.propose({topic:'Data analysis',workIds:ids});
 let view=await fetch(url('/assistant/conversation')).then(r=>r.json()) as any;assert.equal(view.decisions.length,1);assert.deepEqual(view.members,[]);
 const decisionId=view.decisions[0].id;
 assert.equal((await post('/assistant/decisions',{commandId:'d-1',decisionId,answer:'maybe'})).status,400);
 assert.equal((await post('/assistant/decisions',{commandId:'d-1',decisionId,answer:'act',member:{name:'셈',shape:'drop',color:'agent-7'}})).status,400,'the owner sets a name and a shape only');
 assert.equal((await post('/assistant/decisions',{commandId:'d-1',decisionId,answer:'act',member:{name:'셈',shape:'drop'}})).status,200);
 view=await fetch(url('/assistant/conversation')).then(r=>r.json()) as any;assert.deepEqual(view.members.map((m:any)=>[m.name,m.look.shape]),[['셈','drop']]);const memberId=view.members[0].id;
 const beforeGreeting=f.store.inspect().length,beforeCalls=f.prompts.length;
 const greeting=await fetch(url('/assistant/conversation?member='+memberId)).then(r=>r.json()) as any;
 assert.match(greeting.greeting.text,/안녕하세요, 셈이에요/);assert.equal(greeting.greeting.id,'greeting:'+memberId);assert.equal(greeting.segment,null);
 const reread=await fetch(url('/assistant/conversation?member='+memberId)).then(r=>r.json()) as any;
 assert.deepEqual(reread.greeting,greeting.greeting);assert.equal(f.store.inspect().length,beforeGreeting);assert.equal(f.prompts.length,beforeCalls,'the admission introduction is not a provider call');
 assert.equal((await fetch(url('/assistant/conversation?member=nobody'))).status,404);
 assert.equal((await post('/assistant/messages',{commandId:'m-1',segment:1,expectedRevision:0,text:'Hi',member:'nobody'})).status,404);
 const sent=await post('/assistant/messages',{commandId:'m-1',segment:1,expectedRevision:0,text:'Hi',member:memberId});assert.equal(sent.status,200);
 const csp=(await fetch(url('/'))).headers.get('content-security-policy')!;assert.match(csp,/img-src [^;]*data:/,'the avatar shape masks are data: images the page policy must allow');
 const thread=await fetch(url('/assistant/conversation?member='+memberId)).then(r=>r.json()) as any;
 assert.deepEqual(thread.member,{id:memberId,name:'셈'});assert.equal(thread.segment.messages[0].text,'Hi');assert.deepEqual(thread.decisions,[],'admission decisions live in the Representative conversation; a member thread carries only its skill decisions');
});

test('HTTP: an owner decision resuming after drain starts is refused and admits nobody',async t=>{
 const f=await setup(t),ids=await f.works();await f.members.propose({topic:'Data analysis',workIds:ids});const decisionId=(await f.members.read()).decisions[0]!.id;
 let hold=false,held=()=>{},release=()=>{};const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===MEMBERS_ID){hold=false;held();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:3000});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port;hold=true;
 const response=fetch(`http://127.0.0.1:${port}/assistant/decisions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'d-drain',decisionId,answer:'act',member:{name:'셈',shape:'drop'}})});
 await reached;const drain=server.drain();release();
 assert.equal((await response).status,503);await drain;assert.deepEqual((await f.members.read()).members,[]);
});

test('HTTP: a first member message resuming after drain starts is refused and stores nothing',async t=>{
 const f=await setup(t),ids=await f.works();await f.members.propose({topic:'Data analysis',workIds:ids});
 await f.members.decide({commandId:'d-1',decisionId:(await f.members.read()).decisions[0]!.id,answer:'act',member:{name:'셈',shape:'drop'}});const memberId=(await f.members.read()).members[0]!.id;
 let hold=false,held=()=>{},release=()=>{};const reached=new Promise<void>(r=>{held=r;}),gate=new Promise<void>(r=>{release=r;});
 const store=new Proxy(f.store,{get(target,key){if(key==='load')return async(id:string)=>{if(hold&&id===MEMBERS_ID){hold=false;held();await gate;}return target.load(id);};const v=Reflect.get(target,key);return typeof v==='function'?v.bind(target):v;}});
 const server=createWorkbench(store as Store<Mission>,f.root,{connections:f.m,artifacts:f.artifacts,drainTimeoutMs:3000});await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));t.after(()=>server.close());
 const port=(server.address() as {port:number}).port;hold=true;const before=f.store.inspect().length;
 const response=fetch(`http://127.0.0.1:${port}/assistant/messages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({commandId:'m-drain',segment:1,expectedRevision:0,text:'Hi',member:memberId})});
 await reached;const drain=server.drain();release();
 assert.equal((await response).status,503);assert.equal((await drain).status,'drained');assert.equal(f.store.inspect().length,before,'no owner message was committed');
});
