import type {QueryTransport} from './storage.ts';
import {StorageProtocolError} from './storage.ts';
export const MISSION_CATALOG_LIMIT=20;
export interface MissionSummary {missionId:string;revision:number;version:number;purpose:string;scope:string;workCount:number}
export interface MissionCatalogInput {after?:string;cursor?:number;feedId?:string;limit?:number}
export interface MissionCatalogPage {feedId:string;cursor:number;items:MissionSummary[];nextAfter:string|null;limit:number}
export interface MissionCatalogReader {readCatalog(input:MissionCatalogInput):Promise<MissionCatalogPage>}
export class MissionCatalogChangedError extends Error {readonly reason:'feed'|'cursor';constructor(reason:'feed'|'cursor'){super(reason==='feed'?'Database changed; refresh the stored Mission list.':'Stored state changed between pages; explicitly refresh the Mission list.');this.reason=reason;}}
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function catalogInput(input:MissionCatalogInput):Required<MissionCatalogInput> {
 if(!object(input)||Object.keys(input).some(k=>!['after','cursor','feedId','limit'].includes(k)))throw new TypeError('Exact Mission catalog query fields required');
 const {after='',cursor=-1,feedId='',limit=MISSION_CATALOG_LIMIT}=input as MissionCatalogInput;
 if(after!==''&&!id(after)||feedId!==''&&!id(feedId)||cursor!==-1&&!integer(cursor)||!Number.isSafeInteger(limit)||limit<1||limit>MISSION_CATALOG_LIMIT||after!==''&&(cursor<0||feedId==='')||after===''&&cursor!==-1)throw new TypeError('Invalid bounded Mission catalog page boundary');
 return {after,cursor,feedId,limit};
}
/** Project only stored identity and metadata, in the same native read transaction as its feed boundary. */
export const MISSION_CATALOG_QUERY=`BEGIN TRANSACTION;
RETURN {
 LET $feed = SELECT * FROM ONLY massion_feed:global;
 IF $feed = NONE OR $feed.schemaVersion != 2 OR $feed.feedId = NONE { THROW 'Storage feed identity is not initialized'; };
 IF $feedId != '' AND $feed.feedId != $feedId { RETURN {changed:'feed'}; };
 IF $cursor >= 0 AND $feed.cursor != $cursor { RETURN {changed:'cursor'}; };
 LET $rows = SELECT aggregateId, revision, value.id AS missionId, value.version AS version, value.purpose AS purpose, value.scope AS scope, array::len(value.works) AS workCount
  FROM massion_state WHERE aggregateId > $after ORDER BY aggregateId ASC LIMIT $fetchLimit;
 RETURN {feedId:$feed.feedId,cursor:$feed.cursor,rows:$rows};
};
COMMIT TRANSACTION;`;
export class SurrealMissionCatalog implements MissionCatalogReader {
 private readonly transport:QueryTransport;constructor(transport:QueryTransport){this.transport=transport;}
 async readCatalog(input:MissionCatalogInput):Promise<MissionCatalogPage> {
  const q=catalogInput(structuredClone(input)),results=(await this.transport.query(MISSION_CATALOG_QUERY,{...q,fetchLimit:q.limit+1})).filter(v=>v!==null);if(results.length!==1)throw new StorageProtocolError('Invalid Mission catalog result count');const r=results[0];
  if(object(r)&&Object.keys(r).length===1&&(r.changed==='feed'||r.changed==='cursor'))throw new MissionCatalogChangedError(r.changed);
  if(!object(r)||typeof r.feedId!=='string'||!id(r.feedId)||!integer(r.cursor)||!Array.isArray(r.rows)||r.rows.length>q.limit+1||q.feedId&&q.feedId!==r.feedId||q.cursor>=0&&q.cursor!==r.cursor)throw new StorageProtocolError('Invalid Mission catalog feed boundary');
  let previous=q.after;const rows:MissionSummary[]=[];
  for(const row of r.rows){if(!object(row)||!id(row.missionId)||row.aggregateId!==row.missionId||String(row.missionId)<=previous||!integer(row.revision)||Number(row.revision)<1||!integer(row.version)||Number(row.version)<1||!integer(row.workCount)||typeof row.purpose!=='string'||!row.purpose.trim()||!row.purpose.isWellFormed()||row.purpose.length>16000||typeof row.scope!=='string'||!row.scope.trim()||!row.scope.isWellFormed()||row.scope.length>16000)throw new StorageProtocolError('Invalid stored Mission identity or metadata');previous=row.missionId as string;rows.push({missionId:previous,revision:row.revision as number,version:row.version as number,purpose:row.purpose,scope:row.scope,workCount:row.workCount as number});}
  const more=rows.length>q.limit,items=rows.slice(0,q.limit);return {feedId:r.feedId,cursor:r.cursor as number,items,nextAfter:more?items.at(-1)!.missionId:null,limit:q.limit};
 }
}
