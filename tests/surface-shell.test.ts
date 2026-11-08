import test from 'node:test';
import {runInContext} from 'node:vm';
import assert from 'node:assert/strict';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const text=(html:string)=>html.replace(/<style>[\s\S]*?<\/style>|<script>[\s\S]*<\/script>/g,' ').replace(/<[^>]*>/g,' ');
const opening=(id:string)=>new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`).exec(workbenchPage)?.[0]??'';

test('the skeleton has a rail, a sidebar, a page area and a work pane, with no explanation sentences, no assistant word and no old warning yellow',()=>{
 for(const id of ['rail','rail-chat','rail-results','rail-schedules','rail-apps','rail-me','me-menu','me-settings','sidebar','side-representative','side-work','side-members','side-activity','activity-list','activity-toggle','sidebar-toggle','page-heading','page-chat','page-results','page-schedules','page-settings','work-pane','pane-tabs','pane-widen','pane-close'])assert.ok(opening(id),id);
 assert.match(opening('rail'),/^<nav\b[^>]*aria-label="/);assert.match(opening('sidebar'),/^<aside\b/);assert.match(opening('page'),/^<main\b/);assert.match(opening('work-pane'),/aria-label="/);
 for(const id of ['rail-apps','side-members','side-activity','me-menu','work-pane','page-results','page-schedules','page-settings'])assert.match(opening(id),/ hidden/,id);
 assert.match(opening('pane-tabs'),/role="tablist"/);assert.match(opening('me-menu'),/role="menu"/);assert.match(opening('rail-me'),/aria-haspopup="menu"/);assert.match(opening('rail-me'),/aria-expanded="false"/);
 assert.match(opening('sidebar-toggle'),/aria-expanded="true"/);assert.match(opening('activity-toggle'),/aria-pressed="false"/);assert.match(opening('pane-widen'),/aria-pressed="false"/);
 // Settings is reached from the owner's menu only, and the old form column lives there.
 assert.doesNotMatch(opening('rail'),/Settings/);const settings=/<div[^>]*id="page-settings"[\s\S]*?<!-- \/page-settings -->/.exec(workbenchPage)![0];
 for(const id of ['connection-form','mission-form','load-form','run-fixture','health','provider-notice'])assert.match(settings,new RegExp(`id="${id}"`),id);
 const pane=/<section[^>]*id="work-pane"[\s\S]*?<!-- \/work-pane -->/.exec(workbenchPage)![0];for(const id of ['mission-panel','empty-state','event-list','status'])assert.match(pane,new RegExp(`id="${id}"`),id);
 const visible=text(workbenchPage);for(const gone of ['Work with a reason','Purpose → Work → Evidence','Loopback workbench','Local development'])assert.ok(!visible.includes(gone),gone);
 const shell=text(workbenchPage.slice(workbenchPage.indexOf('<body>'),workbenchPage.indexOf('<section id="conversation"')));assert.doesNotMatch(shell,/assistant|department|lead\b|team/i);
 // Yellow is for decision cards only (ADR 0002 §8): tests/conversation-cards.test.ts checks every yellow rule.
 const style=workbenchPage.slice(0,workbenchPage.indexOf('</style>'));for(const yellow of ['#fcf3df','#e7dbbd','#855019','#77531d'])assert.ok(!style.includes(yellow),yellow);
});

type Work={workId:string;title:string;execution:string;acceptance:string;started:boolean};
function fixture(works:Work[],extra?:(path:string,options:any,state:{works:Work[];revision:number},mission:()=>unknown)=>unknown){
 const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
 const missionWork=(w:Work)=>({id:w.workId,title:w.title,missionVersion:1,criteria,execution:w.execution,acceptance:w.acceptance,tasks:[],attempts:[{id:'attempt:1',number:1,criteria,status:'queued',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0}});
 const state={works,revision:2,missions:0,cursor:1,events:[] as any[]};
 const mission=()=>({id:'intake',version:1,purpose:'Owner requests',scope:'local',constraints:[],criteria,works:state.works.map(missionWork),memories:[],growth:[],relations:[]});
 const view=()=>{const messages:any[]=[],turns:any[]=[];state.works.forEach((w,i)=>{const id=String(i+1).repeat(32),turn='assistant-turn:m:'+id;messages.push({id:'m:'+id,role:'owner',turnId:null,text:'Do '+w.title},{id:'r:'+turn,role:'representative',turnId:turn,text:'Okay.'});
  turns.push({id:turn,messageId:'m:'+id,status:'answered',displayStatus:'answered',proposal:{title:w.title},outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:state.revision,workId:w.workId,title:w.title,execution:w.execution,acceptance:w.acceptance,started:w.started}});});
  return {feedId:'feed:a',cursor:1,head:1,segment:{number:1,revision:9,closed:false,full:false,previous:null,messages},turns};};
 const app=harness(async(path,options)=>{
  const handled=extra?.(path,options,state,mission);if(handled)return reply(handled);
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:view().turns.map(t=>({memberId:null,unknown:false,startedAt:null,endedAt:null,segment:1,...t.work,turnId:t.id})).reverse()});
  if(path.startsWith('/assistant/conversation'))return reply(view());
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:state.cursor,events:state.events});
  if(path.startsWith('/read-state')){state.missions++;return reply({feedId:'feed:a',cursor:1,snapshot:{revision:state.revision,value:mission()}});}
  if(path==='/missions/intake'){state.missions++;return reply({revision:state.revision,value:mission()});}
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
const kids=(node:Node)=>node.children.filter(child=>!child.hidden);
const titles=(list:Node)=>kids(list).map(row=>row.children.find(c=>c.tagName==='BUTTON')!.children.find(c=>c.tagName==='STRONG')!.textContent);

test('Work lines show running Work under the Representative; the activity list orders by priority or recency, marks unread changes and every entry opens the same tab',async()=>{
 const {app,state}=fixture([{workId:'work:b',title:'Running one',execution:'active',acceptance:'pending',started:true},{workId:'work:a',title:'Done one',execution:'settled',acceptance:'accepted',started:true},{workId:'work:c',title:'Failed one',execution:'settled',acceptance:'failed',started:true}]);
 await settle();
 const lines=kids(app.node('side-work')).map(n=>n.textContent);assert.equal(lines.length,1,'exceptions and finished Work live in the conversation');assert.ok(lines[0]!.startsWith('Running one'));
 assert.equal(app.node('side-members').hidden,true);assert.equal(app.node('rail-apps').hidden,true);
 await app.node('activity-toggle').fire('click');assert.equal(app.node('side-activity').hidden,false);assert.equal(app.node('side-people').hidden,true);assert.equal(app.node('activity-toggle').attributes.get('aria-pressed'),'true');
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Running one','Done one']);
 assert.match(app.node('activity-list').textContent,/Check failed/);assert.doesNotMatch(app.node('activity-list').textContent,/Unread/,'first sight records the state without a dot');
 await app.node('activity-order').fire('click');assert.equal(app.node('activity-order-menu').hidden,false);await app.node('order-recent').fire('click');
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Done one','Running one']);
 assert.equal(app.node('order-recent').attributes.get('aria-checked'),'true');assert.equal(app.node('activity-order-menu').hidden,true);
 await app.node('activity-order').fire('click');await app.node('order-priority').fire('click');
 // A state change after first sight shows the unread dot until the Work is opened.
 state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted'},state.works[1]!,state.works[2]!];await app.node('chat-latest').fire('click');await settle();
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Done one','Running one'],'ties keep the recent order');
 const row=kids(app.node('activity-list')).find(r=>r.textContent.includes('Running one'))!;assert.match(row.textContent,/Unread/);
 assert.equal(app.node('work-pane').hidden,true);
 await row.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();
 assert.equal(app.node('work-pane').hidden,false);assert.doesNotMatch(app.node('activity-list').textContent,/Unread/);
 const tabs=()=>kids(app.node('pane-tabs'));assert.equal(tabs().length,1);assert.match(tabs()[0]!.textContent,/Running one/);
 assert.equal((app.context as any).document.activeElement.id,'work-heading-work:b');
 assert.deepEqual(kids(app.node('work-list')).map(card=>card.id),['work-card-work:b'],'a Work tab shows that Work only');
 // A Work line and a card open the same tab instead of a second one; another Work adds a tab and selects it.
 await app.all().find(n=>n.id==='chat-fold-assistant-turn:m:'+'3'.repeat(32))!.fire('click');await settle();
 assert.equal(tabs().length,2);const selected=()=>tabs().filter(t=>t.children[0]!.attributes.get('aria-selected')==='true').map(t=>t.children[0]!.textContent);assert.deepEqual(selected(),['Failed one']);
 await kids(app.node('activity-list')).find(r=>r.textContent.includes('Failed one'))!.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();assert.equal(tabs().length,2);
 await tabs()[0]!.children[0]!.fire('click');await settle();assert.deepEqual(selected(),['Running one']);assert.equal((app.context as any).document.activeElement.id,'work-heading-work:b');
 // A background refresh never reopens a closed pane.
 await app.node('pane-close').fire('click');assert.equal(app.node('work-pane').hidden,true);assert.equal(tabs().length,0);
 const reads=state.missions;state.revision=3;state.cursor=2;state.events=[{cursor:2,aggregateId:'intake',revision:3}];await app.tick();await settle();assert.ok(state.missions>reads,'the Mission was read again');assert.equal(app.node('work-pane').hidden,true);
});

test('tabs close one at a time, widen takes the room, the sidebar hides, and the owner menu opens Settings with the earlier forms',async()=>{
 const {app}=fixture([{workId:'work:a',title:'First',execution:'active',acceptance:'pending',started:true},{workId:'work:b',title:'Second',execution:'waiting',acceptance:'pending',started:true}]);
 await settle();
 for(const line of kids(app.node('side-work')).reverse()){await line.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();}
 const tabs=()=>kids(app.node('pane-tabs'));assert.equal(tabs().length,2);
 const close=(tab:Node)=>tab.children.find(c=>c.attributes.get('aria-label')?.startsWith('Close'))!;assert.equal(close(tabs()[1]!).attributes.get('aria-label'),'Close Second');
 await close(tabs()[1]!).fire('click');await settle();assert.equal(tabs().length,1);assert.equal(tabs()[0]!.children[0]!.attributes.get('aria-selected'),'true');assert.equal(app.node('work-pane').hidden,false);
 await app.node('pane-widen').fire('click');assert.equal(app.node('pane-widen').attributes.get('aria-pressed'),'true');assert.match(app.node('app').className,/\bwide\b/);
 await app.node('pane-widen').fire('click');assert.doesNotMatch(app.node('app').className,/\bwide\b/);
 await close(tabs()[0]!).fire('click');assert.equal(app.node('work-pane').hidden,true);
 await app.node('sidebar-toggle').fire('click');assert.equal(app.node('sidebar').hidden,true);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'false');
 await app.node('sidebar-toggle').fire('click');assert.equal(app.node('sidebar').hidden,false);
 assert.equal(app.node('page-chat').hidden,false);assert.equal(app.node('page-heading').textContent,'하하나','avatar letter, then the name');
 await app.node('rail-me').fire('click');assert.equal(app.node('me-menu').hidden,false);assert.equal(app.node('rail-me').attributes.get('aria-expanded'),'true');
 await app.node('me-settings').fire('click');assert.equal(app.node('me-menu').hidden,true);assert.equal(app.node('page-settings').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(app.node('page-heading').textContent,'Settings');
 for(const [rail,page,name] of [['rail-results','page-results','Results'],['rail-schedules','page-schedules','Schedules'],['rail-chat','page-chat','하하나']] as const){
  await app.node(rail).fire('click');assert.equal(app.node(page).hidden,false,page);assert.equal(app.node('page-heading').textContent,name);assert.equal(app.node(rail).attributes.get('aria-current'),'page');
  for(const other of ['page-chat','page-results','page-schedules','page-settings'])if(other!==page)assert.equal(app.node(other).hidden,true,other);
 }
});

test('loading a Mission from Settings opens one pane tab named after its purpose, and a refresh of the same Mission adds none',async()=>{
 const {app}=fixture([]);await settle();
 app.node('mission-id').value='intake';await app.submit('load-form');
 const tabs=kids(app.node('pane-tabs'));assert.equal(tabs.length,1);assert.match(tabs[0]!.textContent,/Owner requests/);assert.equal(app.node('work-pane').hidden,false);
 await app.submit('load-form');assert.equal(kids(app.node('pane-tabs')).length,1);
});

const open=(row:Node)=>row.children.find(c=>c.tagName==='BUTTON')!;
// Running Work opens from its card, settled Work from its fold: the sidebar lists running Work only.
const openTurn=(app:ReturnType<typeof harness>,index:number)=>{const turn='assistant-turn:m:'+String(index+1).repeat(32),node=app.all().find(n=>n.id==='chat-card-'+turn||n.id==='chat-fold-'+turn)!;return node.tagName==='BUTTON'?node:node.children.find(c=>c.className==='chat-card-open')!;};
const shown=(app:ReturnType<typeof harness>)=>kids(app.node('work-list')).map(card=>card.id);
const selectedTab=(app:ReturnType<typeof harness>)=>kids(app.node('pane-tabs')).filter(t=>t.children[0]!.attributes.get('aria-selected')==='true').map(t=>t.children[0]!.textContent);
// Host ready, with a feed boundary that has no Mission selected, so writes and Settings lists are enabled.
const ready=(path:string)=>path==='/health'?{status:'ready'}:path==='/read-state'?{feedId:'feed:a',cursor:1,snapshot:null}:undefined;
const two:Work[]=[{workId:'work:a',title:'First',execution:'active',acceptance:'pending',started:true},{workId:'work:b',title:'Second',execution:'settled',acceptance:'failed',started:true}];

test('an explicit open shows the pane and its target even when the same Mission is already read or the pane was closed',async()=>{
 const inboxItem={missionId:'intake',workId:'work:b',title:'Second',missionPurpose:'Owner requests',revision:2,execution:'settled',acceptance:'failed',openQuestions:0,unknownEffects:0,pendingEffects:0,interrupted:false,blocker:null};
 const catalogItem={missionId:'intake',purpose:'Owner requests',scope:'local',revision:2,version:1,workCount:2};
 const {app}=fixture(two,path=>ready(path)??(path.startsWith('/work-inbox')?{feedId:'feed:a',cursor:1,limit:20,items:[inboxItem],nextAfter:null}:path.startsWith('/mission-catalog')?{feedId:'feed:a',cursor:1,limit:20,items:[catalogItem],nextAfter:null}:undefined));
 await settle();
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();assert.deepEqual(shown(app),['work-card-work:a']);
 // The inbox names another Work of the Mission already shown: it gets its own tab and is not filtered away.
 await app.node('work-inbox-refresh').fire('click');await settle();
 await app.all().find(n=>n.attributes.get('data-inbox-work')==='work:b')!.fire('click');await settle();
 assert.deepEqual(selectedTab(app),['Second']);assert.deepEqual(shown(app),['work-card-work:b']);assert.equal((app.context as any).document.activeElement.id,'work-heading-work:b');
 // After the pane is closed, the catalog, a link and the load form each open it again on the Mission tab.
 for(const reopen of [async()=>{await app.node('mission-catalog-refresh').fire('click');await settle();await app.all().find(n=>n.attributes.get('data-catalog-mission')==='intake')!.fire('click');await settle();},()=>app.navigateFragment('#mission=intake'),async()=>{app.node('mission-id').value='intake';await app.submit('load-form');}]){
  await app.node('pane-close').fire('click');assert.equal(app.node('work-pane').hidden,true);
  await reopen();assert.equal(app.node('work-pane').hidden,false);assert.deepEqual(selectedTab(app),['Owner requests']);assert.deepEqual(shown(app),['work-card-work:a','work-card-work:b']);
 }
});

test('Work admitted from a Work tab switches to the Mission tab so the new card is shown',async()=>{
 const {app}=fixture(two.slice(0,1),(path,options,state,mission)=>{const up=ready(path);if(up)return up;if(options?.method!=='POST'||path!=='/missions/intake/work')return undefined;const body=JSON.parse(options.body);state.works=[...state.works,{workId:body.workId,title:body.title,execution:'queued',acceptance:'pending',started:false}];state.revision++;return {status:'committed',feedId:'feed:a',revision:state.revision,value:mission()};});
 await settle();
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();assert.deepEqual(shown(app),['work-card-work:a']);
 app.node('work-title').value='Third';app.node('work-budget').value='1';await app.submit('work-form');
 assert.deepEqual(selectedTab(app),['Owner requests']);assert.equal(shown(app).length,2);
});

// write() argument slots after successMessage: correction is the 11th, saved-owner-message Work the 13th; a foreign missionId keeps their panels from rendering the stub.
for(const [form,slot] of [['correction',10],['saved owner message',12]] as const)test(`a ${form} admission from a Work tab also switches to the Mission tab`,async()=>{
 const {app}=fixture(two.slice(0,1),(path,options,state,mission)=>{const up=ready(path);if(up)return up;if(options?.method!=='POST'||path!=='/missions/intake/work')return undefined;const body=JSON.parse(options.body);state.works=[...state.works,{workId:body.workId,title:body.title,execution:'queued',acceptance:'pending',started:false}];state.revision++;return {status:'committed',feedId:'feed:a',revision:state.revision,value:mission()};});
 await settle();
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();assert.deepEqual(shown(app),['work-card-work:a']);
 const extra=Array(slot+1).fill(null);extra[slot]={missionId:'elsewhere',body:{expectedRevision:0}};
 (app.context as any).extraArgs=extra;
 assert.equal(await runInContext("write('/missions/intake/work',{commandId:crypto.randomUUID(),expectedRevision:snapshot.revision,workId:'work:c',title:'Third',budget:1},'intake','Admitted.',...extraArgs)",app.context),true);await settle();
 assert.deepEqual(selectedTab(app),['Owner requests']);assert.equal(shown(app).length,2);
});

test('selecting a tab while a read or write is in flight leaves the tabs and the shown cards as they were',async()=>{
 const {app}=fixture(two);await settle();
 for(const id of ['chat-card-assistant-turn:m:'+'1'.repeat(32),'chat-fold-assistant-turn:m:'+'2'.repeat(32)]){const node=app.all().find(n=>n.id===id)!;await (node.tagName==='BUTTON'?node:node.children.find(c=>c.className==='chat-card-open')!).fire('click');await settle();}
 const before=selectedTab(app);runInContext('loading=true',app.context);
 await kids(app.node('pane-tabs'))[0]!.children[0]!.fire('click');assert.deepEqual(selectedTab(app),before);assert.deepEqual(shown(app),['work-card-work:b']);
});

test('unread memory survives viewing another segment and widening reports the hidden sidebar',async()=>{
 const {app}=fixture(two);await settle();
 const seen=JSON.parse(app.storage.get('massion.workbench.seen')!);seen['other/work:z']='Working';app.storage.set('massion.workbench.seen',JSON.stringify(seen));
 await app.node('chat-latest').fire('click');await settle();assert.equal(JSON.parse(app.storage.get('massion.workbench.seen')!)['other/work:z'],'Working');
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();
 await app.node('pane-widen').fire('click');assert.equal(app.node('sidebar').hidden,true);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'false');
 await app.node('pane-widen').fire('click');assert.equal(app.node('sidebar').hidden,false);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'true');
 await app.node('pane-widen').fire('click');await app.node('sidebar-toggle').fire('click');
 assert.doesNotMatch(app.node('app').className,/\bwide\b/);assert.equal(app.node('sidebar').hidden,false);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'true');
 await app.node('sidebar-toggle').fire('click');await app.node('pane-widen').fire('click');await app.node('sidebar-toggle').fire('click');
 assert.equal(app.node('sidebar').hidden,false);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'true');
});

test('closing the selected tab while a read or write is in flight keeps it, and closing another tab still works',async()=>{
 const {app}=fixture([...two,{workId:'work:c',title:'Third',execution:'active',acceptance:'pending',started:true}]);await settle();
 for(const index of [0,1,2]){await openTurn(app,index).fire('click');await settle();}
 const tabs=()=>kids(app.node('pane-tabs')),close=(tab:Node)=>tab.children[1]!;assert.equal(tabs().length,3);assert.deepEqual(selectedTab(app),['Third']);
 runInContext('loading=true',app.context);
 await close(tabs()[2]!).fire('click');assert.equal(tabs().length,3);assert.deepEqual(selectedTab(app),['Third']);assert.deepEqual(shown(app),['work-card-work:c']);
 await close(tabs()[0]!).fire('click');assert.equal(tabs().length,2);assert.deepEqual(selectedTab(app),['Third']);
 runInContext('loading=false',app.context);await close(tabs()[1]!).fire('click');await settle();assert.deepEqual(selectedTab(app),['Second']);assert.deepEqual(shown(app),['work-card-work:b']);
});

test('a failed load from Settings shows its error on the page while the pane is closed',async()=>{
 const {app}=fixture([],path=>path==='/missions/missing'?{error:'Mission not found'}:undefined);await settle();
 await app.node('rail-me').fire('click');await app.node('me-settings').fire('click');
 app.node('mission-id').value='missing';await app.submit('load-form');await settle();
 assert.equal(app.node('work-pane').hidden,true);assert.equal(app.node('page-status').hidden,false);assert.match(app.node('page-status').textContent,/Refresh failed/);
 app.node('mission-id').value='intake';await app.submit('load-form');await settle();
 assert.equal(app.node('work-pane').hidden,false);assert.equal(app.node('page-status').hidden,true);
});

test('moving to another page sets the narrow-screen pane aside until a Work is opened again',async()=>{
 assert.match(workbenchPage,/@media \(max-width:900px\)\{[^}]*\}[^@]*\.pane\.away\{display:none\}/);
 const {app}=fixture(two);await settle();
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();assert.doesNotMatch(app.node('work-pane').className,/\baway\b/);
 await app.node('rail-results').fire('click');assert.match(app.node('work-pane').className,/\baway\b/);assert.equal(app.node('work-pane').hidden,false,'the tabs stay open');
 await openTurn(app,1).fire('click');await settle();assert.doesNotMatch(app.node('work-pane').className,/\baway\b/);assert.equal(app.node('page-chat').hidden,false);
});

test('the narrow-screen sidebar opens below the band so its toggle stays reachable to close it',()=>{
 const narrow=/@media \(max-width:900px\)\{\.sidebar\{([^}]*)\}/.exec(workbenchPage)?.[1]??'';
 assert.match(narrow,/position:fixed/);assert.match(narrow,/top:44px/);
 assert.match(workbenchPage,/\.band\{height:44px/,'the sidebar top matches the band height');
});

test('the owner menu stacks above the narrow-screen work pane so Settings stays reachable',()=>{
 const menu=Number(/\.menu\{position:absolute;z-index:(\d+)/.exec(workbenchPage)?.[1]),pane=Number(/@media \(max-width:900px\)\{[^@]*\.pane\{position:fixed;z-index:(\d+)/.exec(workbenchPage)?.[1]);
 assert.ok(menu>pane,`menu z-index ${menu} must exceed the narrow pane's ${pane}`);
});
