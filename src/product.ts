import {readRecordArtifact} from './record-artifact.ts';
import type {ArtifactReader,RecordArtifactInput} from './record-artifact.ts';
import {Application} from './application.ts';
import {DomainError} from './domain.ts';
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
 async admit(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;title:string;budget:number}) {
  const selected=this.providers.select(['text-output']);const mission=await this.app.store.load(missionId);const available=mission&&this.runtime?.availability(mission.value);
  // Even a configured model does not imply a permitted execution/assurance runtime.
  const executionGate:ExecutionGate|undefined=available?.ready?undefined:this.runtime?.configuration?{code:'runtime_unavailable',detail:available?.reason??'Choose an explicitly authorized execution connection.'}:selected.status==='unavailable'?{code:selected.code,detail:selected.reason}:{code:'runtime_unavailable',detail:'A provider is configured, but general execution and independent assurance have not been enabled. No provider invocation was made.'};
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'admit-work',workId:input.workId,title:input.title,budget:input.budget,...(executionGate?{executionGate}:{})}});
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
 async revertGrowth(missionId:string,input:{commandId:string;expectedRevision:number;growthId:string;baseline:string;candidate:string}) {
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'revert-growth',growthId:input.growthId,baseline:input.baseline,candidate:input.candidate}});
 }
 async readAcceptedText(missionId:string,workId:string,input:RecordArtifactInput) {return readRecordArtifact(this.app.store,this.artifacts,missionId,workId,input);}
 async preflight(missionId:string,workId:string,expectedRevision:number,choice?:ExecutionChoice):Promise<SelectionPreflight|null> {
  const snapshot=await this.app.store.load(missionId);if(!snapshot||!snapshot.value.works.some(w=>w.id===workId))return null;
  if(this.runtime?.preflight)return this.runtime.preflight(snapshot,workId,expectedRevision,choice);
  const result=workAdmissionPreflight(snapshot,workId,expectedRevision);
  return {...result,ready:false,diagnostics:[...result.diagnostics,{code:'selection_unavailable',message:'No runtime with execution preflight is configured.'}]};
 }
 async run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice){if(!this.runtime)throw new Error('No explicitly configured Work runtime');return this.runtime.run(missionId,workId,runId,expectedRevision,choice);}
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  input=structuredClone(input);
  if(!['cancel','steer','quarantine-runtime'].includes(input.command?.type))throw new Error('Only cancel, steer and quarantine-runtime are exposed as owner interventions');
  const result=await this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
  if(result.status!=='conflict'&&'workId' in input.command)this.runtime?.interrupt(missionId,input.command.workId);return result;
 }
}
