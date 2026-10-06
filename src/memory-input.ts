import {DomainError} from './domain.ts';
import type {Memory,Mission,Work} from './domain.ts';

/** Immutable task data; current effective flags must not change an older Work's input. */
export type PinnedMemory = Omit<Memory,'effective'>;
export const MAX_PINNED_MEMORY_BYTES=65536;
export function pinnedMemoryInput(mission:Mission,work:Work):PinnedMemory[] {
 const pins=work.appliedMemoryVersions;
 if(!Array.isArray(pins)||pins.some(pin=>typeof pin!=='string'||!pin)||new Set(pins).size!==pins.length)throw new DomainError('Invalid pinned memory identities');
 if(!pins.length)return [];
 if(!work.missionSnapshot||!Array.isArray(mission.memories))throw new DomainError('Pinned memory scope or history is unavailable');
 const text=(value:unknown)=>typeof value==='string'&&!!value.trim()&&value.length<=16000;
 const result=pins.map(pin=>{
  const matches=mission.memories.filter(m=>m&&`${m.id}@${m.version}`===pin);
  if(matches.length!==1)throw new DomainError('An exact pinned memory version is missing or ambiguous');
  const m=matches[0]!;
  if(!text(m.id)||!Number.isSafeInteger(m.version)||m.version<1||!text(m.scope)||m.scope!==work.missionSnapshot!.scope||!['explicit','learned'].includes(m.authority)||!text(m.content)||!text(m.source))throw new DomainError('Pinned memory content, authority or original scope is invalid');
  return {id:m.id,version:m.version,scope:m.scope,authority:m.authority,content:m.content,source:m.source};
 });
 if(Buffer.byteLength(JSON.stringify(result),'utf8')>MAX_PINNED_MEMORY_BYTES)throw new DomainError('Pinned memory task data exceeds the 65536-byte bound');
 return result;
}
