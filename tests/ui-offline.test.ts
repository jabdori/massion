import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle,SharedWebLocks} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';

const view={feedId:'feed:a',cursor:0,head:1,segment:{number:1,revision:0,closed:false,full:false,previous:null,messages:[]},turns:[]};
test('a definite refusal keeps its draft and identity; explicit resend targets only that message',async()=>{
 let fail=true;const bodies:any[]=[];
 const app=harness(async(path,options)=>{
  if(path==='/assistant/messages'){bodies.push(JSON.parse(options.body));if(fail)return reply({outcome:'rejected'},503);return reply({});}
  if(path.startsWith('/assistant/conversation'))return reply(view);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:0,events:[]});
  return reply({});
 });await settle();
 app.node('chat-input').value='할인 합계';await app.node('chat-input').fire('input');await app.submit('chat-form');
 assert.equal(app.node('chat-input').value,'할인 합계');
 assert.equal(app.node('chat-status').textContent,copy('composer.status.01'));
 runInContext('reconnectRequired=false;chatConnection(false)',app.context);
 assert.equal(app.node('chat-connection').hidden,true,'a failed send does not mark a restored transport disconnected');
 const before=JSON.parse(app.storage.get('massion.workbench.chat-draft')!);assert.ok(before.target);
 await app.tick();assert.equal(bodies.length,1,'reads do not retry sends');
 fail=false;await app.node('chat-status').children.find(n=>n.tagName==='BUTTON')!.fire('click');await settle();
 assert.equal(bodies.length,2);assert.deepEqual(bodies[1],bodies[0]);
 assert.equal(app.storage.has('massion.workbench.chat-draft'),false);assert.equal(app.node('chat-input').value,'');
});

test('disconnect is a name-side status and never destroys private drafts or unlocks writes',async()=>{
 const app=harness(async(path)=>path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]}));await settle();
 app.node('chat-input').value='남겨 둔 초안';await app.node('chat-input').fire('input');
 runInContext('requireReconnect()',app.context);await settle();
 assert.equal(app.node('chat-connection').textContent,copy('header.status.01'));
 assert.equal(app.node('sync-notice').hidden,true);assert.equal(app.node('mission-fields').disabled,true);
 assert.equal(app.node('chat-input').value,'남겨 둔 초안');
 runInContext('chatConnection(false)',app.context);
 assert.equal(app.node('chat-connection').hidden,false,'a successful chat read cannot clear the host reconnect gate');
});

for(const change of ['thread','edit'])test('a failed-send action cannot submit a different draft after '+change,async()=>{
 const posts:any[]=[];
 const app=harness(async(path,options)=>{
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));return reply({outcome:'rejected'},503);}
  if(path.startsWith('/assistant/conversation'))return reply(view);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  return reply({feedId:'feed:a',cursor:0,events:[]});
 });await settle();
 app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');await app.submit('chat-form');
 const stale=app.node('chat-status').children.find(n=>n.tagName==='BUTTON')!;
 if(change==='thread'){
  app.storage.set('massion.workbench.chat-draft:member:b',JSON.stringify({text:'다른 대화의 초안',commandId:'',target:null}));
  runInContext("chatOpenThread('member:b','다른 구성원')",app.context);await settle();
 }else{app.node('chat-input').value='새로 편집한 초안';await app.node('chat-input').fire('input');}
 assert.equal(app.node('chat-status').hidden,true);
 await stale.fire('click');await settle();assert.equal(posts.length,1);
 assert.equal(app.node('chat-input').value,change==='thread'?'다른 대화의 초안':'새로 편집한 초안');
});

test('editing during a lost send cannot attach its resend action to a replacement command',async()=>{
 let rejectPost!:()=>void;const held=new Promise<never>((_resolve,reject)=>{rejectPost=()=>reject(Error('Lost response'));}),posts:any[]=[];
 const app=harness(async(path,options)=>{
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));return held;}
  if(path.startsWith('/assistant/conversation'))return reply(view);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  return reply({feedId:'feed:a',cursor:0,events:[]});
 });await settle();
 app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');await app.submit('chat-form');
 app.node('chat-input').value='편집 중';await app.node('chat-input').fire('input');
 app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');
 rejectPost();await settle();
 assert.equal(app.node('chat-status').children.some(n=>n.tagName==='BUTTON'),false);
 assert.equal(app.node('chat-status').textContent,copy('conversation.text.01'));
 assert.equal(app.node('chat-input').value,'원래 요청');assert.equal(posts.length,1);
});


for(const outcome of ['lost-response','http-500','http-503','explicit-unknown'])test('uncertain '+outcome+' stays unknown and cannot be resubmitted after reload',async()=>{
 const posts:any[]=[];
 const handler=async(path:string,options:any)=>{
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));if(outcome==='lost-response')throw Error('Committed response lost');return reply(outcome==='explicit-unknown'?{outcome:'unknown',error:'answer_in_progress: outcome was not established'}:{error:'Unclassified failure'},outcome==='http-500'?500:503);}
  if(path.startsWith('/assistant/conversation'))return reply(view);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  return reply({feedId:'feed:a',cursor:0,events:[]});
 };
 const app=harness(handler);await settle();app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');await app.submit('chat-form');
 assert.equal(app.node('chat-status').textContent,copy('conversation.text.01'));
 assert.equal(app.node('chat-status').children.some(n=>n.tagName==='BUTTON'),false);
 assert.equal(app.node('chat-send').disabled,true);
 const draft=JSON.parse(app.storage.get('massion.workbench.chat-draft')!);assert.equal(draft.delivery,'unknown');assert.ok(draft.target);
 await app.submit('chat-form');assert.equal(posts.length,1);
 const restored=harness(handler,Object.fromEntries(app.storage));await settle();
 assert.equal(restored.node('chat-status').textContent,copy('conversation.text.01'));assert.equal(restored.node('chat-send').disabled,true);
 await restored.submit('chat-form');await restored.tick();assert.equal(posts.length,1);assert.equal(restored.node('chat-input').value,'원래 요청');
 assert.deepEqual(JSON.parse(restored.storage.get('massion.workbench.chat-draft')!),draft);
});

test('offline before dispatch is definitely not delivered and retries only its original command ID',async()=>{
 const posts:any[]=[];const app=harness(async(path,options)=>{
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));return reply({});}
  if(path.startsWith('/assistant/conversation'))return reply(view);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  return reply({feedId:'feed:a',cursor:0,events:[]});
 });await settle();
 runInContext('navigator.onLine=false',app.context);app.node('chat-input').value='오프라인 요청';await app.node('chat-input').fire('input');await app.submit('chat-form');
 assert.equal(posts.length,0);assert.equal(app.node('chat-status').textContent,copy('composer.status.01'));
 const draft=JSON.parse(app.storage.get('massion.workbench.chat-draft')!);assert.equal(draft.delivery,'not-delivered');
 runInContext('navigator.onLine=true',app.context);await app.node('chat-status').children.find(n=>n.tagName==='BUTTON')!.fire('click');await settle();
 assert.equal(posts.length,1);assert.equal(posts[0].commandId,draft.commandId);assert.equal(posts[0].text,draft.text);assert.equal(app.node('chat-input').value,'');
});


test('legacy saved command identity is conservatively unknown after reload',async()=>{
 const saved={text:'원래 요청',commandId:'old-command',target:{segment:1,expectedRevision:0}},posts:any[]=[];
 const app=harness(async(path,options)=>{if(path==='/assistant/messages')posts.push(options);return path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]});},{'massion.workbench.chat-draft':JSON.stringify(saved)});await settle();
 assert.equal(app.node('chat-status').textContent,copy('conversation.text.01'));await app.submit('chat-form');assert.equal(posts.length,0);
 assert.deepEqual(JSON.parse(app.storage.get('massion.workbench.chat-draft')!),saved);
});

test('failure to persist uncertain dispatch intent prevents the message POST',async()=>{
 const posts:any[]=[];const app=harness(async(path,options)=>{if(path==='/assistant/messages')posts.push(options);return path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]});});await settle();
 app.node('chat-input').value='저장 필요한 요청';await app.node('chat-input').fire('input');
 app.storage.set('massion.workbench.chat-draft',JSON.stringify({text:'저장 필요한 요청',commandId:'original-id',target:null,delivery:'not-delivered'}));
 runInContext('storage.set=()=>false',app.context);
 await app.submit('chat-form');assert.equal(posts.length,0);assert.equal(app.node('chat-status').textContent,copy('ui.recovery-blocked'));assert.equal(app.node('chat-input').value,'저장 필요한 요청');
});


test('a held conversation read cannot resend a command another tab has marked unknown',async()=>{
 const key='massion.workbench.chat-draft',storage=new Map([[key,JSON.stringify({text:'공유 초안',commandId:'original-id',target:null,delivery:'not-delivered'})]]),locks=new SharedWebLocks(),posts:any[]=[];
 let hold=true,release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});
 const handler=(first:boolean)=>async(path:string,options:any)=>{
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));throw Error('Lost response');}
  if(path.startsWith('/assistant/conversation')){if(first&&hold)await waiting;return reply(view);}
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:[]});
  return reply({feedId:'feed:a',cursor:0,events:[]});
 };
 const first=harness(handler(true),{},undefined,{storage,locks,identity:'first'}),second=harness(handler(false),{},undefined,{storage,locks,identity:'second'});await settle();
 try{await first.submit('chat-form');await second.submit('chat-form');assert.equal(posts.length,1);assert.equal(JSON.parse(storage.get(key)!).delivery,'unknown');}
 finally{hold=false;release();await settle();}
 assert.equal(posts.length,1,'the read resumed after another tab committed uncertain dispatch intent');
 assert.equal(first.node('chat-status').textContent,copy('conversation.text.01'));assert.equal(first.node('chat-send').disabled,true);
 assert.equal(JSON.parse(storage.get(key)!).commandId,'original-id');
});

test('draft edits wait for the shared dispatch-intent lock',async()=>{
 const key='massion.workbench.chat-draft',unknown=JSON.stringify({text:'원래 요청',commandId:'original-id',target:{segment:1,expectedRevision:0},delivery:'unknown'}),storage=new Map([[key,unknown]]),locks=new SharedWebLocks();
 const app=harness(async(path)=>path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]}),{},undefined,{storage,locks});await settle();
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),held=locks.request('massion.workbench.recovery',{ifAvailable:false},async()=>gate);await settle();
 app.node('chat-input').value='새로운 초안';const edit=app.node('chat-input').fire('input');await settle();
 try{assert.equal(storage.get(key),unknown,'a concurrent edit cannot overwrite intent while its lock is held');}
 finally{release();await held;await edit;}
 assert.equal(JSON.parse(storage.get(key)!).text,'새로운 초안');assert.equal(JSON.parse(storage.get(key)!).commandId,'');
});

test('queued edits keep their original conversation and latest text across thread switches',async()=>{
 const key='massion.workbench.chat-draft',storage=new Map([[key,JSON.stringify({text:'원래 요청',commandId:'original-id',target:{segment:1,expectedRevision:0},delivery:'unknown'})]]),locks=new SharedWebLocks();
 const app=harness(async(path)=>path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]}),{},undefined,{storage,locks});await settle();
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),held=locks.request('massion.workbench.recovery',{ifAvailable:false},async()=>gate);await settle();const edits:Promise<void>[]=[];
 try{
  app.node('chat-input').value='첫 편집';edits.push(app.node('chat-input').fire('input'));
  app.node('chat-input').value='마지막 편집';edits.push(app.node('chat-input').fire('input'));
  runInContext("chatOpenThread('member:b','B')",app.context);app.node('chat-input').value='다른 대화 초안';edits.push(app.node('chat-input').fire('input'));
  runInContext("chatOpenThread('')",app.context);assert.equal(app.node('chat-input').value,'마지막 편집','queued edits survive returning before their write lock is released');
 }finally{release();await held;await Promise.all(edits);await settle();}
 assert.equal(JSON.parse(storage.get(key)!).text,'마지막 편집');
 runInContext("chatOpenThread('member:b','B')",app.context);assert.equal(app.node('chat-input').value,'다른 대화 초안');
 assert.equal(JSON.parse(storage.get(key+':member:b')!).text,'다른 대화 초안');assert.equal(app.calls.some(c=>c.path==='/assistant/messages'),false);
});

test('a successfully persisted and sent pending edit is not restored as a fresh draft',async()=>{
 const posts:any[]=[];const app=harness(async(path,options)=>{if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));return reply({});}return path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]});});await settle();
 runInContext('const savedSet=storage.set;storage.set=()=>false',app.context);app.node('chat-input').value='전송할 초안';await app.node('chat-input').fire('input');
 runInContext('storage.set=savedSet',app.context);await app.submit('chat-form');assert.equal(posts.length,1);assert.equal(app.node('chat-input').value,'');
 runInContext("chatOpenThread('member:b','B');chatOpenThread('')",app.context);await settle();
 assert.equal(app.node('chat-input').value,'');await app.submit('chat-form');assert.equal(posts.length,1);
});

test('a committed response preserves a newer unsaved edit even when its text matches the sent draft',async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>{release=r;});const app=harness(async(path)=>{if(path==='/assistant/messages'){await held;return reply({});}return path.startsWith('/assistant/conversation')?reply(view):path==='/assistant/works'?reply({feedId:'feed:a',works:[]}):reply({feedId:'feed:a',cursor:0,events:[]});});await settle();
 app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');await app.submit('chat-form');
 runInContext('storage.set=()=>false',app.context);app.node('chat-input').value='다른 편집';await app.node('chat-input').fire('input');app.node('chat-input').value='원래 요청';await app.node('chat-input').fire('input');release();await settle();
 assert.equal(app.node('chat-input').value,'원래 요청');runInContext("chatOpenThread('member:b','B');chatOpenThread('')",app.context);await settle();assert.equal(app.node('chat-input').value,'원래 요청');
});
