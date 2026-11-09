import {AssistantService} from '../../src/assistant-service.ts';
import {AssistantConversation,ASSISTANT_ACTOR_ID,ownerMessageId,assistantTurnId,segmentId} from '../../src/assistant-conversation.ts';
import {memoryCandidateId} from '../../src/memory-candidates.ts';
import {hash} from '../../src/domain.ts';
import {ProductService} from '../../src/product.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';
export const MEMORY_SCREENS=['B6','B7-churn','B7-fail','B18','B18-room-b'];
export async function memoryFixture(template:ScreenFixture){
 const fixture=structuredClone(template),memberId='member-quill',thread='member:'+memberId,routePath='/assistant/conversation?member='+memberId,view=fixture.routes[routePath]?.body as any;if(!view?.segment)return fixture;
 const messages=view.segment.messages,owner=messages.filter((m:any)=>m.role==='owner').at(-1),answer=messages.filter((m:any)=>m.role==='representative').at(-1);if(!owner||!answer)return fixture;
 const store=new InMemoryStore<any>(),product=new ProductService(store);await product.create({id:'intake',purpose:'Member memory fixture',scope:'local',constraints:[],criteria:{version:1,description:'Fixture conversation',oracle:'bounded-text-review/v1'}},'memory-fixture-create');
 const commandId='rd-memory-'+fixture.screen,messageId=ownerMessageId(commandId),turnId=assistantTurnId(messageId),segment=segmentId(1,thread),conversation=new AssistantConversation(store,[{id:'local-owner',roles:['owner']},{id:ASSISTANT_ACTOR_ID,roles:['assistant']}],()=>fixture.now,thread);
 await conversation.dispatch({segment:1,commandId,expectedRevision:0,actorId:'local-owner',command:{type:'open-assistant-segment',recordMessageTime:true,segment:1,previous:null,messageId,text:owner.text,turn:{id:turnId,status:'pending',route:{profileId:'fixture',configHash:'a'.repeat(64),provider:'fixture',model:'fixture',mode:'mock-http',outputTokenCap:256},ownership:{hostSessionId:'fixture-host',dispatchId:'fixture-dispatch',startedAt:fixture.now,deadlineAt:fixture.now+120000},requestHash:'b'.repeat(64),contextMessageIds:[]}}});
 const message=(await store.load(segment))!.value.messages[0];
 await conversation.dispatch({segment:1,commandId:'assistant-settle:'+turnId,expectedRevision:1,actorId:ASSISTANT_ACTOR_ID,command:{type:'settle-assistant-turn',recordMessageTime:true,turnId,status:'answered',usage:{inputTokens:1,outputTokens:1},receipt:'Fixture model response',reply:answer.text,proposal:null,memoryCandidate:{id:memoryCandidateId(segment,turnId),version:1,name:owner.text,content:owner.text,missionId:'intake',scope:'local',memberId,segmentId:segment,turnId,messageHash:hash(message),state:'proposed'}}});
 const chat=new AssistantService(store,product,undefined,{member:{id:memberId,name:'퀼',modelGroup:'default'},clock:()=>fixture.now}),generated=await chat.read(),turn=generated.turns[0]!,oldTurn=view.turns.find((t:any)=>t.messageId===owner.id);if(!turn.memoryCandidate)throw Error('Fixture must produce a typed memory candidate');validateMissionJournalLineage(store.inspect());
 for(const [path,response] of Object.entries(fixture.routes)){const v=response.body as any;if(!path.startsWith(routePath)||!v.segment)continue;const index=v.segment.messages.findIndex((m:any)=>m.id===owner.id);if(index<0)continue;v.segment.messages.splice(index,2,...structuredClone(generated.segment!.messages));v.segment.revision=generated.segment!.revision;v.turns=v.turns.filter((t:any)=>t.id!==oldTurn?.id);v.turns.push(structuredClone(turn));}
 fixture.gaps=fixture.gaps.filter(g=>!/Owner memory-candidate proposals/.test(g)).map(g=>g.replace(' and memory-candidate save/discard',''));fixture.reuse.push('scripts/ui-contracts/memory-fixtures.ts: production AssistantConversation settlement and AssistantService read; no invocation or adoption');return fixture;
}
