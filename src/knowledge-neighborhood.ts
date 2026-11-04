import {createHash} from 'node:crypto';
import type {Relation} from './domain.ts';
import type {QueryTransport} from './storage.ts';
import {StorageProtocolError} from './storage.ts';
export const NEIGHBORHOOD_LIMIT=20,NEIGHBORHOOD_RELATION_LIMIT=1000;
export interface NeighborhoodInput {missionId:string;referenceId:string;version:number;feedId?:string;revision?:number;after?:number;cursor?:number;limit?:number}
export interface NeighborhoodEdge extends Relation {ordinal:number}
export interface NeighborhoodPage {missionId:string;revision:number;feedId:string;cursor:number;reference:{id:string;version:number};relationCount:number;limit:number;items:NeighborhoodEdge[];nextAfter:number|null}
export interface NeighborhoodReader {readNeighborhood(input:NeighborhoodInput):Promise<NeighborhoodPage|null>}
export class NeighborhoodChangedError extends Error {readonly reason:'feed'|'cursor'|'revision';constructor(reason:'feed'|'cursor'|'revision'){super('Relationship read '+reason+' changed; explicitly refresh current Mission/reference.');this.reason=reason;}}
export class NeighborhoodLimitError extends RangeError {constructor(){super('Neighborhood supports at most 1000 retained relations; no truncated graph is shown');}}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v),count=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0,positive=(v:unknown)=>count(v)&&Number(v)>0,id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v),literal=(v:unknown)=>typeof v==='string'&&!!v.trim()&&v.isWellFormed()&&v.length<=2000;
export function neighborhoodInput(input:NeighborhoodInput):Required<NeighborhoodInput>{if(!object(input)||Object.keys(input).some(k=>!['missionId','referenceId','version','feedId','revision','after','cursor','limit'].includes(k)))throw new TypeError('Exact neighborhood fields required');const {missionId,referenceId,version,feedId='',revision=-1,after=-1,cursor=-1,limit=NEIGHBORHOOD_LIMIT}=input;if(!id(missionId)||!literal(referenceId)||!positive(version)||feedId!==''&&!id(feedId)||revision!==-1&&!positive(revision)||after!==-1&&!count(after)||after>=NEIGHBORHOOD_RELATION_LIMIT||cursor!==-1&&!count(cursor)||after>=0&&(!feedId||revision<1||cursor<0)||after===-1&&cursor!==-1||!positive(limit)||limit>NEIGHBORHOOD_LIMIT)throw new TypeError('Invalid exact neighborhood read boundary');return {missionId,referenceId,version,feedId,revision,after,cursor,limit};}
export const NEIGHBORHOOD_QUERY=`BEGIN TRANSACTION;
RETURN {
 LET $feed=SELECT * FROM ONLY massion_feed:global;
 IF $feed=NONE OR $feed.schemaVersion!=2 OR $feed.feedId=NONE { THROW 'Storage feed identity is not initialized'; };
 IF $feedId!='' AND $feed.feedId!=$feedId { RETURN {changed:'feed'}; };
 IF $cursor>=0 AND $feed.cursor!=$cursor { RETURN {changed:'cursor'}; };
 LET $state=SELECT aggregateId,revision,value.relations FROM ONLY type::record('massion_state',$aggregateKey);
 IF $state=NONE { RETURN {missing:true,missionId:$missionId,feedId:$feed.feedId,cursor:$feed.cursor}; };
 IF $state.aggregateId!=$missionId OR !type::is_array($state.value.relations) { THROW 'Invalid Mission relation metadata'; };
 IF $revision>=1 AND $state.revision!=$revision { RETURN {changed:'revision'}; };
 LET $relationCount=array::len($state.value.relations);
 IF $relationCount>$relationLimit { RETURN {limitExceeded:true,missionId:$missionId,feedId:$feed.feedId,cursor:$feed.cursor,relationCount:$relationCount}; };
 LET $indexed=array::map($state.value.relations,|$r,$index| { RETURN {ordinal:$index,from:$r.from,to:$r.to,type:$r.type,fromVersion:$r.fromVersion,toVersion:$r.toVersion,provenance:$r.provenance,inferred:$r.inferred}; });
 LET $rows=SELECT ordinal,from,to,type,fromVersion,toVersion,provenance,inferred FROM $indexed WHERE ordinal>$after AND ((from=$referenceId AND fromVersion=$version) OR (to=$referenceId AND toVersion=$version)) ORDER BY ordinal ASC LIMIT $fetchLimit;
 RETURN {missionId:$state.aggregateId,revision:$state.revision,feedId:$feed.feedId,cursor:$feed.cursor,reference:{id:$referenceId,version:$version},relationCount:$relationCount,rows:$rows};
};
COMMIT TRANSACTION;`;
export class SurrealNeighborhood implements NeighborhoodReader {
 private readonly transport:QueryTransport;constructor(transport:QueryTransport){this.transport=transport;}
 async readNeighborhood(input:NeighborhoodInput):Promise<NeighborhoodPage|null>{const q=neighborhoodInput(structuredClone(input)),values=(await this.transport.query(NEIGHBORHOOD_QUERY,{...q,aggregateKey:createHash('sha256').update(q.missionId).digest('hex'),relationLimit:NEIGHBORHOOD_RELATION_LIMIT,fetchLimit:q.limit+1})).filter(v=>v!==null);if(values.length!==1)throw new StorageProtocolError('Invalid neighborhood result count');const r=values[0];if(object(r)&&Object.keys(r).length===1&&['feed','cursor','revision'].includes(String(r.changed)))throw new NeighborhoodChangedError(r.changed as 'feed'|'cursor'|'revision');
  const boundary=object(r)&&r.missionId===q.missionId&&id(r.feedId)&&count(r.cursor)&&(!q.feedId||r.feedId===q.feedId)&&(q.cursor<0||r.cursor===q.cursor);if(boundary&&Object.keys(r).length===4&&r.missing===true)return null;if(boundary&&Object.keys(r).length===5&&r.limitExceeded===true&&count(r.relationCount)&&Number(r.relationCount)>NEIGHBORHOOD_RELATION_LIMIT)throw new NeighborhoodLimitError();
  if(!boundary||!object(r)||Object.keys(r).length!==7||Object.keys(r).some(k=>!['missionId','revision','feedId','cursor','reference','relationCount','rows'].includes(k))||!positive(r.revision)||q.revision>=1&&r.revision!==q.revision||!object(r.reference)||Object.keys(r.reference).length!==2||r.reference.id!==q.referenceId||r.reference.version!==q.version||!count(r.relationCount)||Number(r.relationCount)>NEIGHBORHOOD_RELATION_LIMIT||!Array.isArray(r.rows)||r.rows.length>q.limit+1)throw new StorageProtocolError('Invalid exact neighborhood protocol');let previous=q.after;const items:NeighborhoodEdge[]=[];
  for(const row of r.rows){if(!object(row)||Object.keys(row).length!==8||Object.keys(row).some(k=>!['ordinal','from','to','type','fromVersion','toVersion','provenance','inferred'].includes(k))||!count(row.ordinal)||Number(row.ordinal)<=previous||Number(row.ordinal)>=Number(r.relationCount)||!literal(row.from)||!literal(row.to)||!literal(row.provenance)||!positive(row.fromVersion)||!positive(row.toVersion)||!['depends-on','evidenced-by','contains'].includes(String(row.type))||typeof row.inferred!=='boolean'||!(row.from===q.referenceId&&row.fromVersion===q.version||row.to===q.referenceId&&row.toVersion===q.version))throw new StorageProtocolError('Invalid original neighborhood edge');items.push(structuredClone(row) as unknown as NeighborhoodEdge);previous=Number(row.ordinal);}
  const more=items.length>q.limit,shown=items.slice(0,q.limit);return {missionId:q.missionId,revision:Number(r.revision),feedId:String(r.feedId),cursor:Number(r.cursor),reference:{id:q.referenceId,version:q.version},relationCount:Number(r.relationCount),limit:q.limit,items:shown,nextAfter:more?shown.at(-1)!.ordinal:null};
 }
}
