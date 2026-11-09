import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

const member={id:'member-q',name:'퀼',look:{shape:'drop',color:'agent-1'},modelGroup:'default'};
const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
const task=(id:string,parentId:string|null,status:string,result:string,step?:{role:string;title:string;dependsOn:string[];skipReason?:string})=>({id,parentId,status,result,...(step?{step}:{})});
function fixture(){
 const tasks=[task('root',null,'active',''),task('produce','root','active',''),task('check','root','queued',''),
  task('collect','produce','settled','해지 41건',{role:'조사',title:'해지 내역 수집',dependsOn:[]}),
  task('group','produce','active','',{role:'분류',title:'고객 분류',dependsOn:['collect']}),
  task('survey','produce','settled','Skipped · 기존 설문',{role:'설문',title:'설문 발송',dependsOn:[],skipReason:'기존 설문'}),
  task('summary','produce','queued','',{role:'요약',title:'원인 요약',dependsOn:['group']})];
 const work={id:'w1',title:'Churn causes',missionVersion:1,criteria,execution:'active',acceptance:'pending',assistantSource:{memberId:member.id},tasks,attempts:[{id:'attempt:1',number:1,criteria,status:'active',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0}};
 const state={feed:'feed:a',revision:3,work,members:[member],hold:null as Promise<void>|null,missionStatus:200,deadline:undefined as number|undefined};
 const list=()=>({missionId:'intake',missionRevision:state.revision,workId:work.id,title:work.title,memberId:work.assistantSource.memberId||null,execution:work.execution,acceptance:work.acceptance,unknown:false,started:true,startedAt:1,endedAt:null,turnId:'assistant-turn:m:a',segment:1});
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
 const progress=()=>app.all().find(n=>n.className==='room-steps'&&n.attributes.get('aria-label')==='절차');
 const people=()=>app.all().find(n=>n.className==='room-people room-compact');
 const results=()=>app.all().find(n=>n.className==='room-worker-results room-compact');
 return {app,state,open,progress,people,results};
}

test('only worker steps become role chips after the member and before Check; compact progress stays flat and worker results follow under member identity',async()=>{
 const {app,open,progress,people,results}=fixture();await open();
 assert.deepEqual(people()!.children.map(n=>n.textContent),['퀼퀼','조사','분류','설문','요약','확인']);
 assert.equal(app.all().find(n=>n.className==='room-progress')?.textContent,'2/4');
 const list=progress();assert.ok(list);assert.equal(list.children.length,6);assert.ok(list.children.every(n=>n.tagName==='LI'));
 assert.deepEqual(list.children.map(n=>n.textContent),['해지 내역 수집','고객 분류','설문 발송건너뜀 · 기존 설문','원인 요약선행 단계 · 고객 분류','확인0/1','기록']);
 assert.ok(list.children.every(n=>n.children.every(child=>child.children.length===0)),'compact rows have no nested identity or result blocks');
 assert.equal(list.children[2]!.textContent.split('기존 설문').length,2,'the skip reason appears once');
 assert.deepEqual(results()!.children[0]!.children[0]!.children.map(n=>n.textContent),['조사','퀼']);
 assert.match(results()!.textContent,/조사.*퀼.*해지 41건/);
 assert.equal(list.children.flatMap(n=>n.children).filter(n=>n.tagName==='TIME').length,0,'Work start time is not a recorded worker-step time');
 assert.equal(results()!.children.length,1,'only non-skipped worker output is shown');
 const compact=list.parentElement!.parentElement!;
 assert.ok(compact.parentElement!.children.indexOf(compact)<compact.parentElement!.children.indexOf(results()!),'results follow the procedure');
 const flow=app.all().find(n=>n.className==='room-flow')!;
 assert.equal(flow.children.filter(n=>n.textContent.includes('해지 내역 수집')).length,1);
 assert.match(flow.textContent,/해지 내역 수집.*퀼.*조사.*해지 41건/);
 assert.match(flow.textContent,/설문 발송.*건너뜀 · 기존 설문/);
 assert.match(list.children[2]!.attributes.get('aria-label')!,/건너뜀 · 기존 설문/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('step labels and results stay text; root, executor and verifier results do not become worker rows',async()=>{
 const {app,state,open,progress,results}=fixture();state.work.tasks[0]!.result='Root only';state.work.tasks[1]!.result='Executor only';state.work.tasks[2]!.result='Verifier only';
 state.work.tasks[3]!.step!.role='<img src=x>';state.work.tasks[3]!.step!.title='<script>title</script>';state.work.tasks[3]!.result='<b>result</b>';
 await open();assert.ok(progress());assert.equal(progress()!.children[0]!.textContent,'<script>title</script>');assert.match(results()!.textContent,/<img src=x>.*<b>result<\/b>/);
 assert.doesNotMatch(results()!.textContent,/Root only|Executor only|Verifier only/);assert.equal(app.all().filter(n=>n.tagName==='IMG').length,0);
});

test('Work without steps keeps its existing participants and procedure',async()=>{
 const {app,state,open,progress,people}=fixture();state.work.tasks=state.work.tasks.slice(0,3);await open();
 assert.equal(people()!.textContent,'퀼퀼확인');assert.equal(progress()!.children.length,2);assert.equal(app.all().find(n=>n.className==='room-progress')?.textContent,'0/2');
});

test('unresolved members stay unnamed and Representative Work uses the existing Representative identity',async()=>{
 const {app,state,open,progress,people,results}=fixture();await open();state.members=[];await runInContext('readChat()',app.context);await settle();assert.ok(progress());
 assert.doesNotMatch(results()!.textContent,/퀼|하나/);assert.equal(people()!.children[0]!.textContent,'');
 state.work.assistantSource.memberId='';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.match(results()!.textContent,/하나/);
});

test('switching Work tabs never shows another Work\'s cached roles or progress; failed reads clear the current steps',async()=>{
 const {app,state,open,progress,people}=fixture();await open();assert.ok(progress());
 runInContext('paneOpen("elsewhere","w2","Another work")',app.context);assert.equal(progress(),undefined);assert.equal(people(),undefined);
 await runInContext('paneSelect("intake/w1")',app.context);await settle();assert.ok(progress());
 state.missionStatus=503;await runInContext('loadMission("intake",false)',app.context);await settle();assert.equal(progress(),undefined);assert.equal(people(),undefined);
});

test('a newer Mission read wins over an older step response',async()=>{
 const {app,state,open,progress,results}=fixture();await open();let release=()=>{};
 state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);
 state.hold=null;state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='기업 고객 7곳';
 await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 assert.ok(progress());assert.match(results()!.textContent,/기업 고객 7곳/);
});

test('queued steps name their unfinished worker dependencies and clear them when those workers settle',async()=>{
 const {app,state,open,progress}=fixture();await open();assert.ok(progress());
 assert.match(progress()!.children[3]!.textContent,/선행 단계 · 고객 분류/);
 assert.doesNotMatch(progress()!.children[1]!.textContent,/선행 단계 · 해지 내역 수집/);
 state.revision++;state.work.tasks[4]!.status='settled';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.doesNotMatch(progress()!.children[3]!.textContent,/선행 단계 ·/);
});

test('feed replacement closes the old team and fences a pending Mission read',async()=>{
 const {app,state,open,people}=fixture();await open();let release=()=>{};
 state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);
 state.feed='feed:b';state.hold=null;await runInContext('readChat()',app.context);await settle();
 release();await old;await settle();
 assert.equal(app.node('work-pane').hidden,true,'an old Mission must not reopen the pane after reset');
 assert.equal(people(),undefined);
});

for(const deadline of [false,true])test((deadline?'deadline':'minute')+' refresh updates worker results without an event while member chat is selected',async()=>{
 const {app,state,open,progress,results}=fixture();await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const timers=new Map<number,{run:()=>void;delay:number}>();let next=0;
 app.context.setTimeout=(run:()=>void,delay:number)=>{timers.set(++next,{run,delay});return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 if(deadline)state.deadline=Date.now()-1;
 await runInContext('readChat()',app.context);await settle();const timer=timers.get(runInContext('chatPendingTimer',app.context))!;assert.equal(timer.delay,deadline?1000:60000);
 state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='기업 고객 7곳';timer.run();await settle();
 assert.ok(progress());assert.match(results()!.textContent,/퀼.*분류.*기업 고객 7곳/);
 assert.equal(runInContext('chatThread',app.context),'member-q');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('Q14 room transcript shows inferred author claims and literal quotes without making the discriminator a speaker',async()=>{
 const {app,state,open}=fixture();Object.assign(state.work,{room:{messages:[{ordinal:2,authorId:'challenger',kind:'challenge',text:'근거 <img src=x>',quote:'해지 41건',inferred:true,status:'admitted'}],issue:{status:'escalated'}},moderation:[{questionId:'q',model:{model:'jev-fixture'},result:{decision:'shadow',applied:false}}]});
 await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();const transcript=app.all().find(n=>n.className==='room-transcript')!;assert.ok(transcript);assert.ok(app.node('chat-log').contains(transcript));assert.ok(!app.node('work-list').contains(transcript));assert.match(transcript.textContent,/퀼.*반박.*추론.*근거 <img src=x>.*해지 41건/);assert.equal(app.all().filter(n=>n.tagName==='IMG').length,0);assert.doesNotMatch(transcript.children.filter(n=>n.tagName==='ARTICLE').map(n=>n.textContent).join(''),/jev-fixture/);assert.notEqual(transcript.children.find(n=>n.tagName==='DETAILS')!.open,true);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('Q14 transcript uses the latest read and clears on feed replacement and Work selection',async()=>{
 const {app,state,open}=fixture();const room={messages:[{ordinal:2,kind:'challenge',text:'이전 주장',quote:'이전 근거',inferred:true,status:'admitted'}],issue:null};Object.assign(state.work,{room});await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);state.hold=null;state.revision++;room.messages[0]!.text='최신 주장';await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 const transcript=()=>app.all().find(n=>n.className==='room-transcript');assert.match(transcript()!.textContent,/최신 주장/);assert.doesNotMatch(transcript()!.textContent,/이전 주장/);
 runInContext('paneOpen("elsewhere","w2","Other")',app.context);assert.equal(transcript(),undefined);await runInContext('paneSelect("intake/w1")',app.context);await settle();assert.ok(transcript());
 state.feed='feed:b';await runInContext('readChat()',app.context);await settle();assert.equal(transcript(),undefined);
});
