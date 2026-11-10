import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {createMission} from '../src/domain.ts';
import {validateMissionLineage} from '../src/backup-lineage.ts';
import {roomTelemetryWork} from '../scripts/ui-contracts/room-telemetry-fixtures.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
test('pricing producer settles six explicit controlled rows and the pane renders those exact values',async()=>{
 const mission=createMission({id:'intake',purpose:'Controlled fixture prices',scope:'local',constraints:[],criteria:{version:1,description:'Controlled prices',oracle:'fixture/v1'}},{id:'local-owner',roles:['owner']});
 const {work}=roomTelemetryWork(mission,'pricing'),task=work.tasks.find(t=>t.step?.title==='표 만들기')!;
 const {parseTableResult}=await import('../src/table-results.ts'),table=parseTableResult(task.result!);
 assert.equal(task.status,'settled');assert.ok(table);assert.deepEqual(table.columns,['회사','요금제','월 요금','출처']);
 assert.deepEqual(table.rows,[['A사','기본','9,900원','통제 예시'],['A사','팀','19,900원','통제 예시'],['B사','개인','8,000원','통제 예시'],['B사','팀','19,000원','통제 예시'],['B사','기업','45,000원','통제 예시'],['C사','연간 ÷ 12','12,500원','통제 예시']]);
 assert.equal(work.effects.filter(e=>e.taskId===task.id).length,1);assert.equal(work.acceptance,'pending');assert.equal(work.record,undefined);assert.equal(work.artifact,undefined);
 validateMissionLineage({...mission,works:[work]});
 const app=harness(()=>reply({},503));await settle();const node=runInContext('workWorkerMessages('+JSON.stringify(work)+',"퀼")',app.context) as Node,nodes=descendants(node),rendered=nodes.find(n=>n.tagName==='TABLE')!;
 assert.ok(rendered);assert.equal(descendants(rendered).filter(n=>n.tagName==='TD').length,24);assert.deepEqual(descendants(rendered).filter(n=>n.tagName==='TD').map(n=>n.textContent),table.rows.flat());
 assert.equal(nodes.some(n=>n.tagName==='A'),false);assert.ok(node.textContent.includes('6'));
});
