import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';
const settings=(extra={})=>({installedVersion:'1.0.0-rc.1',notifications:true,restartRequired:false,restartStatus:'idle',update:'unknown',...extra});
function fixture(){return harness(async path=>path.startsWith('/assistant/conversation')?reply({feedId:'feed:a',cursor:1,head:1,members:[],decisions:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]}):path==='/assistant/devices'?reply({feedId:'feed:a',devices:[]}):reply({}));}
const node=(app:ReturnType<typeof fixture>,id:string)=>app.all().find(n=>n.id===id)!;
const open=async(app:ReturnType<typeof fixture>,name='general')=>{runInContext(`shellShow('settings');void settingsOpen('${name}')`,app.context);await settle();};
test('General shows installed version and persists a notification change before showing restart status',async()=>{
 const app=fixture();await settle();let state=settings(),saves=0,restarts=0;
 (app.context.window as any).massionDesktop={getSettings:async()=>state,saveNotifications:async(value:boolean)=>{saves++;state=settings({notifications:value,restartRequired:true});return state;},restart:async()=>{restarts++;return settings({restartStatus:'restarting'});}};
 await open(app);assert.match(app.node('settings-general-body').textContent,/1.0.0-rc.1/);const field=node(app,'settings-notifications');assert.equal(field.disabled,false);field.value='off';await field.fire('change');await settle();assert.equal(saves,1);
 assert.match(app.node('settings-general-body').textContent,new RegExp(copy('settings.status.01')));await node(app,'settings-restart').fire('click');await settle();assert.equal(restarts,1);
});
test('browser General keeps native facts unknown and cannot save or restart',async()=>{
 const app=fixture();await settle();await open(app);assert.equal(node(app,'settings-notifications').disabled,true);assert.equal(node(app,'settings-restart'),undefined);assert.doesNotMatch(app.node('settings-general-body').textContent,/1.0.0/);
});
test('newer native reads and database replacement fence late settings replies',async()=>{
 const app=fixture();await settle();const releases:((s:any)=>void)[]=[];(app.context.window as any).massionDesktop={getSettings:()=>new Promise(resolve=>releases.push(resolve))};
 const first=runInContext("settingsLoad('general')",app.context),second=runInContext("settingsLoad('general')",app.context);await settle();assert.equal(releases.length,2);
 releases[1]!(settings({installedVersion:'new'}));await second;releases[0]!(settings({installedVersion:'old'}));await first;assert.match(app.node('settings-general-body').textContent,/new/);assert.doesNotMatch(app.node('settings-general-body').textContent,/old/);
 const third=runInContext("settingsLoad('general')",app.context);await settle();runInContext('connectionEpoch++;settingsInvalidate()',app.context);releases[2]!(settings({installedVersion:'stale'}));await third;assert.doesNotMatch(app.node('settings-general-body').textContent,/stale/);
});
test('a lost notification save is read back on reopen without resending',async()=>{
 const app=fixture();await settle();let state=settings(),saves=0;(app.context.window as any).massionDesktop={getSettings:async()=>state,saveNotifications:async()=>{saves++;state=settings({notifications:false,restartRequired:true});throw Error('lost');}};
 await open(app);node(app,'settings-notifications').value='off';await node(app,'settings-notifications').fire('change');await settle();assert.equal(saves,1);assert.equal(node(app,'settings-notifications').disabled,true);
 await open(app);assert.equal(saves,1);assert.equal(node(app,'settings-notifications').value,'off');assert.equal(node(app,'settings-notifications').disabled,false);
});
