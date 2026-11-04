import {DomainError,memoryVersionHash} from './domain.ts';
import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {validateMissionLineage} from './backup-lineage.ts';
import {pinnedMemoryInput} from './memory-input.ts';
export class MemoryUsageError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
/** Original version/pins only; effective state is current admission information, not past usage proof. */
export async function readMemoryUsage(store:Store<Mission>,missionId:string,input:{id:string;version:number;versionHash:string;feedId?:string}) {
 input=structuredClone(input);if(Object.keys(input).some(k=>!['id','version','versionHash','feedId'].includes(k))||typeof input.id!=='string'||!/^[A-Za-z0-9:_-]{1,128}$/.test(input.id)||!Number.isSafeInteger(input.version)||input.version<1||typeof input.versionHash!=='string'||!/^[a-f0-9]{64}$/.test(input.versionHash))throw new DomainError('Exact memory ID/version/hash required');
 const state=await store.readState(missionId);if(input.feedId!==undefined&&input.feedId!==state.feedId)throw new MemoryUsageError(409,'Database feed changed; no memory version substitution');if(!state.snapshot)return null;
 const mission=state.snapshot.value;try{validateMissionLineage(mission);for(const work of mission.works)pinnedMemoryInput(mission,work);}catch{throw new MemoryUsageError(503,'Original memory/Work/Record lineage invalid; no usage fallback');}
 const matches=mission.memories.filter(m=>m.id===input.id&&m.version===input.version);if(!matches.length)return null;if(matches.length!==1||memoryVersionHash(matches[0]!)!==input.versionHash)throw new MemoryUsageError(409,'Exact original memory version hash mismatch; no latest substitution');const memory=matches[0]!,pin=memory.id+'@'+memory.version,uses=mission.works.filter(w=>w.appliedMemoryVersions.includes(pin));
 return {missionId,revision:state.snapshot.revision,feedId:state.feedId,cursor:state.cursor,memory:structuredClone(memory),versionHash:input.versionHash,totalUses:uses.length,limit:20 as const,uses:uses.slice(0,20).map(w=>({workId:w.id,title:w.title,execution:w.execution,acceptance:w.acceptance,criteriaVersion:w.criteria.version,...(w.record?{record:{id:w.record.id,checksum:w.record.checksum,evidenceClass:w.record.evidenceClass,memoryVersions:structuredClone(w.record.memoryVersions)}}:{})}))};
}
