import test from 'node:test';
import {runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/results-and-schedules.md, Surface: Results (B10, B10-preview) and Schedules (B17, B17-empty), and schedule exceptions in the conversation.
const T0=Date.UTC(2026,10,5,23,0),sha='a'.repeat(64);
const result={missionId:'intake',workId:'work:a',recordId:'record:a',version:1,sha256:sha,kind:'text',title:'River summary',at:T0,segment:1,turnId:'turn:1'};
const turn={id:'turn:1',messageId:'m:1',status:'answered',displayStatus:'answered',at:T0-60000,proposal:{title:'River summary'},outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:3,workId:'work:a',title:'River summary',execution:'settled',acceptance:'accepted',started:true}};
const schedule={id:'schedule-a',title:'Morning briefing',request:'Sum up yesterday\'s work: what finished, what was handed back, what has an unknown result.',assignee:'하나',destination:'Conversation with 하나',active:true,nextAt:T0+86400000,minute:480,offset:540,budget:{runs:30,used:1},runs:[{id:'run-1',at:T0,state:'done',fact:'1 Work item',turnIds:['turn:1']}]};
function fixture(initial:{results?:any[];schedules?:any[];exceptions?:any[];artifact?:number;runDeadlineAt?:number}={}){
 const state={results:[result],schedules:[] as any[],exceptions:[] as any[],artifact:200,events:[] as any[],cursor:1,posted:[] as {path:string;body:any}[],...initial};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){const body=JSON.parse(options.body);state.posted.push({path,body});if(path==='/assistant/schedules'&&body.action==='create')state.schedules=[schedule];return reply({status:'committed',revision:2},path==='/assistant/schedules'&&body.action==='create'?201:200);}
  if(path==='/assistant/results')return reply({feedId:'feed:a',results:state.results});
  if(path==='/assistant/schedules')return reply({feedId:'feed:a',revision:1,schedules:state.schedules});
  if(path.startsWith('/missions/intake/record-artifact'))return state.artifact===200?reply({content:'- Rivers carry water.\n- Rivers shape valleys.\nCities grew beside rivers.',byteLength:10}):reply({error:'Unavailable'},state.artifact);
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:2,members:[],decisions:[],exceptions:state.exceptions,...'runDeadlineAt' in state?{runDeadlineAt:state.runDeadlineAt}:{},segment:{number:2,revision:1,closed:false,full:false,previous:'assistant-conversation:1',messages:[]},turns:[]});
  if(path.startsWith('/events')){const events=state.events;state.events=[];return reply({feedId:'feed:a',cursor:state.cursor,events});}
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
/** Text written in the page markup (the DOM double models only nodes with IDs, not static text). */
const staticText=(id:string)=>new RegExp('<[a-z]+[^>]*id="'+id+'"[\\s\\S]*?</(div|section)>(?=<!-- /page-schedules -->|\\n)').exec(workbenchPage)![0].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found[0];};

test('Results lists accepted results with name, source Work, assignee and time, switches between list and grid, and uses its own sidebar',async()=>{
 const {app}=fixture();await settle();
 await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('page-results').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(app.node('page-heading').textContent,'Results');
 assert.equal(app.node('side-results').hidden,false);assert.equal(app.node('side-people').hidden,true);assert.match(app.node('side-results').textContent,/All.*Documents.*River summary/);
 const row=byId(app,'result-row-intake/work:a')!;assert.ok(row);assert.match(row.textContent,/River summary.*River summary.*하.*[A-Z][a-z]{2} \d{1,2} \d{2}:\d{2}/);
 assert.equal(app.node('results-list').attributes.get('aria-checked'),'true');await app.node('results-grid').fire('click');await settle();
 assert.equal(app.node('results-grid').attributes.get('aria-checked'),'true');assert.equal(app.node('results-table').hidden,true);assert.equal(app.node('results-tiles').hidden,false);assert.ok(byId(app,'result-tile-intake/work:a'));
 await app.node('rail-chat').fire('click');await settle();assert.equal(app.node('side-people').hidden,false);assert.equal(app.node('side-results').hidden,true);
});

test('a result opens the conversation that made it with a preview tab: Preview renders lines literally, Original shows the bytes',async()=>{
 const {app}=fixture();await settle();await app.node('rail-results').fire('click');await settle();
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 assert.equal(app.node('page-chat').hidden,false,'the conversation stays beside the preview');assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?segment=1'),'the segment that made it');
 assert.equal(app.node('work-pane').hidden,false);assert.equal(app.node('pane-result').hidden,false);assert.equal(app.node('pane-body').hidden,true);
 assert.ok(app.calls.some(c=>c.path==='/missions/intake/record-artifact?work=work%3Aa&record=record%3Aa&version=1&sha256='+sha),'the exact Record identity');
 const preview=app.node('result-preview');assert.deepEqual(preview.children.map(n=>n.tagName),['UL','P']);assert.deepEqual(preview.children[0]!.children.map(n=>n.textContent),['Rivers carry water.','Rivers shape valleys.']);
 assert.equal(app.node('result-original').textContent,'- Rivers carry water.\n- Rivers shape valleys.\nCities grew beside rivers.');assert.equal(app.node('result-original').hidden,true);
 await app.node('result-tab-original').fire('click');assert.equal(app.node('result-original').hidden,false);assert.equal(app.node('result-preview').hidden,true);
 assert.match(app.node('pane-tabs').textContent,/River summary/);
});

test('a preview that cannot be read says Unavailable and substitutes nothing',async()=>{
 const {app}=fixture({artifact:409});await settle();await app.node('rail-results').fire('click');await settle();
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 assert.equal(app.node('result-preview').textContent,'Unavailable');assert.equal(app.node('result-original').textContent,'');
});

test('Results with nothing accepted shows No results yet',async()=>{
 const {app}=fixture({results:[]});await settle();await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('results-empty').hidden,false);assert.equal(app.node('results-table').hidden,true);
});

test('Schedules empty state offers the morning briefing; choosing it creates it at 08:00 with a cumulative budget and shows its detail',async()=>{
 const {app,state}=fixture();await settle();
 await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('side-schedules').hidden,false);assert.equal(app.node('schedules-empty').hidden,false);assert.equal(app.node('schedule-detail').hidden,true);
 assert.match(staticText('schedules-empty'),/Schedule a task.*Morning briefing.*Sums up yesterday's work each morning/,'B17-empty: icon, title, one example card');
 await app.node('schedule-example-briefing').fire('click');await settle();
 const sent=state.posted.find(p=>p.path==='/assistant/schedules')!;assert.deepEqual([sent.body.action,sent.body.minute,sent.body.budget],['create',480,{runs:30}]);assert.ok(Number.isSafeInteger(sent.body.offset));
 assert.equal(app.node('schedules-empty').hidden,true);assert.equal(app.node('schedule-detail').hidden,false);
 assert.equal(app.node('schedule-title').textContent,'Morning briefing');const detail=app.node('schedule-rows').textContent+app.node('schedule-request').textContent+app.node('schedule-runs').textContent;
 for(const label of ['Assignee','하나','Next run','Cycle','Daily 08:00','Delivers to','Conversation with 하나','Budget','1 of 30 runs','Sum up yesterday','1 Work item','View in conversation'])assert.ok(detail.includes(label),label);
 assert.match(staticText('schedule-detail'),/Run now.*Request.*Past runs/);
 assert.match(app.node('side-schedules').textContent,/Active.*Morning briefing.*Daily/);
});

test('the Active switch pauses and resumes, Run now runs once, View in conversation opens the conversation',async()=>{
 const {app,state}=fixture({schedules:[schedule]});await settle();await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('schedule-active').attributes.get('aria-checked'),'true');assert.match(workbenchPage,/id="schedule-active"[^>]*role="switch"/);
 await app.node('schedule-active').fire('click');await settle();await app.node('schedule-run').fire('click');await settle();
 assert.deepEqual(state.posted.map(p=>[p.body.action,p.body.scheduleId]),[['pause','schedule-a'],['run','schedule-a']]);
 await button(app.node('schedule-runs'),'View in conversation')!.fire('click');await settle();assert.equal(app.node('page-chat').hidden,false);
});

test('schedule exceptions sit in the conversation like Work exceptions: unknown offers Check and Close, failed Retry and Close',async()=>{
 const {app,state}=fixture({exceptions:[{id:'run-x',at:T0,title:'Morning briefing',state:'unknown',fact:'Not resent',actions:['check','close'],scheduleId:'schedule-a',runId:'run-x'},{id:'run-y',at:T0+1,title:'Morning briefing',state:'failed',fact:'Briefing unavailable',actions:['retry','close'],scheduleId:'schedule-a',runId:'run-y'}]});await settle();
 const unknown=byId(app,'chat-run-exception-run-x')!,failed=byId(app,'chat-run-exception-run-y')!;
 assert.match(unknown.textContent,/Morning briefing.*Result unknown.*Not resent.*Check.*Close/);assert.equal(button(unknown,'Retry'),undefined,'an unknown result is not resent');
 assert.match(failed.textContent,/Morning briefing.*Failed.*Briefing unavailable.*Retry.*Close/);
 await button(unknown,'Close')!.fire('click');await settle();await button(failed,'Retry')!.fire('click');await settle();
 assert.deepEqual(state.posted.map(p=>[p.path,p.body.action,p.body.runId,p.body.retryOf]),[['/assistant/schedules','close','run-x',undefined],['/assistant/schedules','run',undefined,'run-y']],'Retry names the failed run it closes');
});

test('no explanation sentences, no assistant label, and yellow stays in decision cards',()=>{
 for(const id of ['page-results','page-schedules']){const block=new RegExp('<div[^>]*id="'+id+'"[\\s\\S]*?<!-- /'+id+' -->').exec(workbenchPage)![0];assert.doesNotMatch(block.replace(/<[^>]*>/g,' '),/assistant/i);assert.doesNotMatch(block,/#f0bc4b|#231d0e/i);}
});

test('a background reread of the Mission loaded before a result was opened keeps the result tab',async()=>{
 const {app}=fixture();await settle();runInContext("paneOpen('intake','','Owner requests')",app.context);
 await app.node('rail-results').fire('click');await settle();await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 runInContext("paneFor({id:'intake',purpose:'Owner requests'})",app.context);
 assert.equal(runInContext('paneActive',app.context),'result:intake/work:a');assert.equal(app.node('pane-result').hidden,false);
});

test('a host-run schedule rereads the Schedules page while it shows',async()=>{
 const {app,state}=fixture({schedules:[schedule]});await settle();await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('schedule-active').attributes.get('aria-checked'),'true');
 state.schedules=[{...schedule,active:false,budget:{runs:30,used:30}}];state.events=[{cursor:2,aggregateId:'assistant-conversation:schedules',revision:3,type:'skip-run'}];state.cursor=2;
 await app.tick();await settle();
 assert.equal(app.node('schedule-active').attributes.get('aria-checked'),'false');assert.match(app.node('schedule-rows').textContent,/30 of 30 runs/);
});

test('a schedule run still in time has the conversation read again just after its deadline, so its unknown card shows without another event',async()=>{
 const deadline=Date.now()+30000,{app,state}=fixture({runDeadlineAt:deadline});const timers:{fn:()=>unknown;ms:number}[]=[];(app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>timers.push({fn,ms});
 runInContext('void readChat()',app.context);await settle();const read=timers.findLast(t=>t.ms>=29000&&t.ms<=31000);assert.ok(read,'one read is due at the deadline');
 delete (state as any).runDeadlineAt;state.exceptions=[{id:'run-x',at:deadline,title:'Morning briefing',state:'unknown',fact:'Not resent',actions:['check','close'],scheduleId:'schedule-a',runId:'run-x'}];
 timers.length=0;read.fn();await settle();assert.match(byId(app,'chat-run-exception-run-x')!.textContent,/Result unknown.*Check.*Close/);assert.deepEqual(timers.map(t=>t.ms).filter(ms=>ms!==15000),[],'no read is due once the run is unknown (15 s is the request timeout)');
});

test('View in conversation from a past run returns to the head segment, where briefings and run exceptions show',async()=>{
 const {app}=fixture({schedules:[schedule]});await settle();await app.node('rail-results').fire('click');await settle();
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();assert.equal(runInContext('chatSegment',app.context),1,'the result opened its own earlier segment');
 await app.node('rail-schedules').fire('click');await settle();const before=app.calls.length;
 await button(app.node('schedule-runs'),'View in conversation')!.fire('click');await settle();
 assert.equal(runInContext('chatSegment',app.context),null);assert.ok(app.calls.slice(before).some(c=>c.path==='/assistant/conversation'),'the head is read again');
});

test('an accepted Record arriving while Results shows rereads the page',async()=>{
 const {app,state}=fixture({results:[]});await settle();await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('results-empty').hidden,false);
 state.results=[result];state.events=[{cursor:2,aggregateId:'intake',revision:4,type:'work-accepted'}];state.cursor=2;
 await app.tick();await settle();
 assert.equal(app.node('results-empty').hidden,true);assert.ok(byId(app,'result-row-intake/work:a'));
});
