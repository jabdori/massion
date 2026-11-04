import {DomainError,memoryVersionHash} from './domain.ts';
import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {validateMissionLineage} from './backup-lineage.ts';
import {pinnedMemoryInput} from './memory-input.ts';
import {MemoryUsageError} from './memory-usage.ts';
export interface MemorySearchInput {text:string;feedId:string;revision:number;after?:number}
/** Literal content discovery only; matching neither ranks nor grants applicability. */
export async function searchMemoryContent(store:Store<Mission>,missionId:string,input:MemorySearchInput){
 input=structuredClone(input);if(Object.keys(input).some(k=>!['text','feedId','revision','after'].includes(k))||typeof input.text!=='string'||!input.text.trim()||input.text.length>512||!input.text.isWellFormed()||typeof input.feedId!=='string'||!input.feedId||!Number.isSafeInteger(input.revision)||input.revision<1||input.after!==undefined&&(!Number.isSafeInteger(input.after)||input.after<=0||input.after%20!==0))throw new DomainError('Literal content fragment up to 512 units, feed, revision and valid 20-result offset required');
 const state=await store.readState(missionId);if(state.feedId!==input.feedId)throw new MemoryUsageError(409,'Database feed changed; no content search fallback');if(!state.snapshot)return null;if(state.snapshot.revision!==input.revision)throw new MemoryUsageError(409,'Mission revision changed; explicitly search against refreshed state');
 const mission=state.snapshot.value;try{validateMissionLineage(mission);for(const work of mission.works)pinnedMemoryInput(mission,work);}catch{throw new MemoryUsageError(503,'Original memory/Work/Record lineage invalid; no content search fallback');}
 const matches=mission.memories.filter(m=>m.content.includes(input.text)&&m.authority==='explicit'&&m.scope===mission.scope),offset=input.after??0;if(input.after!==undefined&&offset>=matches.length)throw new DomainError('Memory continuation is beyond retained versions');const end=Math.min(offset+20,matches.length);
 return {missionId,text:input.text,feedId:state.feedId,revision:state.snapshot.revision,cursor:state.cursor,offset,limit:20 as const,totalVersions:matches.length,nextAfter:end<matches.length?end:null,versions:matches.slice(offset,end).map(memory=>({memory:structuredClone(memory),versionHash:memoryVersionHash(memory)}))};
}
