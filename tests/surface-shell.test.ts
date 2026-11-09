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

type Work={workId:string;title:string;execution:string;acceptance:string;started:boolean;memberId?:string|null;unknown?:boolean;startedAt?:number|null;endedAt?:number|null;segment?:number;stored?:Record<string,unknown>};
function fixture(works:Work[],extra?:(path:string,options:any,state:{works:Work[];revision:number},mission:()=>unknown)=>unknown){
 const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
 const missionWork=(w:Work)=>({id:w.workId,title:w.title,missionVersion:1,criteria,execution:w.execution,acceptance:w.acceptance,tasks:[],attempts:[{id:'attempt:1',number:1,criteria,status:'queued',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0},...w.stored});
 const state={works,revision:2,missions:0,cursor:1,events:[] as any[]};
 const mission=()=>({id:'intake',version:1,purpose:'Owner requests',scope:'local',constraints:[],criteria,works:state.works.map(missionWork),memories:[],growth:[],relations:[]});
 const view=()=>{const messages:any[]=[],turns:any[]=[];state.works.forEach((w,i)=>{const id=String(i+1).repeat(32),turn='assistant-turn:m:'+id;messages.push({id:'m:'+id,role:'owner',turnId:null,text:'Do '+w.title},{id:'r:'+turn,role:'representative',turnId:turn,text:'Okay.'});
  turns.push({id:turn,messageId:'m:'+id,status:'answered',displayStatus:'answered',proposal:{title:w.title},outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:state.revision,workId:w.workId,title:w.title,execution:w.execution,acceptance:w.acceptance,started:w.started,memberId:w.memberId??null,unknown:w.unknown??false,startedAt:w.startedAt??null,endedAt:w.endedAt??null,segment:w.segment??1}});});
  return {feedId:'feed:a',cursor:1,head:1,segment:{number:1,revision:9,closed:false,full:false,previous:null,messages},turns};};
 const app=harness(async(path,options)=>{
  const handled=await extra?.(path,options,state,mission);if(handled)return reply(handled);
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

test('Work lines retain stored Work; the activity list orders by priority or recency, marks unread changes and every entry opens the same tab',async()=>{
 const {app,state}=fixture([{workId:'work:b',title:'Running one',execution:'active',acceptance:'pending',started:true},{workId:'work:a',title:'Done one',execution:'settled',acceptance:'accepted',started:true},{workId:'work:c',title:'Failed one',execution:'settled',acceptance:'failed',started:true}]);
 await settle();
 const lines=kids(app.node('side-work')).map(n=>n.textContent);assert.equal(lines.length,3,'stored failed and accepted Work remain reachable');assert.ok(lines.some(line=>line.startsWith('Running one')));
 assert.equal(app.node('side-members').hidden,true);assert.equal(app.node('rail-apps').hidden,true);
 await app.node('activity-toggle').fire('click');assert.equal(app.node('side-activity').hidden,false);assert.equal(app.node('side-people').hidden,false);assert.equal(app.node('side-work').hidden,true);assert.equal(app.node('activity-toggle').attributes.get('aria-pressed'),'true');
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Running one','Done one']);
 assert.match(app.node('activity-list').textContent,/실패/);assert.match(app.node('activity-list').textContent,/읽지 않음/,'first discovery does not acknowledge Work');
 await app.node('activity-order').fire('click');assert.equal(app.node('activity-order-menu').hidden,false);await app.node('order-recent').fire('click');
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Done one','Running one']);
 assert.equal(app.node('order-recent').attributes.get('aria-checked'),'true');assert.equal(app.node('activity-order-menu').hidden,true);
 await app.node('activity-order').fire('click');await app.node('order-priority').fire('click');
 // A state change after first sight shows the unread dot until the Work is opened.
 state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted'},state.works[1]!,state.works[2]!];await app.node('chat-latest').fire('click');await settle();
 assert.deepEqual(titles(app.node('activity-list')),['Failed one','Done one','Running one'],'ties keep the recent order');
 const row=kids(app.node('activity-list')).find(r=>r.textContent.includes('Running one'))!;assert.match(row.textContent,/읽지 않음/);
 assert.equal(app.node('work-pane').hidden,true);
 await row.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();
 assert.equal(app.node('work-pane').hidden,false);assert.doesNotMatch(kids(app.node('activity-list')).find(r=>r.textContent.includes('Running one'))!.textContent,/읽지 않음/);assert.match(app.node('activity-list').textContent,/읽지 않음/,'opening one Work does not acknowledge the others');
 const tabs=()=>kids(app.node('pane-tabs'));assert.equal(tabs().length,1);assert.match(tabs()[0]!.textContent,/Running one/);
 assert.equal((app.context as any).document.activeElement.id,'work-heading-work:b');
 assert.deepEqual(kids(app.node('work-list')).map(card=>card.id),['work-card-work:b'],'a Work tab shows that Work only');
 // A Work line and a card open the same tab instead of a second one; another Work adds a tab and selects it.
 await openTurn(app,2).fire('click');await settle();
 assert.equal(tabs().length,2);const selected=()=>tabs().filter(t=>t.children[0]!.attributes.get('aria-selected')==='true').map(t=>t.children[0]!.textContent);assert.deepEqual(selected(),['Failed one']);
 await kids(app.node('activity-list')).find(r=>r.textContent.includes('Failed one'))!.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();assert.equal(tabs().length,2);
 await tabs()[0]!.children[0]!.fire('click');await settle();assert.deepEqual(selected(),['Running one']);assert.equal((app.context as any).document.activeElement.id,'work-heading-work:b');
 // A background refresh never reopens a closed pane.
 await app.node('pane-close').fire('click');assert.equal(app.node('work-pane').hidden,true);assert.equal(tabs().length,0);
 const reads=state.missions;state.revision=3;state.cursor=2;state.events=[{cursor:2,aggregateId:'intake',revision:3}];await app.tick();await settle();assert.ok(state.missions>reads,'the Mission was read again');assert.equal(app.node('work-pane').hidden,true);
});

test('tabs close one at a time, widen takes the room, the sidebar hides, and the owner menu opens Settings with the earlier forms',async()=>{
 const {app}=fixture([{workId:'work:a',title:'First',execution:'active',acceptance:'pending',started:true},{workId:'work:b',title:'Second',execution:'active',acceptance:'pending',started:true}]);
 await settle();
 for(const line of kids(app.node('side-work')).reverse()){await line.children.find(c=>c.tagName==='BUTTON')!.fire('click');await settle();}
 const tabs=()=>kids(app.node('pane-tabs'));assert.equal(tabs().length,2);
 const close=(tab:Node)=>tab.children.find(c=>c.attributes.get('aria-label')?.endsWith('닫기'))!;assert.equal(close(tabs()[1]!).attributes.get('aria-label'),'Second 닫기');
 await close(tabs()[1]!).fire('click');await settle();assert.equal(tabs().length,1);assert.equal(tabs()[0]!.children[0]!.attributes.get('aria-selected'),'true');assert.equal(app.node('work-pane').hidden,false);
 await app.node('pane-widen').fire('click');assert.equal(app.node('pane-widen').attributes.get('aria-pressed'),'true');assert.match(app.node('app').className,/\bwide\b/);
 await app.node('pane-widen').fire('click');assert.doesNotMatch(app.node('app').className,/\bwide\b/);
 await close(tabs()[0]!).fire('click');assert.equal(app.node('work-pane').hidden,true);
 await app.node('sidebar-toggle').fire('click');assert.equal(app.node('sidebar').hidden,true);assert.equal(app.node('sidebar-toggle').attributes.get('aria-expanded'),'false');
 await app.node('sidebar-toggle').fire('click');assert.equal(app.node('sidebar').hidden,false);
 assert.equal(app.node('page-chat').hidden,false);assert.equal(app.node('page-heading').textContent,'하하나','avatar letter, then the name');
 await app.node('rail-me').fire('click');assert.equal(app.node('me-menu').hidden,false);assert.equal(app.node('rail-me').attributes.get('aria-expanded'),'true');
 await app.node('me-settings').fire('click');assert.equal(app.node('me-menu').hidden,true);assert.equal(app.node('page-settings').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(app.node('page-heading').textContent,'설정');
 for(const [rail,page,name] of [['rail-results','page-results','결과물'],['rail-schedules','page-schedules','예약'],['rail-chat','page-chat','하하나']] as const){
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
// A Work opens through its current card or folded line.
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
 await find(app,'side-line-intake/work:a').fire('click');await settle();assert.deepEqual(shown(app),['work-card-work:a']);
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
 for(const index of [0,1]){await openTurn(app,index).fire('click');await settle();}
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
 assert.equal(app.node('work-pane').hidden,true);assert.equal(app.node('page-status').hidden,false);assert.match(app.node('page-status').textContent,/갱신 실패/);
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
 assert.match(narrow,/position:fixed/);assert.match(narrow,/top:var\(--header-height\)/);
 assert.match(workbenchPage,/\.band\{height:var\(--header-height\)/,'the sidebar top matches the band height');
});

test('the owner menu stacks above the narrow-screen work pane so Settings stays reachable',()=>{
 const menu=Number(/\.menu\{position:absolute;z-index:(\d+)/.exec(workbenchPage)?.[1]),pane=Number(/@media \(max-width:900px\)\{[^@]*\.pane\{position:fixed;z-index:(\d+)/.exec(workbenchPage)?.[1]);
 assert.ok(menu>pane,`menu z-index ${menu} must exceed the narrow pane's ${pane}`);
});

const shellMembers=[{id:'quill',name:'Quill',look:{shape:'drop',color:'agent-1'}},{id:'juno',name:'Juno',look:{shape:'clover',color:'agent-6'}}];
function shellFixture(){
 const data={members:shellMembers,decisions:[] as any[],exceptions:[] as any[],turns:[] as any[]};
 const result=fixture(two.map(w=>({...w,execution:'active',acceptance:'pending'})),path=>path.startsWith('/assistant/conversation')?{feedId:'feed:a',cursor:1,head:1,...data,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]}}:undefined);
 return {...result,data};
}
const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
async function key(app:ReturnType<typeof harness>,event:Record<string,unknown>){app.context.shellTestKey={preventDefault(){},...event};runInContext('shellKeydown(shellTestKey)',app.context);await settle();}

test('the header profile opens the current member settings through the existing read-only route',async()=>{
 const {app}=shellFixture();await settle();
 assert.ok(find(app,'header-profile'),'a named profile button is reachable');
 await find(app,'header-profile').fire('click');await settle();
 assert.equal(app.node('page-settings').hidden,false);assert.equal(runInContext('settingsShown',app.context),'general');
 await app.node('rail-chat').fire('click');await find(app,'side-member-quill').fire('click');await settle();
 assert.equal(find(app,'header-profile').attributes.get('aria-label'),'Quill');
 await find(app,'header-profile').fire('click');await settle();
 assert.equal(runInContext('settingsShown',app.context),'members');assert.equal(runInContext('settingsMember',app.context),'quill');assert.match(app.node('settings-members-body').textContent,/Quill/);
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('the header menu routes existing settings actions and Escape restores its trigger focus',async()=>{
 const {app}=shellFixture();await settle();
 assert.match(opening('header-more'),/aria-haspopup="menu"/);
 for(const [id,section] of [['header-settings','general'],['header-members','members'],['header-permissions','permissions']]){
  await app.node('rail-chat').fire('click');await app.node('header-more').fire('click');assert.equal(app.node('header-menu').hidden,false);
  await app.node(id!).fire('click');await settle();assert.equal(app.node('header-menu').hidden,true);assert.equal(app.node('page-settings').hidden,false);assert.equal(runInContext('settingsShown',app.context),section);
 }
 await app.node('rail-chat').fire('click');await app.node('header-more').fire('click');await key(app,{key:'Escape'});
 assert.equal(app.node('header-menu').hidden,true);assert.equal(app.context.document.activeElement,app.node('header-more'));
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('the workspace toggle retains tabs and selection across hide, reread and reopen',async()=>{
 const {app}=fixture(two);await settle();assert.ok(opening('header-workspace'));
 assert.equal(app.node('header-workspace').hidden,false);
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();
 const selected=selectedTab(app);assert.equal(app.node('header-workspace').hidden,false);assert.equal(app.node('header-workspace').attributes.get('aria-pressed'),'true');
 await app.node('pane-widen').fire('click');await app.node('header-workspace').fire('click');
 assert.equal(app.node('work-pane').hidden,true);assert.doesNotMatch(app.node('app').className,/\bwide\b/);
 runInContext('renderPane()',app.context);assert.equal(app.node('work-pane').hidden,true);assert.deepEqual(selectedTab(app),selected);
 await app.node('header-workspace').fire('click');assert.equal(app.node('work-pane').hidden,false);assert.deepEqual(selectedTab(app),selected);
 await app.node('pane-close').fire('click');assert.equal(app.node('header-workspace').hidden,false);
});

test('opening an existing result preview reveals a workspace hidden by the header toggle',async()=>{
 const {app}=fixture(two);await settle();await open(kids(app.node('side-work'))[0]!).fire('click');await settle();
 await app.node('header-workspace').fire('click');assert.equal(app.node('work-pane').hidden,true);
 await runInContext("resultOpen({missionId:'intake',workId:'work:a',recordId:'record:a',version:1,sha256:'a'.repeat(64),title:'Accepted result',segment:1})",app.context);await settle();
 assert.equal(app.node('work-pane').hidden,false);assert.equal(app.node('pane-result').hidden,false);assert.deepEqual(selectedTab(app),['Accepted result']);
});

test('sidebar search filters member names and Work titles locally, preserves member rows and clears on Escape',async()=>{
 const {app}=shellFixture();await settle();assert.ok(opening('sidebar-search'));
 await app.node('sidebar-search').fire('click');assert.equal(app.node('sidebar-query').hidden,false);assert.equal(app.context.document.activeElement,app.node('sidebar-query'));
 const quill=find(app,'side-member-quill'),juno=find(app,'side-member-juno');
 assert.equal(quill.children[0]!.attributes.get('data-shape'),'drop');assert.equal(quill.children[0]!.style.background,'var(--agent-1)');
 const calls=app.calls.length;app.node('sidebar-query').value='  qUiLl  ';await app.node('sidebar-query').fire('input');
 assert.equal(quill.parentElement!.hidden,false);assert.equal(juno.parentElement!.hidden,true);assert.equal(app.node('side-representative').hidden,true);assert.equal(app.node('side-work').children.every(n=>n.hidden),true);
 app.node('sidebar-query').value='Second';await app.node('sidebar-query').fire('input');assert.equal(quill.parentElement!.hidden,true);assert.deepEqual(kids(app.node('side-work')).map(n=>open(n).children[0]!.textContent),['Second']);
 await app.node('activity-toggle').fire('click');assert.deepEqual(titles(app.node('activity-list')),['Second']);
 await key(app,{key:'Escape'});assert.equal(app.node('sidebar-query').value,'');assert.equal(app.node('sidebar-query').hidden,true);assert.equal(app.context.document.activeElement,app.node('sidebar-search'));
 assert.equal(quill.parentElement!.hidden,false);assert.equal(juno.parentElement!.hidden,false);assert.equal(find(app,'side-member-quill'),quill);assert.equal(app.calls.length,calls);
 await app.node('rail-results').fire('click');assert.equal(app.node('sidebar-search').hidden,true);await app.node('rail-chat').fire('click');assert.equal(app.node('sidebar-search').hidden,false);
});

test('the attention dot follows open owner decisions and stays clear for unknown Work and schedule exceptions',async()=>{
 const {app,data,state}=shellFixture();await settle();assert.ok(opening('activity-attention'));
 assert.match(opening('activity-toggle'),/role="switch"/);assert.equal(app.node('activity-attention').hidden,true);
 data.decisions=[{id:'d1',at:1,title:'A decision',question:'Change?',action:'Change',rows:[],state:'open'}];await runInContext('readChat()',app.context);await settle();
 assert.equal(app.node('activity-attention').hidden,false);assert.equal(app.node('activity-toggle').attributes.get('aria-label'),'활동 보기, 확인 필요');
 data.decisions[0].state='later';await runInContext('readChat()',app.context);await settle();assert.equal(app.node('activity-attention').hidden,true);
 state.works=[{workId:'unknown',title:'Unknown payment',execution:'active',acceptance:'pending',started:true}];
 runInContext("shellWorks=[{missionId:'intake',workId:'unknown',title:'Unknown payment',unknown:true,execution:'active',acceptance:'pending'}];renderShell()",app.context);
 assert.equal(app.node('activity-attention').hidden,true);assert.equal(app.node('activity-toggle').attributes.get('aria-label'),'활동 보기');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
 state.works=[];await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(app.node('activity-attention').hidden,true);
 data.exceptions=[{id:'run:1',at:1,title:'Unknown schedule',state:'unknown',fact:'No receipt',scheduleId:'s1',runId:'r1',actions:['check']}];await runInContext('readChat()',app.context);await settle();assert.equal(app.node('activity-attention').hidden,true);
 data.exceptions=[];await runInContext('readChat()',app.context);await settle();assert.equal(app.node('activity-attention').hidden,true);
});

test('member shortcut hints match admission order and keyboard navigation preserves drafts and send guards',async()=>{
 const {app}=shellFixture();await settle();
 assert.match(opening('side-representative'),/aria-keyshortcuts="Meta\+1 Control\+1"/);
 const quill=find(app,'side-member-quill'),juno=find(app,'side-member-juno');assert.equal(quill.children.find(c=>c.tagName==='KBD')?.attributes.get('data-shortcut'),'⌘2');assert.equal(juno.children.find(c=>c.tagName==='KBD')?.attributes.get('data-shortcut'),'⌘3');
 app.node('chat-input').value='Private draft';await app.node('chat-input').fire('input');await key(app,{key:'2',metaKey:true});assert.equal(runInContext('chatThread',app.context),'quill');
 await key(app,{key:'ArrowDown',altKey:true,target:app.node('sidebar')});assert.equal(runInContext('chatThread',app.context),'juno');
 await key(app,{key:'ArrowUp',altKey:true,target:app.node('chat-input')});assert.equal(runInContext('chatThread',app.context),'juno','text editing retains Option-arrow navigation');
 runInContext('chatSending=true',app.context);await key(app,{key:'1',ctrlKey:true});assert.equal(runInContext('chatThread',app.context),'juno');
 runInContext('chatSending=false',app.context);await key(app,{key:'1',ctrlKey:true});assert.equal(runInContext('chatThread',app.context),'');assert.equal(app.node('chat-input').value,'Private draft');
 await key(app,{key:'9',metaKey:true});assert.equal(runInContext('chatThread',app.context),'');
});

test('Work lines expose an expand chevron and keep the existing single-tab opening action',async()=>{
 const {app}=fixture(two);await settle();const line=open(kids(app.node('side-work'))[0]!);
 assert.ok(line.children.some(c=>c.className==='work-chevron'&&c.attributes.get('aria-hidden')==='true'));
 await line.fire('click');await settle();await line.fire('click');await settle();assert.equal(kids(app.node('pane-tabs')).length,1);assert.equal(app.node('work-pane').hidden,false);
});

test('the narrow workspace toggle reopens a pane set aside by page navigation in one click',async()=>{
 const {app}=shellFixture();await settle();runInContext('window.matchMedia=()=>({matches:true})',app.context);
 await runInContext("shellOpenWork('assistant-turn:m:'+ '1'.repeat(32))",app.context);await settle();
 await app.node('rail-results').fire('click');assert.equal(app.node('work-pane').className,'pane away');assert.equal(app.node('header-workspace').attributes.get('aria-pressed'),'false');
 await app.node('header-workspace').fire('click');assert.equal(app.node('work-pane').hidden,false);assert.equal(app.node('work-pane').className,'pane');assert.equal(app.node('header-workspace').attributes.get('aria-pressed'),'true');
});

test('sidebar Work states stay separate from member status and only current unanswered questions imply a decision',async()=>{
 const {app}=fixture([
  {workId:'run',title:'Running',execution:'active',acceptance:'pending',started:true},
  {workId:'wait',title:'Waiting',execution:'waiting',acceptance:'pending',started:true},
  {workId:'question',title:'Question',execution:'waiting',acceptance:'pending',started:true,stored:{questions:[{id:'q1',actorId:'owner',text:'Choose?',answer:null}]}},
  {workId:'check',title:'Review',execution:'waiting',acceptance:'pending',started:true,stored:{artifact:{id:'a1',version:1,sha256:'a'.repeat(64),kind:'text'}}},
  {workId:'failed',title:'Failed',execution:'settled',acceptance:'failed',started:true},
  {workId:'done',title:'Accepted',execution:'settled',acceptance:'accepted',started:true,endedAt:1},
  {workId:'unknown',title:'Unknown',execution:'blocked',acceptance:'pending',started:true,unknown:true}
 ]);await settle();app.node('mission-id').value='intake';await app.submit('load-form');await runInContext('shellWorksLoad()',app.context);await settle();
 const labels=()=>kids(app.node('side-work')).map(li=>open(li).children.find(n=>n.attributes.get('role')==='status')?.textContent);
 assert.deepEqual(labels(),['결과 모름','완료','실패','확인 대기','결정 대기','확인 대기','실행 중']);
 assert.equal(app.node('side-representative-busy').hidden,false);
 const neutral=open(kids(app.node('side-work')).find(li=>li.textContent.startsWith('Review'))!).children.find(n=>n.attributes.get('role')==='status')!;assert.doesNotMatch(neutral.className,/exception/);
 runInContext('snapshot.revision=1;renderShell()',app.context);assert.deepEqual(labels().slice(3,6),['확인 대기','확인 대기','확인 대기'],'old questions cannot imply a current owner decision');
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('member busy and unread marks follow actual Work and clear after the stored change is read',async()=>{
 const {app,state}=shellFixture();await settle();state.works=[{workId:'member-work',title:'Member work',memberId:'quill',execution:'active',acceptance:'pending',started:true}];await runInContext('shellWorksLoad()',app.context);await settle();
 const member=find(app,'side-member-quill'),busy=member.children.find(n=>n.className==='busy-avatar')!,unread=member.children.find(n=>n.className==='unread')!;
 assert.ok(busy);assert.equal(busy.hidden,false);assert.equal(busy.attributes.get('aria-label'),'작업 중');assert.equal(member.children[0]!.hidden,true);assert.equal(unread.hidden,true);
 assert.ok(member.children.indexOf(busy)>member.children.findIndex(n=>n.textContent==='Quill'),'the member name precedes its status in reading order');
 state.works=[{...state.works[0]!,execution:'waiting'}];await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(busy.hidden,false,'a member still holds its pending check');assert.notEqual(runInContext('chatPendingTimer',app.context),0,'waiting keeps the elapsed minute clock');
 state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted'}];await runInContext('shellWorksLoad()',app.context);await settle();
 assert.equal(busy.hidden,true);assert.equal(member.children[0]!.hidden,false);assert.equal(member.children[0]!.attributes.get('data-shape'),'drop');assert.equal(unread.hidden,false);assert.equal(unread.attributes.get('aria-label'),'읽지 않음');assert.equal(app.node('activity-attention').hidden,true);
 await find(app,'side-line-intake/member-work').fire('click');await settle();assert.equal(unread.hidden,true);assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('sidebar toggle name describes its action after normal, wide and narrow visibility changes',async()=>{
 const {app}=fixture(two);await settle();const toggle=app.node('sidebar-toggle');
 await toggle.fire('click');assert.equal(toggle.attributes.get('aria-label'),'사이드바 보기');
 await toggle.fire('click');assert.equal(toggle.attributes.get('aria-label'),'사이드바 숨기기');
 await open(kids(app.node('side-work'))[0]!).fire('click');await settle();await app.node('pane-widen').fire('click');assert.equal(toggle.attributes.get('aria-label'),'사이드바 보기');
 await toggle.fire('click');assert.equal(toggle.attributes.get('aria-label'),'사이드바 숨기기');
 runInContext('shellSide(false)',app.context);assert.equal(toggle.attributes.get('aria-label'),'사이드바 보기');assert.equal(toggle.attributes.get('aria-expanded'),'false');
});

test('workspace opens a stored Work before any tab exists, stays read-only and disappears when its feed is cleared',async()=>{
 const {app}=fixture([{workId:'known',title:'Stored Work',execution:'blocked',acceptance:'pending',started:true,unknown:true}]);await settle();
 assert.equal(kids(app.node('pane-tabs')).length,0);assert.equal(app.node('header-workspace').hidden,false);
 await app.node('header-workspace').fire('click');await settle();assert.equal(app.node('work-pane').hidden,false);assert.deepEqual(selectedTab(app),['Stored Work']);
 assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
 runInContext('shellWorks=[];paneTabs=[];renderShell();renderPane()',app.context);assert.equal(app.node('header-workspace').hidden,true);
});

test('the priority label is an operable menu button and decision summaries use the question without expanding detail rows',async()=>{
 const {app,data}=shellFixture();await settle();data.decisions=[{id:'rounding',at:1,title:'Rounding',question:'Change the rule?',action:'Change',state:'open',rows:[['Current','1/3'],['Proposed','3/3']]}];await runInContext('readChat()',app.context);await settle();
 assert.match(opening('activity-order-label'),/^<button\b/);await app.node('activity-toggle').fire('click');await app.node('activity-order-label').fire('click');assert.equal(app.node('activity-order-menu').hidden,false);
 await app.node('order-recent').fire('click');assert.equal(app.node('activity-order-label').textContent,'최근');assert.equal(app.node('activity-order-label').attributes.get('aria-expanded'),'false');assert.equal(app.context.document.activeElement,app.node('activity-order-label'));
 await app.node('activity-order-label').fire('click');await key(app,{key:'Escape'});assert.equal(app.context.document.activeElement,app.node('activity-order-label'));
 const decision=find(app,'activity-row-decision:rounding');assert.match(decision.textContent,/Rounding.*Change the rule\?/);assert.doesNotMatch(decision.textContent,/Current|Proposed|1\/3|3\/3/);
 await decision.fire('click');await settle();assert.equal(runInContext('chatThread',app.context),'');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('activity keeps member navigation before its list and restores Work lines when switched off',async()=>{
 const {app}=shellFixture();await settle();const member=find(app,'side-member-quill'),works=member.parentElement!.children.find(n=>n.tagName==='UL')!;
 await app.node('activity-toggle').fire('click');assert.equal(app.node('side-people').hidden,false);assert.equal(app.node('side-work').hidden,true);assert.equal(works.hidden,true);assert.equal(app.node('side-activity').hidden,false);
 await app.node('rail-results').fire('click');assert.equal(app.node('side-people').hidden,true);await app.node('rail-chat').fire('click');assert.equal(app.node('side-people').hidden,false);assert.equal(find(app,'side-member-quill'),member);
 await app.node('activity-toggle').fire('click');assert.equal(app.node('side-work').hidden,false);assert.equal(works.hidden,false);assert.equal(app.node('side-activity').hidden,true);
});

test('new decisions stay unread through rereads until explicitly opened, then a changed question becomes unread again',async()=>{
 const {app,data}=shellFixture();await settle();data.decisions=[{id:'new',at:1,title:'New decision',question:'Choose?',action:'Change',state:'open',rows:[]}];await runInContext('readChat()',app.context);await settle();
 const unread=()=>find(app,'activity-row-decision:new').children.some(n=>n.className==='marks'&&n.children.some(c=>c.className==='unread'));
 const row=find(app,'activity-row-decision:new');assert.ok(row.children.findIndex(n=>n.className==='summary')<row.children.findIndex(n=>n.className==='marks'),'the decision summary precedes its unread status in reading order');
 assert.equal(row.attributes.get('aria-label'),'New decision Choose?','the link name and unread status are separate accessible occurrences');
 assert.equal(unread(),true);await runInContext('readChat()',app.context);await settle();assert.equal(unread(),true);
 assert.equal(app.node('activity-attention').hidden,false);await find(app,'activity-row-decision:new').fire('click');await settle();assert.equal(unread(),false);assert.equal(app.node('activity-attention').hidden,true);assert.equal(app.node('activity-toggle').attributes.get('aria-label'),'활동 보기');await runInContext('readChat()',app.context);await settle();assert.equal(unread(),false);assert.equal(app.node('activity-attention').hidden,true);
 assert.ok([...app.storage.keys()].includes('massion.workbench.seen'));
 data.decisions[0].question='A different choice?';await runInContext('readChat()',app.context);await settle();assert.equal(unread(),true);assert.equal(app.node('activity-attention').hidden,false);await row.fire('click');await settle();assert.equal(unread(),true,'a detached old row cannot acknowledge changed decision details');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('first-seen accepted Work stays unread until opened and busy members suppress only the member unread dot',async()=>{
 const {app,state}=shellFixture();await settle();state.works=[{workId:'accepted',title:'Accepted review',memberId:'juno',execution:'settled',acceptance:'accepted',started:true}];await runInContext('shellWorksLoad()',app.context);await settle();
 const member=find(app,'side-member-juno'),dot=member.children.find(n=>n.className==='unread')!;
 assert.equal(dot.hidden,false);assert.equal(JSON.parse(app.storage.get('massion.workbench.seen')!)['intake/accepted'],'');
 await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(dot.hidden,false);assert.equal(app.node('activity-attention').hidden,true);
 state.works=[{...state.works[0]!,execution:'active',acceptance:'pending'}];await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(dot.hidden,true);assert.equal(JSON.parse(app.storage.get('massion.workbench.seen')!)['intake/accepted'],'','busy rendering does not acknowledge Work');
 state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted'}];await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(dot.hidden,false);
 await find(app,'side-line-intake/accepted').fire('click');await settle();assert.equal(dot.hidden,true);assert.equal(JSON.parse(app.storage.get('massion.workbench.seen')!)['intake/accepted'],'완료');assert.equal(app.calls.filter(c=>c.options.method==='POST').length,0);
});

test('a Work tab presents the exact room state, task progress and criteria instead of the Mission dashboard',async()=>{
 const {app}=fixture([{workId:'work:a',title:'Current request',execution:'active',acceptance:'pending',started:true,startedAt:Date.now()-60000,stored:{tasks:[{id:'root',parentId:null,status:'active'},{id:'child',parentId:'root',status:'settled',result:'Recorded result'}]}}]);
 await settle();await openTurn(app,0).fire('click');await settle();
 const room=app.all().find(n=>n.id==='work-card-work:a')!;
 assert.match(room.className,/work-room/);assert.match(room.textContent,/절차/);assert.match(room.textContent,/1\/2/);assert.match(room.textContent,/Recorded result/);
 assert.ok(app.all().some(n=>n.id==='work-room-stop-work:a'&&n.textContent==='중지'));
 await app.node('pane-widen').fire('click');assert.equal(app.node('pane-widen').attributes.get('aria-label'),'좁히기');
 assert.match(room.textContent,/Answer the owner request/);assert.equal(app.node('mission-panel').className,'panel room');
 const now=Date.now()+120000;runInContext('globalThis.Date=class extends Date{static now(){return '+now+'}};renderShell()',app.context);assert.equal(app.all().find(n=>n.id==='work-room-time-work:a')!.textContent,'3분');
 await openTurn(app,0).fire('click');await settle();const stale=app.all().find(n=>n.id==='work-room-stop-work:a')!;await app.node('pane-close').fire('click');await stale.fire('click');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0,'a detached room cannot submit Stop');
});

test('Stop reuses one existing cancellation identity for overlapping clicks and keeps unknown effects unknown',async()=>{
 let finish!:()=>void;const held=new Promise<void>(resolve=>finish=resolve);let posts=0;
 const {app,state}=fixture([{workId:'work:a',title:'Active request',execution:'active',acceptance:'pending',started:true,stored:{effects:[{id:'effect:a',taskId:'root',status:'unknown',target:'Original target',authority:'owner'}]}}],(path,options)=>{
  if(path==='/missions/intake/commands'&&options?.method==='POST'){posts++;return held.then(()=>({}));}
 });
 await settle();await openTurn(app,0).fire('click');await settle();
 await app.tick();const stop=app.all().find(n=>n.id==='work-room-stop-work:a');assert.ok(stop);assert.equal(runInContext('reconnectRequired',app.context),false);
 const one=stop.fire('click'),two=stop.fire('click');await settle();assert.equal(posts,1);finish();await Promise.all([one,two]);await settle();
 const sent=app.calls.filter(c=>c.path==='/missions/intake/commands');assert.equal(sent.length,1);assert.deepEqual(JSON.parse(sent[0]!.options.body).command,{type:'cancel',workId:'work:a'});
 assert.equal((state.works[0]!.stored!.effects as any[])[0].status,'unknown');
 await stop.fire('click');await settle();assert.equal(posts,1,'an unknown response never authorizes another send');
});

test('same-revision Work and Mission tab switches rebuild the matching presentation',async()=>{
 const {app}=fixture([{workId:'a',title:'First',execution:'active',acceptance:'pending',started:true},{workId:'b',title:'Second',execution:'active',acceptance:'pending',started:true}]);
 await settle();await openTurn(app,0).fire('click');await settle();await openTurn(app,1).fire('click');await settle();
 assert.equal(app.all().find(n=>n.id==='work-card-b')!.className,'work-room');
 runInContext("paneOpen('intake','','Owner requests')",app.context);assert.equal(app.all().find(n=>n.id==='work-card-a')!.className,'work-card');assert.equal(app.node('mission-panel').className,'panel');
 await openTurn(app,0).fire('click');await settle();assert.equal(app.all().find(n=>n.id==='work-card-a')!.className,'work-room');
});

test('a historical passed verdict cannot label a new artifact checked',async()=>{
 const {app}=fixture([{workId:'a',title:'Changed result',execution:'active',acceptance:'stale',started:true,stored:{artifact:{id:'artifact:a',version:2,sha256:'new'},verdict:{id:'verdict:a',status:'passed',artifactVersion:1,artifactSha256:'old',criteriaVersion:1,evidence:[]}}}]);
 await settle();await openTurn(app,0).fire('click');await settle();
 assert.equal(app.all().find(n=>n.id==='work-room-check-a')!.textContent,'확인 전');
 const card=app.all().find(n=>n.id==='work-card-a')!;const detail=card.children.find(n=>n.className==='room-detail')!;assert.doesNotMatch(detail.textContent,/1\/1|완료/);
});

test('the Work snapshot retains its end time while the global Work list is behind',async()=>{
 const start=Date.UTC(2026,10,5,0,40),end=start+120000;
 const {app,state}=fixture([{workId:'a',title:'Finished result',execution:'settled',acceptance:'failed',started:true,stored:{endedAt:end,runtimeRun:{id:'run:a',ownership:{startedAt:start}}}}]);
 await settle();await openTurn(app,0).fire('click');await settle();
 assert.equal(app.all().find(n=>n.id==='work-room-time-a')!.textContent,runInContext('chatTime('+start+')+" – "+chatTime('+end+')',app.context));
 state.revision++;runInContext('snapshot.revision++',app.context);runInContext('renderMission()',app.context);assert.equal(app.all().find(n=>n.id==='work-room-time-a')!.textContent,runInContext('chatTime('+start+')+" – "+chatTime('+end+')',app.context));
});

test('a room reads its original handoff from an older segment and rejects late source reads after a tab switch',async()=>{
 const turn=(n:number)=>'assistant-turn:m:'+String(n).repeat(32),source=(n:number)=>({segmentId:'assistant-conversation:1',turnId:turn(n),messageId:'m:'+String(n).repeat(32),memberId:'member-quill',message:{text:'Original '+n}});
 let release!:(body:unknown)=>void,reads=0;
 const {app}=fixture([{workId:'a',title:'First',execution:'active',acceptance:'pending',started:true,stored:{assistantSource:source(1)}},{workId:'b',title:'Second',execution:'active',acceptance:'pending',started:true,stored:{assistantSource:source(2)}}],path=>{
  if(path!=='/assistant/conversation?segment=1')return;
  reads++;if(reads===1)return new Promise(resolve=>release=resolve);
  return {feedId:'feed:a',segment:{number:1,messages:[{id:source(2).messageId,role:'owner',text:'Original 2'}]},turns:[{id:turn(2),messageId:source(2).messageId,at:Date.UTC(2026,10,5,0,42),work:{missionId:'intake',workId:'b',missionRevision:2}}]};
 });
 await settle();await app.tick();await openTurn(app,0).fire('click');await settle();assert.equal(reads,1);
 const old=app.all().find(n=>n.id==='work-room-handoff-a')!;await openTurn(app,1).fire('click');await settle();const current=app.all().find(n=>n.id==='work-room-handoff-b')!;
 assert.equal(current.hidden,false);assert.match(current.textContent,/하나가 넘김/);
 const label=current.textContent;release({feedId:'feed:a',segment:{number:1,messages:[{id:source(1).messageId,role:'owner',text:'Original 1'}]},turns:[{id:turn(1),messageId:source(1).messageId,at:Date.UTC(2026,10,5,0,40),work:{missionId:'intake',workId:'a',missionRevision:2}}]});await settle();assert.equal(old.hidden,true);assert.equal(current.textContent,label);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('a member room shows its assigned failed Work and Close keeps one cancellation after an unknown reply',async()=>{
 let finish!:()=>void;const held=new Promise<void>(resolve=>finish=resolve);let posts=0;
 const {app}=fixture([{workId:'a',title:'Failed request',memberId:'member-quill',execution:'settled',acceptance:'failed',started:true}],(path,options)=>{if(path==='/missions/intake/commands'&&options?.method==='POST'){posts++;return held.then(()=>({}));}});
 await settle();await openTurn(app,0).fire('click');await settle();await app.tick();
 runInContext("chatRep.turns[0].at=Date.now();chatThread='member-quill';chatView={...chatView,turns:[],segment:{...chatView.segment,messages:[]}};renderChat()",app.context);
 const card=app.all().find(n=>n.id==='chat-exception-assistant-turn:m:'+String(1).repeat(32));assert.ok(card);
 const actions=card.children.find(n=>n.className==='chat-actions')!,retry=actions.children[0]!,close=actions.children[1]!;
 await retry.fire('click');await settle();assert.equal(app.node('chat-input').value,'Do Failed request');assert.equal(posts,0);
 const one=close.fire('click'),two=close.fire('click');await settle();assert.equal(posts,1);finish();await Promise.all([one,two]);await settle();await close.fire('click');assert.equal(posts,1);
 runInContext("paneTabs=[];paneActive='';chatThread='';chatView=chatRep;renderChat()",app.context);await close.fire('click');await settle();assert.equal(posts,1,'returning to the Representative cannot resend an unknown cancellation');
});
