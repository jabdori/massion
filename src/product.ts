import {readRejectedText} from './rejected-text.ts';
import type {RejectedTextInput} from './rejected-text.ts';
import {runSequence} from './run-sequence.ts';
import type {RunSequenceInput} from './run-sequence.ts';
import {readWorkConversation,readMissionConversation} from './work-conversation.ts';
import {readRuntimeOwnership} from './runtime-lifetime.ts';
import {readRecordArtifact} from './record-artifact.ts';
import {readReflectionTrail} from './reflection-trail.ts';
import type {ArtifactReader,RecordArtifactInput} from './record-artifact.ts';
import {Application} from './application.ts';
import {MEMBERS_ID,isMembersState} from './members.ts';
import {DomainError,hash,memoryVersionHash} from './domain.ts';
import {ROUNDING_ORACLE,keys,orderCases,calculationPlan} from './growth-evaluation.ts';
import {verifyGrowthCalculation} from './execution.ts';
import type {OrderCase} from './growth-evaluation.ts';
import {ProviderRegistry} from './providers.ts';
import type {Mission,Command,ExecutionGate} from './domain.ts';
import type {ExecutionChoice,SelectionPreflight,DefaultResolution} from './selectable-runtime.ts';
import {workAdmissionPreflight,rejectedRun,hostBusyPreflight} from './configured-runtime.ts';
import type {WorkRuntime} from './configured-runtime.ts';
import type {Store} from './storage.ts';
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
 async appendWorkMessage(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;messageId:string;replyTo:string|null;text:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','messageId','replyTo','text']);const {commandId,expectedRevision,...message}=input;return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'append-work-message',...message}});
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
 async saveMemory(missionId:string,input:{commandId:string;expectedRevision:number;memory:{id:string;version:number;content:string;source:string}}) {
  const {commandId,expectedRevision}=input;
  const memory={id:input.memory.id,version:input.memory.version,content:input.memory.content,source:input.memory.source};
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
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'adopt-growth',growthId:input.growthId,baseline:input.baseline,candidate:input.candidate}});
 }
 async proposeGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:{id:string;version:number;content:string;source:string};counterevidence:string}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','growthId','baseline','candidate','counterevidence']);keys(input.candidate,['id','version','content','source']);
  const snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');
  const service=new Application(this.app.store,[{id:'local-owner',roles:['representative']}]);
  return service.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'propose-growth',candidateMemory:{...input.candidate,scope:snapshot.value.scope,authority:'learned',effective:false},proposal:{id:input.growthId,proposer:'local-owner',target:'memory',baseline:input.baseline,candidate:input.candidate.id+'@'+input.candidate.version,counterevidence:input.counterevidence,status:'proposed'}}});
 }
 async evaluateGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string;oracle:string;cases:OrderCase[]}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','growthId','baseline','candidate','oracle','cases']);if(input.oracle!==ROUNDING_ORACLE)throw new DomainError('Unsupported Growth oracle; only rounding-calculation/v1 is enabled. No provider invocation.');const cases=orderCases(input.cases),snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');const g=snapshot.value.growth.find(g=>g.id===input.growthId);if(!g||g.baseline!==input.baseline||g.candidate!==input.candidate)throw new DomainError('Exact Growth memory versions mismatch');
  const baseline=snapshot.value.memories.find(m=>m.id+'@'+m.version===g.baseline),candidate=snapshot.value.memories.find(m=>m.id+'@'+m.version===g.candidate);if(!baseline||!candidate)throw new DomainError('Exact scoped memories required');
  const plan=calculationPlan(baseline,candidate,cases),actorId='host-rounding-oracle/v1',command:Command={type:'evaluate-growth',growthId:g.id,baseline:plan.baseline,candidate:plan.candidate,heldOut:plan.heldOut,binding:{baseline:g.baseline,candidate:g.candidate,baselineHash:memoryVersionHash(baseline),candidateHash:memoryVersionHash(candidate)}},envelope={missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId,command},service=new Application(this.app.store,[{id:actorId,roles:['evaluator']}]);
  const prior=await this.app.store.lookupOperation({id:missionId,commandId:input.commandId,fingerprint:hash({actorId,command,expectedRevision:input.expectedRevision})});if(prior.status!=='unknown')return prior;
  if(snapshot.revision!==input.expectedRevision)return service.dispatch(envelope);if(g.status!=='proposed'||g.proposer===actorId||baseline.scope!==snapshot.value.scope||candidate.scope!==snapshot.value.scope||!baseline.effective||candidate.effective)throw new DomainError('Independent proposed Growth with current scoped baseline required');
  await verifyGrowthCalculation(baseline,candidate,cases);return service.dispatch(envelope);
 }
 async revertGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revert-growth',growthId:input.growthId,baseline:input.baseline,candidate:input.candidate}});
 }
 async readRunOwnership(missionId:string,workId:string,feedId?:string){return readRuntimeOwnership(this.app.store,missionId,workId,feedId,runId=>this.runtime?.owns?.(missionId,workId,runId)??false);}
 async readRejectedText(missionId:string,workId:string,input:RejectedTextInput){return readRejectedText(this.app.store,this.artifacts,missionId,workId,input);}
 async reflectionTrail(missionId:string,workId:string,revision?:number,feedId?:string){return readReflectionTrail(this.app.store,this.artifacts,missionId,workId,revision,feedId);}
 async readAcceptedText(missionId:string,workId:string,input:RecordArtifactInput) {return readRecordArtifact(this.app.store,this.artifacts,missionId,workId,input);}
 /** Unselected Work keeps its pinned member; resolve that member’s group for both preflight and run. A local miss may be stale: another host on the same database may have saved a default. Re-read once, then resolve again; a local hit proceeds and admission blocks if the stored revision changed. */
 async resolveFresh(mission:Mission,workId?:string):Promise<DefaultResolution>{
  const source=mission.works.find(w=>w.id===workId)?.assistantSource;let group:string|undefined;
  if(source?.memberId){const state=(await this.app.store.load(MEMBERS_ID))?.value,member=isMembersState(state)?state.members.find(m=>m.id===source.memberId):undefined;
   if(!member)return {status:'unresolved',diagnostics:[{code:'member_unknown',message:'The assigned member is unavailable; no other execution route was used.'}]};
   if(member.modelGroup!=='default'){if(!this.runtime!.resolveGroupWork)return {status:'unresolved',diagnostics:[{code:'model_group_missing',message:'No member group routing is configured on this host.'}]};group=member.modelGroup;}
  }
  const resolve=()=>group?this.runtime!.resolveGroupWork!(group,mission,source!.representative):this.runtime!.resolveDefault!(mission),local=resolve();if(local.status==='resolved'||!this.runtime!.refreshStoredSettings)return local;await this.runtime!.refreshStoredSettings();return resolve();
 }

 async preflight(missionId:string,workId:string,expectedRevision:number,choice?:ExecutionChoice):Promise<(SelectionPreflight&{selection?:{source:'default';choice:ExecutionChoice}})|null> {
  const snapshot=await this.app.store.load(missionId);if(!snapshot||!snapshot.value.works.some(w=>w.id===workId))return null;
  const resolved=choice===undefined&&this.runtime?.resolveDefault?await this.resolveFresh(snapshot.value,workId):undefined;
  if(resolved?.status==='unresolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return {...result,ready:false,diagnostics:[...result.diagnostics,...resolved.diagnostics]};}
  if(resolved)return {...this.runtime!.preflight!(snapshot,workId,expectedRevision,resolved.choice),selection:{source:'default',choice:resolved.choice}};
  if(this.runtime?.preflight)return this.runtime.preflight(snapshot,workId,expectedRevision,choice);
  const result=workAdmissionPreflight(snapshot,workId,expectedRevision);
  return {...result,ready:false,diagnostics:[...result.diagnostics,{code:'selection_unavailable',message:'No runtime with execution preflight is configured.'}]};
 }
 async runSequence(missionId:string,input:RunSequenceInput){if(!this.runtime)throw new DomainError('No explicitly configured Work runtime');
  if(!input||typeof input!=='object'||Object.hasOwn(input,'selection')||!this.runtime.resolveDefault)return runSequence(this.app.store,this.runtime,missionId,input);
  // Capacity is captured before any await so a request made while the host is busy is refused, not deferred.
  const busyAtEntry=this.runtime.hasActiveAdmission?.()??false;
  const snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');const resolved=await this.resolveFresh(snapshot.value,input.works?.[0]?.workId);
  // Resolve and enter synchronously: the sequence captures the configuration that produced this choice.
  if(resolved.status==='unresolved')return runSequence(this.app.store,this.runtime,missionId,input,resolved.diagnostics,busyAtEntry);
  return {...await runSequence(this.app.store,this.runtime,missionId,input,undefined,busyAtEntry,(mission,workId)=>this.resolveFresh(mission,workId)),selection:{source:'default' as const,choice:resolved.choice}};
 }
 /** `activationActorId` and `expectedDefault` are set only by the conversation host path; HTTP runs are the owner's. `expectedDefault` is the default choice an earlier check approved: a different one now refuses the run. */
 async run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice,activationActorId?:string,expectedDefault?:ExecutionChoice){if(!this.runtime)throw new Error('No explicitly configured Work runtime');
  if(choice!==undefined||!this.runtime.resolveDefault)return this.runtime.run(missionId,workId,runId,expectedRevision,choice,activationActorId);
  const busyAtEntry=this.runtime.hasActiveAdmission?.()??false;
  const snapshot=await this.app.store.load(missionId);if(!snapshot)throw new DomainError('Unknown Mission');const resolved=await this.resolveFresh(snapshot.value,workId);
  if(busyAtEntry&&resolved.status==='resolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision,resolved.choice.outputTokenCap);return rejectedRun(result.ready?hostBusyPreflight(result):result,snapshot);}
  // An unresolved default admits nothing, so it returns blocked even while draining (HTTP refuses mutations during drain first).
  if(resolved.status==='unresolved'){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return rejectedRun({...result,ready:false,diagnostics:[...result.diagnostics,...resolved.diagnostics]},snapshot);}
  if(expectedDefault&&hash(resolved.choice)!==hash(expectedDefault)){const result=workAdmissionPreflight(snapshot,workId,expectedRevision);return rejectedRun({...result,ready:false,diagnostics:[...result.diagnostics,{code:'default_route_changed',message:'The default route changed after the check this run was approved by; nothing was started.'}]},snapshot);}
  // A local change cannot start while the run awaits the stored revision without the run seeing it; a changed revision blocks rather than re-resolving.
  return {...await this.runtime.run(missionId,workId,runId,expectedRevision,resolved.choice,activationActorId),selection:{source:'default' as const,choice:resolved.choice}};
 }
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  input=structuredClone(input);
  if(!['cancel','steer','quarantine-runtime','close-expired-runtime'].includes(input.command?.type))throw new Error('Only cancel, steer, quarantine-runtime and close-expired-runtime are exposed as owner interventions');
  if(input.command.type==='close-expired-runtime'&&(!Number.isSafeInteger(input.command.observedAt)||input.command.observedAt>Date.now()))throw new DomainError('Expired closure observation cannot be in the future');
  const result=await this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
  if(result.status!=='conflict'&&'workId' in input.command)this.runtime?.interrupt(missionId,input.command.workId);return result;
 }
}
