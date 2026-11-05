import test from 'node:test';
import assert from 'node:assert/strict';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/members.md, Surface: members in the sidebar, one 1:1 conversation each, the name-and-shape dialog behind Add member, Work room participants.
const T0=Date.UTC(2026,10,5,1,14);
const decision={id:'decision:1',at:T0,title:'Data analysis',question:'Data analysis came up 4 times this month. Add a member for it?',rows:[['This month','Discount totals by weekday · Order discount totals and 2 more'],['Model group','Default']],action:'Add member',form:'member',state:'open'};
const sem={id:'member-a',name:'셈',look:{shape:'drop',color:'agent-4'}};
function fixture(initial:{members?:any[];decisions?:any[];threads?:Record<string,any[]>;turns?:any[];decisionStatus?:number}={}){
 const state={members:[] as any[],decisions:[decision] as any[],posted:[] as {path:string;body:any}[],threads:{} as Record<string,{id:string;role:string;turnId:string|null;text:string}[]>,turns:[] as any[],decisionStatus:200,...initial};
 const view=(member:string|null)=>({feedId:'feed:a',cursor:1,head:1,members:state.members,...(member?{member:{id:member,name:state.members.find(m=>m.id===member)?.name}}:{decisions:state.decisions}),
  segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:state.threads[member??'']??[]},turns:member?[]:state.turns});
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){const body=JSON.parse(options.body);state.posted.push({path,body});return path==='/assistant/decisions'&&state.decisionStatus!==200?reply({error:'Invalid or taken name'},state.decisionStatus):reply({status:'committed',revision:2});}
  if(path.startsWith('/assistant/conversation')){const member=new URLSearchParams(path.split('?')[1]??'').get('member');return reply(view(member));}
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found[0];};

test('Add member opens the name-and-shape dialog; Cancel sends nothing, Create sends act with the name and shape once',async()=>{
 const {app,state}=fixture();await settle();
 const card=byId(app,'chat-decision-decision:1')!;assert.ok(card);assert.match(card.textContent,/Add a member for it\?.*This month.*Model group.*Default.*Add member.*Later/);
 assert.equal(app.node('member-dialog').hidden,true);
 await button(card,'Add member')!.fire('click');await settle();
 assert.equal(app.node('member-dialog').hidden,false);assert.equal(state.posted.length,0,'the card answer waits for a name');
 await app.node('member-cancel').fire('click');await settle();assert.equal(app.node('member-dialog').hidden,true);assert.equal(state.posted.length,0);
 await button(card,'Add member')!.fire('click');await settle();
 assert.equal(app.node('member-create').disabled,true,'a name is required');
 app.node('member-name').value='셈';await app.node('member-name').fire('input');assert.equal(app.node('member-preview').textContent,'셈');
 assert.equal(workbenchPage.match(/id="member-shape-/g)!.length,8);await app.node('member-shape-drop').fire('click');
 assert.equal(app.node('member-shape-drop').attributes.get('aria-checked'),'true');assert.equal(app.node('member-shape-round').attributes.get('aria-checked'),'false');assert.deepEqual([app.node('member-look-drop').style.display,app.node('member-look-round').style.display],['','none'],'SVG has no hidden property, so the preview toggles display');
 assert.equal(app.node('member-create').disabled,false);await app.node('member-create').fire('click');await settle();
 assert.deepEqual(state.posted.map(p=>[p.path,p.body.decisionId,p.body.answer,p.body.member]),[['/assistant/decisions','decision:1','act',{name:'셈',shape:'drop'}]]);
 assert.equal(app.node('member-dialog').hidden,true);
});

test('members appear under the Representative; selecting one opens its own conversation, header and input, and sends to its thread',async()=>{
 const {app,state}=fixture({members:[sem],decisions:[{...decision,state:'done',line:'Added: 셈'}],threads:{'member-a':[{id:'m:'+'1'.repeat(32),role:'owner',turnId:null,text:'Use won from now on.'}]}});await settle();
 assert.equal(app.node('side-members').hidden,false);const row=byId(app,'side-member-member-a')!;assert.ok(row);assert.equal(row.textContent,'셈셈');
 assert.match(app.node('chat-log').textContent,/Added: 셈/);
 await row.fire('click');await settle();
 assert.equal(app.node('page-heading').textContent,'셈셈','avatar letter, then the name');assert.equal(app.node('page-heading').children[0]!.style.background,'var(--agent-4)');assert.equal(row.attributes.get('aria-current'),'page');assert.equal(app.node('side-representative').attributes.get('aria-current'),'false');
 assert.equal(app.node('chat-input').attributes.get('placeholder')??(app.node('chat-input') as any).placeholder,'Message 셈');
 assert.ok(app.calls.some(c=>c.path==='/assistant/conversation?member=member-a'));
 assert.match(app.node('chat-log').textContent,/Use won from now on\./);assert.doesNotMatch(app.node('chat-log').textContent,/Added: 셈/,'decisions stay in the Representative conversation');
 app.node('chat-input').value='Weekday totals too';await app.node('chat-form').fire('submit');await settle();
 const sent=state.posted.find(p=>p.path==='/assistant/messages')!;assert.equal(sent.body.member,'member-a');
 await app.node('side-representative').fire('click');await settle();assert.equal(app.node('page-heading').textContent,'하하나');assert.match(app.node('chat-log').textContent,/Added: 셈/);
});

test('member avatars use the host colour; no titles or explanation sentences in the dialog; yellow stays in decision rules',()=>{
 const dialog=/<div[^>]*id="member-dialog"[\s\S]*?<!-- \/member-dialog -->/.exec(workbenchPage)![0];
 assert.doesNotMatch(dialog.replace(/<[^>]*>/g,' '),/assistant|lead|department|team/i);
 assert.doesNotMatch(dialog,/#f0bc4b|#231d0e/i);
});

const running={id:'turn:1',messageId:'m:1',status:'answered',displayStatus:'answered',proposal:{title:'Weekday totals'},outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:3,workId:'work:a',title:'Weekday totals',execution:'active',acceptance:'pending',started:true}};

test('a member conversation keeps the Representative Work line and the open decision in the sidebar and activity list',async()=>{
 const {app}=fixture({members:[sem],turns:[running]});await settle();
 assert.ok(byId(app,'side-line-intake/work:a'));assert.ok(byId(app,'activity-row-decision:decision:1'));
 await byId(app,'side-member-member-a')!.fire('click');await settle();
 assert.equal(app.node('page-heading').textContent,'셈셈');
 assert.ok(byId(app,'side-line-intake/work:a'),'the Work line stays under the Representative');assert.ok(byId(app,'activity-row-decision:decision:1'),'open decisions still lead the activity list');
});

test('a refused Create keeps the dialog, its name and shape, and marks the name; nothing is resent',async()=>{
 const {app,state}=fixture({decisionStatus:409});await settle();
 await button(byId(app,'chat-decision-decision:1')!,'Add member')!.fire('click');await settle();
 app.node('member-name').value='하나';await app.node('member-name').fire('input');await app.node('member-shape-drop').fire('click');
 await app.node('member-create').fire('click');await settle();
 assert.equal(state.posted.length,1);assert.equal(app.node('member-dialog').hidden,false);assert.equal(app.node('member-name').value,'하나');
 assert.equal(app.node('member-name').attributes.get('aria-invalid'),'true');assert.equal(app.node('member-shape-drop').attributes.get('aria-checked'),'true');
 app.node('member-name').value='셈';await app.node('member-name').fire('input');state.decisionStatus=200;await app.node('member-create').fire('click');await settle();
 assert.equal(state.posted.length,2);assert.equal(app.node('member-dialog').hidden,true);
});

test('a send right after switching waits for the new thread\'s read and targets its head',async()=>{
 const {app,state}=fixture({members:[sem],threads:{'member-a':[{id:'m:'+'1'.repeat(32),role:'owner',turnId:null,text:'Use won from now on.'}]}});await settle();
 await byId(app,'side-member-member-a')!.fire('click');
 app.node('chat-input').value='Weekday totals too';await app.node('chat-form').fire('submit');await settle();
 const sent=state.posted.find(p=>p.path==='/assistant/messages')!;assert.deepEqual([sent.body.member,sent.body.segment,sent.body.expectedRevision],['member-a',1,1]);
});
