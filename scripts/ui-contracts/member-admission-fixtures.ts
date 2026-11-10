import assert from 'node:assert/strict';
import {hash} from '../../src/domain.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {ProductService} from '../../src/product.ts';
import {AssistantService} from '../../src/assistant-service.ts';
import {ASSISTANT_ACTOR_ID} from '../../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../../src/members.ts';
import type {MembersState,MembersCommand} from '../../src/members.ts';
import {createHostConnections,parseHostManifest} from '../../src/host-connections.ts';
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
  produced.readySelector='[id="chat-system-'+card.id+'"]';
  produced.routes['/assistant/members']={status:200,body:{...org,feedId:view.feedId}};
 }else{
  const product=new ProductService(store);await product.create({id:'intake',purpose:'Fixture conversation',scope:'local',constraints:[],criteria:{version:1,description:'Direct answer',oracle:'bounded-text-review/v1'}},'fixture-intake');
  const exchanges=conversation.segment.messages,answers=[exchanges[1].text,exchanges[3].text];
  const transport=async(_url:string|URL|Request,init?:RequestInit)=>new Response(JSON.stringify({id:'fixture',object:'chat.completion',created:1,model:JSON.parse(String(init!.body)).model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({reply:answers.shift(),work:null})}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{headers:{'content-type':'application/json'}});
  const connections=createHostConnections(store,new TextArtifactStore(process.cwd()+'/.runtime/member-admission-artifacts'),{manifest:parseHostManifest({version:1,revision:'fixture',mode:'local-http-mock',connections:[{id:'fixture',label:'Fixture',providerType:'compatible',baseUrl:'http://127.0.0.1:9999/v1/',models:['fixture-representative','fixture-worker','fixture-check']}]}),allowLiveExecution:false},{transport,readEnvironment:()=>undefined});
  const callAt=Date.now();produced.now=callAt;
  const assistant=new AssistantService(store,product,connections,{clock:()=>callAt,members:()=>members.roster()}),profiles=connections.list().runtime.connections as {id:string;model:string}[],profile=(model:string)=>profiles.find(p=>p.model===model)!.id;
  await connections.save(()=>connections.authorize({id:'fixture-grant',scope:'local',executorProfileId:profile('fixture-worker'),verifierProfileId:profile('fixture-check'),maxOutputTokensPerCall:64,expectedConfigHash:connections.list().configHash}));
  await connections.save(()=>connections.setDefaultRoute({authorizationId:'fixture-grant',outputTokenCap:64,expectedConfigHash:connections.list().configHash}));
  await assistant.setSettings({profileId:profile('fixture-representative'),outputTokenCap:64,intakeMissionId:'intake',expectedConfigHash:connections.list().configHash});
  for(const index of [0,2]){const current=await assistant.read();await assistant.send({commandId:'fixture-message-'+index,segment:1,expectedRevision:current.segment?.revision??0,text:exchanges[index].text});}
  const read=await assistant.read();assert.ok(read.segment!.messages.at(-1)!.member,'The actual member turn must supply attribution');
  for(const [path,response] of Object.entries(produced.routes))if(path.startsWith('/assistant/conversation'))Object.assign(response.body as object,{...read,feedId:view.feedId,members:org.members,decisions:[],briefings:[]});
 }
 validateMissionJournalLineage(store.inspect());produced.gaps=[];produced.reuse.push('scripts/ui-contracts/member-admission-fixtures.ts: actual admitted identities, MembersService receipts and AssistantService member-authored replies');return produced;
}
