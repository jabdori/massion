import test from 'node:test';
import {runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {copy} from '../src/ui-copy.ts';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const sequence=(...parts:string[])=>new RegExp(parts.map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*'));

// docs/architecture/results-and-schedules.md, Surface: Results (B10, B10-preview) and Schedules (B17, B17-empty), and schedule exceptions in the conversation.
const T0=Date.UTC(2026,10,5,23,0),sha='a'.repeat(64);
const result={missionId:'intake',workId:'work:a',recordId:'record:a',version:1,sha256:sha,kind:'text',memberId:null,title:'River summary',at:T0,segment:1,turnId:'turn:1'};
const turn={id:'turn:1',messageId:'m:1',status:'answered',displayStatus:'answered',at:T0-60000,proposal:{title:'River summary'},outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:3,workId:'work:a',title:'River summary',execution:'settled',acceptance:'accepted',started:true}};
const schedule={id:'schedule-a',title:'Morning briefing',request:'Sum up yesterday\'s work: what finished, what was handed back, what has an unknown result.',assignee:'하나',destination:copy('ui.panel.member-conversation',{member:'하나'}),active:true,nextAt:T0+86400000,minute:480,offset:540,budget:{runs:30,used:1},runs:[{id:'run-1',at:T0,state:'done',fact:'1 Work item',turnIds:['turn:1']}]};
function fixture(initial:{results?:any[];schedules?:any[];exceptions?:any[];artifact?:number;runDeadlineAt?:number;head?:number}={}){
 const state={results:[result],schedules:[] as any[],exceptions:[] as any[],artifact:200,events:[] as any[],cursor:1,head:2,feed:'feed:a',hold:null as null|Promise<void>,posted:[] as {path:string;body:any}[],...initial};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){const body=JSON.parse(options.body);state.posted.push({path,body});if(path==='/assistant/schedules'&&body.action==='create')state.schedules=[schedule];return reply({status:'committed',revision:2},path==='/assistant/schedules'&&body.action==='create'?201:200);}
  if(path==='/assistant/results'){const results=state.results;if(state.hold)await state.hold;return reply({feedId:state.feed,results});}
  if(path==='/assistant/schedules'){const schedules=state.schedules;if(state.hold)await state.hold;return reply({feedId:state.feed,revision:1,schedules});}
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:0,snapshot:null});
  if(path.startsWith('/missions/intake/record-artifact'))return state.artifact===200?reply({content:'- Rivers carry water.\n- Rivers shape valleys.\nCities grew beside rivers.',byteLength:10}):reply({error:'Unavailable'},state.artifact);
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:state.head,members:[],decisions:[],exceptions:state.exceptions,...'runDeadlineAt' in state?{runDeadlineAt:state.runDeadlineAt}:{},segment:{number:state.head,revision:1,closed:false,full:false,previous:state.head>1?'assistant-conversation:'+(state.head-1):null,messages:[]},turns:[]});
  if(path.startsWith('/events')){if(options?.headers?.['X-Massion-Feed']&&options.headers['X-Massion-Feed']!==state.feed)return reply({error:'Database changed'},409);const events=state.events;state.events=[];return reply({feedId:state.feed,cursor:state.cursor,events});}
  return reply({error:'Not configured'},503);
 },{'massion.workbench.feed':'feed:a'});
 return {app,state};
}
/** Text written in the page markup (the DOM double models only nodes with IDs, not static text). */
const staticText=(id:string)=>new RegExp('<[a-z]+[^>]*id="'+id+'"[\\s\\S]*?</(div|section)>(?=<!-- /page-schedules -->|\\n)').exec(workbenchPage)![0].replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found[0];};

test('Results search and kind filters keep exact accepted identities and send no commands',async()=>{
 const {app,state}=fixture({results:[result,{...result,workId:'work:b',title:'Valley notes'}]});await settle();
 await app.node('rail-results').fire('click');await settle();
 app.node('results-query').value='valley';await app.node('results-query').fire('input');
 assert.equal(app.node('results-rows').children.length,1);assert.equal(app.node('results-rows').children[0]!.id,'result-row-intake/work:b');
 runInContext('void readChat()',app.context);await settle();assert.equal(app.node('results-query').value,'valley');assert.equal(app.node('results-rows').children.length,1);
 await byId(app,'result-filter-images')!.fire('click');assert.equal(app.node('results-rows').children.length,0);
 await byId(app,'result-filter-all')!.fire('click');assert.equal(app.node('results-rows').children.length,1);
 assert.deepEqual(state.posted,[]);assert.match(workbenchPage,/id="results-table"[^>]*aria-label="결과물"/);
 assert.doesNotMatch(workbenchPage,/id="results-(?:grid|list)"[^>]*role="radio"/);
});

test('background page resets keep conversation search visible and malformed result kinds never enter the list',async()=>{
 const {app}=fixture({results:[result,{...result,workId:'bad',kind:{}}]});await settle();
 await app.node('rail-chat').fire('click');
 runInContext('resultsReset();schedulesReset();renderAppSide()',app.context);
 assert.equal(app.node('sidebar-search').parentElement?.id,'sidebar-controls');
 await app.node('rail-results').fire('click');await settle();assert.equal(app.node('results-rows').children.length,1);
});

test('a result opens its authoritative producing member even without the global Work list and a past run opens its recorded segment',async()=>{
 const {app,state}=fixture({results:[{...result,memberId:'member-a'}],schedules:[{...schedule,runs:[{...schedule.runs[0],segment:1}]}]});await settle();
 runInContext("shellWorksFeed='another-feed';shellWorks=[];chatView.members=[{id:'member-a',name:'퀼'}]",app.context);
 await app.node('rail-results').fire('click');await settle();await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 assert.ok(app.calls.some(c=>c.path.includes('/assistant/conversation?member=member-a')));
 await app.node('rail-schedules').fire('click');await settle();await button(app.node('schedule-runs'),copy('ui.panel.view-conversation'))!.fire('click');await settle();
 assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?segment=1'));assert.deepEqual(state.posted,[]);
});

test('schedule request copy and New task are local controls; New task never creates a second schedule',async()=>{
 const {app,state}=fixture({schedules:[schedule]});await settle();await app.node('rail-schedules').fire('click');await settle();
 (app.context as any).navigator.clipboard={writeText:(text:string)=>{assert.equal(text,copy('ui.panel.briefing-request'));}};
 await app.node('schedule-copy').fire('click');await byId(app,'schedule-new')!.fire('click');
 assert.equal(app.node('schedules-empty').hidden,false);assert.equal(app.node('schedule-detail').hidden,true);assert.equal(app.node('schedule-example-briefing').disabled,true);assert.deepEqual(state.posted,[]);
});

test('Results lists accepted results with name, source Work, assignee and time, switches between list and grid, and uses its own sidebar',async()=>{
 const {app}=fixture();await settle();
 await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('page-results').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(app.node('page-heading').textContent,copy('rail.link.01'));
 assert.equal(app.node('side-results').hidden,false);assert.equal(app.node('side-people').hidden,true);assert.match(app.node('side-results').textContent,sequence(copy('page.button.14'),copy('sidebar.button.06'),'River summary'));
 const row=byId(app,'result-row-intake/work:a')!;assert.ok(row);assert.match(row.textContent,sequence('River summary','River summary','하',new Date(T0).getMonth()+1+'월',new Date(T0).getDate()+'일'));
 assert.equal(app.node('results-list').attributes.get('aria-pressed'),'true');await app.node('results-grid').fire('click');await settle();
 assert.equal(app.node('results-grid').attributes.get('aria-pressed'),'true');assert.equal(app.node('results-table').hidden,true);assert.equal(app.node('results-tiles').hidden,false);assert.ok(byId(app,'result-tile-intake/work:a'));
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
 assert.equal(app.node('result-preview').textContent,copy('ui.panel.unavailable'));assert.equal(app.node('result-original').textContent,'');
});

test('Results with nothing accepted shows No results yet',async()=>{
 const {app}=fixture({results:[]});await settle();await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('results-empty').hidden,false);assert.equal(app.node('results-table').hidden,true);
});

test('Schedules empty state offers the morning briefing; choosing it creates it at 08:00 with a cumulative budget and shows its detail',async()=>{
 const {app,state}=fixture();await settle();
 await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('side-schedules').hidden,false);assert.equal(app.node('schedules-empty').hidden,false);assert.equal(app.node('schedule-detail').hidden,true);
 assert.match(staticText('schedules-empty'),sequence(copy('page.heading.09'),copy('settings.combobox.01'),copy('ui.panel.briefing-description')),'B17-empty: icon, title, one example card');
 await app.node('schedule-example-briefing').fire('click');await settle();
 const sent=state.posted.find(p=>p.path==='/assistant/schedules')!;assert.deepEqual([sent.body.action,sent.body.minute,sent.body.budget],['create',480,{runs:30}]);assert.ok(Number.isSafeInteger(sent.body.offset));
 assert.equal(app.node('schedules-empty').hidden,true);assert.equal(app.node('schedule-detail').hidden,false);
 assert.equal(app.node('schedule-title').textContent,copy('settings.combobox.01'));const detail=app.node('schedule-rows').textContent+app.node('schedule-request').textContent+app.node('schedule-runs').textContent+app.node('schedule-budget').textContent;
 for(const label of [copy('page.columnheader.01'),'하나',copy('ui.panel.next-run'),copy('ui.panel.cycle'),copy('ui.panel.daily-cycle',{time:copy('ui.pages.am',{time:'8:00'})}),copy('ui.panel.destination'),copy('ui.panel.member-conversation',{member:'하나'}),copy('ui.panel.budget'),copy('ui.panel.run-budget',{used:1,count:30}),copy('ui.panel.briefing-request'),copy('ui.pages.briefing-run',{count:1}),copy('ui.panel.view-conversation')])assert.ok(detail.includes(label),label);
 assert.match(staticText('schedule-detail'),sequence(copy('page.button.17'),copy('ui.panel.request'),copy('ui.panel.past-runs')));
 assert.match(app.node('side-schedules').textContent,sequence(copy('sidebar.text.03'),copy('settings.combobox.01'),copy('ui.pages.am',{time:'8:00'}),copy('ui.pages.daily')));
});

test('the Active switch pauses and resumes, Run now runs once, View in conversation opens the conversation',async()=>{
 const {app,state}=fixture({schedules:[schedule]});await settle();await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('schedule-active').attributes.get('aria-checked'),'true');assert.match(workbenchPage,/id="schedule-active"[^>]*role="switch"/);
 await app.node('schedule-active').fire('click');await settle();await app.node('schedule-run').fire('click');await settle();
 assert.deepEqual(state.posted.map(p=>[p.body.action,p.body.scheduleId]),[['pause','schedule-a'],['run','schedule-a']]);
 await button(app.node('schedule-runs'),copy('ui.panel.view-conversation'))!.fire('click');await settle();assert.equal(app.node('page-chat').hidden,false);
});

test('schedule exceptions sit in the conversation like Work exceptions: unknown offers Check and Close, failed Retry and Close',async()=>{
 const {app,state}=fixture({exceptions:[{id:'run-x',at:T0,title:'Morning briefing',state:'unknown',fact:'Not resent',actions:['check','close'],scheduleId:'schedule-a',runId:'run-x'},{id:'run-y',at:T0+1,title:'Morning briefing',state:'failed',fact:'Briefing unavailable',actions:['retry','close'],scheduleId:'schedule-a',runId:'run-y'}]});await settle();
 const unknown=byId(app,'chat-run-exception-run-x')!,failed=byId(app,'chat-run-exception-run-y')!;
 assert.match(unknown.textContent,sequence('Morning briefing',copy('conversation.text.01'),'Not resent',copy('settings.chip.02'),copy('dialog.button.03')));assert.equal(button(unknown,copy('conversation.button.07')),undefined,'an unknown result is not resent');
 assert.match(failed.textContent,sequence('Morning briefing',copy('conversation.status.02'),'Briefing unavailable',copy('conversation.button.07'),copy('dialog.button.03')));
 await button(unknown,copy('dialog.button.03'))!.fire('click');await settle();await button(failed,copy('conversation.button.07'))!.fire('click');await settle();
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
 assert.equal(app.node('schedule-active').attributes.get('aria-checked'),'false');assert.match(app.node('schedule-budget').textContent,sequence(copy('ui.panel.run-budget',{used:30,count:30})));
});

test('a schedule run still in time has the conversation read again just after its deadline, so its unknown card shows without another event',async()=>{
 const deadline=Date.now()+30000,{app,state}=fixture({runDeadlineAt:deadline});const timers:{fn:()=>unknown;ms:number}[]=[];(app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>timers.push({fn,ms});
 runInContext('void readChat()',app.context);await settle();const read=timers.findLast(t=>t.ms>=29000&&t.ms<=31000);assert.ok(read,'one read is due at the deadline');
 delete (state as any).runDeadlineAt;state.exceptions=[{id:'run-x',at:deadline,title:'Morning briefing',state:'unknown',fact:'Not resent',actions:['check','close'],scheduleId:'schedule-a',runId:'run-x'}];
 timers.length=0;read.fn();await settle();assert.match(byId(app,'chat-run-exception-run-x')!.textContent,sequence(copy('conversation.text.01'),copy('settings.chip.02'),copy('dialog.button.03')));assert.deepEqual(timers.map(t=>t.ms).filter(ms=>ms!==15000),[],'no read is due once the run is unknown (15 s is the request timeout)');
});

test('View in conversation from a past run returns to the head segment, where briefings and run exceptions show',async()=>{
 const {app}=fixture({schedules:[schedule]});await settle();await app.node('rail-results').fire('click');await settle();
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();assert.equal(runInContext('chatSegment',app.context),1,'the result opened its own earlier segment');
 await app.node('rail-schedules').fire('click');await settle();const before=app.calls.length;
 await button(app.node('schedule-runs'),copy('ui.panel.view-conversation'))!.fire('click');await settle();
 assert.equal(runInContext('chatSegment',app.context),null);assert.ok(app.calls.slice(before).some(c=>c.path==='/assistant/conversation'),'the head is read again');
});

test('an accepted Record arriving while Results shows rereads the page',async()=>{
 const {app,state}=fixture({results:[]});await settle();await app.node('rail-results').fire('click');await settle();
 assert.equal(app.node('results-empty').hidden,false);
 state.results=[result];state.events=[{cursor:2,aggregateId:'intake',revision:4,type:'work-accepted'}];state.cursor=2;
 await app.tick();await settle();
 assert.equal(app.node('results-empty').hidden,true);assert.ok(byId(app,'result-row-intake/work:a'));
});

test('a result clicked while a member send is pending opens nothing: Results stays, no preview, no segment read',async()=>{
 const {app}=fixture();await settle();await app.node('rail-results').fire('click');await settle();
 runInContext("chatThread='member:a';chatSending=true",app.context);const reads=app.calls.length;
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 assert.equal(app.node('page-results').hidden,false);assert.equal(app.node('pane-result').hidden,true);
 assert.equal(runInContext('chatSegment',app.context),null);assert.equal(runInContext('chatThread',app.context),'member:a');
 assert.ok(!app.calls.slice(reads).some(c=>c.path.startsWith('/assistant/conversation')||c.path.includes('record-artifact')));
});

test('a running past run whose host dies turns result unknown on the Schedules page just after its deadline, without another event',async()=>{
 const deadline=Date.now()+30000,running={...schedule,runs:[{id:'run-2',at:T0,state:'running',fact:'',turnIds:[],deadlineAt:deadline},...schedule.runs]};
 const {app,state}=fixture({schedules:[running]});const timers:{fn:()=>unknown;ms:number}[]=[];(app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>timers.push({fn,ms});
 await settle();await app.node('rail-schedules').fire('click');await settle();
 assert.equal(app.node('schedule-runs').children[0]!.children[0]!.attributes.get('aria-label'),copy('sidebar.status.02'));
 const read=timers.findLast(t=>t.ms>=29000&&t.ms<=31000);assert.ok(read,'one read is due at the deadline');
 state.schedules=[{...schedule,runs:[{id:'run-2',at:T0,state:'unknown',fact:'Not resent',turnIds:[]},...schedule.runs]}];timers.length=0;read.fn();await settle();
 assert.equal(app.node('schedule-runs').children[0]!.children[0]!.attributes.get('aria-label'),copy('conversation.text.01'));assert.match(app.node('schedule-runs').textContent,/Not resent/);
 assert.ok(!timers.some(t=>t.ms>=29000&&t.ms<=31000),'no Schedules read is due once no run is running');
});

test('a replaced database clears Results and Schedules and rereads the shown page; a read sent before the replacement never lands',async()=>{
 const {app,state}=fixture({schedules:[schedule]});await settle();await app.node('rail-results').fire('click');await settle();assert.ok(byId(app,'result-row-intake/work:a'));
 let release!:()=>void;state.hold=new Promise<void>(r=>release=r);runInContext('void resultsLoad()',app.context);await settle();
 state.hold=null;state.results=[];state.schedules=[];state.feed='feed:b';await app.tick();await settle();
 assert.equal(byId(app,'result-row-intake/work:a'),undefined,'no result of the replaced database stays shown');assert.equal(app.node('results-empty').hidden,false);
 release();await settle();assert.equal(byId(app,'result-row-intake/work:a'),undefined,'the read sent before the replacement is dropped');
 await app.node('rail-schedules').fire('click');await settle();assert.equal(app.node('schedule-detail').hidden,true);assert.equal(app.node('schedules-empty').hidden,false);
});

test('a result opens its own segment even when the cached Representative head is stale, and its head segment opens as the head view',async()=>{
 const {app,state}=fixture({head:1});await settle();await app.node('rail-results').fire('click');await settle();
 runInContext("chatThread='member:a'",app.context);state.head=2;const before=app.calls.length;
 await byId(app,'result-row-intake/work:a')!.fire('click');await settle();
 assert.equal(runInContext('chatSegment',app.context),1);assert.ok(app.calls.slice(before).some(c=>c.path==='/assistant/conversation?segment=1'),'the segment that made it, not the new head');
 await app.node('rail-results').fire('click');await settle();state.results=[{...result,workId:'work:b',segment:2}];runInContext('void resultsLoad()',app.context);await settle();
 const reads=app.calls.length;await byId(app,'result-row-intake/work:b')!.fire('click');await settle();
 assert.equal(runInContext('chatSegment',app.context),null,'the head segment reads as the head view');assert.deepEqual(app.calls.slice(reads).map(c=>c.path).filter(p=>p.startsWith('/assistant/conversation')).slice(-2),['/assistant/conversation?segment=2','/assistant/conversation']);
});
