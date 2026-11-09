import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
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
 const work=(fixture.routes['/missions/intake']!.body as any).value.works[0],turn=(fixture.routes['/assistant/works']!.body as any).works.find((w:any)=>w.workId===work.id);
 await runInContext('shellOpenWork('+JSON.stringify(turn.turnId)+')',app.context);await settle();
 const card=()=>app.all().find(n=>n.id==='work-card-'+work.id)!,nodes=()=>descendants(card());
 return {app,work,posted,card,nodes};
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
  const count=nodes().find(n=>hasClass(n,'room-progress'))!.textContent.split('/').map(Number);assert.ok(count[0]!<count[1]!, 'failed verification is not a fully completed procedure');
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
 assert.equal(nodes().find(n=>hasClass(n,'room-progress'))!.textContent,'3/4');
});

test('a rejected Stop reports the revision conflict while the Work stays running',async()=>{
 const {app,nodes,posted,work}=await scene('B7',409),stop=nodes().find(n=>n.id==='work-room-stop-'+work.id)!;
 await stop.fire('click');await settle();
 assert.equal(posted.length,1);assert.equal(runInContext('snapshot.value.works.find(w=>w.id==='+JSON.stringify(work.id)+').execution',app.context),'active');
 assert.match(app.node('status').className,/warning/);assert.match(app.node('status').textContent,/충돌/);assert.equal(app.node('page-status').hidden,true);assert.equal(runInContext('unknownOperation',app.context),null);
});

 test('B22 room steps use the B7 pane and never embed the legacy Work inspector',async()=>{
 const {nodes,card}=await scene('B22-room-steps');
 assert.deepEqual(nodes().find(n=>hasClass(n,'room-steps'))!.children.map(n=>n.children[1]!.textContent),['읽기','테스트 돌리기','확인','기록']);
 assert.ok(nodes().some(n=>n.id==='work-room-stop-pr84'));
 assert.ok(!nodes().some(n=>n.id==='work-evidence-summary-pr84'));
 assert.doesNotMatch(card().textContent,/실행: active|검증: pending|시도 \/ 예산|측정 사용량|기준·기억·근거|선택한 원문 문서|원래 조직 역할/);
 });

for(const [screen,panel] of [['B7-done','record-text-summary'],['B7-fail','rejected-text-summary']])test(screen+' keeps its deliberate result reader without the legacy state dump',async()=>{
 const {nodes,work}=await scene(screen!);assert.ok(nodes().some(n=>n.id==='work-'+panel+'-'+work.id));assert.ok(!nodes().some(n=>n.id==='work-evidence-summary-'+work.id));
});
