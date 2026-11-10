import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {copy} from '../src/ui-copy.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const T=Date.UTC(2026,10,6),briefing={id:'briefing',kind:'briefing',title:'Morning briefing',request:"Sum up yesterday's work: what finished, what was handed back, what has an unknown result.",assignee:'하나',destination:'Conversation with 하나',active:true,nextAt:T+86400000,minute:480,offset:0,budget:{runs:30,used:0},runs:[]};
const expenses={...briefing,id:'expenses',kind:'weekly-expenses',title:'Weekly expenses',request:'Receipts from my supplied files',minute:540,runs:[{id:'expenses-run',at:T,state:'done',turnIds:['turn:expenses'],segment:2,fact:'1 Work item'}]};
function fixture(){
 const state={schedules:[briefing,expenses] as any[],feed:'feed:a',hold:null as null|Promise<void>,posted:[] as any[],events:[] as any[],cursor:1,readHold:null as null|(()=>Promise<void>)};
 const app=harness(async(path,options)=>{
  if(path==='/assistant/schedules'){
   if(options?.method==='POST'){const body=JSON.parse(options.body);state.posted.push(body);if(body.action==='create')state.schedules.push({...briefing,id:'new-'+state.posted.length,kind:body.kind,title:'New schedule',request:body.request,runs:[]});if(state.hold)await state.hold;return reply({status:'committed',revision:2,value:{schedules:structuredClone(state.schedules)}});}
   const schedules=structuredClone(state.schedules),feedId=state.feed;if(state.readHold)await state.readHold();if(state.hold)await state.hold;return reply({feedId,revision:1,schedules});
  }
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:3,members:[],decisions:[],exceptions:[],segment:{number:path.includes('segment=2')?2:3,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:0,snapshot:null});
  if(path.startsWith('/events')){const events=state.events;state.events=[];return reply({feedId:state.feed,cursor:state.cursor,events});}
  return reply({error:'Fixture unavailable'},503);
 },{'massion.workbench.feed':'feed:a'});
 return {app,state};
}
const rows=(app:ReturnType<typeof harness>)=>app.node('side-schedules').children.filter(n=>n.className==='side-sched');
const find=(node:Node,label:string):Node|undefined=>node.tagName==='BUTTON'&&node.textContent===label?node:node.children.map(n=>find(n,label)).find(Boolean);

test('selecting the second schedule scopes run, pause, copy and past-run navigation to its retained identity',async()=>{
 const {app,state}=fixture();await settle();await app.node('rail-schedules').fire('click');await settle();await rows(app)[1]!.fire('click');
 assert.equal(rows(app)[1]!.attributes.get('aria-current'),'page');assert.equal(app.node('schedule-request').textContent,expenses.request);
 let copied='';(app.context as any).navigator.clipboard={writeText:(v:string)=>{copied=v;}};await app.node('schedule-copy').fire('click');assert.equal(copied,expenses.request);
 await app.node('schedule-run').fire('click');await settle();assert.equal(state.posted.at(-1)!.scheduleId,'expenses');
 await app.node('schedule-active').fire('click');await settle();assert.equal(state.posted.at(-1)!.scheduleId,'expenses');
 runInContext("chatThread='member:a'",app.context);const before=app.calls.length;await find(app.node('schedule-runs'),copy('ui.panel.view-conversation'))!.fire('click');await settle();
 assert.equal(runInContext('chatThread',app.context),'');assert.ok(app.calls.slice(before).some(c=>c.path==='/assistant/conversation?segment=2'));
});

test('all B17-empty templates are available and author an owner request without a provider call in the client',async()=>{
 const {app,state}=fixture();await settle();await app.node('rail-schedules').fire('click');await settle();await app.all().find(n=>n.id==='schedule-new')!.fire('click');
 for(const id of ['weekly-expenses','price-watch','monthly-subscriptions','meeting-preparation','weekend-groceries'])assert.ok(app.node('schedule-example-'+id),id);
 await app.node('schedule-example-weekly-expenses').fire('click');app.node('schedule-create-request').value='Classify only the receipt files I supplied.';
 await app.node('schedule-create').fire('submit');await settle();assert.deepEqual(state.posted.at(-1),{commandId:state.posted.at(-1).commandId,action:'create',kind:'weekly-expenses',minute:540,offset:-new Date().getTimezoneOffset()||0,budget:{runs:30},request:'Classify only the receipt files I supplied.'});
 assert.equal(rows(app).at(-1)!.attributes.get('aria-current'),'page');assert.equal(app.node('schedule-detail').hidden,false);
});

test('schedule reads keep the newest generation and discard responses sent before feed replacement',async()=>{
 const {app,state}=fixture();await settle();await app.node('rail-schedules').fire('click');await settle();let release!:()=>void;state.hold=new Promise<void>(r=>release=r);
 runInContext('void schedulesLoad()',app.context);await settle();state.hold=null;state.schedules=[{...expenses,request:'Current expenses'}];runInContext('void schedulesLoad()',app.context);await settle();release();await settle();
 assert.equal(rows(app).length,1);assert.equal(app.node('schedule-request').textContent,'Current expenses');
 state.hold=new Promise<void>(r=>release=r);runInContext('void schedulesLoad()',app.context);await settle();state.hold=null;state.feed='feed:b';state.schedules=[];runInContext('schedulesReset()',app.context);await settle();release();await settle();
 assert.equal(rows(app).length,0);assert.equal(app.node('schedule-detail').hidden,true);
});

test('non-briefing deadlines refresh without events and feeds reread without changing selected schedule',async()=>{
 const {app,state}=fixture();const deadline=Date.now()+30000;state.schedules[1]={...expenses,runs:[{id:'pending',at:T,state:'running',deadlineAt:deadline,turnIds:[],fact:''}]};
 const timers:{fn:()=>unknown;ms:number}[]=[];(app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>{timers.push({fn,ms});return timers.length;};
 await settle();await app.node('rail-schedules').fire('click');await settle();await rows(app)[1]!.fire('click');const timer=timers.find(t=>t.ms>=29000&&t.ms<=31000);assert.ok(timer);
 state.schedules[1]={...expenses,runs:[{id:'pending',at:T,state:'unknown',turnIds:[],fact:'Not resent'}]};timer.fn();await settle();assert.ok(app.node('schedule-runs').textContent.includes(copy('ui.schedules.not-resent')));assert.equal(rows(app)[1]!.attributes.get('aria-current'),'page');
 state.schedules[1]={...expenses,request:'Changed after feed'};state.events=[{cursor:2,aggregateId:'assistant-conversation:schedules',revision:2,type:'finish-run'}];state.cursor=2;await app.tick();await settle();assert.equal(app.node('schedule-request').textContent,'Changed after feed');
});

test('a late action from the replaced feed cannot clear a newer action busy state',async()=>{
 const {app,state}=fixture();await settle();await app.node('rail-schedules').fire('click');await settle();let oldRelease!:()=>void,newRelease!:()=>void;
 state.hold=new Promise<void>(r=>oldRelease=r);runInContext("void scheduleAct({action:'run',scheduleId:'briefing'})",app.context);await settle();
 state.hold=null;state.feed='feed:b';runInContext("feedId='feed:b'; schedulesReset()",app.context);await settle();
 state.hold=new Promise<void>(r=>newRelease=r);runInContext("void scheduleAct({action:'run',scheduleId:'expenses'})",app.context);await settle();oldRelease();await settle();
 assert.equal(app.node('schedule-run').disabled,true);assert.equal(state.posted.length,2);
 state.hold=null;newRelease();await settle();assert.equal(app.node('schedule-run').disabled,false);
});

test('weekly sidebar labels keep accessible names while separating prototype text fragments',async()=>{
 const {app,state}=fixture();state.schedules.push({...expenses,id:'review',kind:'weekly-review',title:'경쟁사 가격'});await settle();await app.node('rail-schedules').fire('click');await settle();
 const leaves=(n:Node):string[]=>n.children.length?n.children.flatMap(leaves):[n.textContent];
 for(const row of rows(app).slice(1)){assert.ok(leaves(row).every(text=>text.trim().length<=24),row.textContent);assert.equal(row.attributes.get('aria-label'),row.textContent.trim());}
 assert.ok(rows(app)[1]!.textContent.startsWith(copy('ui.schedules.weekly-expenses-title')));assert.ok(rows(app)[2]!.textContent.startsWith(copy('settings.switch.01',{work_title:'경쟁사 가격'})));
});

test('a feed read overtaking create readback still exits the form and selects the committed schedule',async()=>{
 const {app,state}=fixture();await settle();await app.node('rail-schedules').fire('click');await settle();await app.all().find(n=>n.id==='schedule-new')!.fire('click');await app.node('schedule-example-monthly-subscriptions').fire('click');
 let releaseRead!:()=>void,newest!:()=>void,reads=0;state.readHold=async()=>{const n=++reads;if(n===1)await new Promise<void>(done=>releaseRead=done);else if(n===2)await new Promise<void>(done=>newest=done);};
 await app.node('schedule-create').fire('submit');await settle();runInContext('void schedulesLoad()',app.context);await settle();
 releaseRead();await settle();newest();await settle();
 assert.equal(app.node('schedule-create').hidden,true);assert.equal(app.node('schedule-detail').hidden,false);assert.equal(rows(app).at(-1)!.attributes.get('aria-current'),'page');
});

test('a member-bound schedule retains the explicit owner title without adding a review suffix',async()=>{
 const {app,state}=fixture();state.schedules.push({...expenses,id:'member-review',kind:'weekly-review',memberId:'quill',title:'Competitor review'});
 await settle();await app.node('rail-schedules').fire('click');await settle();const text=rows(app).at(-1)!.textContent;
 assert.ok(text.includes('Competitor review'));assert.ok(!text.includes(copy('settings.switch.01',{work_title:'Competitor review'})));
});
