import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {Application} from '../../src/application.ts';
import {ConfiguredTextRuntime} from '../../src/configured-runtime.ts';
import {EnvironmentWorkService} from '../../src/environment-work-service.ts';
import {SecretRequestsService} from '../../src/secret-requests-service.ts';
import {InMemorySecretSlots} from '../../src/secret-slots.ts';
import {InMemoryStore} from '../../src/storage.ts';
import type {Snapshot,Operation} from '../../src/storage.ts';
import {hash} from '../../src/domain.ts';
import type {Actor,Mission} from '../../src/domain.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId,assistantWorkId,assistantRunId} from '../../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../../src/members.ts';
import {SKILLS_ID,applySkills} from '../../src/skills.ts';
import {memberProcedures} from '../../src/internal-teams.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {readRecordArtifact} from '../../src/record-artifact.ts';
import {readRuntimeOwnership} from '../../src/runtime-lifetime.ts';
import {readWorkConversation} from '../../src/work-conversation.ts';
import {BrowserSessions} from '../../src/browser-runtime.ts';
import {AssistantService} from '../../src/assistant-service.ts';
import {ProductService} from '../../src/product.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {EnvironmentWorkDefinition,EnvironmentWorkPlan} from '../../src/environment-work.ts';
import {fixtureOptions} from '../../tests/support/steering-resume-fixture.ts';
import {nativeEnvironmentFixture,nativeForm} from './native-environment-fixture.ts';
import type {ScreenFixture} from './fixture-host.ts';

const owner:Actor={id:'local-owner',roles:['owner']},assistant:Actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']};
const generated=new URL('./environment-work.generated.json',import.meta.url);
export const ENVIRONMENT_WORK_SCREENS=['B4','B15','B7','B8','B7-done','B8-done'];
interface Checkpoint {now:number;snapshot:Snapshot<Mission>;chat:Awaited<ReturnType<AssistantService['read']>>;members:Awaited<ReturnType<MembersService['read']>>;decisions:Awaited<ReturnType<EnvironmentWorkService['decisions']>>;browser:Awaited<ReturnType<BrowserSessions['read']>>;ownership:Awaited<ReturnType<typeof readRuntimeOwnership>>;conversation:Awaited<ReturnType<typeof readWorkConversation>>;artifact:Awaited<ReturnType<typeof readRecordArtifact>>;journal?:readonly Operation<any>[]}
export interface EnvironmentWorkFixtureData {origin:string;memberId:string;workId:string;turnId:string;checkpoints:Record<string,Checkpoint>;submissions:number;paymentCalls:number;filled:boolean;textDidNotConfirm:boolean;wrongHashRejected:boolean;form?:EnvironmentWorkFixtureData}

export async function produceEnvironmentWork(root:string):Promise<EnvironmentWorkFixtureData>{
 const OriginalDate=globalThis.Date,epoch=JSON.parse(await readFile(new URL('./fixtures/B7.json',import.meta.url),'utf8')).now,offset=epoch-OriginalDate.now();
 globalThis.Date=class extends OriginalDate {constructor(value?:string|number){super(value===undefined?OriginalDate.now()+offset:value);}static now(){return OriginalDate.now()+offset;}} as DateConstructor;
 try{const order=await produceMemberWork(join(root,'order'),'order');order.form=await produceMemberWork(join(root,'form'),'form');return order;}finally{globalThis.Date=OriginalDate;}
}
async function produceMemberWork(root:string,kind:'order'|'form'):Promise<EnvironmentWorkFixtureData>{
 const native=await nativeEnvironmentFixture(root),store=new InMemoryStore<any>(),members=new MembersService(store,()=>'intake'),slots=new InMemorySecretSlots(),secrets=new SecretRequestsService(store,slots);
 const title=kind==='order'?'프린터 토너 주문':'스터디룸 신청',commandId='fixture-admit-member-quill',memberId=admittedMemberId(commandId),messageCommand='fixture-environment-message-'+kind,messageId=ownerMessageId(messageCommand),turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),checkpoints:Record<string,Checkpoint>={};
 const definition:EnvironmentWorkDefinition={memberId,origin:native.origin,elements:[
  {id:'field',selector:'#field',role:'textbox',label:'비공개 입력',operations:['type'],gates:[]},
  {id:'quantity',selector:'#quantity',role:'combobox',label:'수량',operations:['select'],gates:[]},
  {id:'scroll',selector:'#scroll',role:'region',label:'신청 자료',operations:['scroll'],gates:[]},
  {id:'terms',selector:'#terms',role:'checkbox',label:'약관 확인',operations:['click'],gates:[{kind:'terms-acceptance'}]},
  {id:'submit',selector:'#submit',role:'button',label:'신청서 제출',operations:['submit'],gates:[{kind:'personal-data-submission'},{kind:'account-creation'},{kind:'irreversible-submit'}]},
  {id:'device',selector:'#device',role:'checkbox',label:'기기 확인',operations:['click'],gates:[],ownerOnly:true},
  {id:'payment',selector:'#pay',role:'button',label:'결제 의도 승인',operations:['click'],gates:[{kind:'payment',intent:{kind:'payment-intent',payee:'로컬 공급처',amountMinor:34000,currency:'KRW',purpose:title,sourceReference:'work:'+workId}}]},
 ],facts:[
  {id:'filled',selector:'#field',state:'value-present',label:'신청 정보 입력',kind:'state'},
  {id:'deviceConfirmed',selector:'#device',state:'checked',label:'기기 확인',kind:'state'},
  {id:'orderConfirmed',selector:'#order-confirmation',state:'present',label:'주문 확인',kind:'order-confirmation'},
 ],waits:[{id:'device',request:{kind:'confirm-on-device',who:'소유자',what:'기기에서 확인',where:'로컬 신청 페이지',fact:'deviceConfirmed',from:false,to:true,timeoutMs:60000,maxPolls:50,intervalMs:1000}}],secrets:[{id:'form',label:'신청 정보',purpose:'로컬 신청서 입력',fields:[{slot:'form-value',label:'신청 정보',kind:'id',element:'field'}]}]};
 const service=new EnvironmentWorkService(store,store,{definitions:[definition],secrets,intake:()=>'intake'}),pages=new BrowserSessions(store,store),app=new Application(store,[owner,assistant]),artifacts=new TextArtifactStore(join(root,'artifacts')),reader=new AssistantService(store,new ProductService(store));
 const read=async()=>(await store.load('intake')) as Snapshot<Mission>,work=async()=>(await read()).value.works[0]!;
 const capture=async(name:string)=>{
  const journal=store.inspect();try{validateMissionJournalLineage(journal);}catch(error){failure=error;throw error;}
  const w=await work(),record=w.record;
  checkpoints[name]={now:Date.now(),snapshot:await read(),chat:await reader.read(),members:await members.read(),decisions:await service.decisions(),browser:await pages.read('intake',workId),ownership:await readRuntimeOwnership(store,'intake',workId,undefined,run=>runtime?.owns('intake',workId,run)??false),conversation:await readWorkConversation(store,'intake',workId),artifact:record?await readRecordArtifact(store,artifacts,'intake',workId,{recordId:record.id,artifactVersion:record.artifact.version,artifactSha256:record.artifact.sha256}):null,journal};
 };
 const observe:EnvironmentWorkPlan['operations'][number]={kind:'observe',facts:[]},filled:EnvironmentWorkPlan['operations'][number]={kind:'observe',facts:['filled']};
 const plans:EnvironmentWorkPlan[]=[
  {format:'massion-environment/v1',operations:[observe]},
  {format:'massion-environment/v1',operations:[{kind:'act',element:'field',input:{kind:'type',secret:{owner:'local-owner',slot:'form-value'}}},{kind:'act',element:'quantity',input:{kind:'select',option:'two'}},{kind:'act',element:'scroll',input:{kind:'scroll',x:0,y:200}},{kind:'act',element:'terms',input:{kind:'click'}},filled,{kind:'act',element:'submit',input:{kind:'submit'}},observe]},
  {format:'massion-environment/v1',operations:[{kind:'wait',id:'device'},{kind:'observe',facts:['deviceConfirmed']}]},
  {format:'massion-environment/v1',operations:[{kind:'act',element:'payment',input:{kind:'click'}},observe]},
  {format:'massion-environment/v1',operations:[{kind:'observe',facts:['orderConfirmed']}]},
 ];
 let runtime:ConfiguredTextRuntime|undefined,running:Promise<unknown>|undefined,finished=false,failure:unknown,textDidNotConfirm=false,wrongHashRejected=false;
 try{
  const proposalId=PROPOSAL_PREFIX+hash('environment-member'),proposal={type:'propose-member' as const,decisionId:proposalDecisionId(proposalId),topic:'퀼',works:[{title:'프린터 토너 주문'},{title:'스터디룸 신청'}],count:2},proposed=applyMembers(null,proposal,assistant,{observedAt:Date.now()});
  assert.equal((await store.commit({id:MEMBERS_ID,expectedRevision:0,commandId:proposalId,fingerprint:hash({actorId:assistant.id,command:proposal}),...proposed,outbox:[]})).status,'committed');
  assert.equal((await members.decide({commandId,decisionId:proposal.decisionId,answer:'act',member:{name:'퀼',shape:'square'}})).status,'committed');
  const memberSnapshot=await store.load(MEMBERS_ID),group={type:'set-member-group' as const,memberId,modelGroup:'research'},grouped=applyMembers(memberSnapshot!.value,group,owner,{observedAt:Date.now()});
  assert.equal((await store.commit({id:MEMBERS_ID,expectedRevision:memberSnapshot!.revision,commandId:'fixture-environment-member-group',fingerprint:hash({actorId:owner.id,command:group}),...grouped,outbox:[]})).status,'committed');
  const skill={type:'write-skill' as const,memberId,kind:'procedure' as const,name:'신청과 주문 확인',body:{description:'로컬 신청과 확인',steps:['자료 읽기','신청서 입력과 제출',...(kind==='order'?['기기 확인','결제 의도 확인','주문 확인']:[])],verify:'관찰된 결과 확인'}},written=applySkills(null,skill,owner,{observedAt:Date.now()});
  assert.equal((await store.commit({id:SKILLS_ID,expectedRevision:0,commandId:'fixture-environment-procedure',fingerprint:hash({actorId:owner.id,command:skill}),...written,outbox:[]})).status,'committed');
  await app.create({id:'intake',purpose:'맡긴 일',scope:'local',constraints:[],criteria:{version:1,description:'선언된 상태 관찰',oracle:'bounded-text-review/v1'}},owner.id,'fixture-environment-create');
  const chat=new AssistantConversation(store,[owner,assistant]),startedAt=Date.now(),opened=await chat.dispatch({segment:1,commandId:messageCommand,expectedRevision:0,actorId:owner.id,command:{type:'open-assistant-segment',segment:1,previous:null,messageId,text:kind==='order'?'로컬 신청서를 제출하고 기기 확인 후 주문 확인을 관찰해 줘.':'로컬 스터디룸 신청서를 입력하고 제출해 줘.',recordMessageTime:true,turn:{id:turnId,status:'pending',route:{profileId:'fixture-profile',configHash:hash('fixture'),provider:'fixture',model:'producer',mode:'mock-http',outputTokenCap:64},ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-message',startedAt,deadlineAt:startedAt+120000},requestHash:hash('fixture-environment-message'),contextMessageIds:[]}}});
  assert.notEqual(opened.status,'conflict');
  const settled=await chat.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:opened.revision,actorId:assistant.id,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Synthetic member Work proposal',reply:'퀼에게 맡길게요.',proposal:{title,member:'퀼'},recordMessageTime:true}});
  assert.ok(settled.status!=='conflict');const message=settled.value.messages.find(m=>m.id===messageId)!;
  await app.dispatch({missionId:'intake',commandId:'assistant-work:'+turnId,expectedRevision:1,actorId:assistant.id,command:{type:'admit-work',workId,title,budget:300,team:memberProcedures(written.value,memberId,1),assistantSource:{segmentId:'assistant-conversation:1',turnId,messageId,messageHash:hash(message),message,representative:{provider:'fixture',model:'producer'},memberId}}});
  await chat.dispatch({segment:1,commandId:'assistant-outcome:'+turnId,expectedRevision:settled.revision,actorId:assistant.id,command:{type:'record-assistant-outcome',turnId,missionId:'intake',work:{status:'admitted',diagnostics:[]},run:{status:'requested',diagnostics:[]}}});
  validateMissionJournalLineage(store.inspect());
  const calls:{id:string;prompt:any}[]=[],options=fixtureOptions(artifacts,calls),invoke=options.executor.adapter.invoke.bind(options.executor.adapter);
  options.environment=service;options.runTimeoutMs=150000;options.authorization={...options.authorization!,scope:'local'};
  const resultText=kind==='order'?'주문 확인 관찰':'신청서 제출 확인',quote=kind==='order'?'주문 확인':'신청서 제출';
  options.executor.adapter={...options.executor.adapter,async invoke(request){
   const outcome=await invoke(request),p=JSON.parse(request.instruction);
   if(p.teamPlanning)return {...outcome,status:'completed' as const,reason:'통제된 단계 계획',output:JSON.stringify({steps:p.teamPlanning.steps.map((title:string,index:number)=>({title,role:title,dependsOn:index?[index-1]:[]}))})};
   if(p.step){
    const index=Number(request.invocationId.split(':').at(-1));
    if(index===1){await capture('read');assert.equal(await native.owner('document.body.dataset.scriptRan===undefined'),true);await native.owner('document.getElementById("form-host").innerHTML='+JSON.stringify(nativeForm));}
    if(index===2)await capture('submitted');
    if(index===4){await capture('approved');assert.ok((await work()).tasks.flatMap(t=>t.environment?.records??[]).some(r=>r.kind==='intent-approved'));await native.owner('document.body.insertAdjacentHTML("beforeend","<p id=order-confirmation>로컬 주문 확인</p>")');}
    return {...outcome,status:'completed' as const,reason:'선언된 환경 단계',output:JSON.stringify(plans[index])};
   }
   return {...outcome,status:'completed' as const,reason:'통제된 예시',output:p.roomTurn?JSON.stringify({kind:p.roomTurn==='challenge'?'challenge':'concede',text:'관찰 근거 확인',quote:p.roomTurn==='challenge'?quote:''}):resultText};
  }};
  const verify=options.verifier.adapter.invoke.bind(options.verifier.adapter);options.verifier.adapter={...options.verifier.adapter,async invoke(request){const outcome=await verify(request),p=JSON.parse(request.instruction);return {...outcome,status:'completed' as const,reason:'통제된 독립 확인',output:JSON.stringify({artifactSha256:p.artifact.sha256,criteriaHash:p.binding.criteriaHash,criteriaVersion:1,verdict:'passed',checks:[{criterion:p.criteria.description,passed:true,quote,reason:'선언된 관찰 근거와 일치'}]})};}};
  runtime=new ConfiguredTextRuntime(store,options);running=runtime.run('intake',workId,assistantRunId(turnId),2,undefined,assistant.id).then(async result=>{if(result.status!=='settled'&&!failure)failure=Error('Synthetic runtime did not settle: '+JSON.stringify({status:result.status,effects:(await work()).effects.filter(e=>e.status!=='succeeded').map(e=>({id:e.id,status:e.status,receipt:e.receipt}))}));finished=true;},error=>{failure??=error;finished=true;});
  const answered=new Set<string>(),deadline=AbortSignal.timeout(155000);
  while(!finished){
   deadline.throwIfAborted();const current=await work(),request=current.secretRequests?.find(r=>r.state==='open');
   if(request&&!answered.has(request.id)){
    answered.add(request.id);await capture('secret');assert.equal((await secrets.answer({commandId:'fixture-provide-form',missionId:'intake',workId,expectedRevision:(await read()).revision,requestId:request.id,requestHash:request.requestHash,answer:'provide',selections:[{slot:'form-value',source:{kind:'own'}}],values:{'form-value':'SYNTHETIC-PRIVATE-FIELD'}})).status,'provided');
   }
   const decision=(await service.decisions()).find(d=>d.state==='open');
   if(decision&&!answered.has(decision.id)){
    const pending=(await work()).tasks.find(t=>t.id===decision.environment.taskId)?.environment,operation=pending?.plan.operations[pending.cursor];
    assert.ok(operation&&operation.kind!=='observe');
    answered.add(decision.id);const name=operation.kind==='wait'?'device':operation.element;await capture(name);
    if(name==='device'){
     await assert.rejects(service.decide({commandId:'fixture-invalid-device-answer',decisionId:decision.id,requestHash:decision.environment.requestHash,answer:'act'}));
     await native.owner('document.getElementById("owner-text").textContent="confirmed done success"');await delay(1200);
     textDidNotConfirm=(await service.decisions()).some(d=>d.id===decision.id&&d.state==='open');assert.equal(textDidNotConfirm,true);
     await native.owner('document.getElementById("device").checked=true');
    }else{
     if(name==='submit'){await assert.rejects(service.decide({commandId:'fixture-wrong-hash',decisionId:decision.id,requestHash:hash('wrong'),answer:'act'}));wrongHashRejected=true;}
     const answer={commandId:'fixture-answer-'+hash(decision.id).slice(0,32),decisionId:decision.id,requestHash:decision.environment.requestHash,answer:'act'};
     await service.decide(answer);await service.decide(answer);
    }
   }
   await delay(20);
  }
  await running;if(failure)throw failure;await capture('accepted');
  return {origin:native.origin,memberId,workId,turnId,checkpoints,...native.counts(),textDidNotConfirm,wrongHashRejected};
 }finally{runtime?.beginDrain();service.beginDrain();try{await running;await service.drain();await pages.drain();await secrets.drain();}finally{await native.close();}}
}

export async function saveEnvironmentWorkFixtures(data:EnvironmentWorkFixtureData){
 const saved=structuredClone(data);for(const checkpoint of Object.values(saved.checkpoints))delete checkpoint.journal;
 if(saved.form)for(const checkpoint of Object.values(saved.form.checkpoints))delete checkpoint.journal;
 await writeFile(generated,JSON.stringify(saved)+'\n');
}

export function environmentWorkFixture(template:ScreenFixture,data:EnvironmentWorkFixtureData):ScreenFixture{
 if(template.screen==='B15'&&data.form)data=data.form;
 const name=template.screen==='B4'?'payment':template.screen==='B15'?'submit':template.screen.endsWith('-done')?'accepted':'submitted',checkpoint=data.checkpoints[name]!,{workId,turnId,memberId}=data,member=checkpoint.members.members.find(m=>m.id===memberId)!;
 const originalRoster=(template.routes['/assistant/conversation']!.body as any).members,previousMember=originalRoster.find((m:any)=>m.name===member.name);
 const fixture=previousMember?JSON.parse(JSON.stringify(template).replaceAll(previousMember.id,memberId)) as ScreenFixture:structuredClone(template),work=checkpoint.snapshot.value.works.find(w=>w.id===workId)!,feedId=(fixture.routes['/events']!.body as any).feedId,missionId='intake';
 const roster=(fixture.routes['/assistant/conversation']!.body as any).members;if(!previousMember)roster.push(member);
 const turn=checkpoint.chat.turns.find(t=>t.id===turnId)!;assert.ok(turn.work&&checkpoint.chat.segment);const summary={...turn.work,turnId:turn.id,segment:checkpoint.chat.segment!.number};
 const read=fixture.routes['/read-state?mission=intake']!.body as any,prior=read.snapshot.value.works.find((w:Mission['works'][number])=>w.title===work.title),removed=new Set([prior?.id,fixture.screen==='B15'?'library':'toner'].filter(Boolean));
 read.snapshot.value.works=prior?read.snapshot.value.works.map((w:Mission['works'][number])=>w.id===prior.id?work:w):[work,...read.snapshot.value.works];read.snapshot.revision=checkpoint.snapshot.revision;
 if(read.snapshot.value.conversations)read.snapshot.value.conversations=read.snapshot.value.conversations.filter((c:any)=>!removed.has(c.workId));
 fixture.routes['/missions/intake']={status:200,body:structuredClone(read.snapshot)};
 const list=fixture.routes['/assistant/works']!.body as any;list.works=prior?list.works.map((w:any)=>removed.has(w.workId)?summary:w):[summary,...list.works];list.members=structuredClone(roster);
 for(const [path,response] of Object.entries(fixture.routes)){
  const address=new URL(path,'http://fixture'),oldWork=address.searchParams.get('work');
  if(path.startsWith('/missions/intake/')&&(removed.has(oldWork)||[...removed].some(id=>path.includes('/works/'+id+'/'))))delete fixture.routes[path];
  const body=response.body as any;if(path.startsWith('/assistant/conversation'))body.members=structuredClone(roster);
  if(path==='/assistant/results'&&Array.isArray(body.results))body.results=body.results.filter((r:any)=>!removed.has(r.workId));
 }
 const project=(body:any)=>{
  const oldTurns=body.turns.filter((t:any)=>removed.has(t.work?.workId)),oldIds=new Set(oldTurns.map((t:any)=>t.id)),oldMessages=new Set([...oldTurns.map((t:any)=>t.messageId),...(fixture.screen==='B15'?['m:library','r:library']:[])]),index=body.segment.messages.findIndex((m:any)=>oldIds.has(m.turnId)||oldMessages.has(m.id)),turnIndex=body.turns.findIndex((t:any)=>oldIds.has(t.id));
  body.segment.messages=body.segment.messages.filter((m:any)=>!oldIds.has(m.turnId)&&!oldMessages.has(m.id));body.segment.messages.splice(index<0?body.segment.messages.length:index,0,...structuredClone(checkpoint.chat.segment!.messages));
  body.turns=body.turns.filter((t:any)=>!oldIds.has(t.id));body.turns.splice(turnIndex<0?body.turns.length:turnIndex,0,structuredClone(turn));
  body.decisions=[...(body.decisions??[]).filter((d:any)=>!removed.has((d.environment??d.effect)?.workId)&&!(fixture.screen==='B15'&&d.id==='library')),...checkpoint.decisions];body.members=structuredClone(roster);body.cursor=checkpoint.chat.cursor;
 };
 const conversation=fixture.routes['/assistant/conversation']!.body as any;project(conversation);
 if(fixture.routes['/assistant/conversation?segment=1'])fixture.routes['/assistant/conversation?segment=1']={status:200,body:structuredClone(conversation)};
 const existing=fixture.routes['/assistant/conversation?member='+memberId]?.body as any,memberConversation=existing?structuredClone(existing):{...structuredClone(conversation),member:{id:memberId,name:member.name}};
 if(existing)project(memberConversation);
 fixture.routes['/assistant/conversation?member='+memberId]={status:200,body:memberConversation};
 fixture.routes['/assistant/conversation?segment=1&member='+memberId]={status:200,body:memberConversation};
 fixture.routes['/missions/intake/works/'+workId+'/browser']={status:200,body:{...checkpoint.browser,revision:read.snapshot.revision,feedId}};
 fixture.routes['/missions/intake/run-ownership?work='+workId]={status:200,body:{...checkpoint.ownership,feedId}};
 fixture.routes['/missions/intake/conversation?work='+workId]={status:200,body:{...checkpoint.conversation,feedId}};
 if(checkpoint.artifact){const a=checkpoint.artifact;fixture.routes['/missions/intake/record-artifact?work='+workId+'&record='+a.recordId+'&version='+a.artifact.version+'&sha256='+a.artifact.sha256]={status:200,body:{...a,feedId}};}
 fixture.now=checkpoint.now;fixture.readySelector='#chat-log';fixture.steps=[{action:'click',selector:'[id="side-line-intake/'+workId+'"]',readySelector:'#work-heading-'+workId}];
 if(['B4','B15'].includes(fixture.screen))fixture.steps.push({action:'click',selector:'#work-browser-'+workId,readySelector:'#pane-effect:not([hidden])'});
 if(fixture.screen.endsWith('-done'))fixture.steps.push({action:'click',selector:'#activity-toggle',readySelector:'#activity-head'});
 if(fixture.screen.startsWith('B8'))fixture.steps.push({action:'click',selector:'#pane-widen',readySelector:'#app.wide'});
 fixture.gaps=fixture.gaps.filter(g=>!g.includes('no browser tab')&&!g.startsWith('The host routes owner decisions')).map(g=>g.startsWith('These text-only Works')?'Background text Works retain their recorded procedure and browser gaps; the native producer replaces only the selected Work.':g.startsWith('No host producer supplies payment approval')?'Vendor receipts, payment execution and subscription-CLI connection proof remain absent.':g);
 fixture.reuse.push('scripts/ui-contracts/environment-work-fixture.ts: native local HTTPS member Work through ConfiguredTextRuntime, scoped fake SecretSlots, owner-only simulator and validated cross-aggregate journal');
 fixture.description='Command-generated native local HTTPS member Work; '+name+' checkpoint, synthetic providers and no payment execution.';
 return fixture;
}

export async function recordedEnvironmentWorkFixture(template:ScreenFixture){return environmentWorkFixture(template,JSON.parse(await readFile(generated,'utf8')));}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=await mkdtemp(join(tmpdir(),'massion-environment-fixture-'));
 try{const data=await produceEnvironmentWork(root);await saveEnvironmentWorkFixtures(data);console.log('Native member Work fixtures generated; checkpoints:',Object.keys(data.checkpoints).join(', '));}finally{await rm(root,{recursive:true,force:true});}
}
