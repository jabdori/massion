import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {copy} from '../src/ui-copy.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';

const decision={id:'connect:github',at:1793851920000,title:'GitHub',question:'Connect GitHub?',rows:[['Read','Repositories']],action:copy('conversation.button.12'),state:'open',line:'GitHub connected',remove:'app-github',connection:{appId:'app-github',slot:'github-token',label:'GitHub token',connected:false}};
test('connection copy uses the approved app placeholder',()=>{
 assert.equal(copy('ui.apps.connect-question',{app:'GitHub'}),'GitHub 앱을 연결할까요?');
 assert.equal(copy('ui.apps.connected',{app:'GitHub'}),'GitHub 앱 연결됨');
});
function fixture(){
 const state={feed:'feed:a',decisions:[structuredClone(decision)] as any[],posts:[] as {path:string;body:any;headers:any}[],status:'committed',fail:false,hold:null as Promise<void>|null,readHold:null as Promise<void>|null};
 const view=()=>({feedId:state.feed,cursor:1,head:1,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],decisions:structuredClone(state.decisions),members:[{id:'member:b',name:'Other'}]});
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){
   state.posts.push({path,body:JSON.parse(options.body),headers:options.headers});
   if(state.hold)await state.hold;
   if(path==='/assistant/apps/connect'){
    if(state.fail)throw new Error('Transport unavailable');
    if(['committed','replayed'].includes(state.status))state.decisions=[{...decision,state:'done',connection:{...decision.connection,connected:true}}];
    return reply({status:state.status},state.status==='conflict'?409:200);
   }
   if(path==='/assistant/decisions')state.decisions=[{...decision,state:JSON.parse(options.body).answer==='later'?'later':'open'}];
   return reply({status:'committed'});
  }
  if(path.startsWith('/assistant/conversation')){const body=view();if(state.readHold)await state.readHold;return reply({...body,...(path.includes('member=')?{member:{id:'member:b',name:'Other'},decisions:[]}: {})});}
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[]});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:1,snapshot:null});
  return reply({},503);
 });
 return {app,state};
}
const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
const button=(node:Node,label:string):Node|undefined=>node.children.flatMap(function all(n:Node):Node[]{return [n,...n.children.flatMap(all)];}).find(n=>n.tagName==='BUTTON'&&n.textContent===label);
async function open(app:ReturnType<typeof harness>){await button(find(app,'chat-decision-connect:github'),copy('conversation.button.12'))!.fire('click');await settle();}

test('connection asks use the existing card and open a separate host password panel without posting',async()=>{
 const {app,state}=fixture();await settle();await open(app);
 assert.equal(app.node('chat-input').attributes.get('aria-label'),copy('ui.message',{member:'하나'}));
 assert.equal(app.node('app-connect-panel').hidden,false);assert.equal(app.node('work-pane').hidden,true);
 assert.equal(app.node('app-connect-token').type,'password');assert.equal(app.node('app-connect-token').attributes.get('autocomplete'),'off');
 assert.equal(app.node('app-connect-token').attributes.get('aria-label'),copy('pane.textbox.01',{work_title:'GitHub'}));
 assert.equal(find(app,'chat-decision-connect:github').className,'chat-decision');assert.equal(state.posts.length,0);
 app.node('app-connect-token').value='sentinel-private-token';await app.node('app-connect-cancel').fire('click');
 assert.equal(app.node('app-connect-token').value,'');assert.equal(app.node('app-connect-panel').hidden,true);assert.equal(state.posts.length,0);
});

test('submit clears synchronously, sends only the token command once, and reads the committed line and remove action',async()=>{
 const {app,state}=fixture();await settle();await open(app);
 let release!:()=>void;state.hold=new Promise<void>(resolve=>release=resolve);
 app.node('app-connect-token').value='sentinel-private-token';const submitting=app.node('app-connect-form').fire('submit');
 assert.equal(app.node('app-connect-token').value,'');await app.node('app-connect-form').fire('submit');
 await settle();assert.equal(state.posts.length,1);assert.equal(state.posts[0]!.path,'/assistant/apps/connect');
 assert.deepEqual(Object.keys(state.posts[0]!.body).sort(),['commandId','decisionId','token']);assert.equal(state.posts[0]!.body.token,'sentinel-private-token');
 assert.equal(state.posts[0]!.body.decisionId,decision.id);assert.equal(state.posts[0]!.headers['X-Massion-Feed'],'feed:a');
 assert.ok(![...app.storage.values()].some(value=>value.includes('sentinel-private-token')));
 release();await submitting;await settle();assert.equal(app.node('app-connect-panel').hidden,true);
 const line=find(app,'chat-system-'+decision.id);assert.ok(line.textContent.includes(decision.line));assert.ok(button(line,copy('conversation.link.24')));
});

test('later and ask again use existing decision commands, including mail without a connection',async()=>{
 const {app,state}=fixture();state.decisions=[{...decision,title:'Mail',connection:{...decision.connection,appId:'mail',label:'Mail'}}];await settle();
 await button(find(app,'chat-decision-'+decision.id),copy('conversation.button.04'))!.fire('click');await settle();
 assert.deepEqual(state.posts.map(p=>[p.path,p.body.answer]),[['/assistant/decisions','later']]);
 await button(find(app,'chat-system-'+decision.id),copy('conversation.button.06'))!.fire('click');await settle();assert.equal(state.posts[1]!.body.answer,'ask');
});

test('unknown connection outcomes never resend after close, reopen, reread or repeated submit',async()=>{
 const {app,state}=fixture();state.status='unknown';await settle();await open(app);
 app.node('app-connect-token').value='sentinel-private-token';await app.submit('app-connect-form');
 assert.equal(app.node('app-connect-token').value,'');assert.ok(app.node('app-connect-status').textContent.includes(copy('conversation.text.01')));
 await app.node('app-connect-close').fire('click');await app.node('chat-latest').fire('click');await settle();await open(app);
 app.node('app-connect-token').value='another-token';await app.submit('app-connect-form');assert.equal(state.posts.length,1);
});

test('a transport error clears the password and never authorizes another submission',async()=>{
 const {app,state}=fixture();state.fail=true;await settle();await open(app);app.node('app-connect-token').value='fixture-token';await app.submit('app-connect-form');
 assert.equal(app.node('app-connect-token').value,'');await app.node('app-connect-close').fire('click');await open(app);app.node('app-connect-token').value='another-token';await app.submit('app-connect-form');assert.equal(state.posts.length,1);
});

test('a proven conflict reads current state and permits only a deliberate new entry',async()=>{
 const {app,state}=fixture();state.status='conflict';await settle();await open(app);app.node('app-connect-token').value='fixture-token';await app.submit('app-connect-form');
 assert.equal(app.node('app-connect-panel').hidden,true);assert.equal(state.posts.length,1);await open(app);assert.equal(app.node('app-connect-token').value,'');assert.equal(app.node('app-connect-submit').disabled,false);
});

test('a changed secret slot invalidates the open panel on reread',async()=>{
 const {app,state}=fixture();await settle();await open(app);app.node('app-connect-token').value='fixture-token';state.decisions=[{...decision,connection:{...decision.connection,slot:'replacement'}}];await app.node('chat-latest').fire('click');await settle();
 assert.equal(app.node('app-connect-panel').hidden,true);assert.equal(app.node('app-connect-token').value,'');assert.equal(state.posts.length,0);
});

test('thread switches and feed invalidation clear secrets before pending reads or writes finish',async()=>{
 const {app,state}=fixture();await settle();await open(app);app.node('app-connect-token').value='sentinel-private-token';
 runInContext("chatOpenThread('member:b')",app.context);assert.equal(app.node('app-connect-token').value,'');assert.equal(app.node('app-connect-panel').hidden,true);await settle();
 runInContext("chatOpenThread('')",app.context);await settle();await open(app);app.node('app-connect-token').value='sentinel-private-token';
 runInContext('requireReconnect()',app.context);assert.equal(app.node('app-connect-token').value,'');assert.equal(app.node('app-connect-panel').hidden,true);
 assert.equal(state.posts.length,0);
});

test('an old connection response cannot close or replace a newly opened panel',async()=>{
 const {app,state}=fixture();await settle();await open(app);let release!:()=>void;state.hold=new Promise<void>(resolve=>release=resolve);
 app.node('app-connect-token').value='sentinel-private-token';const submitting=app.node('app-connect-form').fire('submit');await settle();
 await app.node('app-connect-close').fire('click');state.decisions=[{...decision,id:'connect:second',title:'Second',connection:{...decision.connection,appId:'second',label:'Second token'}}];
 await app.node('chat-latest').fire('click');await settle();await button(find(app,'chat-decision-connect:second'),copy('conversation.button.12'))!.fire('click');
 app.node('app-connect-token').value='new-private-token';release();await submitting;await settle();
 assert.equal(app.node('app-connect-panel').hidden,false);assert.equal(app.node('app-connect-token').value,'new-private-token');assert.equal(app.node('app-connect-title').textContent,'Second');
});

test('a conversation read from before a thread switch cannot restore a connection card',async()=>{
 const {app,state}=fixture();await settle();await open(app);let release!:()=>void;state.readHold=new Promise<void>(resolve=>release=resolve);
 const reading=app.node('chat-latest').fire('click');await settle();runInContext("chatOpenThread('member:b')",app.context);state.readHold=null;release();await reading;await settle();
 assert.equal(app.node('app-connect-panel').hidden,true);assert.ok(!app.node('chat-log').textContent.includes(decision.question));
});

test('malformed connection metadata is refused without changing ordinary decision cards',async()=>{
 const {app,state}=fixture();state.decisions=[{...decision,connection:{...decision.connection,connected:'false'}},{...decision,id:'ordinary',connection:undefined}];await settle();
 assert.equal(app.all().find(n=>n.id==='chat-decision-'+decision.id),undefined);assert.ok(find(app,'chat-decision-ordinary'));
});

test('a replayed command response completes the connection with no second submission',async()=>{
 const {app,state}=fixture();state.status='replayed';await settle();await open(app);app.node('app-connect-token').value='fixture-token';await app.submit('app-connect-form');
 assert.equal(app.node('app-connect-panel').hidden,true);assert.ok(find(app,'chat-system-'+decision.id).textContent.includes(decision.line));assert.equal(state.posts.length,1);
});

test('a connected card keeps Remove and links to its installed app page',async()=>{
 const {app,state}=fixture();state.decisions=[{...decision,state:'done',connection:{...decision.connection,connected:true}}];await settle();
 runInContext("chatView.apps=[{id:'app-github',name:'GitHub',page:true,item:false,roomTab:null}];renderChat()",app.context);
 const line=find(app,'chat-system-'+decision.id);assert.equal(line.attributes.get('role'),'status');assert.ok(button(line,copy('conversation.link.24')));assert.ok(button(line,'GitHub'));
});

test('connection fixtures carry the contract metadata, background Work and real panel actions',async()=>{
 for(const screen of ['B24-connect','B24-connect-token','B24-connect-connected','B24-connect-later','B24-connect-mail']){
  const f=await loadFixture(screen),view=f.routes['/assistant/conversation']!.body as any;
  assert.ok(view.decisions.every((d:any)=>d.connection&&typeof d.connection.connected==='boolean'),screen);
  const works=(f.routes['/assistant/works']!.body as any).works;
  assert.deepEqual(works.map((w:any)=>w.title),['이탈 원인 조사','경쟁사 가격']);
  if(['B24-connect','B24-connect-token','B24-connect-mail'].includes(screen))assert.ok(f.steps.some(s=>s.action==='click'&&s.readySelector==='#app-connect-token'),screen);
 }
});

test('leaving the conversation clears the host token entry before another page opens',async()=>{
 const {app,state}=fixture();await settle();await open(app);app.node('app-connect-token').value='private-navigation-sentinel';
 runInContext('shellShow("results")',app.context);
 assert.equal(app.node('app-connect-token').value,'');assert.equal(app.node('app-connect-panel').hidden,true);assert.equal(state.posts.length,0);
});

test('mail connection in an empty first conversation retains More and the real connection button',async()=>{
 const {app,state}=fixture();state.decisions=[{...decision,id:'mail-connect',title:'Gmail',question:'Gmail을 연결할까요?',connection:{appId:'app-gmail',slot:'gmail-token',label:'Gmail token',connected:false}}];await settle();
 runInContext("connectionCatalog={logins:[{status:'detected'}],connections:[]};shellWorks=[];renderChat()",app.context);
 assert.equal(app.node('header-more').hidden,false);
 const card=find(app,'chat-decision-mail-connect');assert.ok(card,'host connection remains an actual decision');
 const connect=button(card,copy('conversation.button.12'));assert.ok(connect);assert.equal(connect.tagName,'BUTTON');
 await connect.fire('click');await settle();assert.equal(app.node('app-connect-panel').hidden,false);assert.equal(app.node('page-settings').hidden,true);assert.equal(state.posts.length,0);
});

test('a durable pending connection disables token entry after a fresh client read',async()=>{
 const {app,state}=fixture();state.decisions=[{...decision,connection:{...decision.connection,pending:true}}];await settle();await open(app);
 assert.equal(app.node('app-connect-token').disabled,true);assert.equal(app.node('app-connect-submit').disabled,true);
 assert.ok(app.node('app-connect-status').textContent.includes(copy('conversation.text.01')));
 app.node('app-connect-token').value='private-do-not-resend';await app.submit('app-connect-form');assert.equal(state.posts.length,0);assert.equal(app.node('app-connect-token').value,'');
});
