import assert from 'node:assert/strict';
import {Application} from '../../src/application.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId,segmentId} from '../../src/assistant-conversation.ts';
import {AssistantService,workCardFacts} from '../../src/assistant-service.ts';
import {hash,workInputHash} from '../../src/domain.ts';
import type {Actor,Command,Mission,Work} from '../../src/domain.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {ProductService} from '../../src/product.ts';
import {readRejectedText} from '../../src/rejected-text.ts';
import type {ScreenFixture} from './fixture-host.ts';

export const STEERING_SCREENS=['B6','B7-churn','B7-fail','B8-fail','B18-room-b'];
/** Fixture text is input; confirmation, progression and projections use production commands. */
export async function steeringFixture(template:ScreenFixture){
 const fixture=structuredClone(template),memberPath='/assistant/conversation?member=member-quill',view=fixture.routes[memberPath]!.body as any;
 const mission=(fixture.routes['/missions/intake']!.body as any).value as Mission,original=mission.works.find(w=>w.title==='이탈 원인 조사')!;
 const owner=view.segment.messages.find((m:any)=>m.role==='owner'&&m.text==='기업 고객은 따로 봐 줘.'),reply=view.segment.messages.find((m:any)=>m.role==='representative'&&m.turnId===view.turns.find((t:any)=>t.messageId===owner.id)?.id);
 assert.ok(owner&&reply);
 let now=fixture.now-180000,n=0;const store=new InMemoryStore<any>(),actors:Actor[]=[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']},{id:'runtime-representative',roles:['representative']},...original.assignments.map(a=>({id:a.actorId,roles:[a.role]}))];
 const team=original.team??{memberId:'member-quill',skillsRevision:0,procedures:[{id:'fixture-churn',version:1,body:{description:original.title,steps:[original.title],verify:original.criteria.description},hash:''}]};
 for(const p of team.procedures)p.hash=hash(p.body);
 const steps=original.tasks.filter(t=>t.step),executor=original.assignments.find(a=>a.taskId===original.id+':executor')!;
 if(!steps.length){steps.push({id:original.id+':step:0',parentId:original.id+':executor',status:'settled',step:{role:'조사',title:original.title,dependsOn:[]},result:'기업 고객을 구분한 해지 원인 초안'});actors.push({id:'fixture-steering-worker',roles:['executor']});}
 const app=new Application(store,actors,()=>now),work=async()=>(await store.load(mission.id))!.value.works[0] as Work;
 const send=async(command:Command,actorId='runtime-representative')=>{const result=await app.dispatch({missionId:mission.id,commandId:'rf:'+n++,expectedRevision:(await store.load(mission.id))!.revision,actorId,command});assert.equal(result.status,'committed');};
 await app.create({id:mission.id,purpose:mission.purpose,scope:mission.scope,constraints:mission.constraints,criteria:mission.criteria},'local-owner','rf:create');
 await send({type:'admit-work',workId:original.id,title:original.title,budget:128,assistantSource:original.assistantSource!,team},ASSISTANT_ACTOR_ID);
 const run={...original.runtimeRun!,steeringVersion:1 as const,inputHash:workInputHash(await work()),ownership:{hostSessionId:'host:rf',dispatchId:'dispatch:rf',startedAt:now,deadlineAt:fixture.now+120000}};
 await send({type:'activate-runtime',workId:original.id,run},'local-owner');
 const tasks=[...original.tasks.filter(t=>!t.step),...steps];
 for(const task of tasks)if(task.parentId)await send({type:'delegate',workId:original.id,taskId:task.id,parentId:task.parentId,...(task.step?{step:task.step}:{})});
 const assignments=[...original.assignments];for(const task of steps)if(!assignments.some(a=>a.taskId===task.id))assignments.push({...executor,id:run.id+':step:0:assignment',taskId:task.id,actorId:'fixture-steering-worker'});
 for(const assignment of assignments)await send({type:'assign',workId:original.id,assignment});
 const actor=(taskId:string)=>assignments.find(a=>a.taskId===taskId)!;
 const first=steps.find(t=>!t.step!.skipReason)!,firstActor=actor(first.id),firstEffect={id:run.id+':step:0',taskId:first.id,status:'pending' as const,target:firstActor.model.provider+'/'+firstActor.model.model,authority:run.authorizationId};
 await send({type:'admit-effect',workId:original.id,effect:firstEffect,reserve:0,inputHash:workInputHash(await work())},firstActor.actorId);
 const thread='member:member-quill',conversation=new AssistantConversation(store,actors,()=>now,thread);
 const exchange=async(key:string,text:string,answer:string,target=false)=>{
  const messageId=ownerMessageId(key),turnId=assistantTurnId(messageId),stored=await store.load(segmentId(1,thread));
  await conversation.dispatch({segment:1,commandId:key,expectedRevision:stored?.revision??0,actorId:'local-owner',command:{...(stored?{type:'append-assistant-message' as const}:{type:'open-assistant-segment' as const,segment:1,previous:null}),recordMessageTime:true,messageId,text,turn:{id:turnId,status:'pending',route:{profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http',outputTokenCap:64},ownership:{...run.ownership,startedAt:now},requestHash:hash(key),contextMessageIds:[]}}});
  await conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:(await store.load(segmentId(1,thread)))!.revision,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',recordMessageTime:true,turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Data-only fixture response',reply:answer,proposal:null,...(target?{steer:{missionId:mission.id,workId:original.id,status:'proposed' as const}}:{})}});
  return turnId;
 };
 const firstMessage=view.segment.messages[0],firstReply=view.segment.messages[1];
 await exchange('rf-first',firstMessage.text,firstReply.text);now+=30000;
 const turnId=await exchange('rf-direction',owner.text,reply.text,true);
 const chat=new AssistantService(store,new ProductService(store),undefined,{member:{id:'member-quill',name:'퀼',modelGroup:'default'},clock:()=>now});
 assert.equal((await chat.confirmSteer({segment:1,turnId})).status,'recorded');assert.equal((await work()).execution,'active');
 const effectFor=(task:Work['tasks'][number])=>{const a=actor(task.id);return task===first?firstEffect:{id:run.id+':'+task.id,taskId:task.id,status:'pending' as const,target:a.model.provider+'/'+a.model.model,authority:run.authorizationId};};
 const pending=steps.filter(t=>t.status!=='queued');
 while(pending.length){
  const current=await work(),ready=pending.filter(t=>t.step!.dependsOn.every(id=>current.tasks.find(x=>x.id===id)?.status==='settled'));assert.ok(ready.length,'Unresolved fixture dependencies');
  for(const task of ready)if(!task.step!.skipReason&&task!==first){now++;await send({type:'admit-effect',workId:original.id,effect:effectFor(task),reserve:0,inputHash:workInputHash(await work())},actor(task.id).actorId);}
  for(const task of ready){
   now++;const a=actor(task.id);
   if(!task.step!.skipReason)await send({type:'receipt',workId:original.id,effectId:effectFor(task).id,outcome:'succeeded',receipt:task.result??'Fixture worker text; no external research',usage:0},a.actorId);
   if(task.status==='settled')await send({type:'settle-task',workId:original.id,taskId:task.id,result:task.result!},a.actorId);
   if(task.progress&&!task.step!.skipReason){const {at,...progress}=task.progress;await send({type:'record-step-progress',workId:original.id,taskId:task.id,progress},a.actorId);}
   pending.splice(pending.indexOf(task),1);
  }
 }
 if(original.execution==='settled'){
  for(const effect of original.effects.filter(e=>!steps.some(t=>t.id===e.taskId))){await send({type:'admit-effect',workId:original.id,inputHash:workInputHash(await work()),effect:{id:effect.id,taskId:effect.taskId,status:'pending',target:effect.target,authority:effect.authority},reserve:0},actor(effect.taskId).actorId);await send({type:'receipt',workId:original.id,effectId:effect.id,outcome:'succeeded',receipt:effect.receipt!,usage:0},actor(effect.taskId).actorId);}
  await send({type:'publish-artifact',workId:original.id,artifact:original.artifact!},executor.actorId);
  const {checkedAt,...verdict}=original.verdict!;await send({type:'verify',workId:original.id,verdict},actor(original.id+':verifier').actorId);
  for(const task of tasks.filter(t=>!t.step&&t.parentId))await send({type:'settle-task',workId:original.id,taskId:task.id,result:task.result!},actor(task.id).actorId);
  await send({type:'settle-task',workId:original.id,taskId:original.id+':root',result:original.tasks[0]!.result!},actor(original.id+':root').actorId);
 }
 const final=await work(),generated=await chat.read();assert.equal(final.execution,original.execution);
 for(const [path,response] of Object.entries(fixture.routes)){
  const body=response.body as any;
  for(const row of [...(body?.works??[]),...(body?.turns??[]).flatMap((t:any)=>t.work?[t.work]:[])])if(row.workId===final.id){row.startedAt=final.runtimeRun!.ownership!.startedAt;row.endedAt=final.endedAt??null;row.execution=final.execution;row.acceptance=final.acceptance;Object.assign(row,workCardFacts(final));}
  for(const value of [body?.value,body?.snapshot?.value])if(value?.id===mission.id){const index=value.works.findIndex((w:Work)=>w.id===final.id);if(index>=0)value.works[index]=structuredClone(final);}
  if(path.startsWith(memberPath)&&body.segment){const index=body.segment.messages.findIndex((m:any)=>m.id===firstMessage.id);if(index>=0){body.segment.messages.splice(index,4,...structuredClone(generated.segment!.messages));body.turns=body.turns.filter((t:any)=>![firstMessage.id,owner.id].includes(t.messageId));body.turns.push(...structuredClone(generated.turns));}}
  if(path.includes('/rejected-artifact?')&&body.workId===final.id){const value=await readRejectedText(store,{read:async()=>body.content},mission.id,final.id,{binding:hash(final),artifactVersion:final.artifact!.version,artifactSha256:final.artifact!.sha256});delete fixture.routes[path];const url=new URL(path,'http://fixture');url.searchParams.set('binding',hash(final));fixture.routes[url.pathname+url.search]={status:200,body:{...body,...value}};}
 }
 for(const step of fixture.steps)if(step.readySelector)step.readySelector=step.readySelector.replace(firstMessage.id,generated.segment!.messages[0]!.id);
 fixture.readySelector=fixture.readySelector.replace(firstMessage.id,generated.segment!.messages[0]!.id);
 fixture.gaps=fixture.gaps.filter(g=>!g.startsWith('Confirmed enterprise steering followed'));
 fixture.reuse.push('scripts/ui-contracts/steering-fixture.ts: owner confirmation and continued procedure commands and rejected artifact read');
 return fixture;
}
