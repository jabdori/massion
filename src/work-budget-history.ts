import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {EventCursorError,StorageProtocolError} from './storage.ts';

export interface BudgetHistoryInput {after:number;limit:number;through?:number;feedId?:string}
export interface BudgetHistoryChange {cursor:number;revision:number;commandId:string;actor:string;limit:number;reason:string}
export interface BudgetHistoryPage {missionId:string;workId:string;feedId:string;through:number;cursor:number;complete:boolean;scannedBatches:number;changes:BudgetHistoryChange[]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Read recorded commands only, at a frozen database-local feed boundary. No mutation/replay. */
export async function readWorkBudgetHistory(store:Store<Mission>,missionId:string,workId:string,input:BudgetHistoryInput):Promise<BudgetHistoryPage|null> {
 return readWorkCommandHistory(store,missionId,workId,input,'budget') as Promise<BudgetHistoryPage|null>;
}
export interface InterventionHistoryChange {cursor:number;revision:number;commandId:string;actor:string;action:'steer'|'cancel'|'quarantine-runtime'|'close-expired-runtime';instruction?:string;reason?:string;runId?:string}
export interface InterventionHistoryPage extends Omit<BudgetHistoryPage,'changes'> {changes:InterventionHistoryChange[]}
export function readWorkInterventionHistory(store:Store<Mission>,missionId:string,workId:string,input:BudgetHistoryInput):Promise<InterventionHistoryPage|null> {return readWorkCommandHistory(store,missionId,workId,input,'intervention') as Promise<InterventionHistoryPage|null>;}
async function readWorkCommandHistory(store:Store<Mission>,missionId:string,workId:string,input:BudgetHistoryInput,kind:'budget'|'intervention'):Promise<BudgetHistoryPage|InterventionHistoryPage|null> {
 const {after,limit,through:requestedThrough,feedId}=input;
 if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100||requestedThrough!==undefined&&(!Number.isSafeInteger(requestedThrough)||requestedThrough<after))throw new TypeError('Invalid budget history bounds');
 if(after>0&&requestedThrough===undefined)throw new TypeError('Continuation requires the original through boundary');
 if((after>0||requestedThrough!==undefined)&&!feedId)throw new TypeError('Continuation requires the original feed identity');
 const state=await store.readState(missionId);
 if(feedId!==undefined&&feedId!==state.feedId)throw new EventCursorError(after,state.cursor);
 const through=requestedThrough??state.cursor;
 if(after>through||through>state.cursor)throw new EventCursorError(after,state.cursor);
 if(!state.snapshot?.value.works.some(work=>work.id===workId))return null;
 // Always recheck the same feed, even an empty/final page: replacement after readState must reject.
 const page=await store.readCatchup(after,state.feedId,limit);
 if(page.feedId!==state.feedId)throw new EventCursorError(after,state.cursor);
 const batches=page.events.filter(batch=>batch.cursor<=through),changes:(BudgetHistoryChange|InterventionHistoryChange)[]=[];
 for(const batch of batches) {
  if(batch.aggregateId!==missionId)continue;
  for(const event of batch.events) {
   if(!object(event)||!object(event.command)||event.command.workId!==workId)continue;
   const {command}=event;
   if(kind==='intervention') {
    if(!['steer','cancel','quarantine-runtime','close-expired-runtime'].includes(String(event.type)))continue;
    if(command.type!==event.type||typeof event.actor!=='string'||!event.actor||event.actor.length>128)throw new StorageProtocolError('Invalid recorded intervention');
    const row:InterventionHistoryChange={cursor:batch.cursor,revision:batch.revision,commandId:batch.commandId,actor:event.actor,action:event.type as InterventionHistoryChange['action']};
    if(event.type==='steer'){if(typeof command.instruction!=='string'||!command.instruction.trim()||command.instruction.length>16000)throw new StorageProtocolError('Invalid recorded instruction');row.instruction=command.instruction;}
    if(event.type==='quarantine-runtime'||event.type==='close-expired-runtime'){if(typeof command.reason!=='string'||!command.reason.trim()||command.reason.length>16000||typeof command.runId!=='string'||!command.runId||command.runId.length>128||command.acknowledgeUncertainOutcome!==true)throw new StorageProtocolError('Invalid recorded quarantine');row.reason=command.reason;row.runId=command.runId;}
    changes.push(row);continue;
   }
   if(event.type!=='revise-budget')continue;
   if(command.type!=='revise-budget'||typeof event.actor!=='string'||!event.actor||typeof command.limit!=='number'||!Number.isFinite(command.limit)||command.limit<0||typeof command.reason!=='string'||!command.reason.trim()||command.reason.length>16000)throw new StorageProtocolError('Invalid recorded budget change');
   changes.push({cursor:batch.cursor,revision:batch.revision,commandId:batch.commandId,actor:event.actor,limit:command.limit,reason:command.reason});
  }
 }
 const cursor=Math.min(page.cursor,through);
 return {missionId,workId,feedId:state.feedId,through,cursor,complete:cursor===through,scannedBatches:batches.length,changes} as BudgetHistoryPage|InterventionHistoryPage;
}
