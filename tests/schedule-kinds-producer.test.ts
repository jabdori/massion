import test from 'node:test';
import assert from 'node:assert/strict';
import {scheduleWorkProducer} from '../src/schedules.ts';
import type {AssistantService} from '../src/assistant-service.ts';
import {DomainError} from '../src/domain.ts';
import {copy} from '../src/ui-copy.ts';

const request={commandId:'schedule-work:run:one',scheduleId:'expenses',runId:'run:one',kind:'weekly-expenses' as const,request:'Group the supplied receipt files by category.'};
function fixture(status='answered',workStatus='admitted'){
 const sent:any[]=[],reads:(number|undefined)[]=[],outcome={missionId:'intake',work:{status:workStatus,diagnostics:[]},run:{status:'requested',diagnostics:[]}},turn={id:'turn:scheduled',status,outcome};
 const assistant={
  async send(input:unknown){sent.push(input);return {message:{status:'committed',revision:1,value:{kind:'assistant-conversation',id:'assistant-conversation:4',segment:4,previous:{id:'assistant-conversation:3',lastMessageId:'message:previous'},closed:false,timeWatermark:1,messages:[],turns:[]}},turn};},
  async read(segment?:number){reads.push(segment);return {feedId:'feed:a',cursor:1,head:4,segment:{number:segment??3,revision:4,closed:!segment,full:!segment,previous:null,messages:[]},turns:segment?[{...turn,work:workStatus==='admitted'?{missionId:'intake',workId:'work:scheduled',title:'Receipt categories',execution:'queued',acceptance:'pending',unknown:false}:undefined},{id:'turn:other',work:{workId:'work:other'}}]:[]};}
 } as unknown as Pick<AssistantService,'read'|'send'>;
 return {assistant,sent,reads};
}

test('the producer rolls over a full conversation and retains only the exact admitted Work source',async()=>{
 const {assistant,sent,reads}=fixture();assert.deepEqual(await scheduleWorkProducer(assistant)(request),{turnIds:['turn:scheduled'],segment:4});
 assert.deepEqual(reads,[undefined,4]);assert.equal(sent.length,1);assert.deepEqual({...sent[0],text:request.request},{commandId:request.commandId,segment:4,expectedRevision:0,text:request.request});assert.equal(sent[0].text,copy('ui.schedules.dispatch',{request:request.request}));
});

test('a pending or unknown Representative response stays unknown instead of creating retry permission',async()=>{
 for(const [status,work] of [['pending','admitted'],['unknown','admitted'],['answered','unknown']]){const {assistant,sent}=fixture(status,work);assert.equal(await scheduleWorkProducer(assistant)(request),null,status);assert.equal(sent.length,1);}
});

test('a direct answer or rejected Work admission cannot fabricate a completed scheduled outcome',async()=>{
 for(const [status,work] of [['failed','not_created'],['answered','not_created']]){const {assistant}=fixture(status,work);await assert.rejects(scheduleWorkProducer(assistant)(request),DomainError);}
});

test('an answered turn without recorded admission outcome stays unknown even when Work exists',async()=>{
 const f=fixture(),send=f.assistant.send.bind(f.assistant);f.assistant.send=async input=>{const result=await send(input);delete result.turn!.outcome;return result;};
 assert.equal(await scheduleWorkProducer(f.assistant)(request),null);assert.equal(f.sent.length,1);
});

test('an admitted turn whose authoritative source read fails never becomes retry permission',async()=>{
 for(const fail of [false,true]){const f=fixture(),read=f.assistant.read.bind(f.assistant);f.assistant.read=async segment=>{if(segment!==undefined){if(fail)throw new DomainError('Source unavailable');return {...await read(segment),turns:[]};}return read(segment);};assert.equal(await scheduleWorkProducer(f.assistant)(request),null);assert.equal(f.sent.length,1);}
});
