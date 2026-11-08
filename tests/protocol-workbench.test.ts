import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {readFile,readdir} from 'node:fs/promises';
import {harness,reply,settle} from './support/workbench-client.ts';

test('every panel uses the client port and the browser has no feed polling timer',async()=>{
 const files=(await readdir(new URL('../src/',import.meta.url))).filter(name=>name.endsWith('-panel.ts')||['workbench.ts','connection-workbench.ts','surface-shell.ts'].includes(name));
 for(const name of files)assert.doesNotMatch(await readFile(new URL('../src/'+name,import.meta.url),'utf8'),/\bfetch\(/,name);
 const app=harness(path=>reply(path.startsWith('/events')?{feedId:'feed-a',cursor:0,events:[]}:{}));await settle();assert.equal(app.intervals.length,0);assert.equal(app.streams.length,1);
});

test('push reconnect with a revision gap drains retained pages and keeps an unknown marker until its exact receipt',async()=>{
 let head=0;const events:any[]=[],pending={missionId:'absent',commandId:'unknown-command',reconcileCursor:0};let reads=0;
 const app=harness((path,options)=>{
  assert.notEqual(options.method,'POST');
  if(path.startsWith('/events')){const after=Number(new URL(path,'http://fixture').searchParams.get('after'));const page=events.filter(e=>e.cursor>after).slice(0,100);return reply({feedId:'feed-a',cursor:page.at(-1)?.cursor??after,events:page});}
  if(path.startsWith('/read-state')){reads++;return reply({feedId:'feed-a',cursor:head,snapshot:null});}
  return reply({});
 },{'massion.workbench.pending':JSON.stringify(pending)});
 await settle();assert.equal(app.storage.has('massion.workbench.pending'),true);const before=reads;
 for(let cursor=1;cursor<=205;cursor++)events.push({cursor,aggregateId:'other',revision:cursor,commandId:'write-'+cursor,events:[]});head=205;
 await app.disconnect();await app.windowEvent('online');await app.push({reason:'connected',feedId:'feed-a',cursor:205});await settle();
 assert.ok(reads>before);assert.equal(runInContext('cursor',app.context),205);assert.equal(app.storage.has('massion.workbench.pending'),true);
 events.push({cursor:206,aggregateId:'absent',revision:1,commandId:'unknown-command',events:[]});head=206;
 await app.push({reason:'revision',feedId:'feed-a',cursor:206});await settle();assert.equal(app.storage.has('massion.workbench.pending'),false);
});

test('push feed replacement at the same revision replaces authoritative state without resubmission',async()=>{
 let feed='feed-a';const mission={id:'mission',version:1,purpose:'Original',scope:'fixture',constraints:[],criteria:{version:1,description:'Read',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]};
 const app=harness((path,options)=>{
  assert.notEqual(options.method,'POST');
  if(path.startsWith('/events'))return reply({feedId:feed,cursor:1,events:[]});
  if(path.startsWith('/read-state'))return reply({feedId:feed,cursor:1,snapshot:{revision:1,value:{...mission}}});
  return reply({});
 },{},undefined,{fragment:'#mission=mission'});await settle();assert.match(app.node('snapshot-json').textContent,/Original/);
 app.node('work-title').value='Private draft';feed='feed-b';mission.purpose='Replacement';
 await app.push({reason:'reset',feedId:feed,cursor:1});await settle();assert.match(app.node('snapshot-json').textContent,/Replacement/);assert.equal(app.node('work-title').value,'Private draft');
 assert.equal(app.calls.filter(call=>call.options.method==='POST').length,0);
});

test('a push arriving during an explicit catch-up waits for that read instead of spinning',async()=>{
 let hold=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);let head=0;
 const app=harness(async path=>{
  if(path.startsWith('/events')){if(hold)await gate;return reply({feedId:'feed-a',cursor:head,events:head?[{cursor:head,aggregateId:'other',revision:head,commandId:'one',events:[]}]:[]});}
  if(path.startsWith('/read-state'))return reply({feedId:'feed-a',cursor:head,snapshot:null});return reply({});
 });await settle();hold=true;runInContext('void pollEvents()',app.context);await settle();
 // A timer must be allowed to run while the hint waits on the held query.
 const pushed=app.push({reason:'revision',feedId:'feed-a',cursor:1});setImmediate(()=>{head=1;hold=false;release();});await pushed;await settle();assert.equal(runInContext('cursor',app.context),1);
});

for(const failed of [false,true])test('late reflection '+(failed?'failure':'reply')+' cannot overwrite the latest read',async()=>{
 const pending:{resolve:(v:any)=>void;reject:(e:Error)=>void}[]=[];
 const app=harness(path=>path.includes('/reflection-trail?')?new Promise((resolve,reject)=>pending.push({resolve,reject})):reply(path.startsWith('/events')?{feedId:'feed-a',cursor:0,events:[]}:{}));await settle();
 runInContext("snapshot={revision:1,value:{id:'mission'}};feedId='feed-a'",app.context);
 const first=runInContext("readReflectionTrail('work')",app.context);await settle();const second=runInContext("readReflectionTrail('work')",app.context);await settle();
 pending[1]!.resolve(reply({result:'latest'}));await second;
 if(failed)pending[0]!.reject(Error('old error'));else pending[0]!.resolve(reply({result:'old'}));await first;
 assert.match(runInContext("reflectionTrails.get('mission\\nwork').text",app.context),/latest/);
});

test('reconnect deferred by an outstanding command resumes after its response without another feed event',async()=>{
 let revision=1,posted:any,release!:(r:any)=>void;
 const mission={id:'mission',version:1,purpose:'Original',scope:'fixture',constraints:[],criteria:{version:1,description:'Read',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]};
 const app=harness((path,options)=>{
  if(options.method==='POST'){posted=JSON.parse(options.body);revision=2;return new Promise(resolve=>release=resolve);}
  if(path.startsWith('/events')){const after=Number(new URL(path,'http://fixture').searchParams.get('after'));return reply({feedId:'feed-a',cursor:revision,events:posted&&after<2?[{cursor:2,aggregateId:'mission',revision:2,commandId:posted.commandId,events:[]}]:[]});}
  if(path.startsWith('/read-state'))return reply({feedId:'feed-a',cursor:revision,snapshot:{revision,value:mission}});return reply({});
 },{},undefined,{fragment:'#mission=mission'});await settle();app.node('work-title').value='New responsibility';
 const write=app.submit('work-form');await settle();await app.push({reason:'revision',feedId:'feed-a',cursor:2});await settle();
 await app.push({reason:'connected',feedId:'feed-a',cursor:2});assert.equal(runInContext('reconnectRequired',app.context),true);
 release(reply({status:'committed',revision:2,value:mission,feedId:'feed-a'},201));await write;await settle();
 assert.equal(runInContext('reconnectRequired',app.context),false);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,1);
});

test('a failed reconnect read retries the subscription even when no later revision arrives',async()=>{
 let fail=false;const timers:(()=>unknown)[]=[];
 const app=harness(path=>path.startsWith('/events')?reply({feedId:'feed-a',cursor:0,events:[]}):path.startsWith('/read-state')?fail?reply({},503):reply({feedId:'feed-a',cursor:0,snapshot:null}):reply({}));await settle();
 (app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>{if(ms===1000)timers.push(fn);return 1;};
 fail=true;await app.push({reason:'connected',feedId:'feed-a',cursor:0});await settle();assert.equal(runInContext('reconnectRequired',app.context),true);assert.equal(timers.length,1);
 fail=false;timers[0]!();await settle();await app.push({reason:'connected',feedId:'feed-a',cursor:0});await settle();assert.equal(runInContext('reconnectRequired',app.context),false);
});

for(const resume of ['pageshow','visible','online'])test('pagehide then '+resume+' restores one feed and delivers later revisions',async()=>{
 let cursor=0;const app=harness(path=>path.startsWith('/events')?reply({feedId:'feed-a',cursor,events:cursor?[{cursor,aggregateId:'other',revision:cursor,commandId:'write-'+cursor,events:[]}]:[]}):path.startsWith('/read-state')?reply({feedId:'feed-a',cursor,snapshot:null}):reply({}));await settle();
 const first=app.streams.at(-1);await app.windowEvent('pagehide');assert.equal(first.closed,true);
 if(resume==='visible')await app.documentEvent('visibilitychange');else await app.windowEvent(resume);
 await settle();assert.equal(app.streams.length,2);assert.equal(app.streams.at(-1).closed,false);
 await app.windowEvent('pageshow');await app.documentEvent('visibilitychange');await settle();assert.equal(app.streams.length,2,'resume events must not duplicate a connecting subscription');
 await app.push({reason:'connected',feedId:'feed-a',cursor:0});cursor=1;await app.push({reason:'revision',feedId:'feed-a',cursor:1});assert.equal(runInContext('cursor',app.context),1);
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('a terminal SSE error schedules a subscription retry after successful negotiation',async()=>{
 const timers:(()=>unknown)[]=[];const app=harness(path=>reply(path.startsWith('/events')?{feedId:'feed-a',cursor:0,events:[]}:path.startsWith('/read-state')?{feedId:'feed-a',cursor:0,snapshot:null}:{}));await settle();
 (app.context as any).setTimeout=(fn:()=>unknown,ms:number)=>{if(ms===1000)timers.push(fn);return 1;};
 await app.disconnect();assert.equal(timers.length,1);assert.equal(app.streams[0].closed,true);
 timers[0]!();await settle();assert.equal(app.streams.length,2);await app.push({reason:'connected',feedId:'feed-a',cursor:0});assert.equal(runInContext('reconnectRequired',app.context),false);
});

test('a revision arriving during an ordinary Mission read refreshes after that old read settles',async()=>{
 let revision=1,hold=false,release!:(r:any)=>void;const mission={id:'mission',version:1,purpose:'Current',scope:'fixture',constraints:[],criteria:{version:1,description:'Read',oracle:'manual-review/v1'},works:[],memories:[],growth:[],relations:[]};
 const app=harness(path=>{
  if(path.startsWith('/events')){const after=Number(new URL(path,'http://fixture').searchParams.get('after'));return reply({feedId:'feed-a',cursor:revision,events:after<revision?[{cursor:revision,aggregateId:'mission',revision,commandId:'write-'+revision,events:[]}]:[]});}
  if(path.startsWith('/read-state'))return hold?new Promise(resolve=>release=resolve):reply({feedId:'feed-a',cursor:revision,snapshot:{revision,value:mission}});return reply({});
 },{},undefined,{fragment:'#mission=mission'});await settle();hold=true;const loading=app.submit('load-form');await settle();revision=2;await app.push({reason:'revision',feedId:'feed-a',cursor:2});
 hold=false;release(reply({feedId:'feed-a',cursor:1,snapshot:{revision:1,value:mission}}));await loading;await settle();assert.equal(runInContext('snapshot.revision',app.context),2);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('a subscription created while pagehide races its handshake is closed instead of installed',async()=>{
 const app=harness(path=>reply(path.startsWith('/events')?{feedId:'feed-a',cursor:0,events:[]}:path.startsWith('/read-state')?{feedId:'feed-a',cursor:0,snapshot:null}:{}));await settle();await app.windowEvent('pagehide');
 runInContext('var originalSubscribe=protocol.subscribe,releaseSubscribe;protocol.subscribe=async(...args)=>{const stop=await originalSubscribe(...args);return new Promise(resolve=>{releaseSubscribe=()=>resolve(stop);});}',app.context);
 await app.windowEvent('pageshow');await settle();assert.equal(app.streams.length,2);await app.windowEvent('pagehide');runInContext('releaseSubscribe();protocol.subscribe=originalSubscribe',app.context);await settle();assert.equal(app.streams[1].closed,true);
 await app.windowEvent('pageshow');await settle();assert.equal(app.streams.length,3);assert.equal(app.streams[2].closed,false);
});
