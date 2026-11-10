import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';

const member={id:'river',name:'리버',look:{shape:'round',color:'agent-1'},modelGroup:'default',workCount:0,scheduleCount:1,builtinSkills:[{id:'read',name:'출처 찾아 읽기',version:1,hash:'a'.repeat(64),builtin:{id:'read-sources',version:1}}],memories:[{id:'remember',version:1,name:'요약 방식',content:'짧게 정리',missionId:'old-intake',missionRevision:4,sourceSegment:2,sourceTurnId:'original-turn',at:1}],schedules:[{id:'weekly',title:'주간 확인',active:true,nextAt:Date.now()+86400000}]};
function fixture(){
 const posted:{path:string;body:any}[]=[],reads:string[]=[];let respond:(value:any)=>void=()=>{};
 const app=harness(async(path,options)=>{
  reads.push(path);if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return new Promise(resolve=>respond=resolve);}
  if(path==='/assistant/members')return reply({feedId:'feed:a',members:[structuredClone(member)],archived:[]});
  if(path==='/assistant/skills')return reply({skills:[],improvements:[]});if(path==='/assistant/apps')return reply({apps:[]});if(path==='/connections')return reply({modelGroups:[],connections:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:3,members:[member],segment:{number:3,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});return reply({});
 });
 const open=async()=>{await settle();await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-members').fire('click');await settle();await app.all().find(n=>n.id==='settings-member-river')!.fire('click');await settle();};
 return {app,posted,reads,open,respond:(v:any)=>respond(v),node:(id:string)=>app.all().find(n=>n.id===id)!};
}

test('member page renders builtin provenance, exact saved memory and member-bound schedule controls',async()=>{
 const f=fixture();await f.open();const text=f.app.node('settings-members-body').textContent;
 assert.match(text,/출처 찾아 읽기/);assert.ok(text.includes(copy('settings.text.01')));assert.match(text,/요약 방식.*짧게 정리.*리버과의 대화/s);
 assert.ok(f.node('member-schedule-weekly'));assert.equal(f.node('member-schedule-weekly').attributes.get('aria-checked'),'true');
 await f.node('member-memory-source-remember').fire('click');await settle();assert.ok(f.reads.some(p=>p.includes('member=river')&&p.includes('segment=2')));
});

test('member memory retirement carries its original Mission revision and sends once after an unknown response',async()=>{
 const f=fixture();await f.open();const remove=f.node('member-memory-remove-remember'),first=remove.fire('click');await settle();await remove.fire('click');assert.equal(f.posted.length,1);
 assert.equal(f.posted[0]!.path,'/missions/old-intake/memory-retirement');assert.equal(f.posted[0]!.body.expectedRevision,4);assert.equal(f.posted[0]!.body.memoryId,'remember');
 f.respond(Promise.reject(Error('Lost reply')));await first;await settle();assert.equal(f.node('member-memory-remove-remember').disabled,true);
});

test('stale member controls cannot write after selection or database feed changes',async()=>{
 const f=fixture();await f.open();const toggle=f.node('member-schedule-weekly'),remove=f.node('member-memory-remove-remember');
 runInContext("settingsMember='other'",f.app.context);await toggle.fire('click');await remove.fire('click');assert.equal(f.posted.length,0);
 runInContext("settingsMember='river';chatView={...chatView,feedId:'feed:b'}",f.app.context);await toggle.fire('click');await remove.fire('click');assert.equal(f.posted.length,0);
});

test('member schedule switches send one pause and discard a late response after a newer selection',async()=>{
 const f=fixture();await f.open();const first=f.node('member-schedule-weekly').fire('click');await settle();assert.equal(f.posted.length,1);assert.equal(f.posted[0]!.body.action,'pause');assert.equal(f.posted[0]!.body.scheduleId,'weekly');
 runInContext("settingsMember='other'",f.app.context);f.respond(reply({status:'committed'}));await first;await settle();assert.equal(runInContext('settingsMember',f.app.context),'');assert.equal(f.posted.length,1);
});

test('schedule creation exposes admitted members and submits the selected immutable member ID',async()=>{
 const f=fixture();await settle();await f.app.all().find(n=>n.id==='schedule-example-price-watch')!.fire('click');await settle();
 assert.match(f.app.node('schedule-create-member').textContent,/리버/);f.app.node('schedule-create-member').value='river';f.app.node('schedule-create-request').value='Review supplied sources';
 await f.app.node('schedule-create').fire('submit');await settle();assert.equal(f.posted.length,1);assert.equal(f.posted[0]!.body.memberId,'river');assert.equal(f.posted[0]!.body.kind,'price-watch');
 f.respond(reply({status:'committed'}));await settle();
});
