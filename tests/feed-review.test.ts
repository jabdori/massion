import test from 'node:test';
import assert from 'node:assert/strict';
import type {Mission} from '../src/domain.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Reply} from './support/workbench-client.ts';
const mission:Mission={id:'mission:review',version:1,purpose:'Original',scope:'review',constraints:[],criteria:{version:1,description:'Read recovery',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]};
function setup(){
 let feed='feed:a',release!:(response:Reply)=>void;
 const app=harness(async(path,options)=>{
  if(options.method==='POST')return new Promise<Reply>(resolve=>{release=resolve;});
  if(path==='/health')return reply({status:'ready'});
  if(path==='/providers')return reply({providers:[],selection:{status:'unavailable'}});
  if(path==='/connections')return reply({},503);
  if(path.startsWith('/events'))return options.headers?.['X-Massion-Feed']&&options.headers['X-Massion-Feed']!==feed?reply({},409):reply({feedId:feed,cursor:1,events:[]});
  const value={...mission,purpose:feed==='feed:a'?'Original':'Replacement'};
  if(path.startsWith('/read-state'))return reply({feedId:feed,cursor:1,snapshot:{revision:1,value}});
  return reply({revision:1,value});
 },{},undefined,{network:true,fragment:'#mission=mission%3Areview'});
 return {app,replace(){feed='feed:b';},release(result:Reply){release(result);}};
}
test('old command response before any replacement poll preserves its unknown marker',async()=>{
 const s=setup();await settle();s.app.node('work-title').value='Pending';const pending=s.app.submit('work-form');await settle();
 const marker=s.app.storage.get('massion.workbench.pending');s.replace();s.release(reply({status:'committed',revision:2,value:{...mission,purpose:'Old acknowledged state'},feedId:'feed:a'},201));await pending;
 assert.equal(s.app.storage.get('massion.workbench.pending'),marker);assert.equal(s.app.node('work-fields').disabled,true);
 assert.doesNotMatch(s.app.node('snapshot-json').textContent,/Old acknowledged state/);assert.equal(s.app.calls.filter(c=>c.options.method==='POST').length,1);
});
test('routine explicit snapshot refresh detecting another feed cannot leave writes enabled',async()=>{
 const s=setup();await settle();s.replace();s.app.node('mission-id').value=mission.id;await s.app.submit('load-form');
 assert.equal(s.app.node('sync-notice').hidden,false);assert.equal(s.app.node('work-fields').disabled,true);assert.equal(s.app.calls.filter(c=>c.options.method==='POST').length,0);
});
for(const polled of [false,true])test(`old fixture acknowledgement ${polled?'after':'before'} replacement polling retains its unknown fixture marker`,async()=>{
 const s=setup();await settle();const pending=s.app.node('run-fixture').fire('click');await settle();assert.equal(s.app.storage.get('massion.workbench.fixture-pending'),'pending');
 s.replace();if(polled)await s.app.tick();s.release(reply({missionId:mission.id,revision:2,evidenceClass:'fixture',feedId:'feed:a'},201));await pending;await settle();
 assert.equal(s.app.storage.get('massion.workbench.fixture-pending'),'pending');assert.equal(s.app.node('run-fixture').disabled,true);assert.equal(s.app.calls.filter(c=>c.options.method==='POST').length,1);
});
test('paginated reconnect keeps the delivered cursor until every event page is observed',async()=>{
 const events=Array.from({length:205},(_,i)=>({cursor:i+1,aggregateId:mission.id,revision:i+1,commandId:'page:'+i,events:[{type:'change-'+(i+1)}]}));
 const app=harness(async path=>{
  if(path.startsWith('/events')){const after=Number(new URL(path,'http://localhost').searchParams.get('after'));const page=events.filter(e=>e.cursor>after).slice(0,100);return reply({feedId:'feed:a',cursor:page.at(-1)?.cursor??after,events:page});}
  if(path.startsWith('/read-state'))return reply({feedId:'feed:a',cursor:205,snapshot:{revision:205,value:mission}});
  return reply({},503);
 },{},undefined,{fragment:'#mission=mission%3Areview'});
 await settle();assert.equal(app.storage.get('massion.workbench.cursor'),'100');
 await app.tick();assert.equal(app.storage.get('massion.workbench.cursor'),'200');
 await app.tick();assert.equal(app.storage.get('massion.workbench.cursor'),'205');
 assert.match(app.node('event-list').textContent,/change 205/);
 assert.deepEqual(app.calls.filter(c=>c.path.startsWith('/events')).map(c=>Number(new URL(c.path,'http://localhost').searchParams.get('after'))),[0,100,200]);
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});
