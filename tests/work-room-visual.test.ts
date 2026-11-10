import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {parseResultFacts} from '../src/result-facts.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
const hasClass=(node:Node,name:string)=>node.className.split(' ').includes(name);
async function scene(screen:string,rejectStatus=405){
 const fixture=await loadFixture(screen),posted:string[]=[];
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){posted.push(path);return reply({error:'Read-only fixture',...(rejectStatus===409?{status:'conflict',reason:'revision'}:{})},rejectStatus);}
  const r=fixture.routes[path]??(path.startsWith('/events?')?fixture.routes['/events']:undefined);
  return r?reply(structuredClone(r.body),r.status):reply({},503);
 });await settle();
 const selected=fixture.steps.map(s=>'readySelector' in s?s.readySelector:undefined).findLast(s=>s?.startsWith('#work-heading-'))??fixture.readySelector,works=(fixture.routes['/missions/intake']!.body as any).value.works;
 const work=works.find((w:any)=>selected==='#work-heading-'+w.id)??works[0],turn=(fixture.routes['/assistant/works']!.body as any).works.find((w:any)=>w.workId===work.id);
 await runInContext('shellOpenWork('+JSON.stringify(turn.turnId)+')',app.context);await settle();
 const card=()=>app.all().find(n=>n.id==='work-card-'+work.id)!,nodes=()=>descendants(card());
 return {app,work,posted,card,nodes,fixture};
}

for(const [screen,status] of [['B7','확인 대기'],['B7-done','확인 완료'],['B7-fail','확인 실패'],['B7-unknown','확인 안 함']] as const)test(screen+' has a status/detail check bar and no unsolicited budget line',async()=>{
 const {nodes,posted}=await scene(screen),summary=nodes().find(n=>n.tagName==='SUMMARY'&&n.id.startsWith('work-room-check-'))!;
 assert.ok(!nodes().some(n=>hasClass(n,'room-budget')));
 assert.equal(summary.attributes.get('role'),'button');assert.equal(summary.children.find(n=>n.tagName==='STRONG')?.textContent,status);
 assert.ok(summary.children.some(n=>hasClass(n,'room-check-icon')));assert.ok(summary.children.some(n=>hasClass(n,'room-check-detail')));assert.ok(summary.children.some(n=>hasClass(n,'room-check-chevron')));
 if(screen==='B7-fail')assert.ok(hasClass(summary,'room-check-failed'));assert.equal(posted.length,0);
});

for(const screen of ['B7-done','B7-fail','B7-unknown'] as const)test(screen+' is terminal and cannot offer Stop',async()=>{
 const {nodes,work}=await scene(screen);
 assert.ok(!nodes().some(n=>n.id==='work-room-stop-'+work.id));
 const markers=nodes().filter(n=>hasClass(n,'room-step-marker'));
 if(screen==='B7-unknown'){assert.ok(markers.some(n=>hasClass(n,'unknown')));assert.ok(nodes().some(n=>hasClass(n,'room-step-status')&&n.textContent==='결과 모름'));}
 if(screen==='B7-done')assert.ok(markers.length>0&&markers.every(n=>hasClass(n,'done')));
 if(screen==='B7-fail'){
  assert.ok(markers.some(n=>hasClass(n,'failed')));
  const count=nodes().find(n=>hasClass(n,'room-progress'))!.textContent.split('/').map(Number);assert.deepEqual(count,[5,5]);assert.equal(work.record,undefined,'settled workers do not accept a failed check');
 }
});

test('expanded cards keep labelled value rows, distinct effects and real flow entries',async()=>{
 const {app,nodes}=await scene('B7-fail');await app.node('pane-widen').fire('click');
 const detail=nodes().find(n=>hasClass(n,'room-detail'))!,groups=descendants(detail).filter(n=>hasClass(n,'room-fields'));
 assert.equal(groups.length,4);
 for(const group of groups)for(const row of group.children){assert.equal(row.children[0]?.tagName,'DT');assert.equal(row.children[1]?.tagName,'DD');}
 const effects=groups[2]!.children.map(n=>n.children[0]!.textContent);assert.equal(new Set(effects).size,effects.length);
 assert.ok(!groups[3]!.children.some(n=>n.children[0]!.textContent==='기록'));
 const flow=descendants(detail).find(n=>hasClass(n,'room-flow'))!;assert.ok(flow.children.length>0);
 for(const row of flow.children){assert.ok(row.children.some(n=>hasClass(n,'room-flow-dot')));assert.notEqual(row.textContent,'대화');}
});

test('flow distinguishes admission from run start in the same minute and never invents an admission-only start',async()=>{
 const {app,nodes,work}=await scene('B7-fail'),flow=()=>nodes().find(n=>hasClass(n,'room-flow'))!;
 const start=work.runtimeRun.ownership.startedAt;
 assert.equal(runInContext('chatTime('+work.admittedAt+')',app.context),runInContext('chatTime('+start+')',app.context));
 assert.deepEqual(flow().children.slice(0,2).map(n=>n.children[2]!.textContent),['작업 접수','실행 시작']);
 assert.deepEqual(flow().children.slice(0,2).map(n=>n.children[0]!.textContent),[work.admittedAt,start].map(at=>runInContext('chatTime('+at+')',app.context)));
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});delete w.runtimeRun;for(const task of w.tasks)delete task.startedAt;for(const row of shellWorks)if(row.workId===w.id)row.startedAt=null;renderMission();}`,app.context);
 assert.equal(flow().children.filter(n=>n.children[2]!.textContent==='작업 접수').length,1);
 assert.equal(flow().children.filter(n=>n.children[2]!.textContent==='실행 시작').length,0);
});

test('the connection strip resolves pinned production labels and never falls back to a fixture provider tag',async()=>{
 const {app,nodes,work}=await scene('B7');
 runInContext(`runtimeConfiguration={connections:[{id:'profile:live',configHash:'pin',revision:'connection-hash',providerKind:'openai',label:'Selected model'}]};connectionCatalog={connections:[{label:'운영 연결',configHash:'connection-hash',providerType:'openai'}]};snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)}).runtimeRun.connectionBindings={executor:{profileId:'profile:live',configHash:'pin'},verifier:{profileId:'profile:live',configHash:'pin'}};renderMission()`,app.context);
 const connection=()=>nodes().find(n=>hasClass(n,'room-connection'))!.textContent;
 assert.equal(connection(),'운영 연결');assert.doesNotMatch(connection(),/fixture/);
 runInContext("runtimeConfiguration.connections[0].configHash='new-pin';renderMission()",app.context);assert.equal(connection(),'알 수 없음');
});

test('a failed verdict marks only its bound verification task as failed',async()=>{
 const {app,nodes,work}=await scene('B7-fail');
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)}),other={...w.assignments.find(a=>a.role==='verifier'),id:'other-review',taskId:'other-review-task'};w.assignments.push(other);w.tasks.push({id:other.taskId,parentId:w.tasks[0].id,status:'settled'});renderMission()}`,app.context);
 assert.equal(nodes().filter(n=>hasClass(n,'room-step-marker')&&hasClass(n,'failed')).length,1);
 assert.equal(nodes().find(n=>hasClass(n,'room-progress'))!.textContent,'5/5');
});

test('a rejected Stop reports the revision conflict while the Work stays running',async()=>{
 const {app,nodes,posted,work}=await scene('B7',409),stop=nodes().find(n=>n.id==='work-room-stop-'+work.id)!;
 await stop.fire('click');await settle();
 assert.equal(posted.length,1);assert.equal(runInContext('snapshot.value.works.find(w=>w.id==='+JSON.stringify(work.id)+').execution',app.context),'active');
 assert.match(app.node('status').className,/warning/);assert.match(app.node('status').textContent,/충돌/);assert.equal(app.node('page-status').hidden,true);assert.equal(runInContext('unknownOperation',app.context),null);
});

 test('B22 room steps use the B7 pane and never embed the legacy Work inspector',async()=>{
 const {nodes,card,work}=await scene('B22-room-steps');
 assert.deepEqual(nodes().find(n=>hasClass(n,'room-steps'))!.children.map(n=>n.children[1]!.textContent),['읽기','테스트 돌리기','확인','기록']);
 assert.ok(nodes().some(n=>n.id==='work-room-stop-'+work.id));
 assert.ok(!nodes().some(n=>n.id==='work-evidence-summary-'+work.id));
 assert.doesNotMatch(card().textContent,/실행: active|검증: pending|시도 \/ 예산|측정 사용량|기준·기억·근거|선택한 원문 문서|원래 조직 역할/);
 });

for(const [screen,panel] of [['B7-done','record-text-summary'],['B7-fail','rejected-text-summary']])test(screen+' keeps its deliberate result reader without the legacy state dump',async()=>{
 const {nodes,work}=await scene(screen!);assert.ok(nodes().some(n=>n.id==='work-'+panel+'-'+work.id));assert.ok(!nodes().some(n=>n.id==='work-evidence-summary-'+work.id));
});

test('failed procedure rows show only the current bound verdict evidence',async()=>{
 const {app,nodes,work}=await scene('B7-fail');
 const failed=()=>nodes().find(n=>hasClass(n,'room-step')&&hasClass(n,'failed'))!;
 assert.equal(failed().children.find(n=>hasClass(n,'room-step-status'))?.textContent,work.verdict.evidence.map((e:any)=>e.detail).join(' · '));
 runInContext(`snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)}).verdict.artifactSha256='stale';renderMission()`,app.context);
 assert.ok(!failed().children.some(n=>hasClass(n,'room-step-status')));
});

for(const [screen,word] of [['B8-done','맞음'],['B8-fail','아님']] as const)test(screen+' shows the verdict word instead of repeating the header count',async()=>{
 const {nodes}=await scene(screen),group=nodes().find(n=>hasClass(n,'room-grid'))!.children[1]!;
 assert.equal(descendants(group).filter(n=>hasClass(n,'room-field-note'))[0]?.textContent,word);
});

test('conversation and procedure counts use the same child tasks and failed check state',async()=>{
 const {app,nodes,work}=await scene('B7-fail');
 const count=nodes().find(n=>hasClass(n,'room-progress'))!.textContent;
 assert.equal(count,'5/5');
 const active=await scene('B7');
 const card=active.app.all().find(n=>n.className==='chat-card'&&n.textContent.includes(active.work.title))!;
 assert.ok(card);assert.equal(descendants(card).find(n=>hasClass(n,'chat-steps'))?.textContent,active.nodes().find(n=>hasClass(n,'room-progress'))!.textContent);
});

test('legacy procedures list exactly the child tasks counted by their progress',async()=>{
 const {nodes,work}=await scene('B7'),steps=nodes().find(n=>hasClass(n,'room-steps'))!;
 assert.equal(steps.children.length,work.tasks.filter((task:any)=>task.parentId!==null).length);
 assert.ok(!steps.children.some(n=>n.children[1]?.textContent===work.title));
});

for(const screen of ['B8-done','B8-fail'])test(screen+' keeps raw execution results behind deliberate flow disclosures',async()=>{
 const {nodes,work}=await scene(screen),flow=nodes().find(n=>hasClass(n,'room-flow'))!;
 for(const task of work.tasks.filter((task:any)=>task.result&&!task.step?.skipReason)){
  if(parseResultFacts(task.result)){
   const detail=descendants(flow).find(n=>n.tagName==='DETAILS'&&n.children.some(c=>c.tagName==='SUMMARY'&&c.textContent===task.step.title));assert.ok(detail,'typed result has a disclosure');assert.equal(detail.open,false);assert.ok(detail.children.some(n=>n.tagName==='P'));assert.doesNotMatch(detail.textContent,/massion-facts/);continue;
  }
  const detail=descendants(flow).find(n=>n.tagName==='DETAILS'&&n.textContent.includes(task.result));
  assert.ok(detail,'task result has a disclosure');assert.equal(detail.open,false);
  assert.ok(detail.children.some(n=>n.tagName==='SUMMARY'&&n.textContent.length>0));
  assert.equal(detail.children.find(n=>n.tagName==='PRE')?.textContent,task.result);
 }
});

test('room participants expose member and independent Check as list items and use the exact current handoff turn',async()=>{
 const {nodes,posted}=await scene('B22-room-steps'),people=nodes().find(n=>hasClass(n,'room-people'))!;
 assert.equal(people.tagName,'UL');assert.ok(people.children.every(n=>n.tagName==='LI'));
 assert.equal(people.children[0]!.children.at(-1)!.textContent,'주노');assert.equal(people.children.at(-1)!.textContent,'확인');
 const check=nodes().find(n=>hasClass(n,'room-steps'))!.children.find(n=>n.children[1]?.textContent==='확인')!;
 assert.equal(check.children.find(n=>hasClass(n,'room-step-count'))?.textContent,'0/1');
 const handoff=nodes().find(n=>hasClass(n,'room-handoff'))!;
 assert.ok(handoff);assert.equal(handoff.hidden,false);assert.match(handoff.textContent,/^하나가 넘김 · \d{1,2}:\d{2}$/);
 assert.equal(posted.length,0);
});

test('both room fixtures retain current sibling Work with matching Mission snapshots',async()=>{
 for(const screen of ['B22-room','B22-room-steps']){
  const fixture=await loadFixture(screen),mission=(fixture.routes['/missions/intake']!.body as any).value;
  const rows=(fixture.routes['/assistant/works']!.body as any).works;
  assert.deepEqual(rows.filter((w:any)=>w.memberId==='member-quill').map((w:any)=>[w.title,w.execution]),[['이탈 원인 조사','active'],['경쟁사 가격','active']]);
  for(const row of rows){const work=mission.works.find((w:any)=>w.id===row.workId);assert.ok(work);assert.equal(row.execution,work.execution);}
 }
});

test('bound check predicates and admission, check and steering times render literally; stale verdicts hide their telemetry',async()=>{
 const {app,nodes,work,fixture}=await scene('B8-fail'),at=Date.UTC(2026,10,5,0,1),quote=Object.values(fixture.routes).map(route=>route.body as any).find(body=>body?.artifact?.sha256===work.artifact.sha256&&typeof body.content==='string').content.trim();
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});w.admittedAt=${at};w.instructions=[{text:'지시',at:${at+60000}}];w.verdict.checkedAt=${at+120000};w.criteria.description='원문 <img src=x>';w.verdict.predicates=[{checkedAt:${at+120000},criterion:'원문 <img src=x>',passed:true,quote:${JSON.stringify(quote)},reason:'일치 <b>그대로</b>'},{criterion:'원문 <img src=x>',passed:false,quote:${JSON.stringify(quote)},reason:'누락'}];w.verdict.evidence.push({kind:'provider-review',detail:JSON.stringify({checks:w.verdict.predicates}),source:'fixture'});renderMission()}`,app.context);
 const text=()=>nodes().find(n=>hasClass(n,'room-detail'))!.textContent;
 assert.match(text(),/원문 <img src=x>[\s\S]*맞음[\s\S]*일치 <b>그대로<\/b>/);assert.match(text(),/원문 <img src=x>[\s\S]*아님[\s\S]*누락/);
 const time=(stamp:number)=>runInContext('chatTime('+stamp+')',app.context);
 assert.ok(text().includes(time(at)));assert.ok(text().includes(time(at+120000)));
 const observed=nodes().filter(n=>hasClass(n,'room-field')&&n.textContent.includes('일치 <b>그대로</b>'));assert.equal(observed.length,2);assert.ok(observed.every(n=>n.children.some(child=>hasClass(child,'room-field-note')&&child.textContent===time(at+120000))));
 assert.ok(nodes().find(n=>hasClass(n,'room-flow'))!.children.some(n=>n.children[0]?.textContent===time(at+60000)));
 assert.equal(nodes().filter(n=>n.tagName==='IMG').length,0);assert.doesNotMatch(text(),/"checks"/);assert.ok(text().includes(work.verdict.evidence[0].detail));
 runInContext(`snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)}).verdict.artifactSha256='old';renderMission()`,app.context);
 assert.doesNotMatch(text(),/일치 <b>|아님누락/);
});


test('pending rooms omit the generic check caption while failed and unknown evidence stays visible',async()=>{
 const pending=await scene('B22-room-steps'),summary=pending.nodes().find(n=>n.id==='work-room-check-'+pending.work.id)!;
 assert.doesNotMatch(summary.textContent,/요청한 결과와 근거 확인/);
 assert.equal(pending.nodes().find(n=>hasClass(n,'room-progress')),undefined);
 for(const screen of ['B7-fail','B7-unknown']){
  const current=await scene(screen),check=current.nodes().find(n=>n.id==='work-room-check-'+current.work.id)!;
  assert.ok(check.children.find(n=>hasClass(n,'room-check-detail'))!.textContent.length>0);
 }
});

test('pending completed production shows check waiting and an elapsed duration even when the run has an end time',async()=>{
 const {app,nodes,work}=await scene('B22-room-steps'),at=Date.UTC(2026,10,5,1,30);
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});w.execution='settled';w.acceptance='pending';w.runtimeRun={ownership:{startedAt:${at}}};w.endedAt=${at+22*60000};renderMission()}`,app.context);
 const status=nodes().find(n=>hasClass(n,'room-status'))!;
 assert.equal(status.children[1]!.textContent,'확인 대기');assert.equal(status.children.find(n=>n.tagName==='TIME')?.textContent,'22분');
});


test('room step roles already expressed by titles disappear from participants and observed counts reach the chat card',async()=>{
 const {app,nodes,work}=await scene('B22-room-steps');
 assert.deepEqual(nodes().find(n=>hasClass(n,'room-people'))!.children.map(n=>n.children.at(-1)?.textContent??n.textContent),['주노','확인']);
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});w.tasks.find(t=>t.step&&t.step.title==='읽기').progress={done:4,total:11,at:Date.now()};renderMission();renderChat()}`,app.context);
 const card=app.all().find(n=>n.className==='chat-card'&&n.textContent.includes(work.title))!;
 assert.match(descendants(card).find(n=>hasClass(n,'chat-steps'))!.textContent,/읽기 4\/11.*확인 0\/1/);
 assert.equal(nodes().find(n=>hasClass(n,'room-worker-results')),undefined,'progress without an instruction does not create a transcript');
});


test('all settled workers await the independent check while the Work stays active and its elapsed clock keeps running',async()=>{
 const {app,nodes,work}=await scene('B22-room-steps');
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});for(const t of w.tasks.filter(t=>t.step))t.status='settled';w.execution='active';w.runtimeRun={ownership:{startedAt:Date.now()-22*60000}};delete w.endedAt;renderMission()}`,app.context);
 const status=nodes().find(n=>hasClass(n,'room-status'))!;
 assert.equal(status.children[1]!.textContent,'확인 대기');assert.equal(status.children.find(n=>n.tagName==='TIME')?.textContent,'22분');
 assert.equal(runInContext('snapshot.value.works.find(w=>w.id==='+JSON.stringify(work.id)+').execution',app.context),'active');
});

test('observed coding-step cards omit duplicate role chips and keep actual step counts',async()=>{
 const {app}=await scene('B22-room-steps'),card=app.all().find(n=>hasClass(n,'chat-card'))!;
 assert.ok(descendants(card).find(n=>hasClass(n,'chat-chips'))!.hidden);
 assert.match(descendants(card).find(n=>hasClass(n,'chat-steps'))!.textContent,/읽기 4\/11.*확인 0\/1/);
});

test('the sidebar and pane agree when all producing steps await the independent check',async()=>{
 const {app,work}=await scene('B18-room-b'),line=app.all().find(n=>n.id==='side-line-intake/'+work.id)!;
 assert.equal(descendants(line).find(n=>n.attributes.get('role')==='status')!.textContent,'확인 대기');
});

test('conversation table summaries retain authoritative list facts across unrelated pane revisions and clear stale fallbacks',async()=>{
 const {app,work,fixture}=await scene('B18-room-b'),summary=(fixture.routes['/assistant/works']!.body as any).works.find((w:any)=>w.workId===work.id),table=JSON.stringify({format:'massion-table/v1',caption:'가격',columns:['요금'],rows:[['9,900원']]});
 const card=()=>runInContext('chatCard('+JSON.stringify({id:summary.turnId,work:summary})+')',app.context) as Node;
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});w.tasks.find(t=>t.step?.title==='표 만들기').result=${JSON.stringify(table)}}`,app.context);
 assert.match(card().textContent,/표 1개 · 확인 대기/);
 runInContext('snapshot.revision++',app.context);assert.match(card().textContent,/표 1개 ·/);
 summary.missionRevision+=2;delete summary.resultFacts;delete summary.tableCount;assert.doesNotMatch(card().textContent,/표 1개 ·/);
});

test('skipped steps use the skip glyph and carry no time',async()=>{
 const measure=async(screen:string)=>{
  const {app,nodes,work}=await scene(screen);
  const task=(work.tasks as any[]).find(t=>t.step&&t.step.skipReason);
  assert.ok(task,screen+' needs a skipped task');
  runInContext(`const w=snapshot.value.works.find(x=>x.id===${JSON.stringify(work.id)});const t=(w.tasks.find(x=>x.step&&x.step.skipReason)||w.tasks[0]);t.startedAt=1700000000000;t.endedAt=1700000060000;renderMission()`,app.context);
  const row=nodes().find(n=>hasClass(n,'room-step')&&hasClass(n,'skipped'))!;
  assert.ok(row.children.some(n=>hasClass(n,'room-marker')&&hasClass(n,'skipped')));
  assert.equal(row.children.find(n=>n.tagName==='TIME')?.textContent??'','');
  assert.ok(row.textContent.includes('건너뜀'));
 };
 await measure('B7-churn');
 await measure('B18-room-b');
});

test('room attribution uses named product members and omits identities without a display source',async()=>{
 const {app,nodes,work}=await scene('B18-room-b'),strip=()=>nodes().find(n=>hasClass(n,'room-models'))!;
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});for(const a of w.assignments){a.model.model='provider-internal/route-42';a.model.evidenceClass='real-provider'}renderMission()}`,app.context);
 assert.ok(strip().children.some(n=>n.children.some(child=>child.tagName==='STRONG'&&child.textContent==='퀼')));
 assert.doesNotMatch(strip().textContent,/provider-internal|route-42|bounded-fixture|확인한 쪽/);
 runInContext(`{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)});delete w.assistantSource.memberId;for(const row of shellWorks)if(row.workId===w.id)row.memberId=null;renderMission()}`,app.context);
 assert.equal(strip().children.length,1);assert.equal(strip().children[0]!.children[1]!.className,'room-connection');
});
