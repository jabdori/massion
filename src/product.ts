import {readRejectedText} from './rejected-text.ts';
import type {RejectedTextInput} from './rejected-text.ts';
import {runSequence} from './run-sequence.ts';
import type {RunSequenceInput} from './run-sequence.ts';
import {readWorkConversation,readMissionConversation} from './work-conversation.ts';
import {readRuntimeOwnership,HostDrainError} from './runtime-lifetime.ts';
import {readRecordArtifact} from './record-artifact.ts';
import {readReflectionTrail} from './reflection-trail.ts';
import type {ArtifactReader,RecordArtifactInput} from './record-artifact.ts';
import {Application} from './application.ts';
import {MEMBERS_ID,isMembersState} from './members.ts';
import {DomainError,hash,memoryVersionHash,workInputHash} from './domain.ts';
import {ASSISTANT_ACTOR_ID} from './assistant-conversation.ts';
import {ROUNDING_ORACLE,keys,orderCases,calculationPlan} from './growth-evaluation.ts';
import {verifyGrowthCalculation,wasConfined} from './execution.ts';
import type {OrderCase} from './growth-evaluation.ts';
import {ProviderRegistry} from './providers.ts';
import type {Mission,Command,ExecutionGate} from './domain.ts';
import type {ExecutionChoice,SelectionPreflight,DefaultResolution} from './selectable-runtime.ts';
import type {ConnectionDiagnostic} from './provider-profiles.ts';
import {workAdmissionPreflight,rejectedRun,hostBusyPreflight,captureRuntimeFence,checkRuntimeFence,withRuntimeFence,RunUnsettledError,RunAdmissionUnknownError} from './configured-runtime.ts';
import type {WorkRuntime,RuntimeFence,RuntimeResult} from './configured-runtime.ts';
import {withQueueTake,QueueSlotLostError,inQueueTake} from './run-queue.ts';
import type {RunQueueJoinInput,RunQueueHost,RunQueueEntry} from './run-queue.ts';
import type {Store} from './storage.ts';
const MEMBER_UNKNOWN:ConnectionDiagnostic={code:'member_unknown',message:'The assigned member is unavailable; no other execution route was used.'};
const MEMBER_ARCHIVED:ConnectionDiagnostic={code:'member_archived',message:'The assigned member is archived; no other execution route was used.'};
/**
 * Refusal codes that mean a queued entry can never run as queued: the pass records the reason on the
 * Work (the existing block-work blocker shape) and removes the entry. Everything else — settings_pending
 * while a save settles, a fence or store that could not be read, any unknown code — keeps the entry
 * stored for the next trigger. The default is KEEP.
 */
const RUN_QUEUE_FINAL_REFUSALS=new Set(['member_archived','member_unknown','input_changed','monthly_budget_waiting','work_already_started','work_cancelled','revision_conflict','input_snapshot_missing','clarification_pending','prerequisite_unavailable','source_input_unavailable','organization_input_unavailable','memory_input_unavailable','work_not_fresh','work_blocked','budget_exceeded','routing_configuration_changed','selection_required','authorization_mismatch','profile_not_authorized','output_limit','usage_unsupported','evidence_mode_mismatch','runtime_unavailable']);
/** Final codes whose reason is already the Work's own stored state; no second blocker is written for these. */
const RUN_QUEUE_INTRINSIC_REFUSALS=new Set(['work_already_started','work_cancelled','monthly_budget_waiting','work_blocked']);
/** Current local-owner API. Production authentication and provider execution remain explicit gates. */
export class ProductService {
 readonly app:Application;readonly providers:ProviderRegistry;readonly runtime?:WorkRuntime;readonly artifacts?:ArtifactReader;
 constructor(store:Store<Mission>,providers=new ProviderRegistry(),runtime?:WorkRuntime,artifacts?:ArtifactReader) {this.artifacts=artifacts;this.runtime=runtime;this.app=new Application(store,[{id:'local-owner',roles:['owner']}]);this.providers=providers;}
 async create(input:Parameters<Application['create']>[0],commandId:string) {return this.app.create(input,'local-owner',commandId);}
 async admit(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;title:string;budget:number;conversationSource?:import('./conversation-work.ts').ConversationSelection;correction?:import('./work-correction.ts').CorrectionSelection}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','title','budget','correction','conversationSource']);
  const executionGate=this.executionGate((await this.app.store.load(missionId))?.value);
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'admit-work',workId:input.workId,title:input.title,budget:input.budget,...(Object.hasOwn(input,'conversationSource')?{conversationSource:input.conversationSource}:{}),...(Object.hasOwn(input,'correction')?{correction:input.correction}:{}),...(executionGate?{executionGate}:{})}});
 }
 /** Shared by owner and Representative admission: the host, never the caller, pins this gate. */
 executionGate(mission:Mission|undefined):ExecutionGate|undefined {
  const selected=this.providers.select(['text-output']);const available=mission&&this.runtime?.availability(mission);
  // Even a configured model does not imply a permitted execution/assurance runtime.
  return available?.ready?undefined:this.runtime?.configuration?{code:'runtime_unavailable',detail:available?.reason??'Choose an explicitly authorized execution connection.'}:selected.status==='unavailable'?{code:selected.code,detail:selected.reason}:{code:'runtime_unavailable',detail:'A provider is configured, but general execution and independent assurance have not been enabled. No provider invocation was made.'};
 }
 async clarifyWork(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;questionId:string;text:string},answer:boolean) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','questionId','text']);const {commandId,expectedRevision,...question}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:answer?'answer-work-question':'ask-work-question',...question}});
 }
 async appendMissionMessage(missionId:string,input:{commandId:string;expectedRevision:number;messageId:string;replyTo:string|null;text:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','messageId','replyTo','text']);const {commandId,expectedRevision,...message}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'append-mission-message',...message}});
 }
 async readMissionConversation(missionId:string,feedId?:string){return readMissionConversation(this.app.store,missionId,feedId);}
 async appendWorkMessage(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;messageId:string;replyTo:string|null;text:string;stepNote?:import('./domain.ts').StepNote}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','messageId','replyTo','text','stepNote']);const {commandId,expectedRevision,...message}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'append-work-message',...message}});
 }
 async readWorkConversation(missionId:string,workId:string,feedId?:string){return readWorkConversation(this.app.store,missionId,workId,feedId);}
 async attachWorkPrerequisite(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;prerequisiteId:string;criteriaHash:string;inputHash:string;reason:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','prerequisiteId','criteriaHash','inputHash','reason']);const {commandId,expectedRevision,...pin}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'attach-work-prerequisite',...pin}});
 }
 async attachWorkSource(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;documentId:string;version:number;contentSha256:string;reason:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','documentId','version','contentSha256','reason']);
  const {commandId,expectedRevision,...selection}=input;
  return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'attach-work-source',...selection}});
 }
 async captureDocument(missionId:string,input:{commandId:string;expectedRevision:number;document:Pick<import('./domain.ts').DocumentVersion,'id'|'version'|'title'|'content'|'source'>}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','document']);keys(input.document,['id','version','title','content','source']);
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'capture-document',document:input.document}});
 }
 async recordRelation(missionId:string,input:{commandId:string;expectedRevision:number;relation:Omit<import('./domain.ts').Relation,'inferred'>}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','relation']);keys(input.relation,['from','to','type','fromVersion','toVersion','provenance']);
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'record-relation',relation:input.relation}});
 }
 async reviseOrganization(missionId:string,input:{commandId:string;expectedRevision:number;version:number;reason:string;responsibilities:import('./domain.ts').OrganizationResponsibility[]}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','version','reason','responsibilities']);
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revise-organization',version:input.version,reason:input.reason,responsibilities:input.responsibilities}});
 }
 async reviseMissionConstraints(missionId:string,input:{commandId:string;expectedRevision:number;constraints:string[];reason:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','constraints','reason']);const {commandId,expectedRevision,...revision}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'revise-mission-constraints',...revision}});
 }
 async reviseMission(missionId:string,input:{commandId:string;expectedRevision:number;purpose:string;criteria:Mission['criteria']}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revise-mission',purpose:input.purpose,criteria:{version:input.criteria.version,description:input.criteria.description,oracle:input.criteria.oracle}}});
 }
 async saveMemory(missionId:string,input:{commandId:string;expectedRevision:number;memory:Pick<import('./domain.ts').Memory,'id'|'version'|'content'|'source'|'name'|'sourceWork'>}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','memory']);keys(input.memory,['id','version','content','source','name','sourceWork']);
  const {commandId,expectedRevision}=input;
  const memory={...input.memory};
  const current=await this.app.store.load(missionId);if(!current)throw new DomainError('Unknown Mission');
  return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'save-memory',memory:{...memory,scope:current.value.scope,authority:'explicit',effective:true}}});
 }
 async declareMemoryExpiry(missionId:string,input:{commandId:string;expectedRevision:number;expiryId:string;memory:import('./memory-conflicts.ts').MemoryConflictReference;deadline:string;reason:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','expiryId','memory','deadline','reason']);const {commandId,expectedRevision,...declaration}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'declare-memory-expiry',...declaration}});
 }
 async declareMemoryConflict(missionId:string,input:{commandId:string;expectedRevision:number;conflictId:string;first:import('./memory-conflicts.ts').MemoryConflictReference;second:import('./memory-conflicts.ts').MemoryConflictReference;reason:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','conflictId','first','second','reason']);const {commandId,expectedRevision,...declaration}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'declare-memory-conflict',...declaration}});
 }
 async retireMemory(missionId:string,input:{commandId:string;expectedRevision:number;memoryId:string;version:number;reason:string}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'retire-memory',memoryId:input.memoryId,version:input.version,reason:input.reason}});
 }
 async reviseBudget(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;limit:number;reason:string}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revise-budget',workId:input.workId,limit:input.limit,reason:input.reason}});
 }
 async adoptGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string}) {
  const envelope={missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'adopt-growth' as const,recordChangeTime:true as const,growthId:input.growthId,baseline:input.baseline,candidate:input.candidate}},result=await this.app.dispatch(envelope);
  if(result.status==='conflict'&&result.reason==='idempotency'){const {recordChangeTime,...command}=envelope.command;return this.app.dispatch({...envelope,command});}return result;
 }
 async proposeGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:Pick<import('./domain.ts').Memory,'id'|'version'|'content'|'source'|'name'|'sourceWork'>;counterevidence:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','growthId','baseline','candidate','counterevidence']);keys(input.candidate,['id','version','content','source','name','sourceWork']);
  const snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');
  const service=new Application(this.app.store,[{id:'local-owner',roles:['representative']}]);
  return service.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'propose-growth',candidateMemory:{...input.candidate,scope:snapshot.value.scope,authority:'learned',effective:false},proposal:{id:input.growthId,proposer:'local-owner',target:'memory',baseline:input.baseline,candidate:input.candidate.id+'@'+input.candidate.version,counterevidence:input.counterevidence,status:'proposed'}}});
 }
 async evaluateGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string;oracle:string;cases:OrderCase[]}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','growthId','baseline','candidate','oracle','cases']);if(input.oracle!==ROUNDING_ORACLE)throw new DomainError('Unsupported Growth oracle; only rounding-calculation/v1 is enabled. No provider invocation.');const cases=orderCases(input.cases),snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');const g=snapshot.value.growth.find(g=>g.id===input.growthId);if(!g||g.baseline!==input.baseline||g.candidate!==input.candidate)throw new DomainError('Exact Growth memory versions mismatch');
  const baseline=snapshot.value.memories.find(m=>m.id+'@'+m.version===g.baseline),candidate=snapshot.value.memories.find(m=>m.id+'@'+m.version===g.candidate);if(!baseline||!candidate)throw new DomainError('Exact scoped memories required');
  const plan=calculationPlan(baseline,candidate,cases),actorId='host-rounding-oracle/v1',command:Command={type:'evaluate-growth',ownerDecision:true,growthId:g.id,baseline:plan.baseline,candidate:plan.candidate,heldOut:plan.heldOut,binding:{baseline:g.baseline,candidate:g.candidate,baselineHash:memoryVersionHash(baseline),candidateHash:memoryVersionHash(candidate)}},envelope={missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId,command},service=new Application(this.app.store,[{id:actorId,roles:['evaluator']}]);
  const prior=await this.app.store.lookupOperation({id:missionId,commandId:input.commandId,fingerprint:hash({actorId,command,expectedRevision:input.expectedRevision})});if(prior.status==='conflict'&&prior.reason==='idempotency'){const {ownerDecision,...legacy}=command,replay=await this.app.store.lookupOperation({id:missionId,commandId:input.commandId,fingerprint:hash({actorId,command:legacy,expectedRevision:input.expectedRevision})});if(replay.status==='committed'||replay.status==='replayed')return replay;for(const confined of [true,false] as const){const stored=await this.app.store.lookupOperation({id:missionId,commandId:input.commandId,fingerprint:hash({actorId,command:{...command,confined},expectedRevision:input.expectedRevision})});if(stored.status==='committed'||stored.status==='replayed')return stored;}}if(prior.status!=='unknown')return prior;
  if(snapshot.revision!==input.expectedRevision)return service.dispatch(envelope);if(g.status!=='proposed'||g.proposer===actorId||baseline.scope!==snapshot.value.scope||candidate.scope!==snapshot.value.scope||!baseline.effective||candidate.effective)throw new DomainError('Independent proposed Growth with current scoped baseline required');
  const confirmation=await verifyGrowthCalculation(baseline,candidate,cases);return service.dispatch({...envelope,command:{...command,confined:wasConfined(confirmation)}});
 }
 async revertGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string}) {
  const envelope={missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revert-growth' as const,recordChangeTime:true as const,growthId:input.growthId,baseline:input.baseline,candidate:input.candidate}},result=await this.app.dispatch(envelope);
  if(result.status==='conflict'&&result.reason==='idempotency'){const {recordChangeTime,...command}=envelope.command;return this.app.dispatch({...envelope,command});}return result;
 }
 async readRunOwnership(missionId:string,workId:string,feedId?:string){return readRuntimeOwnership(this.app.store,missionId,workId,feedId,runId=>this.runtime?.owns?.(missionId,workId,runId)??false);}
 async readRejectedText(missionId:string,workId:string,input:RejectedTextInput){return readRejectedText(this.app.store,this.artifacts,missionId,workId,input);}
 async reflectionTrail(missionId:string,workId:string,revision?:number,feedId?:string){return readReflectionTrail(this.app.store,this.artifacts,missionId,workId,revision,feedId);}
 async readAcceptedText(missionId:string,workId:string,input:RecordArtifactInput) {return readRecordArtifact(this.app.store,this.artifacts,missionId,workId,input);}
 /** Unselected Work keeps its pinned member; resolve that member’s group for both preflight and run. A local miss may be stale: another host on the same database may have saved a default. Re-read once, then resolve again; a local hit proceeds and admission blocks if the stored revision changed. */
 async resolveFresh(mission:Mission,workId?:string,fence?:RuntimeFence):Promise<DefaultResolution>{
  const source=mission.works.find(w=>w.id===workId)?.assistantSource;let group:string|undefined;
  if(source?.memberId){const state=(await this.app.store.load(MEMBERS_ID))?.value,member=isMembersState(state)?state.members.find(m=>m.id===source.memberId):undefined;
   if(!member)return {status:'unresolved',diagnostics:[MEMBER_UNKNOWN]};
   if(member.archivedAt!==undefined)return {status:'unresolved',diagnostics:[MEMBER_ARCHIVED]};
   if(member.modelGroup!=='default'){if(!this.runtime!.resolveGroupWork)return {status:'unresolved',diagnostics:[{code:'model_group_missing',message:'No member group routing is configured on this host.'}]};group=member.modelGroup;}
  }
  const resolve=()=>group?this.runtime!.resolveGroupWork!(group,mission,source!.representative):this.runtime!.resolveDefault!(mission),local=resolve();if(local.status==='resolved'||!this.runtime!.refreshStoredSettings)return local;
  if(fence){const changed=await checkRuntimeFence(this.app.store,this.runtime!,fence,false);if(changed)return {status:'unresolved',diagnostics:[changed]};}
  const refreshed=await this.runtime!.refreshStoredSettings();if(fence&&refreshed)fence.configuration=hash(this.runtime!.configuration?.()??null);return resolve();
 }

 async preflight(missionId:string,workId:string,expectedRevision:number,choice?:ExecutionChoice):Promise<(SelectionPreflight&{selection?:{source:'default';choice:ExecutionChoice}})|null> {
  choice=structuredClone(choice);const [fence,snapshot]=await Promise.all([this.runtime?captureRuntimeFence(this.app.store,this.runtime):undefined,this.app.store.load(missionId)]);if(!snapshot||!snapshot.value.works.some(w=>w.id===workId))return null;
  const resolved=choice===undefined&&this.runtime?.resolveDefault?await this.resolveFresh(snapshot.value,workId,fence):undefined;
  const changed=fence?await checkRuntimeFence(this.app.store,this.runtime!,fence):undefined;if(changed){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return {...result,ready:false,diagnostics:[...result.diagnostics,changed]};}
  if(resolved?.status==='unresolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return {...result,ready:false,diagnostics:[...result.diagnostics,...resolved.diagnostics]};}
  if(resolved)return {...this.runtime!.preflight!(snapshot,workId,expectedRevision,resolved.choice),selection:{source:'default',choice:resolved.choice}};
  if(this.runtime?.preflight)return this.runtime.preflight(snapshot,workId,expectedRevision,choice);
  const result=workAdmissionPreflight(snapshot,workId,expectedRevision);
  return {...result,ready:false,diagnostics:[...result.diagnostics,{code:'selection_unavailable',message:'No runtime with execution preflight is configured.'}]};
 }
 async runSequence(missionId:string,input:RunSequenceInput){if(!this.runtime)throw new DomainError('No explicitly configured Work runtime');
  input=structuredClone(input);
  // Capacity including waiting queue entries is captured before any await: a sequence never runs ahead of queued Work.
  const busyAtEntry=this.runtime.runQueue?this.runtime.runQueue.busy():this.runtime.hasActiveAdmission?.()??false;
  if(!input||typeof input!=='object'||Object.hasOwn(input,'selection')||!this.runtime.resolveDefault)return runSequence(this.app.store,this.runtime,missionId,input,undefined,busyAtEntry);
  const [fence,snapshot]=await Promise.all([captureRuntimeFence(this.app.store,this.runtime),this.app.store.load(missionId)]);if(!snapshot)throw new DomainError('Unknown Mission');const resolved=await this.resolveFresh(snapshot.value,input.works?.[0]?.workId,fence);
  // Resolve and enter synchronously: the sequence captures the configuration that produced this choice.
  if(resolved.status==='unresolved')return runSequence(this.app.store,this.runtime,missionId,input,resolved.diagnostics,busyAtEntry,undefined,fence);
  return {...await runSequence(this.app.store,this.runtime,missionId,input,undefined,busyAtEntry,(mission,workId)=>this.resolveFresh(mission,workId),fence),selection:{source:'default' as const,choice:resolved.choice}};
 }
 /** `activationActorId` and `expectedDefault` are set only by the conversation host path; HTTP runs are the owner's. `expectedDefault` is the default choice an earlier check approved: a different one now refuses the run. */
 async run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice,activationActorId?:string,expectedDefault?:ExecutionChoice){if(!this.runtime)throw new Error('No explicitly configured Work runtime');
  choice=structuredClone(choice);expectedDefault=structuredClone(expectedDefault);
  const queue=this.runtime.runQueue,queueTake=inQueueTake();
  const busyAtEntry=!queueTake&&(queue?queue.busy():this.runtime.hasActiveAdmission?.()??false);
  const [fence,snapshot]=await Promise.all([captureRuntimeFence(this.app.store,this.runtime),this.app.store.load(missionId)]);if(!snapshot)throw new DomainError('Unknown Mission');
  // The member aggregate is read at this admission: a Work of a member who is gone or archived is refused
  // exactly as a direct request, whether the host is idle, busy or taking a queued entry.
  const memberGate=await this.#memberGate(snapshot.value,workId);
  if(memberGate){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return rejectedRun({...result,ready:false,diagnostics:[...result.diagnostics,memberGate]},snapshot);}
  const resolved=choice===undefined&&this.runtime.resolveDefault?await this.resolveFresh(snapshot.value,workId,fence):undefined;
  const changed=await checkRuntimeFence(this.app.store,this.runtime,fence);if(changed)return rejectedRun({...workAdmissionPreflight(snapshot,workId,expectedRevision),ready:false,diagnostics:[changed]},snapshot);
  if(!resolved){
   // A stale revision is refused with the same conflict an idle host returns; joining never widens it.
   if(busyAtEntry){const checked=workAdmissionPreflight(snapshot,workId,expectedRevision,choice?.outputTokenCap);if(queue)return checked.ready?queue.join(this.#queueInput(snapshot.value,workId,runId,activationActorId,choice),snapshot):rejectedRun(checked,snapshot);return rejectedRun(checked.ready?hostBusyPreflight(checked):checked,snapshot);}
   return withRuntimeFence(fence,()=>this.runtime!.run(missionId,workId,runId,expectedRevision,choice,activationActorId));}
  if(busyAtEntry&&resolved.status==='resolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision,resolved.choice.outputTokenCap);if(queue)return result.ready?queue.join(this.#queueInput(snapshot.value,workId,runId,activationActorId,resolved.choice),snapshot):rejectedRun(result,snapshot);return rejectedRun(result.ready?hostBusyPreflight(result):result,snapshot);}
  // An unresolved default admits nothing, so it returns blocked even while draining (HTTP refuses mutations during drain first).
  if(resolved.status==='unresolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return rejectedRun({...result,ready:false,diagnostics:[...result.diagnostics,...resolved.diagnostics]},snapshot);}
  if(expectedDefault&&hash(resolved.choice)!==hash(expectedDefault)){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return rejectedRun({...result,ready:false,diagnostics:[...result.diagnostics,{code:'default_route_changed',message:'The default route changed after the check this run was approved by; nothing was started.'}]},snapshot);}
  // A local change cannot start while the run awaits the stored revision without the run seeing it; a changed revision blocks rather than re-resolving.
  return {...await withRuntimeFence(fence,()=>this.runtime!.run(missionId,workId,runId,expectedRevision,resolved.choice,activationActorId)),selection:{source:'default' as const,choice:resolved.choice}};
 }
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  input=structuredClone(input);
  if(!['cancel','steer','quarantine-runtime','close-expired-runtime'].includes(input.command?.type))throw new Error('Only cancel, steer, quarantine-runtime and close-expired-runtime are exposed as owner interventions');
  if(input.command.type==='close-expired-runtime'&&(!Number.isSafeInteger(input.command.observedAt)||input.command.observedAt>Date.now()))throw new DomainError('Expired closure observation cannot be in the future');
  const result=await this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
  if(result.status!=='conflict'&&'workId' in input.command){const workId=input.command.workId;if(input.command.type!=='steer'||result.value.works.find(w=>w.id===workId)?.execution!=='active')this.runtime?.interrupt(missionId,workId);}return result;
 }
 #queueInput(mission:Mission,workId:string,runId:string,activationActorId:string|undefined,choice?:ExecutionChoice):RunQueueJoinInput{
  const work=mission.works.find(w=>w.id===workId)!;
  return {missionId:mission.id,work:{workId,inputHash:workInputHash(work),criteriaHash:hash(work.criteria)},runId,requestedBy:activationActorId===ASSISTANT_ACTOR_ID?'assistant':'owner',...(choice?{choice}:{})};
 }
 /** Member liveness at admission: the members aggregate as it is at this read decides, for pinned and default choices alike. */
 async #memberGate(mission:Mission,workId:string):Promise<ConnectionDiagnostic|undefined>{
  const memberId=mission.works.find(w=>w.id===workId)?.assistantSource?.memberId;if(memberId===undefined)return;
  const state=(await this.app.store.load(MEMBERS_ID))?.value,member=isMembersState(state)?state.members.find(m=>m.id===memberId):undefined;
  return member?member.archivedAt===undefined?undefined:MEMBER_ARCHIVED:MEMBER_UNKNOWN;
 }
 /**
  * The one taker of queued runs. The caller holds the hand-over mark; each entry is re-admitted
  * against current state (hash-pinned Work, today's preflight, the fence and the stored settings)
  * and carries no permission of its own. A refusal whose every code is final records the reason
  * on the Work and drops the entry; anything else (storage contention, settings pending, an
  * unknown failure) leaves it stored and stops the pass for the next trigger, so a transient
  * error never loses an entry. A removal that fails, or a reason that cannot be recorded, halts
  * the queue (the head would otherwise run twice); the halt is the workbench's, cleared by restart.
  */
 async runQueuePass(){
  const queue=this.runtime?.runQueue;if(!queue)return;
  for(;;){
   if(queue.hostDraining()||this.runtime?.hasActiveAdmission?.())return;
   const head=(await queue.entries())[0];if(!head)return;
   const snapshot=await this.app.store.load(head.missionId),work=snapshot?.value.works.find(w=>w.id===head.work.workId);
   if(!snapshot||!work){if(!(await this.#removeQueuedEntry(queue,head)))return;continue;}
   if(workInputHash(work)!==head.work.inputHash||hash(work.criteria)!==head.work.criteriaHash){
    if(!(await this.#settleQueuedRefusal(queue,head,[{code:'input_changed',message:'The Work input or criteria changed while it was queued; the queued request was removed without a run.'}])))return;continue;}
   const checked=workAdmissionPreflight(snapshot,head.work.workId,snapshot.revision,head.choice?.outputTokenCap);
   if(!checked.ready){if(!(await this.#settleQueuedRefusal(queue,head,checked.diagnostics)))return;continue;}
   // The revision of this same snapshot is the admission's expected revision: any change between the
   // hash comparison above and the activation commit below surfaces as the CAS conflict it is.
   let result:RuntimeResult|undefined;
   try{result=await withQueueTake(()=>this.run(head.missionId,head.work.workId,head.runId,snapshot.revision,head.choice,head.requestedBy==='assistant'?ASSISTANT_ACTOR_ID:undefined));}
   catch(error){
    if(error instanceof QueueSlotLostError||error instanceof HostDrainError)return;
    // A consumed or possibly consumed run identity can never run as queued again: replay is forbidden.
    if(error instanceof RunUnsettledError||error instanceof RunAdmissionUnknownError||error instanceof Error&&error.name==='CommitOutcomeUnknownError'){if(!(await this.#removeQueuedEntry(queue,head)))return;throw error;}
    // A deterministic dispatch refusal never runs as queued either; every other error says nothing
    // about the entry, so it stays and the pass's rejection is surfaced to the trigger.
    if(!(error instanceof DomainError))throw error;
    if(!(await this.#removeQueuedEntry(queue,head)))return;continue;
   }
   if(result===undefined)continue;
   if(result.status!=='settled'){
    // A direct request only returns these refusals; the queue also records the reason on the Work.
    const refused=result.status==='cancelled'?[{code:'work_cancelled',message:result.reason??''}]
     :result.status==='already-started'?[{code:'work_already_started',message:result.reason??''}]
     :result.diagnostics??[];
    if(!(await this.#settleQueuedRefusal(queue,head,refused)))return;continue;}
   if(!(await this.#removeQueuedEntry(queue,head)))return;
  }
 }
 /** Removes a finished entry; a failed removal halts the queue — the head would otherwise run twice — and ends the pass. */
 async #removeQueuedEntry(queue:RunQueueHost,head:RunQueueEntry):Promise<boolean>{
  try{await queue.remove(head);}catch{queue.halt?.('queue_removal_failed',{missionId:head.missionId,workId:head.work.workId});return false;}
  return true;
 }
 /** Records a final queued refusal on the Work and removes the entry; false keeps the entry stored for the next trigger. */
 async #settleQueuedRefusal(queue:RunQueueHost,head:RunQueueEntry,diagnostics:ConnectionDiagnostic[]):Promise<boolean>{
  // Only a refusal whose every code is final may remove the entry; one transient code keeps it (default keep).
  const refusal=diagnostics.length>0&&diagnostics.every(d=>RUN_QUEUE_FINAL_REFUSALS.has(d.code))?diagnostics.find(d=>!RUN_QUEUE_INTRINSIC_REFUSALS.has(d.code))??diagnostics[0]!:undefined;
  if(!refusal)return false;
  if(!RUN_QUEUE_INTRINSIC_REFUSALS.has(refusal.code)&&!(await this.#recordQueueRefusal(queue,head,refusal)))return false;
  return this.#removeQueuedEntry(queue,head);
 }
 /**
  * A direct request only returns a refusal; the queue leaves the smallest existing blocker shape (block-work)
  * so a person sees why the queued Work did not run. The command id carries the entry's sequence number, so a
  * repeated refusal records again; a reason that cannot be recorded halts the queue rather than disappearing.
  */
 async #recordQueueRefusal(queue:RunQueueHost,head:RunQueueEntry,refusal:ConnectionDiagnostic):Promise<boolean>{
  let result:Awaited<ReturnType<Application['dispatch']>>|undefined;
  try{
   const snapshot=await this.app.store.load(head.missionId),work=snapshot?.value.works.find(w=>w.id===head.work.workId);
   if(!snapshot||!work||work.runtimeRun||['settled','cancelled','waiting'].includes(work.execution))return true;
   const command={type:'block-work' as const,workId:head.work.workId,blocker:{code:refusal.code==='budget_exceeded'?'budget_exceeded' as const:'runtime_unavailable' as const,detail:refusal.message}};
   result=await this.app.dispatch({missionId:head.missionId,commandId:'run-queue-refusal:'+hash({...command,entry:{seq:head.seq,joinedAt:head.joinedAt,runId:head.runId}}).slice(0,48),expectedRevision:snapshot.revision,actorId:'local-owner',command});
  }catch{queue.halt?.('queue_record_failed',{missionId:head.missionId,workId:head.work.workId});return false;}
  if(result.status==='committed'||result.status==='replayed')return true;
  queue.halt?.('queue_record_failed',{missionId:head.missionId,workId:head.work.workId});return false;
 }
}
