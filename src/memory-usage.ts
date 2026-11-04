import {DomainError,memoryVersionHash} from './domain.ts';
import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {validateMissionLineage} from './backup-lineage.ts';
import {pinnedMemoryInput} from './memory-input.ts';
export interface MemoryUsageInput {id:string;version:number;versionHash:string;feedId?:string;revision?:number;after?:number}
export class MemoryUsageError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
/** Original version/pins only; effective state is current admission information, not past usage proof. */
export async function readMemoryUsage(store:Store<Mission>,missionId:string,input:MemoryUsageInput) {
 input=structuredClone(input);if(Object.keys(input).some(k=>!['id','version','versionHash','feedId','revision','after'].includes(k))||typeof input.id!=='string'||!input.id.trim()||input.id.length>16000||!input.id.isWellFormed()||!Number.isSafeInteger(input.version)||input.version<1||typeof input.versionHash!=='string'||!/^[a-f0-9]{64}$/.test(input.versionHash))throw new DomainError('Exact memory ID/version/hash required');
 if(input.revision!==undefined&&(!Number.isSafeInteger(input.revision)||input.revision<1))throw new DomainError('Positive exact usage revision required');
 if(input.after!==undefined&&(!Number.isSafeInteger(input.after)||input.after<=0||input.after%20!==0||input.revision===undefined||typeof input.feedId!=='string'||!input.feedId.length))throw new DomainError('Usage continuation requires a positive 20-use offset, original feed and revision');
 const state=await store.readState(missionId);if(input.feedId!==undefined&&input.feedId!==state.feedId)throw new MemoryUsageError(409,'Database feed changed; no memory version substitution');if(!state.snapshot)return null;if(input.revision!==undefined&&input.revision!==state.snapshot.revision)throw new MemoryUsageError(409,'Mission revision changed; explicitly read the original version again before paging');
 const mission=state.snapshot.value;try{validateMissionLineage(mission);for(const work of mission.works)pinnedMemoryInput(mission,work);}catch{throw new MemoryUsageError(503,'Original memory/Work/Record lineage invalid; no usage fallback');}
 const matches=mission.memories.filter(m=>m.id===input.id&&m.version===input.version);if(!matches.length)return null;if(matches.length!==1||memoryVersionHash(matches[0]!)!==input.versionHash)throw new MemoryUsageError(409,'Exact original memory version hash mismatch; no latest substitution');const memory=matches[0]!,pin=memory.id+'@'+memory.version,uses=mission.works.filter(w=>w.appliedMemoryVersions.includes(pin));
 const offset=input.after??0;if(input.after!==undefined&&offset>=uses.length)throw new DomainError('Usage continuation is beyond retained uses');const end=Math.min(offset+20,uses.length),nextAfter=end<uses.length?end:null;
 return {missionId,offset,nextAfter,revision:state.snapshot.revision,feedId:state.feedId,cursor:state.cursor,memory:structuredClone(memory),versionHash:input.versionHash,totalUses:uses.length,limit:20 as const,uses:uses.slice(offset,end).map(w=>({workId:w.id,title:w.title,execution:w.execution,acceptance:w.acceptance,criteriaVersion:w.criteria.version,...(w.record?{record:{id:w.record.id,checksum:w.record.checksum,evidenceClass:w.record.evidenceClass,memoryVersions:structuredClone(w.record.memoryVersions)}}:{})}))};
}
