import type {Mission} from './domain.ts';
import type {Store} from './storage.ts';
import {EventCursorError,StorageProtocolError} from './storage.ts';

export interface BudgetHistoryInput {after:number;limit:number;through?:number;feedId?:string}
export interface BudgetHistoryChange {cursor:number;revision:number;commandId:string;actor:string;limit:number;reason:string}
export interface BudgetHistoryPage {missionId:string;workId:string;feedId:string;through:number;cursor:number;complete:boolean;scannedBatches:number;changes:BudgetHistoryChange[]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

/** Read recorded commands only, at a frozen database-local feed boundary. No mutation/replay. */
export async function readWorkBudgetHistory(store:Store<Mission>,missionId:string,workId:string,input:BudgetHistoryInput):Promise<BudgetHistoryPage|null> {
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
 const batches=page.events.filter(batch=>batch.cursor<=through),changes:BudgetHistoryChange[]=[];
 for(const batch of batches) {
  if(batch.aggregateId!==missionId)continue;
  for(const event of batch.events) {
   if(!object(event)||event.type!=='revise-budget'||!object(event.command)||event.command.workId!==workId)continue;
   const {command}=event;
   if(command.type!=='revise-budget'||typeof event.actor!=='string'||!event.actor||typeof command.limit!=='number'||!Number.isFinite(command.limit)||command.limit<0||typeof command.reason!=='string'||!command.reason.trim()||command.reason.length>16000)throw new StorageProtocolError('Invalid recorded budget change');
   changes.push({cursor:batch.cursor,revision:batch.revision,commandId:batch.commandId,actor:event.actor,limit:command.limit,reason:command.reason});
  }
 }
 const cursor=Math.min(page.cursor,through);
 return {missionId,workId,feedId:state.feedId,through,cursor,complete:cursor===through,scannedBatches:batches.length,changes};
}
