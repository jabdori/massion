export interface FocusTarget {feedId:string;missionId?:string;workId?:string;turnId?:string;decisionId?:string;memberId?:string}
export interface OwnerException extends FocusTarget {key:string;kind:'decision'|'failure'|'unknown';title:string}
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9:_-]{1,128}$/.test(value);
const title=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=16000;
export class ExceptionTracker {
 #active=new Map<string,OwnerException>();
 update(feedId:string,works:readonly Record<string,unknown>[],decisions:readonly Record<string,unknown>[]){
  if(!id(feedId))throw new Error('Invalid notification feed');
  const next=new Map<string,OwnerException>();
  for(const work of works){
   if(!id(work.missionId)||!id(work.workId)||!id(work.turnId)||!title(work.title))continue;
   const kind=work.unknown===true?'unknown':['failed','stale'].includes(String(work.acceptance))||work.execution==='blocked'?'failure':null;
   if(!kind)continue;
   const key=JSON.stringify([feedId,work.missionId,work.workId,kind]);
   next.set(key,{key,feedId,kind,title:work.title.slice(0,160),missionId:work.missionId,workId:work.workId,turnId:work.turnId});
  }
  for(const decision of decisions){
   if(!id(decision.id)||!title(decision.title)||decision.state!=='open'||decision.memberId!==undefined&&!id(decision.memberId))continue;
   const key=JSON.stringify([feedId,decision.memberId??'',decision.id,'decision']);
   next.set(key,{key,feedId,kind:'decision',title:decision.title.slice(0,160),decisionId:decision.id,...(id(decision.memberId)?{memberId:decision.memberId}:{})});
  }
  const fresh=[...next.values()].filter(item=>!this.#active.has(item.key));this.#active=next;return fresh;
 }
 current(target:OwnerException){return this.#active.has(target.key);}
 clear(){this.#active.clear();}
}
