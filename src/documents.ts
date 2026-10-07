import {DomainError,validateDocumentHistory} from './domain.ts';
import type {Mission,DocumentVersion} from './domain.ts';
import type {Store} from './storage.ts';
import {EventCursorError} from './storage.ts';
export class DocumentReadError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;this.name='DocumentReadError';}}
export interface DocumentMatch {id:string;version:number;title:string;source:string;contentSha256:string;actorId:string;excerpt:string}
export interface DocumentSearch {missionId:string;revision:number;feedId:string;cursor:number;query:string;totalMatches:number;limit:20;matches:DocumentMatch[]}
export interface DocumentRead {missionId:string;revision:number;feedId:string;cursor:number;document:DocumentVersion;byteLength:number}
async function documentState(store:Store<Mission>,missionId:string,feedId?:string){
 const state=await store.readState(missionId);if(feedId!==undefined&&state.feedId!==feedId)throw new EventCursorError(0,state.cursor);
 if(state.snapshot?.value.documents!==undefined)try{validateDocumentHistory(state.snapshot.value.documents);}catch{throw new DocumentReadError(503,'Stored document history failed exact content/lineage integrity checks. No fallback is used.');}return state;
}
/** Literal case-sensitive title/content search over latest versions only; no effects or relevance claim. */
export async function searchDocuments(store:Store<Mission>,missionId:string,input:{query:string;feedId?:string}):Promise<DocumentSearch|null>{
 input=structuredClone(input);if(typeof input.query!=='string'||!input.query.trim()||input.query.length>200||!input.query.isWellFormed())throw new DomainError('Nonblank literal document query of at most 200 characters required');
 const state=await documentState(store,missionId,input.feedId);if(!state.snapshot)return null;const latest=new Map<string,DocumentVersion>();for(const d of state.snapshot.value.documents??[])latest.set(d.id,d);
 const hits=[...latest.values()].filter(d=>d.title.includes(input.query)||d.content.includes(input.query));return {missionId,revision:state.snapshot.revision,feedId:state.feedId,cursor:state.cursor,query:input.query,totalMatches:hits.length,limit:20,matches:hits.slice(0,20).map(d=>{const at=d.content.indexOf(input.query),start=Math.max(0,at-40);return {id:d.id,version:d.version,title:d.title,source:d.source,contentSha256:d.contentSha256,actorId:d.actorId,excerpt:d.content.slice(start,start+240)};})};
}
/** Exact historical version/hash, never replaced by latest; a single authoritative snapshot read. */
export async function readDocument(store:Store<Mission>,missionId:string,input:{id:string;version:number;contentSha256:string;feedId?:string}):Promise<DocumentRead|null>{
 input=structuredClone(input);if(typeof input.id!=='string'||!/^document:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.id)||!Number.isSafeInteger(input.version)||input.version<1||typeof input.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(input.contentSha256))throw new DomainError('Exact document ID/version/SHA-256 required');
 const state=await documentState(store,missionId,input.feedId);if(!state.snapshot)return null;const d=state.snapshot.value.documents?.find(d=>d.id===input.id&&d.version===input.version);if(!d)return null;if(d.contentSha256!==input.contentSha256)throw new DocumentReadError(409,'Exact document content hash does not match. No newer version is substituted.');
 return {missionId,revision:state.snapshot.revision,feedId:state.feedId,cursor:state.cursor,document:structuredClone(d),byteLength:Buffer.byteLength(d.content,'utf8')};
}
