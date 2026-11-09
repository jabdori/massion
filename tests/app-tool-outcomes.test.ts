import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import {copy} from '../src/ui-copy.ts';

function fixture(){
 const state={feed:'feed:a',unresolved:[{id:'call-one',name:'comment',status:'unknown'}],posts:[] as any[],hold:null as Promise<void>|null,fail:false};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){state.posts.push({path,body:JSON.parse(options.body)});if(state.hold)await state.hold;if(state.fail)throw Error('Lost response');state.unresolved=[];return reply({status:'committed',revision:3});}
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:1,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],apps:[{id:'app-mcp',name:'MCP',page:false,item:false,roomTab:null,unresolved:structuredClone(state.unresolved)}]});
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:1,snapshot:null});
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[]});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});return reply({error:'Unavailable'},503);
 });return {app,state};
}
const node=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
async function open(app:ReturnType<typeof harness>){await settle();const icon=node(app,'rail-app-app-mcp');assert.ok(icon,'a blocked tool-only app can be opened');await icon.fire('click');await settle();}

test('an unknown app outcome shows the existing warning and records one evidenced owner decision',async()=>{
 const {app,state}=fixture();await open(app);
 assert.match(app.node('app-tool-outcomes').textContent,new RegExp(copy('conversation.text.01')));assert.match(app.node('app-tool-outcomes').textContent,new RegExp(copy('ui.not-resent')));
 assert.equal(state.posts.length,0,'opening the blocked app executes no tool or view');
 const input=node(app,'app-reconcile-evidence-call-one'),done=node(app,'app-reconcile-done-call-one');assert.equal(done.disabled,true);
 input.value='Service receipt confirms completion';await input.fire('input');assert.equal(done.disabled,false);
 let release!:()=>void;state.hold=new Promise(r=>{release=r;});const sending=done.fire('click');await settle();await done.fire('click');await settle();assert.equal(state.posts.length,1);
 assert.deepEqual(state.posts[0].body,{commandId:state.posts[0].body.commandId,action:'reconcile',appId:'app-mcp',callId:'call-one',outcome:'done',evidence:'Service receipt confirms completion'});assert.equal(state.posts[0].path,'/assistant/apps');
 release();await sending;await settle();assert.equal(app.node('app-tool-outcomes').hidden,true);
});

test('unknown reconciliation response never resubmits and feed invalidation drops the old form',async()=>{
 const {app,state}=fixture();state.fail=true;await open(app);
 const input=node(app,'app-reconcile-evidence-call-one');input.value='Server confirms no effect';await input.fire('input');await node(app,'app-reconcile-not-done-call-one').fire('click');await settle();
 await node(app,'app-reconcile-not-done-call-one').fire('click');await settle();assert.equal(state.posts.length,1);
 runInContext('chatReset()',app.context);assert.equal(app.node('app-tool-outcomes').hidden,true);
 assert.equal(state.posts[0].body.outcome,'not-done');
});


test('pending calls remain blocked without an owner reconciliation action',async()=>{
 const {app,state}=fixture();state.unresolved[0]!.status='pending';await open(app);
 assert.ok(app.node('app-tool-outcomes').textContent.includes(copy('conversation.text.01')));assert.equal(node(app,'app-reconcile-done-call-one'),undefined);assert.equal(state.posts.length,0);
});
