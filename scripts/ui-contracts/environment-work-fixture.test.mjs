import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadFixture} from './fixture-host.ts';
import {environmentWorkFixture,ENVIRONMENT_WORK_SCREENS} from './environment-work-fixture.ts';

const data=JSON.parse(await readFile(new URL('./environment-work.generated.json',import.meta.url),'utf8'));

test('cached native Work replies anchor their cards and preserve member identity across every route',async()=>{
 for(const screen of ENVIRONMENT_WORK_SCREENS){
  const fixture=await loadFixture(screen),selected=screen==='B15'?data.form:data,checkpoint=selected.checkpoints[screen==='B4'?'payment':screen==='B15'?'submit':screen.endsWith('-done')?'accepted':'submitted'];
  const actualReply=checkpoint.chat.segment.messages.find(m=>m.role==='representative'&&m.turnId===selected.turnId);assert.ok(actualReply,screen);
  for(const path of ['/assistant/conversation','/assistant/conversation?segment=1','/assistant/conversation?member='+selected.memberId,'/assistant/conversation?segment=1&member='+selected.memberId]){
   const view=fixture.routes[path].body,reply=view.segment.messages.filter(m=>m.id===actualReply.id),turn=view.turns.filter(t=>t.id===selected.turnId);
   assert.deepEqual(reply,[actualReply],path);assert.equal(turn.length,1,path);assert.equal(turn[0].work.workId,selected.workId,path);
   assert.equal(view.members.find(m=>m.id===selected.memberId).name,'퀼',path);
  }
  const list=fixture.routes['/assistant/works'].body;assert.equal(list.works.find(w=>w.workId===selected.workId).turnId,selected.turnId,screen);assert.equal(list.works.find(w=>w.workId===selected.workId).segment,checkpoint.chat.segment.number,screen);assert.equal(list.members[0].id,selected.memberId,screen);assert.equal(list.members[0].name,'퀼',screen);
  assert.equal(new Set(list.members.map(m=>m.id)).size,list.members.length,screen);
  assert.ok(Math.abs(fixture.now-1793855520000)<60000,screen);
  for(const task of checkpoint.snapshot.value.works[0].tasks)if(task.result)assert.doesNotMatch(task.result,/Answer original|Check evidence|Worker evidence/,screen);
 }
});

test('overlay replaces only the selected Work and keeps background decisions, ordering and alternate member routes',async()=>{
 for(const screen of ENVIRONMENT_WORK_SCREENS){
  const raw=await loadFixture(screen,['cached-source']),source=JSON.parse(JSON.stringify(raw).replaceAll('member-quill','different-template-member-id')),before=structuredClone(source),selected=screen==='B15'?data.form:data;
  const result=environmentWorkFixture(source,data),checkpoint=selected.checkpoints[screen==='B4'?'payment':screen==='B15'?'submit':screen.endsWith('-done')?'accepted':'submitted'],target=checkpoint.snapshot.value.works[0],normalize=value=>JSON.parse(JSON.stringify(value).replaceAll('different-template-member-id',selected.memberId));
  assert.deepEqual(source,before,screen);
  const previous=source.routes['/read-state?mission=intake'].body.snapshot.value.works,after=result.routes['/read-state?mission=intake'].body.snapshot.value.works;
  assert.deepEqual(after.filter(w=>w.id!==selected.workId),normalize(previous.filter(w=>w.title!==target.title)),screen);
  const old=previous.find(w=>w.title===target.title),removed=new Set([old?.id,screen==='B15'?'library':'toner']);
  for(const decision of source.routes['/assistant/conversation'].body.decisions.filter(d=>!removed.has((d.environment??d.effect)?.workId)&&!(screen==='B15'&&d.id==='library')))assert.ok(result.routes['/assistant/conversation'].body.decisions.some(d=>d.id===decision.id),decision.id);
  assert.deepEqual(result.routes['/assistant/works'].body.members.map(m=>m.name),source.routes['/assistant/conversation'].body.members.map(m=>m.name),screen);
  for(const [path,response] of Object.entries(source.routes))if(path.includes('member=member-juno'))assert.deepEqual(result.routes[path],normalize(response),path);
  for(const path of Object.keys(result.routes))if(path.startsWith('/missions/intake/'))assert.ok(!removed.has(new URL(path,'http://fixture').searchParams.get('work')),path);
 }
});
