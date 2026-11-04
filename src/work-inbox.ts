import type {QueryTransport} from './storage.ts';
import {StorageProtocolError} from './storage.ts';
export const WORK_INBOX_LIMIT=20;
export interface WorkInboxInput {afterMission?:string;afterWork?:string;cursor?:number;feedId?:string;limit?:number}
export interface WorkInboxItem {missionId:string;missionPurpose:string;revision:number;workId:string;title:string;execution:string;acceptance:string;openQuestions:number;unknownEffects:number;pendingEffects:number;interrupted:boolean;blocker:null|{code:string;detail:string}}
export interface WorkInboxPage {feedId:string;cursor:number;limit:number;items:WorkInboxItem[];nextAfter:null|{missionId:string;workId:string}}
export interface WorkInboxReader {readInbox(input:WorkInboxInput):Promise<WorkInboxPage>}
export class WorkInboxChangedError extends Error {readonly reason:'feed'|'cursor';constructor(reason:'feed'|'cursor'){super(reason==='feed'?'Database changed; explicitly refresh the unresolved Work inbox.':'Stored state changed between inbox pages; explicitly refresh.');this.reason=reason;}}
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v),integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function inboxInput(input:WorkInboxInput):Required<WorkInboxInput>{
 if(!object(input)||Object.keys(input).some(k=>!['afterMission','afterWork','cursor','feedId','limit'].includes(k)))throw new TypeError('Exact Work inbox page fields required');const {afterMission='',afterWork='',cursor=-1,feedId='',limit=WORK_INBOX_LIMIT}=input as WorkInboxInput;
 if((afterMission==='')!==(afterWork==='')||afterMission!==''&&(!id(afterMission)||!id(afterWork)||cursor<0||feedId==='')||feedId!==''&&!id(feedId)||cursor!==-1&&!integer(cursor)||afterMission===''&&cursor!==-1||!Number.isSafeInteger(limit)||limit<1||limit>WORK_INBOX_LIMIT)throw new TypeError('Invalid bounded Work inbox read boundary');return {afterMission,afterWork,cursor,feedId,limit};
}
/** Stored fact predicate only; cancellation never hides unresolved outcomes. */
export function unresolvedInboxItem(w:Pick<WorkInboxItem,'openQuestions'|'unknownEffects'|'pendingEffects'|'execution'|'interrupted'|'acceptance'|'blocker'>):boolean{return w.openQuestions>0||w.unknownEffects>0||w.pendingEffects>0&&(w.execution==='cancelled'||w.interrupted)||['failed','stale'].includes(w.acceptance)||w.blocker!==null;}
/** Native projection/array splitting follows SurrealQL SELECT/SPLIT; no graph write or body transfer. */
export const WORK_INBOX_QUERY=`BEGIN TRANSACTION;
RETURN {
 LET $feed = SELECT * FROM ONLY massion_feed:global;
 IF $feed = NONE OR $feed.schemaVersion != 2 OR $feed.feedId = NONE { THROW 'Storage feed identity is not initialized'; };
 IF $feedId != '' AND $feed.feedId != $feedId { RETURN {changed:'feed'}; };
 IF $cursor >= 0 AND $feed.cursor != $cursor { RETURN {changed:'cursor'}; };
 LET $missions = SELECT aggregateId,revision,value.id AS missionId,value.purpose AS missionPurpose,
  array::map(value.works,|$w| { RETURN {workId:$w.id,title:$w.title,execution:$w.execution,acceptance:$w.acceptance,
   openQuestions:array::len(($w.questions ?? [])[WHERE answer = NULL]),unknownEffects:array::len($w.effects[WHERE status = 'unknown']),pendingEffects:array::len($w.effects[WHERE status = 'pending']),
   interrupted:$w.runtimeInterruption != NONE OR $w.runtimeRecovery != NONE,blocker:IF $w.blocker = NONE { NULL } ELSE { $w.blocker }}; }) AS works
  FROM massion_state WHERE aggregateId >= $afterMission;
 LET $split = SELECT aggregateId,revision,missionId,missionPurpose,works FROM $missions SPLIT works;
 LET $rows = SELECT aggregateId,revision,missionId,missionPurpose,works.workId AS workId,works.title AS title,works.execution AS execution,works.acceptance AS acceptance,
  works.openQuestions AS openQuestions,works.unknownEffects AS unknownEffects,works.pendingEffects AS pendingEffects,works.interrupted AS interrupted,works.blocker AS blocker
  FROM $split WHERE (missionId > $afterMission OR missionId = $afterMission AND works.workId > $afterWork)
   AND (works.openQuestions > 0 OR works.unknownEffects > 0 OR works.pendingEffects > 0 AND (works.execution = 'cancelled' OR works.interrupted)
    OR works.acceptance IN ['failed','stale'] OR works.blocker != NULL)
  ORDER BY missionId ASC,workId ASC LIMIT $fetchLimit;
 RETURN {feedId:$feed.feedId,cursor:$feed.cursor,rows:$rows};
};
COMMIT TRANSACTION;`;
export class SurrealWorkInbox implements WorkInboxReader {
 private readonly transport:QueryTransport;constructor(transport:QueryTransport){this.transport=transport;}
 async readInbox(input:WorkInboxInput):Promise<WorkInboxPage>{
  const q=inboxInput(structuredClone(input)),values=(await this.transport.query(WORK_INBOX_QUERY,{...q,fetchLimit:q.limit+1})).filter(v=>v!==null);if(values.length!==1)throw new StorageProtocolError('Invalid inbox result count');const r=values[0];if(object(r)&&Object.keys(r).length===1&&(r.changed==='feed'||r.changed==='cursor'))throw new WorkInboxChangedError(r.changed);
  if(!object(r)||!id(r.feedId)||!integer(r.cursor)||!Array.isArray(r.rows)||r.rows.length>q.limit+1||q.feedId&&r.feedId!==q.feedId||q.cursor>=0&&r.cursor!==q.cursor)throw new StorageProtocolError('Invalid inbox read boundary');let prior=[q.afterMission,q.afterWork];const items:WorkInboxItem[]=[];
  for(const row of r.rows){if(!object(row)||Object.keys(row).length!==13||Object.keys(row).some(k=>!['aggregateId','revision','missionId','missionPurpose','workId','title','execution','acceptance','openQuestions','unknownEffects','pendingEffects','interrupted','blocker'].includes(k))||!id(row.missionId)||row.aggregateId!==row.missionId||!id(row.workId)||String(row.missionId)<prior[0]!||row.missionId===prior[0]&&String(row.workId)<=prior[1]!||!integer(row.revision)||Number(row.revision)<1||typeof row.missionPurpose!=='string'||!row.missionPurpose.trim()||!row.missionPurpose.isWellFormed()||row.missionPurpose.length>16000||typeof row.title!=='string'||!row.title.trim()||!row.title.isWellFormed()||row.title.length>16000||!['queued','active','waiting','blocked','cancelled','settled'].includes(String(row.execution))||!['pending','failed','stale','accepted'].includes(String(row.acceptance))||!integer(row.openQuestions)||Number(row.openQuestions)>3||!integer(row.unknownEffects)||!integer(row.pendingEffects)||typeof row.interrupted!=='boolean'||row.blocker!==null&&(!object(row.blocker)||Object.keys(row.blocker).length!==2||!['provider_unavailable','runtime_unavailable','provider_failed','budget_exceeded','verification_failed'].includes(String(row.blocker.code))||typeof row.blocker.detail!=='string'||!row.blocker.detail.trim()||!row.blocker.detail.isWellFormed()||row.blocker.detail.length>16000))throw new StorageProtocolError('Invalid original inbox Work identity/facts');const {aggregateId,...item}=row;const typed=item as unknown as WorkInboxItem;if(!unresolvedInboxItem(typed))throw new StorageProtocolError('Inbox item has no retained unresolved fact');items.push(structuredClone(typed));prior=[typed.missionId,typed.workId];}
  const more=items.length>q.limit,shown=items.slice(0,q.limit),last=shown.at(-1);return {feedId:r.feedId as string,cursor:r.cursor as number,limit:q.limit,items:shown,nextAfter:more?{missionId:last!.missionId,workId:last!.workId}:null};
 }
}
