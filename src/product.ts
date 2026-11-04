import {Application} from './application.ts';
import {ProviderRegistry} from './providers.ts';
import type {Mission,Command,ExecutionGate} from './domain.ts';
import type {Store} from './storage.ts';
/** Current local-owner API. Production authentication and provider execution remain explicit gates. */
export class ProductService {
 readonly app:Application;readonly providers:ProviderRegistry;
 constructor(store:Store<Mission>,providers=new ProviderRegistry()) {this.app=new Application(store,[{id:'local-owner',roles:['owner']}]);this.providers=providers;}
 async create(input:Parameters<Application['create']>[0],commandId:string) {return this.app.create(input,'local-owner',commandId);}
 async admit(missionId:string,input:{commandId:string;expectedRevision:number;workId:string;title:string;budget:number}) {
  const selected=this.providers.select(['text-output']);
  // Even a configured model does not imply a permitted execution/assurance runtime.
  const executionGate:ExecutionGate=selected.status==='unavailable'?{code:selected.code,detail:selected.reason}:{code:'runtime_unavailable',detail:'A provider is configured, but general execution and independent assurance have not been enabled. No provider invocation was made.'};
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:{type:'admit-work',workId:input.workId,title:input.title,budget:input.budget,executionGate}});
 }
 async intervene(missionId:string,input:{commandId:string;expectedRevision:number;command:Command}) {
  if(!['cancel','steer'].includes(input.command?.type))throw new Error('Only cancel and steer are exposed as owner interventions');
  return this.app.dispatch({missionId,commandId:input.commandId,expectedRevision:input.expectedRevision,actorId:'local-owner',command:input.command});
 }
}
