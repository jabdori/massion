import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appLifecycleFixture} from './app-lifecycle-fixtures.ts';
import {hash} from '../../src/domain.ts';
import type {Actor,Mission} from '../../src/domain.ts';
import {InMemoryStore} from '../../src/storage.ts';
import type {Snapshot} from '../../src/storage.ts';
import {ASSISTANT_ACTOR_ID} from '../../src/assistant-conversation.ts';
import {MEMBERS_ID,MembersService,applyMembers,admittedMemberId,proposalDecisionId,PROPOSAL_PREFIX} from '../../src/members.ts';
import type {Member,MembersState,MembersCommand} from '../../src/members.ts';
import {validateMissionJournalLineage} from '../../src/backup-lineage.ts';
import type {ScreenFixture} from './fixture-host.ts';

/** Preserve recorded background routes; new member metadata comes only from production transitions and reads. */
export async function memberLifecycleFixture(template:ScreenFixture):Promise<ScreenFixture>{
 if(!['B13','B13-general','B13-general-restart','B19','B19-juno'].includes(template.screen))return structuredClone(template);
 const source=structuredClone(template),conversation=source.routes['/assistant/conversation']!.body as {feedId:string;members:Pick<Member,'id'|'name'|'look'|'modelGroup'>[]};
 const titles=((source.routes['/assistant/works']!.body as {works:{title:string}[]}).works).map(w=>({title:w.title}));assert.ok(titles.length>=2,'Member fixtures require two recorded Work titles');
 let now=source.now-86400000;const store=new InMemoryStore<any>(()=>new Date(now)),service=new MembersService(store,()=>'intake',()=>now),mapping=new Map<string,string>();
 const owner:Actor={id:'local-owner',roles:['owner']},host:Actor={id:ASSISTANT_ACTOR_ID,roles:['assistant']};
 const dispatch=async(commandId:string,command:MembersCommand,actor:Actor)=>{
  const prior=await store.load(MEMBERS_ID) as Snapshot<MembersState>|null,{value,events}=applyMembers(prior?.value??null,command,actor,{observedAt:now});
  assert.equal((await store.commit({id:MEMBERS_ID,expectedRevision:prior?.revision??0,commandId,fingerprint:hash({actorId:actor.id,command}),value,events,outbox:[]})).status,'committed');
 };
 const archived={id:'member-archive-sample',name:'River',look:{shape:'round',color:'agent-3'},modelGroup:'default'};
 for(const member of [...conversation.members,archived]){
  const proposalId=PROPOSAL_PREFIX+hash(member.id),decisionId=proposalDecisionId(proposalId),commandId='fixture-admit-'+member.id,memberId=admittedMemberId(commandId);mapping.set(member.id,memberId);
  await dispatch(proposalId,{type:'propose-member',decisionId,topic:member.name,works:titles.slice(0,2),count:titles.length},host);
  assert.equal((await service.decide({commandId,decisionId,answer:'act',member:{name:member.name,shape:member.look.shape}})).status,'committed');
  if(member.modelGroup!=='default')await dispatch('fixture-group-'+member.id,{type:'set-member-group',memberId,modelGroup:member.modelGroup},owner);
 }
 now=source.now;assert.equal((await service.act({commandId:'fixture-archive-member',action:'archive',memberId:mapping.get(archived.id)!})).status,'committed');
 validateMissionJournalLineage(store.inspect());
 // IDs occur in route keys, setup selectors, skill IDs and Work member references.
 let serialized=JSON.stringify(source);for(const [before,after] of mapping)serialized=serialized.replaceAll(before,after);const fixture=JSON.parse(serialized) as ScreenFixture;
 const mission=(fixture.routes['/read-state?mission=intake']?.body as {snapshot?:Snapshot<Mission>})?.snapshot?.value;
 if(mission)await store.commit({id:mission.id,expectedRevision:0,commandId:'fixture-recorded-intake',fingerprint:hash(mission),value:mission,events:[],outbox:[]});
 // Fixture transport keeps its existing feed envelope; every member field is the service projection.
 const read={...await service.read(),feedId:conversation.feedId};fixture.routes['/assistant/members']={status:200,body:read};
 for(const [path,response] of Object.entries(fixture.routes))if(path==='/assistant/conversation'||path.startsWith('/assistant/conversation?'))(response.body as {members:typeof read.members}).members=structuredClone(read.members);
 let appSource=await readFile(new URL('./fixtures/B23.json',import.meta.url),'utf8');for(const [before,after] of mapping)appSource=appSource.replaceAll(before,after);const appTemplate=JSON.parse(appSource) as ScreenFixture;appTemplate.routes['/assistant/conversation']=structuredClone(fixture.routes['/assistant/conversation']!);const apps=await appLifecycleFixture(appTemplate);fixture.routes['/assistant/apps']=apps.routes['/assistant/apps']!;
 fixture.reuse.push('scripts/ui-contracts/member-lifecycle-fixtures.ts: production member admission/archive, validated member journal and MembersService.read; no member memory or schedules');
 return fixture;
}
