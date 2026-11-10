import assert from 'node:assert/strict';
import {hash} from '../../src/domain.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {ProductService} from '../../src/product.ts';
import {AssistantService} from '../../src/assistant-service.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId} from '../../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../../src/members.ts';
import type {MembersState,MembersCommand} from '../../src/members.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** Both screens use admitted identities and production message/admission projections. No external calls. */
export async function memberAdmissionFixture(template:ScreenFixture):Promise<ScreenFixture>{
 if(!['B11-quill','B21-done-hana'].includes(template.screen))return structuredClone(template);
 const fixture=structuredClone(template),view=fixture.routes['/assistant/conversation']!.body as any,store=new InMemoryStore<any>(),members=new MembersService(store,()=>'intake',()=>fixture.now),mapping=new Map<string,string>();
 const dispatch=async(commandId:string,command:MembersCommand,actorId:string)=>{
  const prior=await store.load(MEMBERS_ID),derived=applyMembers(prior?.value as MembersState??null,command,{id:actorId,roles:[actorId===ASSISTANT_ACTOR_ID?'assistant':'owner']},{observedAt:fixture.now});
  assert.equal((await store.commit({id:MEMBERS_ID,expectedRevision:prior?.revision??0,commandId,fingerprint:hash({actorId,command}),...derived,outbox:[]})).status,'committed');
 };
 for(const [index,member] of view.members.entries()){
  const commandId='fixture-member-'+index,proposalId=PROPOSAL_PREFIX+index,decisionId=proposalDecisionId(proposalId),memberId=admittedMemberId(commandId);mapping.set(member.id,memberId);
  await dispatch(proposalId,{type:'propose-member',decisionId,topic:member.name,works:[{title:'First'},{title:'Second'}],count:2},ASSISTANT_ACTOR_ID);
  if(fixture.screen==='B21-done-hana'&&index===view.members.length-1)await members.decide({commandId,decisionId,answer:'act',member:{name:member.name,shape:member.look.shape}});
  else await dispatch(commandId,{type:'admit-member',decisionId,memberId,name:member.name,shape:member.look.shape},'local-owner');
 }
 let serialized=JSON.stringify(fixture);for(const [before,after] of mapping)serialized=serialized.replaceAll(before,after);const produced=JSON.parse(serialized) as ScreenFixture;
 const org=await members.read(),conversation=produced.routes['/assistant/conversation']!.body as any;
 if(fixture.screen==='B21-done-hana'){
  const card=org.decisions.at(-1)!;
  for(const [path,response] of Object.entries(produced.routes))if(path.startsWith('/assistant/conversation')){const body=response.body as any;body.members=org.members;body.decisions=[card];}
  produced.readySelector='#chat-log';
  produced.routes['/assistant/members']={status:200,body:{...org,feedId:view.feedId}};
 }else{
  const product=new ProductService(store);await product.create({id:'intake',purpose:'Fixture conversation',scope:'local',constraints:[],criteria:{version:1,description:'Direct answer',oracle:'bounded-text-review/v1'}},'fixture-intake');
  const exchanges=conversation.segment.messages,owner={id:'local-owner',roles:['owner' as const]},host={id:ASSISTANT_ACTOR_ID,roles:['assistant' as const]},chat=new AssistantConversation(store,[owner,host],()=>fixture.now);
  const assistant=new AssistantService(store,product,undefined,{clock:()=>fixture.now}),roster=await members.roster();
  for(const index of [0,2]){
   const commandId='fixture-message-'+index,messageId=ownerMessageId(commandId),turnId=assistantTurnId(messageId),current=await assistant.read(),member=index===2?roster[0]:undefined;
   if(member)await members.use(member.id);
   const turn={id:turnId,status:'pending' as const,...(member?{member:{id:member.id,name:member.name}}:{}),route:{profileId:'fixture-profile',configHash:hash('fixture'),provider:'fixture',model:'fixture',mode:'mock-http' as const,outputTokenCap:64},ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-'+index,startedAt:fixture.now,deadlineAt:fixture.now+120000},requestHash:hash({fixture:fixture.screen,index}),contextMessageIds:[]};
   const command=current.segment?{type:'append-assistant-message' as const,messageId,text:exchanges[index].text,turn,recordMessageTime:true as const}:{type:'open-assistant-segment' as const,segment:1,previous:null,messageId,text:exchanges[index].text,turn,recordMessageTime:true as const};
   const opened=await chat.dispatch({segment:1,commandId,expectedRevision:current.segment?.revision??0,actorId:owner.id,command});assert.equal(opened.status,'committed');
   await chat.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:opened.revision,actorId:host.id,command:{type:'settle-assistant-turn',turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Fixture member reply',reply:exchanges[index+1].text,proposal:null,recordMessageTime:true}});
  }
  const read=await assistant.read();assert.ok(read.segment!.messages.at(-1)!.member,'The actual member turn must supply attribution');
  for(const [path,response] of Object.entries(produced.routes))if(path.startsWith('/assistant/conversation'))Object.assign(response.body as object,{...read,feedId:view.feedId,members:org.members,decisions:[],briefings:[]});
 }
 validateMissionJournalLineage(store.inspect());produced.gaps=[];produced.reuse.push('scripts/ui-contracts/member-admission-fixtures.ts: admitted identities, MembersService receipts, host-validated turn settlement and AssistantService.read');return produced;
}
