import assert from 'node:assert/strict';
import {Application} from '../../src/application.ts';
import {AssistantService} from '../../src/assistant-service.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,assistantTurnId,ownerMessageId,segmentId} from '../../src/assistant-conversation.ts';
import {candidateMemory,memoryCandidateId,memoryCandidateHash} from '../../src/memory-candidates.ts';
import type {MemoryCandidate} from '../../src/memory-candidates.ts';
import {hash} from '../../src/domain.ts';
import {ProductService} from '../../src/product.ts';
import {memberThread} from '../../src/members.ts';
import type {MembersService} from '../../src/members.ts';
import {SkillsService} from '../../src/skills.ts';
import {SchedulesService} from '../../src/schedules.ts';
import type {Store} from '../../src/storage.ts';
import {copy} from '../../src/ui-copy.ts';

/** Exact production transitions shared by the screen fixture and live browser verification. */
export async function produceMemberPage(store:Store<any>,members:MembersService,now:number,memberId:string,coding=false){
 const clock=()=>now,owner={id:'local-owner',roles:['owner' as const]},host={id:ASSISTANT_ACTOR_ID,roles:['assistant' as const]},skills=new SkillsService(store,{clock});
 for(const builtinId of coding?['read-code','run-tests']:['read-sources','summarize-evidence'])assert.equal((await skills.act({commandId:'fixture-builtin-'+builtinId,action:'builtin',memberId,builtinId})).status,'committed');
 const schedules=new SchedulesService(store,async()=>({turns:[]}),clock,store,undefined,{member:id=>members.member(id),readMember:async()=>({turns:[]}),produceMember:async()=>null});
 if(!coding){
  const product=new ProductService(store);assert.equal((await product.create({id:'member-page-intake',purpose:'Member memory fixture',scope:'local',constraints:[],criteria:{version:1,description:'Retain the instruction',oracle:'bounded-text-review/v1'}},'fixture-member-page-intake')).status,'committed');
  const thread=memberThread(memberId),chat=new AssistantConversation(store,[owner,host],clock,thread),messageId=ownerMessageId('fixture-memory-remark'),turnId=assistantTurnId(messageId),route={profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http' as const,outputTokenCap:256};
  assert.equal((await chat.dispatch({segment:1,commandId:'fixture-memory-remark',expectedRevision:0,actorId:owner.id,command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId,text:copy('ui.member-fixture.memory'),turn:{status:'pending',id:turnId,route,ownership:{hostSessionId:'fixture',dispatchId:'fixture-memory',startedAt:now,deadlineAt:now+10000},requestHash:'a'.repeat(64),contextMessageIds:[]}}})).status,'committed');
  const c:MemoryCandidate={id:memoryCandidateId(segmentId(1,thread),turnId),version:1,name:copy('ui.member-fixture.memory'),content:copy('ui.member-fixture.memory'),missionId:'member-page-intake',scope:'local',memberId,segmentId:segmentId(1,thread),turnId,messageHash:hash((await store.load(segmentId(1,thread)))!.value.messages[0]),state:'proposed'};
  assert.equal((await chat.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:host.id,command:{type:'settle-assistant-turn',recordMessageTime:true,turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Controlled fixture',reply:copy('ui.member-fixture.reply'),proposal:null,memoryCandidate:c}})).status,'committed');
  assert.equal((await chat.dispatch({segment:1,commandId:'assistant-memory-decision:'+turnId,expectedRevision:2,actorId:owner.id,command:{type:'decide-assistant-memory',turnId,candidateId:c.id,version:1,hash:memoryCandidateHash(c),action:'save',missionRevision:1}})).status,'committed');
  assert.equal((await new Application(store,[owner],clock).dispatch({missionId:c.missionId,commandId:'assistant-memory-save:'+turnId,expectedRevision:1,actorId:owner.id,command:{type:'save-memory',memory:candidateMemory(c)}})).status,'committed');
  for(const [commandId,title] of [['fixture-member-review',copy('settings.switch.01',{work_title:copy('ui.member-fixture.work')})],['fixture-member-churn',copy('settings.switch.02')]])assert.equal((await schedules.act({commandId,action:'create',kind:'weekly-review',memberId,title,minute:540,offset:540,budget:{runs:30}})).status,'committed');
  return {skills:await skills.read(),schedules:await schedules.read(),conversation:await new AssistantService(store,product,undefined,{member:{id:memberId,name:(await members.member(memberId))!.name,modelGroup:'default'},clock}).read()};
 }
 return {skills:await skills.read(),schedules:await schedules.read(),conversation:undefined};
}
