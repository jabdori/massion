import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Application} from '../../../src/application.ts';
import {hash,workInputHash} from '../../../src/domain.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId,assistantWorkId,assistantRunId,segmentId} from '../../../src/assistant-conversation.ts';
import {AssistantService} from '../../../src/assistant-service.ts';
import {InMemoryStore} from '../../../src/storage.ts';
import {ProductService} from '../../../src/product.ts';
import {readRejectedText} from '../../../src/rejected-text.ts';

// Reconstruct the requested chronology using only existing application commands.
// No fixture write is authorized unless all required state/reader checks succeed.
const root=new URL('../../../',import.meta.url);
const fixture=async name=>JSON.parse(await readFile(new URL('scripts/ui-contracts/fixtures/'+name+'.json',root),'utf8'));
const failed=await fixture('B7-fail'),active=await fixture('B7-churn');
const time=clock=>Date.parse('2026-11-05T'+clock+':00+09:00');
const actors=[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{id:'runtime-representative',roles:['representative']},{id:'executor',roles:['executor']},{id:'verifier',roles:['verifier']}];

async function build(screen){
 const template=screen==='B7-fail'?failed:active,original=template.routes['/missions/intake'].body.value;
 const store=new InMemoryStore();let now=time('09:40'),sequence=0;
 const clock=()=>now,app=new Application(store,actors,clock),conversation=new AssistantConversation(store,actors,clock);
 const product=new ProductService(store),connections={list:()=>({representative:{intakeMissionId:'intake'}})};
 const member=template.routes['/assistant/conversation'].body.members.find(m=>m.id==='member-quill');
 const memberConversation=new AssistantConversation(store,actors,clock,'member:member-quill');
 const memberService=new AssistantService(store,product,connections,{clock,member});
 const route={profileId:'fixture-representative',configHash:hash('fixture'),provider:'fixture',model:'claude-sonnet-5-5',mode:'mock-http',outputTokenCap:64};
 const send=async(command,actorId='runtime-representative')=>{
  const current=await store.load('intake'),r=await app.dispatch({missionId:'intake',commandId:'chronology:'+sequence++,expectedRevision:current.revision,actorId,command});
  assert.equal(r.status,'committed');return r;
 };
 const current=async id=>(await store.load('intake')).value.works.find(w=>w.id===id);
 await app.create({id:'intake',purpose:original.purpose,scope:original.scope,constraints:original.constraints,criteria:original.criteria},'local-owner','chronology:create');
 async function admission(title,at){
  now=time(at);const old=original.works.find(w=>w.title===title),key=title==='이탈 원인 조사'?'churn':'pricing';
  const messageId=old.assistantSource.messageId,turnId=assistantTurnId(messageId),workId=assistantWorkId(turnId),runId=assistantRunId(turnId),segment=await store.load(segmentId(1));
  const ownership={hostSessionId:'host:chronology',dispatchId:'dispatch:turn:'+key,startedAt:now,deadlineAt:now+300000};
  await conversation.dispatch({segment:1,commandId:'e3c:'+key,expectedRevision:segment?.revision??0,actorId:'local-owner',command:{type:segment?'append-assistant-message':'open-assistant-segment',...(!segment?{segment:1,previous:null}:{}),messageId,text:old.assistantSource.message.text,turn:{status:'pending',id:turnId,route,ownership,requestHash:hash(key),contextMessageIds:[]}}});
  const pending=await store.load(segmentId(1));
  const reply=template.routes['/assistant/conversation'].body.segment.messages.find(m=>m.turnId===turnId).text;
  await conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:pending.revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Data-only chronological fixture; no provider invocation',reply,proposal:{title,member:member.name}}});
  const message=(await store.load(segmentId(1))).value.messages.find(m=>m.id===messageId),source={segmentId:segmentId(1),turnId,messageId,messageHash:hash(message),message,representative:{provider:route.provider,model:route.model},memberId:member.id};
  await send({type:'admit-work',workId,title,budget:8,assistantSource:source},ASSISTANT_ACTOR_ID);
  const w=await current(workId);
  await send({type:'activate-runtime',workId,run:{id:runId,authorizationId:'fixture-authorization',criteriaHash:hash(w.criteria),inputHash:workInputHash(w),mode:'mock-http',outputTokenCap:4,ownership:{...ownership,dispatchId:'dispatch:work:'+key}}},ASSISTANT_ACTOR_ID);
  for(const stage of ['executor','verifier'])await send({type:'delegate',workId,taskId:workId+':'+stage,parentId:workId+':root'});
  for(const [suffix,role,taskId] of [['root','executor',workId+':root'],['executor:assignment','executor',workId+':executor'],['verifier:assignment','verifier',workId+':verifier']])await send({type:'assign',workId,assignment:{id:runId+':'+suffix,actorId:role,role,taskId,model:old.assignments.find(a=>a.role===role).model,extensionVersion:'massion.builtin.bounded-text@9'}});
  await send({type:'admit-effect',workId,effect:{id:runId+':executor',taskId:workId+':executor',status:'pending',target:'fixture/claude-sonnet-5-5',authority:'fixture-authorization'},reserve:4},'executor');
  await send({type:'receipt',workId,effectId:runId+':executor',outcome:'succeeded',receipt:old.effects[0].receipt,usage:1},'executor');
  return {workId,runId,old};
 }
 async function exchange(key,at,target){
  now=time(at);const view=template.routes['/assistant/conversation?member=member-quill'].body;
  const index=['churn','direction','memory'].indexOf(key),owner=view.segment.messages[index*2],reply=view.segment.messages[index*2+1];
  const messageId=ownerMessageId('e3c-member-'+key),turnId=assistantTurnId(messageId),s=await store.load(segmentId(1,'member:member-quill'));
  await memberConversation.dispatch({segment:1,commandId:'e3c-member-'+key,expectedRevision:s?.revision??0,actorId:'local-owner',command:{type:s?'append-assistant-message':'open-assistant-segment',...(!s?{segment:1,previous:null}:{}),messageId,text:owner.text,turn:{status:'pending',id:turnId,route,ownership:{hostSessionId:'host:chronology',dispatchId:'dispatch:member:'+key,startedAt:now,deadlineAt:now+300000},requestHash:hash(key),contextMessageIds:[]}}});
  const pending=await store.load(segmentId(1,'member:member-quill'));
  await memberConversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:pending.revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Data-only member exchange; no provider invocation',reply:reply.text,proposal:null,...(target?{steer:{missionId:'intake',workId:target,status:'proposed'}}:{})}});
  if(target){assert.equal((await current(target)).execution,'active');assert.equal((await memberService.confirmSteer({segment:1,turnId})).status,'recorded');}
  return turnId;
 }
 const churn=await admission('이탈 원인 조사','09:40');
 await exchange('churn','09:41');
 if(screen==='B7-fail'){
  now=time('09:50');const {workId,runId,old}=churn;
  await send({type:'admit-effect',workId,effect:{id:runId+':artifact',taskId:workId+':executor',status:'pending',target:'bounded text artifact',authority:'fixture-authorization'},reserve:0},'executor');
  await send({type:'receipt',workId,effectId:runId+':artifact',outcome:'succeeded',receipt:'Existing failed fixture candidate retained',usage:0},'executor');
  await send({type:'publish-artifact',workId,artifact:old.artifact},'executor');
  await send({type:'settle-task',workId,taskId:workId+':executor',result:'Text artifact '+old.artifact.sha256},'executor');
  await send({type:'admit-effect',workId,effect:{id:runId+':verifier',taskId:workId+':verifier',status:'pending',target:'fixture/gpt-6.1-terra',authority:'fixture-authorization'},reserve:4},'verifier');
 }
 const direction=await exchange('direction','09:52',churn.workId);
 const afterSteer=await current(churn.workId);assert.equal(afterSteer.execution,'waiting');
 const pricing=await admission('경쟁사 가격','10:30');
 await exchange('memory','10:41',pricing.workId);
 let settlementError=null,readerStatus=null;
 if(screen==='B7-fail'){
  now=time('11:20');const {workId,runId,old}=churn;
  await send({type:'receipt',workId,effectId:runId+':verifier',outcome:'succeeded',receipt:'Existing failed fixture independent review retained',usage:1},'verifier');
  await send({type:'verify',workId,verdict:old.verdict},'verifier');
  await assert.rejects(send({type:'settle-task',workId,taskId:workId+':verifier',result:'Independent review failed'},'verifier'),error=>{settlementError=error.message;return error.message==='Owner steering must be resolved before task progression';});
  const w=await current(workId),body=Object.entries(template.routes).find(([p,r])=>p.includes('/rejected-artifact?')&&r.body.workId===workId)[1].body;
  await assert.rejects(readRejectedText(store,{read:async()=>body.content},'intake',workId,{binding:hash(w),artifactVersion:1,artifactSha256:w.artifact.sha256}),error=>{readerStatus=error.status;return error.status===409;});
 }
 const final=await current(churn.workId),memberRead=await memberService.read(),historical=memberRead.turns.find(t=>t.id===direction).steer;
 assert.equal(historical.status,'recorded');assert.equal(historical.workId,churn.workId);
 const record={screen,admissions:(await store.load(segmentId(1))).value.messages.filter(m=>m.role==='owner').map(m=>({text:m.text,ordinal:m.ordinal})),memberTimes:memberRead.turns.map(t=>new Date(t.at).toISOString()),historicalSteer:historical,execution:final.execution,acceptance:final.acceptance,inputPinStillCurrent:final.runtimeRun.inputHash===workInputHash(final),settlementError,readerStatus};
 console.log(JSON.stringify(record,null,2));
 return record;
}

const results=[];
for(const screen of ['B7-churn','B7-fail'])results.push(await build(screen));
assert.equal(results[0].execution,'waiting');
assert.equal(results[1].acceptance,'failed');
assert.equal(results[1].readerStatus,409);
console.log('Reproduced with actual commands: requested source chronology and recorded historical churn steering are supported; active/settled continuation and the existing rejected reader are blocked. No fixture JSON written.');
