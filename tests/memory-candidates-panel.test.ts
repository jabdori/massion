import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';

const member={id:'quill',name:'Quill',modelGroup:'default',look:{shape:'drop',color:'agent-1'}},turnId='assistant-turn:m:'+'a'.repeat(32);
const candidate={id:'memory-candidate',version:1,hash:'a'.repeat(64),missionId:'intake',missionRevision:1,memberId:'quill',name:'Preferred summary',content:'Use a short summary <img src=x>.',status:'proposed'};
function fixture(initial:Record<string,string>={}){
 const state={feed:'feed:a',revision:2,candidate:structuredClone(candidate),posts:[] as any[],post:undefined as undefined|(()=>Promise<any>),read:undefined as undefined|(()=>Promise<void>)};
 const view=(who:string|null)=>({feedId:state.feed,cursor:1,head:1,members:[member],decisions:[],segment:{number:1,revision:state.revision,closed:false,full:false,previous:null,messages:who?[{id:'m:'+'a'.repeat(32),role:'owner',turnId:null,text:'Remember my preference.'},{id:'r:'+turnId,role:'representative',turnId,text:'Suggested.'}]:[]},turns:who?[{id:turnId,messageId:'m:'+'a'.repeat(32),status:'answered',displayStatus:'answered',memoryCandidate:state.candidate}]:[]});
 const app=harness(async(path,options)=>{
  if(path==='/assistant/memory-candidates'){state.posts.push(JSON.parse(options.body));if(state.post)return state.post();state.candidate.status='saved';return reply({status:'saved'});}
  if(path.startsWith('/assistant/conversation')){const body=structuredClone(view(new URLSearchParams(path.split('?')[1]??'').get('member')));if(state.read)await state.read();return reply(body);}
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[]});return reply({},503);
 },initial);
 return {app,state,open:async()=>{await settle();await runInContext("chatOpenThread('quill','Quill')",app.context);await settle();}};
}
const find=(app:ReturnType<typeof harness>,label:string)=>app.all().find(n=>n.tagName==='BUTTON'&&n.textContent===label&&app.node('chat-log').contains(n));

test('candidate card renders literal content, saves the reviewed identity once and displays the receipt',async()=>{
 const f=fixture();await f.open();assert.match(f.app.node('chat-log').textContent,/Preferred summary/);assert.match(f.app.node('chat-log').textContent,/<img src=x>/);assert.ok(!f.app.all().some(n=>n.tagName==='IMG'));
 const save=find(f.app,copy('conversation.button.05'))!;assert.ok(save);let release!:(v:any)=>void;f.state.post=()=>new Promise(r=>release=r);const pending=save.fire('click');await settle();await save.fire('click');assert.equal(f.state.posts.length,1);
 assert.deepEqual(f.state.posts[0],{member:'quill',feedId:'feed:a',segment:1,expectedRevision:2,turnId,candidateId:candidate.id,version:1,hash:candidate.hash,missionRevision:1,action:'save'});
 f.state.candidate.status='saved';release(reply({status:'saved'}));await pending;await settle();assert.ok(!find(f.app,copy('conversation.button.05')));assert.match(f.app.node('chat-log').textContent,/남김/);
});

test('discard uses the same bound candidate and unknown delivery remains read-only across reload',async()=>{
 const f=fixture();await f.open();f.state.post=async()=>{throw Error('lost reply');};await find(f.app,copy('conversation.button.14'))!.fire('click');await settle();assert.equal(f.state.posts[0].action,'discard');assert.ok(!find(f.app,copy('conversation.button.05')));
 await runInContext('readChat()',f.app.context);await settle();assert.equal(f.state.posts.length,1);assert.ok(!find(f.app,copy('conversation.button.14')));
 const reload=fixture(Object.fromEntries(f.app.storage));await reload.open();assert.ok(!find(reload.app,copy('conversation.button.05')));assert.equal(reload.state.posts.length,0);
});

test('stale thread, candidate version, segment revision and feed bindings cannot submit cached buttons',async()=>{
 for(const change of ["chatOpenThread('')",'chatView.turns[0].memoryCandidate.version=2;renderChat()','chatView.segment.revision++;renderChat()',"chatView.feedId='feed:b';renderChat()"]){const f=fixture();await f.open();const save=find(f.app,copy('conversation.button.05'))!;assert.ok(save);await runInContext(change,f.app.context);await settle();await save.fire('click');assert.equal(f.state.posts.length,0,change);}
});

test('an older action response cannot clear a later generation receipt or alter another thread',async()=>{
 const f=fixture();await f.open();let release!:(v:any)=>void;f.state.post=()=>new Promise(r=>release=r);const pending=find(f.app,copy('conversation.button.05'))!.fire('click');await settle();await runInContext("chatOpenThread('')",f.app.context);await settle();
 release(reply({status:'saved'}));await pending;await settle();assert.equal(runInContext('chatThread',f.app.context),'');assert.ok(!f.app.node('chat-log').textContent.includes(candidate.name));await f.open();assert.ok(!find(f.app,copy('conversation.button.05')),'an acknowledgment from the previous generation does not release the uncertain receipt');
});

test('a greeting without a turn never prevents a later memory candidate from rendering',async()=>{const f=fixture();await f.open();assert.equal(runInContext('chatMemoryCard(undefined)',f.app.context),null);assert.ok(find(f.app,copy('conversation.button.05')));});

test('an explicit stale-review rejection unlocks a new review without resending the old choice',async()=>{
 const f=fixture();await f.open();f.state.post=async()=>{f.state.revision++;f.state.candidate.missionRevision++;return reply({error:'Memory candidate review changed',outcome:'rejected',phase:'admission',feedId:f.state.feed},409);};
 await find(f.app,copy('conversation.button.05'))!.fire('click');await settle();assert.equal(f.state.posts.length,1);assert.ok(find(f.app,copy('conversation.button.05')));assert.equal([...f.app.storage.keys()].filter(k=>k.startsWith('massion.workbench.memory-candidate:')).length,0);
 f.state.post=undefined;await find(f.app,copy('conversation.button.05'))!.fire('click');await settle();assert.equal(f.state.posts.length,2);assert.equal(f.state.posts[1].expectedRevision,f.state.revision);assert.equal(f.state.posts[1].missionRevision,f.state.candidate.missionRevision);
});
