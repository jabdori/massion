import {DomainError,memoryVersionHash} from './domain.ts';
import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {validateMissionLineage} from './backup-lineage.ts';
import {pinnedMemoryInput} from './memory-input.ts';
import {MemoryUsageError} from './memory-usage.ts';
export interface MemoryFindInput {id:string;feedId:string;revision:number;after?:number}
/** Exact owner-declared identity discovery only. Neither match nor choice grants applicability. */
export async function findMemoryVersions(store:Store<Mission>,missionId:string,input:MemoryFindInput){
 input=structuredClone(input);if(Object.keys(input).some(k=>!['id','feedId','revision','after'].includes(k))||typeof input.id!=='string'||!input.id.trim()||input.id.length>16000||!input.id.isWellFormed()||typeof input.feedId!=='string'||!input.feedId||!Number.isSafeInteger(input.revision)||input.revision<1||input.after!==undefined&&(!Number.isSafeInteger(input.after)||input.after<=0||input.after%20!==0))throw new DomainError('Original literal memory ID, feed, revision and valid 20-version offset required');
 const state=await store.readState(missionId);if(state.feedId!==input.feedId)throw new MemoryUsageError(409,'Database feed changed; no memory discovery fallback');if(!state.snapshot)return null;if(state.snapshot.revision!==input.revision)throw new MemoryUsageError(409,'Mission revision changed; explicitly find against refreshed state');
 const mission=state.snapshot.value;try{validateMissionLineage(mission);for(const work of mission.works)pinnedMemoryInput(mission,work);}catch{throw new MemoryUsageError(503,'Original memory/Work/Record lineage invalid; no discovery fallback');}
 const matches=mission.memories.filter(m=>m.id===input.id&&m.authority==='explicit'&&m.scope===mission.scope),offset=input.after??0;if(input.after!==undefined&&offset>=matches.length)throw new DomainError('Memory continuation is beyond retained versions');const end=Math.min(offset+20,matches.length);
 return {missionId,id:input.id,feedId:state.feedId,revision:state.snapshot.revision,cursor:state.cursor,offset,limit:20 as const,totalVersions:matches.length,nextAfter:end<matches.length?end:null,versions:matches.slice(offset,end).map(memory=>({memory:structuredClone(memory),versionHash:memoryVersionHash(memory)}))};
}
