import {DomainError,hash,workInputHash} from './domain.ts';
import type {Memory,Mission,Work} from './domain.ts';

export interface MemorySourceWork {missionId:string;workId:string;title:string;inputHash:string;criteriaHash:string}
export interface MemoryProposal {name:string;content:string;sourceWorkId:string|null}
export interface MemoryCandidate {id:string;version:1;name:string;content:string;missionId:string;scope:string;memberId:string;segmentId:string;turnId:string;messageHash:string;sourceWork?:MemorySourceWork;state:'proposed'|'saving'|'discarded';missionRevision?:number}
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v),sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function ensure(v:unknown,message:string):asserts v {if(!v)throw new DomainError(message);}
export const memoryText=(v:unknown,limit:number,line=false):v is string=>typeof v==='string'&&!!v.trim()&&v.isWellFormed()&&Buffer.byteLength(v,'utf8')<=limit&&!(line?/[\u0000-\u001f]/:/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/).test(v);
export function validMemoryProposal(v:unknown):v is MemoryProposal {return exact(v,['name','content','sourceWorkId'])&&memoryText(v.name,512,true)&&memoryText(v.content,4096)&&(v.sourceWorkId===null||id(v.sourceWorkId));}
export function memoryWorkSource(mission:Mission,work:Work):MemorySourceWork {return {missionId:mission.id,workId:work.id,title:work.title,inputHash:workInputHash(work),criteriaHash:hash(work.criteria)};}
export function validateMemoryMetadata(memory:Memory,mission?:Mission):void {
 if(Object.hasOwn(memory,'name'))ensure(memoryText(memory.name,512,true),'Invalid memory display name');
 if(Object.hasOwn(memory,'sourceWork')){const s=memory.sourceWork;ensure(exact(s,['missionId','workId','title','inputHash','criteriaHash'])&&id(s.missionId)&&id(s.workId)&&memoryText(s.title,16000)&&sha(s.inputHash)&&sha(s.criteriaHash),'Invalid exact memory source Work');
  if(mission){const w=mission.works.find(w=>w.id===s.workId);ensure(s.missionId===mission.id&&w&&hash(memoryWorkSource(mission,w))===hash(s),'Exact memory source Work changed or unavailable');}
 }
}
export const memoryCandidateId=(segmentId:string,turnId:string)=>'memory-'+hash([segmentId,turnId]).slice(0,24);
export function memoryCandidateHash(candidate:MemoryCandidate):string {const {state,missionRevision,...proposal}=candidate;return hash(proposal);}
export function validateMemoryCandidate(candidate:MemoryCandidate,segmentId:string,turnId:string,messageHash:string,thread:string):void {
 const c=candidate;ensure(exact(c,['id','version','name','content','missionId','scope','memberId','segmentId','turnId','messageHash','state',...(Object.hasOwn(c,'sourceWork')?['sourceWork']:[]),...(Object.hasOwn(c,'missionRevision')?['missionRevision']:[])])&&c.id===memoryCandidateId(segmentId,turnId)&&c.version===1&&c.segmentId===segmentId&&c.turnId===turnId&&c.messageHash===messageHash&&sha(c.messageHash)&&id(c.memberId)&&thread==='member:'+c.memberId&&id(c.missionId)&&memoryText(c.scope,16000)&&memoryText(c.name,512,true)&&memoryText(c.content,4096)&&['proposed','saving','discarded'].includes(c.state),'Invalid exact member memory candidate');
 ensure(c.state==='saving'?Number.isSafeInteger(c.missionRevision)&&c.missionRevision!>=1:!Object.hasOwn(c,'missionRevision'),'Invalid memory save intent revision');validateMemoryMetadata(candidateMemory(c));
 ensure(!c.sourceWork||c.sourceWork.missionId===c.missionId,'Memory source Mission mismatch');
}
export function candidateMemory(c:MemoryCandidate):Memory {return {id:c.id,version:c.version,name:c.name,scope:c.scope,authority:'explicit',content:c.content,source:c.segmentId+'/'+c.turnId,effective:true,...(c.sourceWork?{sourceWork:structuredClone(c.sourceWork)}:{})};}
