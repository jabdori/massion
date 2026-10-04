import {Application} from './application.ts';
import {ProviderRegistry} from './providers.ts';
import type {Mission,Command,ExecutionGate} from './domain.ts';
import type {ExecutionChoice} from './selectable-runtime.ts';
import type {WorkRuntime} from './configured-runtime.ts';
import type {Store} from './storage.ts';
/** Current local-owner API. Production authentication and provider execution remain explicit gates. */
export class ProductService {
 readonly app:Application;readonly providers:ProviderRegistry;readonly runtime?:WorkRuntime;
 constructor(store:Store<Mission>,providers=new ProviderRegistry(),runtime?:WorkRuntime) {this.runtime=runtime;this.app=new Application(store,[{id:'local-owner',roles:['owner']}]);this.providers=providers;}
 async create(input:Parameters<Application['create']>[0],commandId:string) {return this.app.create(input,'local-owner',commandId);}
 async admit(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;title:string;budget:number}) {
  const selected=this.providers.select(['text-output']);const mission=await this.app.store.load(missionId);const available=mission&&this.runtime?.availability(mission.value);
  // Even a configured model does not imply a permitted execution/assurance runtime.
  const executionGate:ExecutionGate|undefined=available?.ready?undefined:this.runtime?.configuration?{code:'runtime_unavailable',detail:available?.reason??'Choose an explicitly authorized execution connection.'}:selected.status==='unavailable'?{code:selected.code,detail:selected.reason}:{code:'runtime_unavailable',detail:'A provider is configured, but general execution and independent assurance have not been enabled. No provider invocation was made.'};
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'admit-work',workId:input.workId,title:input.title,budget:input.budget,...(executionGate?{executionGate}:{})}});
 }
 async run(missionId:string,workId:string,runId:string,expectedRevision:number,choice?:ExecutionChoice){if(!this.runtime)throw new Error('No explicitly configured Work runtime');return this.runtime.run(missionId,workId,runId,expectedRevision,choice);}
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  if(!['cancel','steer','quarantine-runtime'].includes(input.command?.type))throw new Error('Only cancel, steer and quarantine-runtime are exposed as owner interventions');
  const result=await this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
  if(result.status!=='conflict'&&'workId' in input.command)this.runtime?.interrupt(missionId,input.command.workId);return result;
 }
}
