import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

const member={id:'member-q',name:'Quill',look:{shape:'drop',color:'agent-1'},modelGroup:'default'};
const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
const task=(id:string,parentId:string|null,status:string,result:string,step?:{role:string;title:string;dependsOn:string[];skipReason?:string})=>({id,parentId,status,result,...(step?{step}:{})});
function fixture(){
 const tasks=[task('root',null,'active',''),task('produce','root','active',''),task('check','root','queued',''),
  task('collect','produce','settled','41 cancellations',{role:'Research',title:'Collect cancellations',dependsOn:[]}),
  task('group','produce','active','',{role:'Group',title:'Group accounts',dependsOn:['collect']}),
  task('survey','produce','settled','Skipped · Existing survey',{role:'Survey',title:'Send survey',dependsOn:[],skipReason:'Existing survey'}),
  task('summary','produce','queued','',{role:'Summary',title:'Summarize causes',dependsOn:['group']})];
 const work={id:'w1',title:'Churn causes',missionVersion:1,criteria,execution:'active',acceptance:'pending',assistantSource:{memberId:member.id},tasks,attempts:[{id:'attempt:1',number:1,criteria,status:'active',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0}};
 const state={feed:'feed:a',revision:3,work,members:[member],hold:null as Promise<void>|null,missionStatus:200,deadline:undefined as number|undefined};
 const list=()=>({missionId:'intake',missionRevision:state.revision,workId:work.id,title:work.title,memberId:work.assistantSource.memberId,execution:work.execution,acceptance:work.acceptance,unknown:false,started:true,startedAt:1,endedAt:null,turnId:'assistant-turn:m:a',segment:1});
 const app=harness(async(path)=>{
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:1,members:state.members,runDeadlineAt:state.deadline,decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[list()]});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  if(path==='/missions/intake'||path.startsWith('/read-state')){
   const snapshot=structuredClone({revision:state.revision,value:{id:'intake',version:1,purpose:'Owner requests',scope:'local',constraints:[],criteria,works:[work],memories:[],growth:[],relations:[]}}),feedId=state.feed,hold=state.hold,status=state.missionStatus;
   if(hold)await hold;return reply(path.startsWith('/read-state')?{feedId,cursor:1,snapshot}:snapshot,status);
  }
  return reply({error:'Not configured'},503);
 });
 const open=async()=>{await settle();await app.all().find(n=>n.id==='side-line-intake/w1')!.fire('click');await settle();};
 const progress=()=>app.all().find(n=>n.tagName==='OL'&&n.attributes.get('aria-label')==='Progress');
 return {app,state,open,progress};
}

test('only worker steps become role chips after the member and before Check; progress attributes each title, status and result to the member',async()=>{
 const {app,open,progress}=fixture();await open();
 assert.deepEqual(app.node('pane-people').children.map(n=>n.textContent),['Q','Quill','Research','Group','Survey','Summary','Check']);
 const list=progress();assert.ok(list);assert.equal(list.children.length,4);assert.ok(list.children.every(n=>n.tagName==='LI'));
 assert.match(list.children[0]!.textContent,/Collect cancellations.*Research.*Quill.*Settled.*41 cancellations/);
 assert.match(list.children[1]!.textContent,/Group accounts.*Group.*Quill.*Active/);
 assert.match(list.children[2]!.textContent,/Send survey.*Survey.*Quill.*Settled.*Skipped · Existing survey/);
 assert.equal(list.children[2]!.textContent.split('Existing survey').length,2,'the skip reason appears once');
 assert.match(list.children[3]!.textContent,/Summarize causes.*Summary.*Quill.*Queued/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('step labels and results stay text; root, executor and verifier results do not become worker rows',async()=>{
 const {app,state,open,progress}=fixture();state.work.tasks[0]!.result='Root only';state.work.tasks[1]!.result='Executor only';state.work.tasks[2]!.result='Verifier only';
 state.work.tasks[3]!.step!.role='<img src=x>';state.work.tasks[3]!.step!.title='<script>title</script>';state.work.tasks[3]!.result='<b>result</b>';
 await open();assert.ok(progress());assert.match(progress()!.textContent,/<script>title<\/script>.*<img src=x>.*<b>result<\/b>/);
 assert.doesNotMatch(progress()!.textContent,/Root only|Executor only|Verifier only/);assert.equal(app.all().filter(n=>n.tagName==='IMG').length,0);
});

test('Work without steps keeps its existing participants and has no invented progress',async()=>{
 const {app,state,open,progress}=fixture();state.work.tasks=state.work.tasks.slice(0,3);await open();
 assert.equal(app.node('pane-people').textContent,'QQuillCheck');assert.equal(progress(),undefined);
});

test('unresolved members stay unnamed and Representative Work uses the existing Representative identity',async()=>{
 const {app,state,open,progress}=fixture();await open();state.members=[];await runInContext('readChat()',app.context);await settle();assert.ok(progress());
 assert.doesNotMatch(progress()!.textContent,/Quill|하나/);assert.equal(app.node('pane-people').children[1]!.textContent,'');
 state.work.assistantSource.memberId='';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.match(progress()!.textContent,/하나/);
});

test('switching Work tabs never shows another Work\'s cached roles or progress; failed reads clear the current steps',async()=>{
 const {app,state,open,progress}=fixture();await open();assert.ok(progress());
 runInContext('paneOpen("elsewhere","w2","Another work")',app.context);assert.equal(progress(),undefined);assert.doesNotMatch(app.node('pane-people').textContent,/Research|Group|Survey|Summary/);
 await runInContext('paneSelect("intake/w1")',app.context);await settle();assert.ok(progress());
 state.missionStatus=503;await runInContext('loadMission("intake",false)',app.context);await settle();assert.equal(progress(),undefined);assert.equal(app.node('pane-people').textContent,'QQuillCheck');
});

test('a newer Mission read wins over an older step response',async()=>{
 const {app,state,open,progress}=fixture();await open();let release=()=>{};
 state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);
 state.hold=null;state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='7 enterprise accounts';
 await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 assert.ok(progress());assert.match(progress()!.textContent,/7 enterprise accounts/);
});

test('queued steps name their unfinished worker dependencies and clear them when those workers settle',async()=>{
 const {app,state,open,progress}=fixture();await open();assert.ok(progress());
 assert.match(progress()!.children[3]!.textContent,/Queued.*After · Group accounts/);
 assert.doesNotMatch(progress()!.children[1]!.textContent,/After · Collect cancellations/);
 state.revision++;state.work.tasks[4]!.status='settled';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.doesNotMatch(progress()!.children[3]!.textContent,/After ·/);
});

test('feed replacement closes the old team and fences a pending Mission read',async()=>{
 const {app,state,open}=fixture();await open();let release=()=>{};
 state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);
 state.feed='feed:b';state.hold=null;await runInContext('readChat()',app.context);await settle();
 release();await old;await settle();
 assert.equal(app.node('work-pane').hidden,true,'an old Mission must not reopen the pane after reset');
 assert.equal(app.node('pane-people').hidden,true);
});

for(const deadline of [false,true])test((deadline?'deadline':'minute')+' refresh updates worker results without an event while member chat is selected',async()=>{
 const {app,state,open,progress}=fixture();await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const timers=new Map<number,{run:()=>void;delay:number}>();let next=0;
 app.context.setTimeout=(run:()=>void,delay:number)=>{timers.set(++next,{run,delay});return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 if(deadline)state.deadline=Date.now()-1;
 await runInContext('readChat()',app.context);await settle();const timer=timers.get(runInContext('chatPendingTimer',app.context))!;assert.equal(timer.delay,deadline?1000:60000);
 state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='7 enterprise accounts';timer.run();await settle();
 assert.ok(progress());assert.match(progress()!.textContent,/Group accounts.*Settled.*7 enterprise accounts/);
 assert.equal(runInContext('chatThread',app.context),'member-q');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
