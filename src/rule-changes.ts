import {apply,DomainError,hash,memoryVersionHash,ruleChangeId} from './domain.ts';
import type {Actor,Growth,Mission,Command} from './domain.ts';
import {calculationPlan,orderCases,ROUNDING_ORACLE} from './growth-evaluation.ts';
import {FeedAdmissionError} from './storage.ts';
import type {Store,CommitResult} from './storage.ts';
import {copy} from './ui-copy.ts';
export const RULE_DECISION_PREFIX='rule-change:';
export {ruleChangeId};
function ensure(value:unknown,message:string):asserts value {if(!value)throw new DomainError(message,'conflict');}
export function roundingCases(m:Mission,g:Growth){
 ensure(g.evaluator==='host-rounding-oracle/v1'&&g.scores,'Host rounding evaluation required');let evidence;try{evidence=JSON.parse(g.scores.heldOut);}catch{throw new DomainError('Invalid stored evaluation');}
 const b=m.memories.find(v=>v.id+'@'+v.version===g.baseline),c=m.memories.find(v=>v.id+'@'+v.version===g.candidate);ensure(b&&c&&evidence.oracle===ROUNDING_ORACLE,'Exact rounding versions required');
 const plan=calculationPlan(b,c,orderCases(evidence.orders));ensure(plan.heldOut===g.scores.heldOut&&plan.baseline===g.scores.baseline&&plan.candidate===g.scores.candidate,'Stored case evidence does not match exact memory versions');
 return {baseline:g.baseline,candidate:g.candidate,baselineHash:memoryVersionHash(b),candidateHash:memoryVersionHash(c),orders:evidence.orders as ReturnType<typeof orderCases>,reports:evidence.reports as {expected:number;actual:number;passed:boolean}[][]};
}
export class RuleChangesService {
 readonly #store:Store<Mission>;readonly #intake:()=>string|undefined;
 constructor(ownerStore:Store<Mission>,intake:()=>string|undefined){this.#store=ownerStore;this.#intake=intake;}
 async decisions(expectedFeed?:string){
  const missionId=this.#intake();if(!missionId)return [];const read=await this.#store.readState(missionId);if(expectedFeed!==undefined&&read.feedId!==expectedFeed)throw new FeedAdmissionError();const snapshot=read.snapshot;if(!snapshot)return [];
  return snapshot.value.growth.flatMap(g=>{if(!g.ruleChange||g.status==='proposed'||g.status==='reverted'||!g.scores||g.scores.candidate<=g.scores.baseline)return [];const cases=roundingCases(snapshot.value,g),count=cases.orders.length,score=(n:number)=>copy('ui.rule.score',{count:n,total:count});
   return [{id:ruleChangeId(missionId,g),at:g.ruleChange.at,title:copy('ui.rule.name'),question:copy('ui.rule.question'),rows:[[copy('ui.rule.baseline'),score(g.scores.baseline)],[copy('ui.rule.candidate'),score(g.scores.candidate)]] as [string,string][],detail:g.counterevidence,action:copy('conversation.button.09'),state:g.status==='adopted'?'done':g.ruleChange.state,line:g.status==='adopted'?copy('ui.rule.changed'):copy('ui.rule.question'),ruleChange:{activityTitle:copy('ui.rule.activity-title'),activitySummary:copy('ui.rule.activity-summary',{baseline:g.scores.baseline+'/'+count,candidate:g.scores.candidate+'/'+count}),missionId,revision:snapshot.revision,growthId:g.id,cases}}];});
 }
 async decide(input:unknown):Promise<CommitResult<Mission>>{
  const i=structuredClone(input) as Record<string,unknown>;ensure(i&&typeof i==='object'&&Object.keys(i).length===3&&['commandId','decisionId','answer'].every(k=>Object.hasOwn(i,k)),'Exact rule answer required');ensure(typeof i.commandId==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(i.commandId)&&!i.commandId.startsWith('assistant-')&&typeof i.decisionId==='string'&&['act','later','ask'].includes(String(i.answer)),'Invalid rule answer');
  const missionId=this.#intake();ensure(missionId,'Intake Mission unavailable');const actor:Actor={id:'local-owner',roles:['owner']};
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await this.#store.load(missionId),g=snapshot?.value.growth.find(g=>ruleChangeId(missionId,g)===i.decisionId);ensure(g,'Unknown rule decision identity');
   const command:Command={type:'answer-rule-change',growthId:g.id,baseline:g.baseline,candidate:g.candidate,decisionId:i.decisionId as string,answer:i.answer as 'act'|'later'|'ask'},identity={id:missionId,commandId:i.commandId as string,fingerprint:hash({actorId:actor.id,command})},prior=await this.#store.lookupOperation(identity);if(prior.status!=='unknown')return prior;
   if(i.answer==='act')roundingCases(snapshot!.value,g);const {value,events}=apply(snapshot!.value,command,actor);const result=await this.#store.commit({...identity,expectedRevision:snapshot!.revision,value,events,outbox:[]});
   if(result.status==='conflict'&&result.reason==='idempotency'){const stored=await this.#store.lookupOperation(identity);if(stored.status!=='unknown')return stored;}if(result.status!=='conflict'||result.reason!=='revision')return result;
  }
  return {status:'conflict',revision:(await this.#store.load(missionId))?.revision??0,reason:'revision'};
 }
}
