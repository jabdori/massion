/** Named members and their admission decisions (docs/architecture/members.md, ADR 0003 §1, §2, §8). Identity lives here; Work context never does. */
import {DomainError,hash} from './domain.ts';
import type {Actor,Mission,Work} from './domain.ts';
import {ASSISTANT_ACTOR_ID,ASSISTANT_CONVERSATION_PREFIX,TITLE_BYTES,headSegment,segmentId} from './assistant-conversation.ts';
import type {AssistantSegment} from './assistant-conversation.ts';
import type {ConnectionWorkbench} from './connection-workbench.ts';
import type {TimeObservation} from './memory-expiry.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';
import {copy} from './ui-copy.ts';
import {representativeName} from './surface-shell.ts';

/** Under the reserved conversation prefix, so no Mission can take this ID and Mission readers refuse it. */
export const MEMBERS_ID=ASSISTANT_CONVERSATION_PREFIX+'members',MEMBER_SHAPES=['round','square','drop','hex','diamond','cloud','clover','tri'] as const,MAX_MEMBERS=32,MAX_DECISIONS=32,LATER_MS=30*86400000;
export interface Member {id:string;name:string;look:{shape:string;color:string};home:string;modelGroup:string;skills:string[];procedures:string[];decisionId:string;admittedAt:number;archivedAt?:number}
export interface MemberRead {id:string;name:string;look:{shape:string;color:string};modelGroup:string;admittedAt:number;archivedAt:number|null;lastActiveAt:number|null;workCount:number;completedWorkCount:number;openWorkCount:number;unknownWorkCount:number;messageCount:number;scheduleCount:number}
export interface MemberDecision {id:string;at:number;topic:string;works:{title:string}[];count:number;handoff?:string;modelGroup:'default';state:'open'|'later'|'done';answeredAt?:number;memberId?:string}
export interface MembersState {kind:'members';id:string;members:Member[];decisions:MemberDecision[]}
export type MembersCommand =
 | {type:'propose-member';decisionId:string;topic:string;works:{title:string}[];count:number;handoff?:string}
 | {type:'set-member-group';memberId:string;modelGroup:string}
 | {type:'archive-member'|'unarchive-member';memberId:string}
 | {type:'defer-member';decisionId:string}
 | {type:'reopen-member';decisionId:string}
 | {type:'admit-member';decisionId:string;memberId:string;name:string;shape:string};
export const memberThread=(memberId:string)=>'member:'+memberId;
export const isMembersState=(value:unknown):value is MembersState=>!!value&&typeof value==='object'&&(value as {kind?:unknown}).kind==='members';
function ensure(condition:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts condition {if(!condition)throw new DomainError(message,code);}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(v);
const line=(v:unknown,chars:number):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&[...v].length<=chars&&v.isWellFormed()&&Buffer.byteLength(v,'utf8')<=TITLE_BYTES&&!/[\u0000-\u001f\u007f]/.test(v);
// Locale-free folding, so a host locale (Turkish dotted I) cannot change which names collide.
const same=(a:string,b:string)=>a.toLowerCase()===b.toLowerCase();
/** Host-derived IDs: a proposal's command ID is the host's own, its decision ID and an admission's member ID follow from the command ID, so lineage can tell a host proposal from a caller's. */
export const PROPOSAL_PREFIX='assistant-member-proposal:',proposalDecisionId=(commandId:string)=>'decision:'+hash(commandId).slice(0,24),admittedMemberId=(commandId:string)=>'member-'+hash(commandId).slice(0,16);

/** Reducer for the one members aggregate. `current` is null only before the first proposal. */
export function applyMembers(current:MembersState|null,command:MembersCommand,actor:Actor,time:TimeObservation):{value:MembersState;events:unknown[]} {
 ensure(actor&&id(actor.id),'Invalid actor');ensure(exact(time,['observedAt'])&&Number.isSafeInteger(time.observedAt)&&time.observedAt>=0,'Host clock observation unavailable');const at=time.observedAt;
 const state:MembersState=current?structuredClone(current):{kind:'members',id:MEMBERS_ID,members:[],decisions:[]};
 const role=(needed:'owner'|'assistant')=>ensure(actor.roles.includes(needed),'Actor lacks required role','denied');
 const decision=(decisionId:unknown)=>{const found=state.decisions.find(d=>d.id===decisionId);ensure(found,'Unknown decision');return found;};
 ensure(current!==null||command?.type==='propose-member','Only a proposal starts the members record');
 switch(command?.type){
  case 'propose-member': {
   role('assistant');ensure((exact(command,['type','decisionId','topic','works','count',...(Object.hasOwn(command,'handoff')?['handoff']:[])])&&(!Object.hasOwn(command,'handoff')||line(command.handoff,TITLE_BYTES)))&&id(command.decisionId)&&line(command.topic,64),'Exact member proposal fields required');
   ensure(Array.isArray(command.works)&&command.works.length>=1&&command.works.length<=2&&command.works.every(w=>exact(w,['title'])&&line(w.title,TITLE_BYTES)),'One or two Work titles required');
   ensure(Number.isSafeInteger(command.count)&&command.count>=2&&command.count<=1000&&command.count>=command.works.length,'Invalid Work count');
   // Done decisions are bounded by MAX_MEMBERS, so the bound counts open and deferred ones only.
   // ponytail: 32 deferred decisions still block every later proposal; prune deferrals older than 30 days if owners defer that often.
   ensure(!state.decisions.some(d=>d.id===command.decisionId),'Decision already exists');ensure(state.decisions.filter(d=>d.state!=='done').length<MAX_DECISIONS,'Decision bound reached','conflict');
   ensure(!state.decisions.some(d=>d.state==='open'),'Another admission decision is open','conflict');
   ensure(!state.decisions.some(d=>d.state==='later'&&same(d.topic,command.topic)&&d.answeredAt!>at-LATER_MS),'This topic was deferred within 30 days','conflict');
   state.decisions.push({id:command.decisionId,at,topic:command.topic,works:structuredClone(command.works),count:command.count,...(command.handoff!==undefined?{handoff:command.handoff}:{}),modelGroup:'default',state:'open'});break;
  }
  case 'defer-member': {role('owner');ensure(exact(command,['type','decisionId']),'Exact defer fields required');const d=decision(command.decisionId);ensure(d.state==='open','Only an open decision is deferred','conflict');d.state='later';d.answeredAt=at;break;}
  case 'reopen-member': {role('owner');ensure(exact(command,['type','decisionId']),'Exact reopen fields required');const d=decision(command.decisionId);ensure(d.state==='later','Only a deferred decision is asked again','conflict');ensure(!state.decisions.some(x=>x.state==='open'),'Another admission decision is open','conflict');d.state='open';delete d.answeredAt;break;}
  case 'admit-member': {
   role('owner');ensure(exact(command,['type','decisionId','memberId','name','shape'])&&id(command.memberId),'Exact admission fields required');const d=decision(command.decisionId);ensure(d.state==='open','Only an open decision admits a member','conflict');
   ensure(line(command.name,32)&&!same(command.name,representativeName)&&!state.members.some(m=>same(m.name,command.name)),'Invalid or taken name');ensure((MEMBER_SHAPES as readonly string[]).includes(command.shape),'Unknown shape');
   ensure(!state.members.some(m=>m.id===command.memberId),'Member already exists');ensure(state.members.length<MAX_MEMBERS,'Member bound reached','conflict');
   // The host picks the colour; the owner sets only a name and a shape (ADR 0003 §8).
   state.members.push({id:command.memberId,name:command.name,look:{shape:command.shape,color:'agent-'+(state.members.length%7+1)},home:'members/'+command.memberId,modelGroup:d.modelGroup,skills:[],procedures:[],decisionId:d.id,admittedAt:at});
   d.state='done';d.answeredAt=at;d.memberId=command.memberId;break;
  }
  case 'set-member-group': {role('owner');ensure(exact(command,['type','memberId','modelGroup'])&&id(command.memberId)&&id(command.modelGroup),'Exact member group fields required');const member=state.members.find(m=>m.id===command.memberId);ensure(member,'Unknown member');member.modelGroup=command.modelGroup;break;}
  case 'archive-member': case 'unarchive-member': {
   role('owner');ensure(exact(command,['type','memberId'])&&id(command.memberId),'Exact member archive fields required');const member=state.members.find(m=>m.id===command.memberId);ensure(member,'Unknown member');
   if(command.type==='archive-member'){ensure(member.archivedAt===undefined,'Member is already archived','conflict');ensure(at>=member.admittedAt,'Archive time precedes admission');member.archivedAt=at;}
   else {ensure(member.archivedAt!==undefined,'Member is not archived','conflict');delete member.archivedAt;}break;
  }
  default: throw new DomainError('Unknown command');
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command),time:structuredClone(time)}]};
}
const fingerprint=(actorId:string,command:MembersCommand)=>hash({actorId,command});
/** Backup lineage: each operation replays from the one before it with the recorded time. */
export function replayMembers(operation:Operation<MembersState>,prior:Operation<MembersState>|undefined):void {
 ensure(operation.aggregateId===MEMBERS_ID&&operation.value.id===MEMBERS_ID,'members aggregate mismatch');ensure(operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'operation revision lineage mismatch');
 const event=operation.events?.[0] as {type:string;actor:string;command:MembersCommand;time:TimeObservation}|undefined;ensure(operation.events.length===1&&exact(event,['type','actor','command','time'])&&event.type===event.command?.type,'members operation requires one typed event');
 ensure((event.actor===ASSISTANT_ACTOR_ID)===(event.command.type==='propose-member'),'members step actor mismatch');ensure(operation.fingerprint===fingerprint(event.actor,event.command),'command fingerprint mismatch');
 ensure(operation.commandId.startsWith(PROPOSAL_PREFIX)===(event.command.type==='propose-member')&&(event.command.type!=='propose-member'||event.command.decisionId===proposalDecisionId(operation.commandId))&&(event.command.type!=='admit-member'||event.command.memberId===admittedMemberId(operation.commandId)),'members command identity mismatch');
 const derived=applyMembers(prior?prior.value:null,event.command,{id:event.actor,roles:[event.actor===ASSISTANT_ACTOR_ID?'assistant':'owner']},event.time);
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'members command/state transition');
}

/** The card shape of conversation-cards.md, plus `form: 'member'` so Add member asks for a name and a shape first. */
function card(state:MembersState,d:MemberDecision){
 const named=d.works.map(w=>w.title).join(' · '),titles=d.count>d.works.length?copy('ui.member-work-more',{titles:named,count:d.count-d.works.length}):named,member=state.members.find(m=>m.id===d.memberId);
 return {id:d.id,at:d.at,title:d.topic,question:copy('ui.member-proposal-question',{topic:d.topic,count:d.count}),rows:[[copy('ui.this-month'),titles],...(d.handoff?[[copy('ui.member-work'),d.handoff]]:[]),[copy('settings.heading.03'),copy('settings.text.01')]],action:'Add member',form:'member',state:d.state,...(d.state==='done'?{line:copy('ui.member-added',{member:member?.name??d.topic}),...(member?{memberId:member.id}:{})}:{})};
}
const OWNER='local-owner';
function lifecycleCommand(input:unknown):{commandId:string;command:MembersCommand}{
 ensure(exact(input,['commandId','action','memberId'])&&id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.memberId)&&['archive','unarchive'].includes(input.action as string),'Exact member lifecycle fields required');
 return {commandId:input.commandId,command:{type:input.action==='archive'?'archive-member':'unarchive-member',memberId:input.memberId}};
}
export class MembersService {
 readonly #groupWrites=new Map<string,Promise<CommitResult<MembersState>>>();
 readonly #store:Store<any>;readonly #intake:()=>string|undefined;readonly #clock:()=>number;
 constructor(store:Store<any>,intake:()=>string|undefined,clock:()=>number=Date.now){this.#store=store;this.#intake=intake;this.#clock=clock;}
 async #state(){return await this.#store.load(MEMBERS_ID) as Snapshot<MembersState>|null;}
 /** Only active identities reach the existing turn/admission path; historical reads retain archived identities. */
 async roster(){return ((await this.#state())?.value.members??[]).filter(m=>m.archivedAt===undefined).map(m=>({id:m.id,name:m.name,modelGroup:m.modelGroup}));}
 async read(){
  for(let attempt=0;attempt<3;attempt++){
   const initial=await this.#store.readState(MEMBERS_ID),feedId=initial.feedId,s=initial.snapshot as Snapshot<MembersState>|null,v=s?.value;let replaced=false;
   const load=async(id:string)=>{const read=await this.#store.readState(id);if(read.feedId!==feedId){replaced=true;throw new DomainError('Database changed during member read','conflict');}return read.snapshot;};
   try{
    const missionIds=new Set<string>(),intake=this.#intake();if(intake&&!intake.startsWith(ASSISTANT_CONVERSATION_PREFIX))missionIds.add(intake);
    const remember=(id:string|undefined)=>{if(id&&!id.startsWith(ASSISTANT_CONVERSATION_PREFIX))missionIds.add(id);};
    const conversation=async(thread:string)=>{
     let messageCount=0,lastActiveAt:number|null=null;
     const activity=(at:number|undefined)=>{if(at!==undefined)lastActiveAt=Math.max(lastActiveAt??0,at);};
     const head=await headSegment({load},thread);
     for(let n=1;n<=head;n++){
      const segment=(await load(segmentId(n,thread)))?.value as AssistantSegment|undefined;
      for(const message of segment?.messages??[]){messageCount++;activity(message.at);}
      for(const turn of segment?.turns??[]){activity(turn.ownership?.startedAt);remember(turn.outcome?.missionId);remember(turn.steer?.missionId);}
     }
     return {messageCount,lastActiveAt};
    };
    // Follow every retained Mission pin, including old intake Missions; the UI Work list is truncated.
    await conversation('');const activity=new Map<string,Awaited<ReturnType<typeof conversation>>>();
    for(const m of v?.members??[])activity.set(m.id,await conversation(memberThread(m.id)));
    const works:Work[]=[];for(const missionId of missionIds){const mission=(await load(missionId))?.value as Mission|undefined;works.push(...mission?.works??[]);}
    const members:MemberRead[]=(v?.members??[]).map(m=>{
     const own=works.filter(w=>w.assistantSource?.memberId===m.id),chat=activity.get(m.id)!;let lastActiveAt:number|null=chat.lastActiveAt;
     for(const work of own)for(const at of [work.runtimeRun?.ownership?.startedAt,work.endedAt])if(at!==undefined)lastActiveAt=Math.max(lastActiveAt??0,at);
     // Schedules dispatch through the Representative, without a member binding.
     return {id:m.id,name:m.name,look:structuredClone(m.look),modelGroup:m.modelGroup,admittedAt:m.admittedAt,archivedAt:m.archivedAt??null,lastActiveAt,workCount:own.length,completedWorkCount:own.filter(w=>w.acceptance==='accepted').length,openWorkCount:own.filter(w=>w.acceptance!=='accepted'&&w.execution!=='cancelled'&&w.execution!=='settled').length,unknownWorkCount:own.filter(w=>!w.runtimeRecovery&&w.effects.some(e=>e.status==='unknown')).length,messageCount:chat.messageCount,scheduleCount:0};
    });
    await load(MEMBERS_ID);
    return {feedId,revision:s?.revision??0,members:members.filter(m=>m.archivedAt===null),archived:members.filter(m=>m.archivedAt!==null),decisions:v?v.decisions.map(d=>card(v,d)):[]};
   }catch(error){if(!replaced)throw error;}
  }
  throw new DomainError('Database changed during member read','conflict');
 }
 async member(memberId:string){return (await this.#state())?.value.members.find(m=>m.id===memberId);}
 async act(input:unknown):Promise<CommitResult<MembersState>>{
  const {commandId,command}=lifecycleCommand(input);return this.#dispatch(commandId,OWNER,command);
 }
 async outcome(input:unknown){
  const {commandId,command}=lifecycleCommand(input),result=await this.#store.lookupOperation({id:MEMBERS_ID,commandId,fingerprint:fingerprint(OWNER,command)});return {commandId,status:result.status};
 }
 /** Host-only step for the Representative (no HTTP route, so no caller can write a Representative proposal): the host writes the rows from Representative Works whose run started this calendar month (UTC). */
 async propose(input:unknown):Promise<CommitResult<MembersState>>{
  ensure((exact(input,['topic','workIds'])||exact(input,['topic','workIds','handoff'])&&line(input.handoff,TITLE_BYTES))&&Array.isArray(input.workIds)&&input.workIds.length<=64&&input.workIds.every(id)&&new Set(input.workIds).size===input.workIds.length,'Exact member proposal fields required');
  ensure(input.workIds.length>=2,'At least two Works are required');const intake=this.#intake(),mission=intake?(await this.#store.load(intake))?.value as Mission|undefined:undefined;
  const now=new Date(this.#clock()),month=(t:number)=>{const d=new Date(t);return d.getUTCFullYear()===now.getUTCFullYear()&&d.getUTCMonth()===now.getUTCMonth();};
  // One canonical order for identity, fingerprint and the rows, so a reordered ask replays.
  const ordered=[...input.workIds as string[]].sort();
  const works=ordered.map(workId=>{const w=mission?.works?.find(x=>x.id===workId);ensure(w&&w.assistantSource,'Unknown Representative Work: '+workId);ensure(w.runtimeRun?.ownership&&month(w.runtimeRun.ownership.startedAt),'Work did not run this month: '+workId);return w;});
  // The same topic over the same Works is one proposal: asking again replays it instead of opening a second card.
  const commandId=PROPOSAL_PREFIX+hash({topic:input.topic,works:ordered,...(input.handoff!==undefined?{handoff:input.handoff}:{})}).slice(0,64);
  return this.#dispatch(commandId,ASSISTANT_ACTOR_ID,{type:'propose-member',decisionId:proposalDecisionId(commandId),topic:input.topic as string,works:works.slice(0,2).map(w=>({title:w.title})),count:works.length,...(input.handoff!==undefined?{handoff:input.handoff as string}:{})});
 }
 /** The owner's answer to a card. `act` admits and needs a name and a shape; the member ID derives from the command ID, so a replay admits once. */
 async decide(input:unknown):Promise<CommitResult<MembersState>>{
  const act=(input as {answer?:unknown})?.answer==='act';ensure(exact(input,act?['commandId','decisionId','answer','member']:['commandId','decisionId','answer'])&&id(input.commandId)&&id(input.decisionId)&&['act','later','ask'].includes(input.answer as string),'Exact decision answer fields required'+(act?' with a name and a shape':''));
  const decisionId=input.decisionId as string;if(!act)return this.#dispatch(input.commandId,OWNER,{type:input.answer==='later'?'defer-member':'reopen-member',decisionId});
  const member=input.member;ensure(exact(member,['name','shape'])&&typeof member.name==='string'&&typeof member.shape==='string','A name and a shape are required');
  return this.#dispatch(input.commandId,OWNER,{type:'admit-member',decisionId,memberId:admittedMemberId(input.commandId),name:member.name,shape:member.shape});
 }
 async setGroup(input:unknown,connections:ConnectionWorkbench):Promise<CommitResult<MembersState>>{
  ensure(exact(input,['commandId','memberId','modelGroup'])&&id(input.commandId)&&!input.commandId.startsWith('assistant-')&&id(input.memberId)&&id(input.modelGroup),'Exact member group fields required');
  const commandId=input.commandId,command:MembersCommand={type:'set-member-group',memberId:input.memberId,modelGroup:input.modelGroup},pending=this.#groupWrites.get(commandId);
  if(pending){await pending;return this.#dispatch(commandId,OWNER,command,connections);}
  const result=this.#dispatch(commandId,OWNER,command,connections);this.#groupWrites.set(commandId,result);try{return await result;}finally{this.#groupWrites.delete(commandId);}
 }
 /** Lookup after the load, CAS on the revision read; a lost or overlapping answer replays by command ID. */
 async #dispatch(commandId:string,actorId:string,command:MembersCommand,connections?:ConnectionWorkbench):Promise<CommitResult<MembersState>>{
  const identity={id:MEMBERS_ID,commandId,fingerprint:fingerprint(actorId,command)},actor:Actor={id:actorId,roles:[actorId===ASSISTANT_ACTOR_ID?'assistant':'owner']};
  for(let attempt=0;attempt<3;attempt++){
   // Load first, then look up: an answer committed before the load is found here, one after it fails the commit and is found on retry.
   const snapshot=await this.#state(),prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   const commit=()=>{const {value,events}=applyMembers(snapshot?.value??null,command,actor,{observedAt:this.#clock()});return this.#store.commit({id:MEMBERS_ID,expectedRevision:snapshot?.revision??0,commandId,fingerprint:identity.fingerprint,value,events,outbox:[]});};
   const result=command.type==='set-member-group'?await connections!.save(()=>{ensure(connections!.list().modelGroups.some(g=>g.id===command.modelGroup),'Unknown model group');return commit();}):await commit();
   // A stale revision or the same command ID committed meanwhile: the next lookup replays it or reports a different command.
   if(result.status!=='conflict')return result;
  }
  return {status:'conflict',revision:(await this.#state())?.revision??0,reason:'revision'};
 }
}
