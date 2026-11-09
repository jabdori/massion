import {requiresMemoryTime} from './memory-expiry.ts';
import {apply,createMission,DomainError,endsWork,observesWork,hash} from './domain.ts';
import type {Actor,Command,Mission} from './domain.ts';
import type {Store,CommitResult} from './storage.ts';
export interface Envelope { missionId:string; commandId:string; expectedRevision:number; actorId:string; command:Command }
export class Application {
  readonly store:Store<Mission>;
  private readonly actors:Map<string,Actor>;
  private readonly clock:()=>number;
  constructor(store:Store<Mission>,actors:readonly Actor[],clock:()=>number=Date.now) {
    this.clock=clock;this.store=store; this.actors=new Map(actors.map(a=>[a.id,structuredClone(a)]));
  }
  actor(id:string):Actor {const a=this.actors.get(id); if(!a)throw new DomainError('Unknown actor','denied');return structuredClone(a);}
  async create(input:Parameters<typeof createMission>[0],actorId:string,commandId:string):Promise<CommitResult<Mission>> {
    const actor=this.actor(actorId); const value=createMission(input,actor);
    const fingerprint=hash({actorId,input,kind:'create'});
    const old=await this.store.lookupOperation({id:input.id,commandId,fingerprint});
    if(old.status!=='unknown') return old;
    return this.store.commit({id:input.id,expectedRevision:0,commandId,fingerprint,value,events:[{type:'mission-created',actor:actor.id}],outbox:[]});
  }
  async dispatch(envelope:Envelope):Promise<CommitResult<Mission>> {
    // Keep identity, authority and applied command bound across asynchronous store reads.
    envelope=structuredClone(envelope);
    if(Object.keys(envelope).length!==5||Object.keys(envelope).some(k=>!['missionId','commandId','expectedRevision','actorId','command'].includes(k)))throw new DomainError('Exact application envelope fields required');
    const actor=this.actor(envelope.actorId);
    if(!Number.isSafeInteger(envelope.expectedRevision)||envelope.expectedRevision<1)throw new DomainError('Invalid expected revision');
    if(typeof envelope.commandId!=='string'||!envelope.commandId.length)throw new DomainError('Missing command identity');
    const fingerprint=hash({actorId:actor.id,command:envelope.command,expectedRevision:envelope.expectedRevision});
    const prior=await this.store.lookupOperation({id:envelope.missionId,commandId:envelope.commandId,fingerprint});
    if(prior.status!=='unknown')return prior;
    const snapshot=await this.store.load(envelope.missionId);
    if(!snapshot)throw new DomainError('Unknown Mission');
    // A duplicate may have committed while loading; replay before running the reducer.
    const concurrent=await this.store.lookupOperation({id:envelope.missionId,commandId:envelope.commandId,fingerprint});
    if(concurrent.status!=='unknown')return concurrent;
    if(snapshot.revision!==envelope.expectedRevision) {
      return {status:'conflict',revision:snapshot.revision,reason:'revision'};
    }
    if(envelope.command.type==='steer'){const workId=envelope.command.workId;if(snapshot.value.works.find(w=>w.id===workId)?.monthlyBudgetDecision)throw new DomainError('Resolve the monthly budget decision before steering budget-paused Work');}
    const {value,events}=apply(snapshot.value,envelope.command,actor,(envelope.command.type==='evaluate-growth'&&envelope.command.ownerDecision||(envelope.command.type==='adopt-growth'||envelope.command.type==='revert-growth'||envelope.command.type==='answer-rule-change')&&envelope.command.recordChangeTime)||observesWork(envelope.command.type)||endsWork(envelope.command.type)||requiresMemoryTime(snapshot.value,envelope.command.type)?{observedAt:this.clock(),...(endsWork(envelope.command.type)?{workEndVersion:2 as const}:{}),...(observesWork(envelope.command.type)?{telemetryVersion:1 as const}:{})}:undefined);
    const outbox=envelope.command.type==='admit-effect'?[{type:'effect-admitted',workId:envelope.command.workId,effectId:envelope.command.effect.id}]:[];
    const result=await this.store.commit({id:envelope.missionId,expectedRevision:envelope.expectedRevision,commandId:envelope.commandId,fingerprint,value,events,outbox});
    if(result.status==='conflict'&&result.reason==='idempotency'){
      const stored=await this.store.lookupOperation({id:envelope.missionId,commandId:envelope.commandId,fingerprint});
      if(stored.status!=='unknown')return stored;
    }
    return result;
  }
}
