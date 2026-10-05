import {createHash} from 'node:crypto';
import type {Relation} from './domain.ts';
import type {QueryTransport} from './storage.ts';
import {StorageProtocolError} from './storage.ts';

export interface RelationImpact {
  missionId:string; revision:number; feedId:string; cursor:number;
  changed:{id:string;version:number}; affected:string[]; relations:Relation[];
}
export interface RelationImpactReader {
  readImpact(missionId:string,entityId:string,version:number):Promise<RelationImpact|null>;
}
export const IMPACT_RELATION_LIMIT=1000;
export class RelationImpactLimitError extends RangeError {
  constructor(){super('Impact query supports at most 1000 relations; no result was truncated');this.name='RelationImpactLimitError';}
}
export function validateImpactInput(missionId:string,entityId:string,version:number):void {
  if(typeof missionId!=='string'||!missionId.trim()||typeof entityId!=='string'||!entityId.trim()||
    !Number.isSafeInteger(version)||version<1)throw new TypeError('A Mission, entity and positive safe version are required');
}

/** The existing Relation array is authoritative; traversal happens entirely in one DB snapshot. */
export const RELATION_IMPACT_QUERY = `BEGIN TRANSACTION;
RETURN {
  LET $feed = SELECT * FROM ONLY massion_feed:global;
  IF $feed = NONE OR $feed.schemaVersion != 2 OR $feed.feedId = NONE { THROW 'Storage feed identity is not initialized'; };
  LET $state = SELECT aggregateId, revision, value.relations FROM ONLY type::record('massion_state', $aggregateKey);
  IF $state = NONE { RETURN {missing:true,missionId:$missionId,feedId:$feed.feedId,cursor:$feed.cursor}; };
  IF $state.aggregateId != $missionId OR !type::is_array($state.value.relations) { THROW 'Invalid Mission relations'; };
  LET $relations = $state.value.relations;
  IF array::len($relations) > $relationLimit { RETURN {limitExceeded:true,missionId:$missionId,feedId:$feed.feedId,cursor:$feed.cursor,relationCount:array::len($relations)}; };
  LET $reachable = array::fold($relations, [{id:$entityId,version:$version}], |$seen,$unused| {
    LET $incoming = SELECT from, fromVersion FROM $relations WHERE {id:to,version:toVersion} IN $seen;
    RETURN array::union($seen, array::map($incoming, |$edge| { RETURN {id:$edge.from,version:$edge.fromVersion}; }));
  });
  LET $edges = SELECT * FROM $relations WHERE {id:to,version:toVersion} IN $reachable;
  RETURN {missionId:$state.aggregateId,revision:$state.revision,feedId:$feed.feedId,cursor:$feed.cursor,
    changed:{id:$entityId,version:$version},affected:array::distinct(array::map($edges, |$edge| $edge.from + '@' + <string>$edge.fromVersion)),relations:$edges};
};
COMMIT TRANSACTION;`;

const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const positive=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;
function relation(v:unknown):v is Relation {
  return object(v)&&typeof v.from==='string'&&!!v.from.trim()&&typeof v.to==='string'&&!!v.to.trim()&&
    positive(v.fromVersion)&&positive(v.toVersion)&&['depends-on','evidenced-by','contains'].includes(String(v.type))&&
    typeof v.provenance==='string'&&!!v.provenance.trim()&&typeof v.inferred==='boolean';
}
/** Read-only adapter; does not load the graph into JS for traversal or mutate a projection. */
export class SurrealRelationImpact implements RelationImpactReader {
  private readonly transport:QueryTransport;
  constructor(transport:QueryTransport){this.transport=transport;}
  async readImpact(missionId:string,entityId:string,version:number):Promise<RelationImpact|null> {
    validateImpactInput(missionId,entityId,version);
    const results=await this.transport.query(RELATION_IMPACT_QUERY,{
      missionId,entityId,version,relationLimit:IMPACT_RELATION_LIMIT,aggregateKey:createHash('sha256').update(missionId).digest('hex'),
    });
    // BEGIN/COMMIT may return null; absence requires an explicit valid payload.
    const values=results.filter(value=>value!==null);
    if(values.length!==1)throw new StorageProtocolError('Invalid relation impact result count');
    const result=values[0];
    if(object(result)&&result.missing===true&&result.missionId===missionId&&
      typeof result.feedId==='string'&&!!result.feedId&&Number.isSafeInteger(result.cursor)&&Number(result.cursor)>=0)return null;
    if(object(result)&&result.limitExceeded===true&&result.missionId===missionId&&
      typeof result.feedId==='string'&&!!result.feedId&&Number.isSafeInteger(result.cursor)&&Number(result.cursor)>=0&&
      Number.isSafeInteger(result.relationCount)&&Number(result.relationCount)>IMPACT_RELATION_LIMIT)throw new RelationImpactLimitError();
    if(!object(result)||result.missionId!==missionId||!positive(result.revision)||
      typeof result.feedId!=='string'||!result.feedId||!Number.isSafeInteger(result.cursor)||Number(result.cursor)<0||
      !object(result.changed)||result.changed.id!==entityId||result.changed.version!==version||
      !Array.isArray(result.affected)||result.affected.some(id=>typeof id!=='string')||
      new Set(result.affected).size!==result.affected.length||!Array.isArray(result.relations)||!result.relations.every(relation)){
      throw new StorageProtocolError('Invalid relation impact result');
    }
    const versions=new Set(result.relations.map(edge=>edge.from+'@'+edge.fromVersion));
    if(versions.size!==result.affected.length||result.affected.some(id=>!versions.has(id)))throw new StorageProtocolError('Impact entities do not match returned relations');
    return {...result,affected:[...result.affected].sort()} as unknown as RelationImpact;
  }
}
