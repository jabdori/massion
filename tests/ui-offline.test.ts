import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';

const view={feedId:'feed:a',cursor:0,head:1,segment:{number:1,revision:0,closed:false,full:false,previous:null,messages:[]},turns:[]};
test('a lost send keeps its draft and pinned identity; explicit resend replays only that message',async()=>{
 let fail=true;const bodies:any[]=[];
 const app=harness(async(path,options)=>{
  if(path==='/assistant/messages'){bodies.push(JSON.parse(options.body));if(fail)throw Error('Lost response');return reply({});}
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
  if(path==='/assistant/messages'){posts.push(JSON.parse(options.body));throw Error('Lost response');}
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
