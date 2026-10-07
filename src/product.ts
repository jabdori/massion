import {readRejectedText} from './rejected-text.ts';
import type {RejectedTextInput} from './rejected-text.ts';
import {runSequence} from './run-sequence.ts';
import type {RunSequenceInput} from './run-sequence.ts';
import {readWorkConversation} from './work-conversation.ts';
import {readRuntimeOwnership} from './runtime-lifetime.ts';
import {readRecordArtifact} from './record-artifact.ts';
import type {ArtifactReader,RecordArtifactInput} from './record-artifact.ts';
import {Application} from './application.ts';
import {DomainError,hash,memoryVersionHash} from './domain.ts';
import {ROUNDING_ORACLE,keys,orderCases,calculationPlan} from './growth-evaluation.ts';
import {verifyGrowthCalculation} from './execution.ts';
import type {OrderCase} from './growth-evaluation.ts';
import {ProviderRegistry} from './providers.ts';
import type {Mission,Command,ExecutionGate} from './domain.ts';
import type {ExecutionChoice,SelectionPreflight} from './selectable-runtime.ts';
import {workAdmissionPreflight} from './configured-runtime.ts';
import type {WorkRuntime} from './configured-runtime.ts';
import type {Store} from './storage.ts';
/** Current local-owner API. Production authentication and provider execution remain explicit gates. */
export class ProductService {
 readonly app:Application;readonly providers:ProviderRegistry;readonly runtime?:WorkRuntime;readonly artifacts?:ArtifactReader;
 constructor(store:Store<Mission>,providers=new ProviderRegistry(),runtime?:WorkRuntime,artifacts?:ArtifactReader) {this.artifacts=artifacts;this.runtime=runtime;this.app=new Application(store,[{id:'local-owner',roles:['owner']}]);this.providers=providers;}
 async create(input:Parameters<Application['create']>[0],commandId:string) {return this.app.create(input,'local-owner',commandId);}
 async admit(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;title:string;budget:number;correction?:import('./work-correction.ts').CorrectionSelection}) {
  input=structuredClone(input);keys(input,['commandId','expectedRevision','workId','title','budget','correction']);
  const selected=this.providers.select(['text-output']);const mission=await this.app.store.load(missionId);const available=mission&&this.runtime?.availability(mission.value);
  // Even a configured model does not imply a permitted execution/assurance runtime.
  const executionGate:ExecutionGate|undefined=available?.ready?undefined:this.runtime?.configuration?{code:'runtime_unavailable',detail:available?.reason??'Choose an explicitly authorized execution connection.'}:selected.status==='unavailable'?{code:selected.code,detail:selected.reason}:{code:'runtime_unavailable',detail:'A provider is configured, but general execution and independent assurance have not been enabled. No provider invocation was made.'};
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'admit-work',workId:input.workId,title:input.title,budget:input.budget,...(Object.hasOwn(input,'correction')?{correction:input.correction}:{}),...(executionGate?{executionGate}:{})}});
 }
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
 async reviseMission(missionId:string,input:{commandId:string;expectedRevision:number;purpose:string;criteria:Mission['criteria']}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revise-mission',purpose:input.purpose,criteria:{version:input.criteria.version,description:input.criteria.description,oracle:input.criteria.oracle}}});
 }
 async saveMemory(missionId:string,input:{commandId:string;expectedRevision:number;memory:{id:string;version:number;content:string;source:string}}) {
  const {commandId,expectedRevision}=input;
  const memory={id:input.memory.id,version:input.memory.version,content:input.memory.content,source:input.memory.source};
  const current=await this.app.store.load(missionId);if(!current)throw new DomainError('Unknown Mission');
  return this.app.dispatch({missionId,commandId,expectedRevision,actorId:'local-owner',command:{type:'save-memory',memory:{...memory,scope:current.value.scope,authority:'explicit',effective:true}}});
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
 async readAcceptedText(missionId:string,workId:string,input:RecordArtifactInput) {return readRecordArtifact(this.app.store,this.artifacts,missionId,workId,input);}
 async preflight(missionId:string,workId:string,expectedRevision:number,choice?:ExecutionChoice):Promise<SelectionPreflight|null> {
  const snapshot=await this.app.store.load(missionId);if(!snapshot||!snapshot.value.works.some(w=>w.id===workId))return null;
  if(this.runtime?.preflight)return this.runtime.preflight(snapshot,workId,expectedRevision,choice);
  const result=workAdmissionPreflight(snapshot,workId,expectedRevision);
  return {...result,ready:false,diagnostics:[...result.diagnostics,{code:'selection_unavailable',message:'No runtime with execution preflight is configured.'}]};
 }
 async runSequence(missionId:string,input:RunSequenceInput){if(!this.runtime)throw new DomainError('No explicitly configured Work runtime');return runSequence(this.app.store,this.runtime,missionId,input);}
 async run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice){if(!this.runtime)throw new Error('No explicitly configured Work runtime');return this.runtime.run(missionId,workId,runId,expectedRevision,choice);}
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  input=structuredClone(input);
  if(!['cancel','steer','quarantine-runtime','close-expired-runtime'].includes(input.command?.type))throw new Error('Only cancel, steer, quarantine-runtime and close-expired-runtime are exposed as owner interventions');
  if(input.command.type==='close-expired-runtime'&&(!Number.isSafeInteger(input.command.observedAt)||input.command.observedAt>Date.now()))throw new DomainError('Expired closure observation cannot be in the future');
  const result=await this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
  if(result.status!=='conflict'&&'workId' in input.command)this.runtime?.interrupt(missionId,input.command.workId);return result;
 }
}
