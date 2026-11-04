import {DomainError,memoryVersionHash} from './domain.ts';
import type {Memory,Mission} from './domain.ts';
export interface MemoryConflictReference {id:string;version:number;hash:string}
export interface MemoryConflict {id:string;first:MemoryConflictReference;second:MemoryConflictReference;actorId:string;reason:string}
export const MEMORY_CONFLICTS=100,MEMORY_CONFLICT_BYTES=131072;
const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every(k=>keys.includes(k));
function ensure(value:unknown,message:string):asserts value {if(!value)throw new DomainError(message);}
const identifier=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
export function conflictMemory(mission:Mission,reference:MemoryConflictReference):Memory {
 ensure(exact(reference,['id','version','hash'])&&typeof reference.id==='string'&&!!reference.id.trim()&&reference.id.length<=16000&&reference.id.isWellFormed()&&Number.isSafeInteger(reference.version)&&reference.version>0&&typeof reference.hash==='string'&&/^[a-f0-9]{64}$/.test(reference.hash),'Exact memory conflict ID/version/hash required');
 const originals=mission.memories.filter(m=>m.id===reference.id&&m.version===reference.version);ensure(originals.length===1,'Exact same-Mission memory conflict version unavailable');const memory=originals[0]!;ensure(typeof memory.effective==='boolean'&&memory.scope===mission.scope&&memory.authority==='explicit'&&memoryVersionHash(memory)===reference.hash,'Conflict must name exact same-scope explicit memory originals');return memory;
}
export function memoryConflictPair(first:MemoryConflictReference,second:MemoryConflictReference):string {return JSON.stringify([JSON.stringify([first.id,first.version,first.hash]),JSON.stringify([second.id,second.version,second.hash])].sort());}
export function validateMemoryConflicts(mission:Mission):void {
 if(!Object.hasOwn(mission,'memoryConflicts'))return;const history=mission.memoryConflicts;ensure(Array.isArray(history)&&history.length>0&&history.length<=MEMORY_CONFLICTS&&Object.keys(history).length===history.length&&Object.keys(history).every((k,i)=>k===String(i))&&Buffer.byteLength(JSON.stringify(history),'utf8')<=MEMORY_CONFLICT_BYTES,'Memory conflict history exceeds its exact bounded array contract');const ids=new Set<string>(),pairs=new Set<string>();
 for(const c of history){ensure(exact(c,['id','first','second','actorId','reason'])&&identifier(c.id)&&!ids.has(c.id)&&identifier(c.actorId)&&typeof c.reason==='string'&&!!c.reason.trim()&&c.reason.isWellFormed()&&c.reason.length<=2000,'Invalid original owner memory conflict');conflictMemory(mission,c.first);conflictMemory(mission,c.second);ensure(c.first.id!==c.second.id,'Conflict needs two distinct memory identities');const pair=memoryConflictPair(c.first,c.second);ensure(!pairs.has(pair),'Exact memory conflict pair already declared');ids.add(c.id);pairs.add(pair);}
}
/** Applicable is a current-data statement, never a semantic resolution or an execution grant. */
export function applicableMemoryConflicts(mission:Mission):MemoryConflict[] {validateMemoryConflicts(mission);return (mission.memoryConflicts??[]).filter(c=>conflictMemory(mission,c.first).effective&&conflictMemory(mission,c.second).effective);}
export function declareMemoryConflict(mission:Mission,input:{conflictId:string;first:MemoryConflictReference;second:MemoryConflictReference;reason:string},actorId:string):void {
 validateMemoryConflicts(mission);ensure(exact(input,['conflictId','first','second','reason']),'Exact memory conflict declaration fields required');const first=conflictMemory(mission,input.first),second=conflictMemory(mission,input.second);ensure(first.effective===true&&second.effective===true,'Only currently effective explicit memory versions may be declared');const conflict={id:input.conflictId,first:structuredClone(input.first),second:structuredClone(input.second),actorId,reason:input.reason};(mission.memoryConflicts??=[]).push(conflict);validateMemoryConflicts(mission);
}
export function requireUnconflictedNewWork(mission:Mission):void {const active=applicableMemoryConflicts(mission);ensure(!active.length,'New Work admission blocked by declared memory conflict: '+active.map(c=>c.id+' ['+c.first.id+'@'+c.first.version+' ↔ '+c.second.id+'@'+c.second.version+']').join('; ')+'. Deliberately retire an exact version before a new admission. Existing Work remains unchanged.');}
