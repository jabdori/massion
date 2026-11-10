import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';

const member={id:'member-q',name:'퀼',look:{shape:'drop',color:'agent-1'},modelGroup:'default'};
const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
const task=(id:string,parentId:string|null,status:string,result:string,step?:{role:string;title:string;dependsOn:string[];skipReason?:string;instruction?:string})=>({id,parentId,status,result,...(step?{step}:{})});
function fixture(){
 const tasks=[task('root',null,'active',''),task('produce','root','active',''),task('check','root','queued',''),
  task('collect','produce','settled','해지 41건',{role:'조사',title:'해지 내역 수집',dependsOn:[],instruction:'해지 내역을 모아 줘.'}),
  task('group','produce','active','',{role:'분류',title:'고객 분류',dependsOn:['collect'],instruction:'고객을 분류해 줘.'}),
  task('survey','produce','settled','Skipped · 기존 설문',{role:'설문',title:'설문 발송',dependsOn:[],skipReason:'기존 설문'}),
  task('summary','produce','queued','',{role:'요약',title:'원인 요약',dependsOn:['group']})];
 const work={id:'w1',title:'Churn causes',missionVersion:1,criteria,execution:'active',acceptance:'pending',assistantSource:{memberId:member.id},tasks,attempts:[{id:'attempt:1',number:1,criteria,status:'active',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0}};
 const state={feed:'feed:a',revision:3,work,members:[member],hold:null as Promise<void>|null,missionStatus:200,conversations:[] as any[],deadline:undefined as number|undefined};
 const list=()=>({missionId:'intake',missionRevision:state.revision,workId:work.id,title:work.title,memberId:work.assistantSource.memberId||null,execution:work.execution,acceptance:work.acceptance,unknown:false,started:true,startedAt:1,endedAt:null,turnId:'assistant-turn:m:a',segment:1});
 const app=harness(async(path)=>{
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:1,members:state.members,runDeadlineAt:state.deadline,decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[list()]});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  if(path==='/missions/intake'||path.startsWith('/read-state')){
   const snapshot=structuredClone({revision:state.revision,value:{id:'intake',version:1,purpose:'Owner requests',scope:'local',constraints:[],criteria,works:[work],memories:[],growth:[],relations:[],...(state.conversations.length?{conversations:state.conversations}:{})}}),feedId=state.feed,hold=state.hold,status=state.missionStatus;
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

test('worker roles stay between member and Check; rows show status and worker output belongs to the selected pane',async()=>{
 const {app,open,progress,people,results}=fixture();await open();
 assert.deepEqual(people()!.children.map(n=>n.textContent),['퀼퀼','조사','분류','요약','확인']);
 assert.equal(app.all().find(n=>n.className==='room-progress')?.textContent,'2/4');
 const list=progress();assert.ok(list);assert.equal(list.children.length,6);assert.ok(list.children.every(n=>n.tagName==='LI'));
 assert.deepEqual(list.children.map(n=>n.textContent),['해지 내역 수집조사','고객 분류실행 중','설문 발송건너뜀 · 기존 설문','원인 요약다음 단계','확인0/1','기록']);
 assert.ok(list.children.every(n=>n.children.every(child=>child.children.length===0)),'compact rows have no nested identity or result blocks');
 assert.equal(list.children[2]!.textContent.split('기존 설문').length,2,'the skip reason appears once');
 assert.deepEqual(results()!.children[0]!.children[0]!.children.map(n=>n.textContent),['조사',' → ','퀼']);
 assert.match(results()!.textContent,/조사.*퀼.*해지 41건/);
 assert.equal(list.children.flatMap(n=>n.children).filter(n=>n.tagName==='TIME').length,0,'Work start time is not a recorded worker-step time');
 assert.equal(results()!.children.length,1,'only non-skipped worker output is shown');
 const compact=list.parentElement!.parentElement!;
 assert.ok(app.node('work-list').contains(results()!),'worker output belongs to the selected pane');assert.ok(!app.node('chat-log').contains(results()!));
 const flow=app.all().find(n=>n.className==='room-flow')!;
 assert.equal(flow.children.filter(n=>n.textContent.includes('해지 내역 수집')).length,1);
 assert.match(flow.textContent,/해지 내역 수집.*퀼.*조사/);assert.equal(app.all().find(n=>n.tagName==='DETAILS'&&n.children.some(c=>c.tagName==='PRE'&&c.textContent==='해지 41건'))?.open,false);
 assert.match(flow.textContent,/설문 발송.*건너뜀 · 기존 설문/);
 assert.match(list.children[2]!.attributes.get('aria-label')!,/건너뜀 · 기존 설문/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('step labels and results stay text; root, executor and verifier results do not become worker rows',async()=>{
 const {app,state,open,progress,results}=fixture();state.work.tasks[0]!.result='Root only';state.work.tasks[1]!.result='Executor only';state.work.tasks[2]!.result='Verifier only';
 state.work.tasks[3]!.step!.role='<img src=x>';state.work.tasks[3]!.step!.title='<script>title</script>';state.work.tasks[3]!.result='<b>result</b>';
 await open();assert.ok(progress());assert.equal(progress()!.children[0]!.children[1]!.textContent,'<script>title</script>');assert.match(results()!.textContent,/<img src=x>.*<b>result<\/b>/);
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
 state.hold=null;state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='기업 고객 7곳';Object.assign(state.work.tasks[4]!,{endedAt:Date.UTC(2026,10,5,0,7)});
 await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 assert.ok(progress());assert.match(results()!.textContent,/기업 고객 7곳/);assert.ok(results()!.textContent.includes(runInContext('chatTime('+Date.UTC(2026,10,5,0,7)+')',app.context)));
});

test('queued steps name their unfinished worker dependencies and clear them when those workers settle',async()=>{
 const {app,state,open,progress}=fixture();await open();assert.ok(progress());
 assert.match(progress()!.children[3]!.attributes.get('title')??'',/선행 단계 · 고객 분류/);
 assert.equal(progress()!.children[1]!.attributes.get('title'),undefined);
 state.revision++;state.work.tasks[4]!.status='settled';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.equal(progress()!.children[3]!.attributes.get('title'),undefined);
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
 state.revision++;state.work.tasks[4]!.status='settled';state.work.tasks[4]!.result='기업 고객 7곳';Object.assign(state.work.tasks[4]!,{endedAt:Date.UTC(2026,10,5,0,7)});timer.run();await settle();
 assert.ok(progress());assert.match(results()!.textContent,/분류.*퀼.*기업 고객 7곳/);assert.ok(results()!.textContent.includes(runInContext('chatTime('+Date.UTC(2026,10,5,0,7)+')',app.context)));
 assert.equal(runInContext('chatThread',app.context),'member-q');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('Q14 room transcript shows inferred author claims and literal quotes without making the discriminator a speaker',async()=>{
 const {app,state,open}=fixture();Object.assign(state.work,{room:{messages:[{ordinal:2,authorId:'challenger',kind:'challenge',text:'근거 <img src=x>',quote:'해지 41건',inferred:true,status:'admitted'}],issue:{status:'escalated'}},moderation:[{questionId:'q',model:{model:'jev-fixture'},result:{decision:'shadow',applied:false}}]});
 await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();const transcript=app.all().find(n=>n.className==='room-transcript')!;assert.ok(transcript);assert.ok(app.node('chat-log').contains(transcript));assert.ok(!app.node('work-list').contains(transcript));assert.match(transcript.textContent,/퀼.*반박.*추론.*근거 <img src=x>.*해지 41건/);assert.equal(app.all().filter(n=>n.tagName==='IMG').length,0);assert.doesNotMatch(transcript.children.filter(n=>n.tagName==='ARTICLE').map(n=>n.textContent).join(''),/jev-fixture/);assert.notEqual(transcript.children.find(n=>n.tagName==='DETAILS')!.open,true);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('Q14 transcript uses the latest read and clears on feed replacement and Work selection',async()=>{
 const {app,state,open}=fixture();const room={messages:[{ordinal:2,kind:'challenge',text:'이전 주장',quote:'이전 근거',inferred:true,status:'admitted'}],issue:null};Object.assign(state.work,{room});await open();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);state.hold=null;state.revision++;room.messages[0]!.text='최신 주장';Object.assign(room.messages[0]!,{at:Date.UTC(2026,10,5,0,8)});await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 const transcript=()=>app.all().find(n=>n.className==='room-transcript');assert.match(transcript()!.textContent,/최신 주장/);assert.doesNotMatch(transcript()!.textContent,/이전 주장/);assert.ok(transcript()!.textContent.includes(runInContext('chatTime('+Date.UTC(2026,10,5,0,8)+')',app.context)));
 runInContext('paneOpen("elsewhere","w2","Other")',app.context);assert.equal(transcript(),undefined);await runInContext('paneSelect("intake/w1")',app.context);await settle();assert.ok(transcript());
 state.feed='feed:b';await runInContext('readChat()',app.context);await settle();assert.equal(transcript(),undefined);
});

test('recorded worker times reach the procedure, output and Work-bound conversation without borrowing Work time',async()=>{
 const {app,state,open,progress,results}=fixture();
 Object.assign(state.work,{admittedAt:Date.UTC(2026,10,5,0,0)});
 Object.assign(state.work.tasks[3]!,{startedAt:Date.UTC(2026,10,5,0,1),endedAt:Date.UTC(2026,10,5,0,2)});
 await open();
 const time=(at:number)=>runInContext('chatTime('+at+')',app.context);
 assert.equal(progress()!.children[0]!.children.find(n=>n.tagName==='TIME')?.textContent,time(Date.UTC(2026,10,5,0,2)));
 assert.equal(progress()!.children[1]!.children.find(n=>n.tagName==='TIME'),undefined);
 assert.ok(results()!.children[1]!.children[0]!.children.some(n=>n.tagName==='TIME'&&n.textContent===time(Date.UTC(2026,10,5,0,2))));
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const transcript=app.all().find(n=>n.className==='room-transcript')!;
 assert.equal(transcript,undefined,'worker output stays in the pane when the member thread opens');assert.ok(app.node('work-list').contains(results()!));
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('room turns render their assignment role and recorded time, and owner discussion stays Work-bound',async()=>{
 const {app,state,open}=fixture(),at=Date.UTC(2026,10,5,0,3);
 Object.assign(state.work,{room:{messages:[{ordinal:2,assignmentId:'challenger',kind:'challenge',text:'해지 41건 확인',quote:'해지 41건',inferred:true,status:'admitted',at}],issue:null},assignments:[{id:'challenger',taskId:'collect',actorId:'worker',role:'executor'}]});
 state.conversations=[{workId:'w1',messages:[{id:'m1',text:'이 작업 지시',at}]},{workId:'other',messages:[{id:'m2',text:'다른 작업 지시',at}]}];await open();
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const transcript=app.all().find(n=>n.className==='room-transcript')!;
 const challenge=transcript.children.find(n=>n.tagName==='ARTICLE'&&n.textContent.includes('반박'))!;
 assert.ok(challenge.children[0]!.children.some(n=>n.textContent==='조사'));
 assert.equal(challenge.children[0]!.children.find(n=>n.tagName==='TIME')?.textContent,runInContext('chatTime('+at+')',app.context));
 assert.match(transcript.textContent,/이 작업 지시/);assert.doesNotMatch(transcript.textContent,/다른 작업 지시/);const note=transcript.children.find(n=>n.className==='chat-owner')!;assert.equal(note.children[0]!.children[0]!.textContent,'나');assert.equal(note.children[0]!.children.find(n=>n.tagName==='TIME')?.textContent,runInContext('chatTime('+at+')',app.context));
 runInContext('paneOpen("elsewhere","w2","Other")',app.context);assert.equal(app.all().find(n=>n.className==='room-transcript'),undefined);await runInContext('paneSelect("intake/w1")',app.context);await settle();assert.ok(app.all().find(n=>n.className==='room-transcript')?.textContent.includes('이 작업 지시'));state.feed='feed:b';await runInContext('readChat()',app.context);await settle();assert.equal(app.all().find(n=>n.className==='room-transcript'),undefined);
});

test('predicate and check times follow the newest Mission read and disappear on feed replacement',async()=>{
 const {app,state,open}=fixture(),at=Date.UTC(2026,10,5,0,9),criterion=criteria.description;
 Object.assign(state.work,{artifact:{id:'a',version:1,sha256:'a'.repeat(64)},verdict:{id:'v',verifierAssignmentId:'check',artifactSha256:'a'.repeat(64),artifactVersion:1,criteriaVersion:1,status:'passed',checkedAt:at,predicates:[{criterion,passed:true,quote:'해지 41건',reason:'이전 판정'}],evidence:[{kind:'fixture',detail:'해지 41건',source:'fixture'}]}});
 await open();let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('loadMission("intake",false)',app.context);state.hold=null;state.revision++;
 const verdict=(state.work as any).verdict;verdict.checkedAt=at+60000;verdict.predicates[0].reason='최신 판정';
 await runInContext('loadMission("intake",false)',app.context);release();await old;await settle();
 const fields=()=>app.all().filter(n=>n.className==='room-fields').map(n=>n.textContent).join('');
 assert.match(fields(),/최신 판정/);assert.doesNotMatch(fields(),/이전 판정/);assert.ok(fields().includes(runInContext('chatTime('+(at+60000)+')',app.context)));
 state.feed='feed:b';await runInContext('readChat()',app.context);await settle();assert.equal(fields(),'');
});


test('observed worker progress shows row counts, status, recorded time and literal detail without an aggregate header',async()=>{
 const {app,state,open,progress}=fixture(),at=Date.UTC(2026,10,5,0,40);
 Object.assign(state.work.tasks[4]!,{startedAt:at-60000,progress:{done:4,total:11,at,note:{label:'C사',text:'연간 요금만 공개 <b>원문</b>'}}});
 await open();const row=progress()!.children[1]!;
 assert.equal(row.children.find(n=>n.className==='room-step-count')?.textContent,'4/11');
 assert.equal(row.children.find(n=>n.className==='room-step-status')?.textContent,'실행 중');
 assert.equal(row.children.find(n=>n.tagName==='TIME')?.textContent,runInContext('chatTime('+(at-60000)+')',app.context));
 assert.equal(row.children.find(n=>n.className==='room-step-note')?.textContent,'C사연간 요금만 공개 <b>원문</b>');
 assert.equal(app.all().find(n=>n.className==='room-progress'),undefined);
 assert.equal(app.all().filter(n=>n.tagName==='B').length,0);
 state.revision++;state.work.tasks[4]!.status='settled';await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.equal(progress()!.children[3]!.children.find(n=>n.className==='room-step-status')?.textContent,'다음 단계');
});

test('participant chips omit roles already named by step titles',async()=>{
 const {state,open,people}=fixture();for(const t of state.work.tasks)if(t.step)t.step.role=t.step.title;
 await open();assert.deepEqual(people()!.children.map(n=>n.textContent),['퀼퀼','확인']);
});

test('a step note links the exact Work discussion to its pane row with the message time and never adopts the proposal',async()=>{
 const {app,state,open,progress}=fixture(),at=Date.UTC(2026,10,5,0,44);
 state.conversations=[{workId:'w1',messages:[{id:'note',role:'owner',text:'이번에는 테스트부터 돌려 줘.',at,stepNote:{taskId:'summary',title:'테스트 먼저 돌리기'}},{id:'wrong-step',role:'owner',text:'원문만 유지',at,stepNote:{taskId:'other',title:'없는 단계'}}]},{workId:'other',messages:[{id:'foreign',role:'owner',text:'다른 작업',at,stepNote:{taskId:'summary',title:'다른 작업 메모'}}]}];
 await open();const row=progress()!.children[3]!,note=row.children.find(n=>n.className==='room-step-note')!;
 assert.ok(note);assert.equal(note.children[0]!.textContent,'절차 고침: 테스트 먼저 돌리기 · 확인 대기');
 assert.equal(note.children.find(n=>n.tagName==='TIME')?.textContent,runInContext('chatTime('+at+')',app.context));
 assert.equal(app.all().find(n=>n.className==='room-transcript'),undefined);const transcript=app.all().find(n=>n.className==='chat-step-notes')!;
 const line=transcript.children.find(n=>n.className==='chat-system')!,link=line.children.find(n=>n.tagName==='BUTTON')!;
 assert.ok(link);assert.ok(line.textContent.includes('절차 고침: 테스트 먼저 돌리기 · 확인 대기'));
 assert.ok(line.children.some(n=>n.tagName==='TIME'&&n.textContent===runInContext('chatTime('+at+')',app.context)));
 assert.doesNotMatch(transcript.textContent,/다른 작업|절차 고침: 없는 단계/);assert.match(transcript.textContent,/원문만 유지/);
 await link.fire('click');assert.equal((app.context.document as any).activeElement,row);
 assert.equal(row.children[1]!.textContent,'원인 요약');assert.equal(state.work.tasks[6]!.step!.title,'원인 요약');assert.equal(state.work.tasks[6]!.status,'queued');
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('worker instruction and result project direction and recorded times into the exact selected pane',async()=>{
 const {app,state,open,results}=fixture(),at=Date.UTC(2026,10,5,0,32);
 Object.assign(state.work.tasks[3]!,{startedAt:at,endedAt:at+480000});state.work.tasks[3]!.step!.instruction='세 곳 요금제에서 월 요금만 모아 줘. <b>원문</b>';
 Object.assign(state.work.tasks[5]!,{startedAt:at,endedAt:at+60000});state.work.tasks[5]!.step!.instruction='건너뛴 지시';
 await open();const messages=results()!.children;
 assert.equal(messages.length,2);assert.deepEqual(messages[0]!.children[0]!.children.filter(n=>n.attributes.get('aria-hidden')!=='true').map(n=>n.textContent),['퀼',' → ','조사',runInContext('chatTime('+at+')',app.context)]);
 assert.deepEqual(messages[1]!.children[0]!.children.map(n=>n.textContent),['조사',' → ','퀼',runInContext('chatTime('+(at+480000)+')',app.context)]);
 assert.match(results()!.textContent,/세 곳 요금제에서 월 요금만 모아 줘. <b>원문<\/b>/);assert.doesNotMatch(results()!.textContent,/건너뛴 지시|기존 설문/);
 assert.ok(app.node('work-list').contains(results()!));assert.equal(app.all().filter(n=>n.tagName==='B').length,0);
 const copied:string[]=[];(app.context.navigator as any).clipboard={writeText:async(text:string)=>{copied.push(text);}};
 for(const message of messages){const button=message.children.find(n=>n.tagName==='BUTTON');assert.ok(button);assert.equal(button.attributes.get('aria-label'),'복사');await button.fire('click');}
 assert.deepEqual(copied,['세 곳 요금제에서 월 요금만 모아 줘. <b>원문</b>','해지 41건']);
 runInContext('paneOpen("elsewhere","w2","Other")',app.context);assert.equal(results(),undefined);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});


test('silent worker results remain in deliberate flow detail without becoming pane messages',async()=>{
 const {app,state,open,results}=fixture();delete state.work.tasks[3]!.step!.instruction;Object.assign(state.work.tasks[3]!,{endedAt:Date.UTC(2026,10,5,0,32)});
 await open();assert.equal(results(),undefined);
 const flow=app.all().find(n=>n.className==='room-flow')!;
 const result=flow.children.flatMap(n=>n.children).flatMap(n=>n.children).flatMap(n=>n.children).find(n=>n.tagName==='DETAILS'&&n.textContent.includes('해지 41건'))!;
 assert.ok(result);assert.equal(result.open,false);assert.equal(result.children.find(n=>n.tagName==='PRE')?.textContent,'해지 41건');
 assert.equal(app.all().find(n=>n.className==='room-transcript'),undefined);
});

test('an owner steering wait is not relabelled as independent checking',async()=>{
 const {app,state,open}=fixture();state.work.execution='waiting';state.work.tasks.filter(t=>t.step).forEach(t=>t.status='settled');await open();
 const status=app.all().find(n=>n.className==='room-status')!;assert.match(status.textContent,/대기 중/);assert.doesNotMatch(status.textContent,/확인 대기/);
});

test('a pending step note changes to the room presentation only when a real room arrives',async()=>{
 const {app,state,open}=fixture();state.conversations=[{workId:'w1',messages:[{id:'note',role:'owner',text:'Tests first',at:1,stepNote:{taskId:'summary',title:'Tests first'}}]}];await open();
 assert.ok(app.all().find(n=>n.className==='chat-step-notes'));assert.equal(app.all().find(n=>n.className==='room-transcript'),undefined);
 Object.assign(state.work,{room:{messages:[{ordinal:1,kind:'proposal',text:'Recorded artifact',quote:'',inferred:true,status:'admitted',at:2}],issue:null}});state.revision++;
 await runInContext('loadMission("intake",false)',app.context);await settle();
 assert.equal(!!app.all().find(n=>n.className==='chat-step-notes'),false);assert.match(app.all().find(n=>n.className==='room-transcript')!.textContent,/Recorded artifact/);
});

test('file status comes only from exact host dispatch inputs and never from progress or file names',async()=>{
 const {app,state,open}=fixture(),sha='a'.repeat(64),at=Date.UTC(2026,10,5,1,40);
 Object.assign(state.work,{sourceDocuments:[{document:{id:'source',source:'https://github.com/jabdori/massion/pull/84',content:JSON.stringify({format:'github-review/v2',repository:'jabdori/massion',number:84,headSha:'b'.repeat(40),url:'https://github.com/jabdori/massion/pull/84',files:[{path:'src/a.ts',content:'source A'},{path:'src/b.ts',content:'source B'}]})}}],effects:[{id:'read',taskId:'collect',status:'succeeded',providerDispatch:{claimedAt:at,fileInputs:[{documentId:'source',path:'src/a.ts',sha256:sha}]}},{id:'reading',taskId:'group',status:'pending',providerDispatch:{claimedAt:at+1,fileInputs:[{documentId:'source',path:'src/b.ts',sha256:sha}]}}]});
 await open();const files=()=>app.all().find(n=>n.className==='room-files');
 assert.ok(files());assert.deepEqual(files()!.children.map(n=>n.textContent),['src/a.ts읽음','src/b.ts읽는 중']);
 (state.work.effects as any[])[1]!.status='unknown';state.revision++;await runInContext('loadMission("intake",false)',app.context);await settle();assert.match(files()!.textContent,/결과 모름/);assert.doesNotMatch(files()!.children[1]!.textContent,/읽음/);
});

test('acknowledged step notes preserve the proposal and expose the member reply with copying',async()=>{
 const {app,state,open,progress}=fixture(),at=Date.UTC(2026,10,5,1,44);
 state.conversations=[{workId:'w1',messages:[{id:'note',role:'owner',text:'테스트부터 돌려 줘.',at,stepNote:{taskId:'summary',title:'테스트 먼저 돌리기'}}]}];
 Object.assign(state.work.tasks.find(t=>t.id==='summary')!,{procedureEdit:{messageId:'note',actorId:'worker',title:'테스트 먼저 돌리기',instruction:'테스트부터 돌려 줘.',at:at+1}});
 await open();assert.match(progress()!.textContent,/테스트 먼저 돌리기/);const transcript=app.all().find(n=>n.className==='chat-step-notes')!;
 assert.match(transcript.textContent,/퀼/);assert.match(transcript.textContent,/테스트 먼저 돌리기/);assert.ok(transcript.children.some(n=>n.className==='chat-reply'&&n.children.some(c=>c.tagName==='BUTTON'&&c.attributes.get('aria-label')==='복사')));
});

test('expanded flow distinguishes an accepted Record from skipped recording after a failed check',async()=>{
 const {app,state,open}=fixture(),at=Date.UTC(2026,10,5,1,50);
 Object.assign(state.work,{execution:'settled',acceptance:'accepted',artifact:{sha256:'a',version:1,kind:'text'},verdict:{artifactSha256:'a',artifactVersion:1,criteriaVersion:1,status:'passed',checkedAt:at,evidence:[]},record:{id:'record',createdAt:at+1000,artifact:{sha256:'a',version:1,kind:'text'},criteria:state.work.criteria},endedAt:at+1000});
 await open();let flow=app.all().find(n=>n.className==='room-flow')!;assert.ok(flow.children.some(n=>n.textContent.includes('기록 생성')&&n.children[0]?.textContent));
 Object.assign(state.work,{acceptance:'failed',record:undefined,verdict:{...((state.work as any).verdict),status:'failed'}});state.revision++;await runInContext('loadMission("intake",false)',app.context);await settle();flow=app.all().find(n=>n.className==='room-flow')!;assert.match(flow.textContent,/기록.*건너뜀/);
});

test('an expired dispatch updates every delivered file row in the fallback pane',async()=>{
 const {app,state,open}=fixture(),deadline=Date.now()+60000;
 Object.assign(state.work,{runtimeRun:{ownership:{startedAt:deadline-60000,deadlineAt:deadline}},sourceDocuments:[{document:{id:'source',source:'https://github.com/jabdori/massion/pull/84',content:JSON.stringify({format:'github-review/v2',url:'https://github.com/jabdori/massion/pull/84',files:[{path:'src/a.ts',content:'a'},{path:'src/b.ts',content:'b'}]})}}],effects:[{id:'batch-read',taskId:'group',status:'pending',providerDispatch:{claimedAt:deadline-50000,fileInputs:[{documentId:'source',path:'src/a.ts',sha256:'a'.repeat(64)},{documentId:'source',path:'src/b.ts',sha256:'b'.repeat(64)}]}}]});
 await open();const files=app.all().find(n=>n.className==='room-files')!,statuses=files.children.map(n=>n.children[1]!);
 assert.deepEqual(statuses.map(n=>n.textContent),['읽는 중','읽는 중']);assert.equal(new Set(statuses.map(n=>n.id)).size,2);
 (app.context as any).fileDeadline=deadline;runInContext('Date=class extends Date{static now(){return fileDeadline+1}};workRoomClock()',app.context);
 assert.deepEqual(statuses.map(n=>n.textContent),['결과 모름','결과 모름']);
});

test('expanded file effects identify each delivered repository path instead of repeating a worker title',async()=>{
 const {app,state,open}=fixture();
 Object.assign(state.work,{effects:[{id:'files',taskId:'group',status:'succeeded',providerDispatch:{fileInputs:[{documentId:'source',path:'src/review/source.ts',sha256:'a'.repeat(64)},{documentId:'source',path:'tests/review/source.test.ts',sha256:'b'.repeat(64)}]}}]});
 await open();const effects=app.all().filter(n=>n.className==='room-fields')[2]!;
 assert.deepEqual(effects.children.map(n=>n.children[0]!.textContent),['src/review/source.ts','tests/review/source.test.ts']);
 assert.ok(effects.children.every(n=>n.children[0]!.attributes.get('title')===n.children[0]!.textContent));
 assert.ok(effects.children.every(n=>n.children[1]!.textContent==='완료'));
});

test('the step note line states its exact assigned member acknowledgement while other notes remain pending',async()=>{
 const {app,state,open,progress}=fixture(),at=Date.UTC(2026,10,5,1,44);
 state.conversations=[{workId:'w1',messages:[{id:'applied',role:'owner',text:'Use the next instruction',at,stepNote:{taskId:'summary',title:'Next instruction'}},{id:'pending',role:'owner',text:'Another proposal',at,stepNote:{taskId:'group',title:'Another instruction'}}]}];
 Object.assign(state.work.tasks.find(t=>t.id==='summary')!,{procedureEdit:{messageId:'applied',actorId:'worker',title:'Next instruction',instruction:'Use the next instruction',at:at+1}});
 await open();assert.match(progress()!.textContent,/절차 고침: Next instruction · 퀼 확인/);assert.match(progress()!.textContent,/절차 고침: Another instruction · 확인 대기/);
 const transcript=app.all().find(n=>n.className==='chat-step-notes')!;assert.match(transcript.textContent,/절차 고침: Next instruction · 퀼 확인/);
});
