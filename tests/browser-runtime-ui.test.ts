import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {apply,createMission} from '../src/domain.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle,Node} from './support/workbench-client.ts';

const at=Date.UTC(2026,10,10,3),owner={id:'owner',roles:['owner'] as const};
const page=(title='Observed checkout')=>({readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at,address:'https://shop.example.com/checkout',title,blocks:['Observed item <script>not executable</script>'],fields:[{label:'Recipient',value:'Observed recipient',masked:false},{label:'Card',value:'never show this',masked:true}]});
const request={kind:'payment',adapterId:'fixture-payment',checkoutId:'checkout:1',item:'Toner',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'Shop',origin:'https://shop.example.com',destination:'Saved address',method:'Saved card',expiresAt:Date.now()+60000,cancellation:'Cancel',pagesRead:9,startedAt:at-60000};
function decision(){return {id:'decision:1',at,title:'Order',question:'Pay?',rows:[['Item','Toner']],action:'34,000원 결제',state:'open',effect:{kind:'payment',missionId:'mission:1',workId:'work:1',effectId:'effect:1',status:'pending',request:{...request}}};}
function fixture(){
 let mission=createMission({id:'mission:1',purpose:'Observed Work',scope:'local',constraints:[],criteria:{version:1,description:'Review',oracle:'manual'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'work:1',title:'Order',budget:8},owner).value;
 const state={feed:'feed:a',revision:2,decisions:[decision()],deadline:undefined as number|undefined,mission:mission as any,session:{id:'browser:1',startedAt:at-60000,pagesRead:2,page:page()} as any,works:[] as any[],browserStatus:200,browser:undefined as undefined|(()=>Promise<ReturnType<typeof reply>>)};
 state.mission.works[0].browserSession={id:'browser:1',pages:[{...page(),readId:'read:0',at:at-60000},page()]};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST')return reply({error:'No writes in browser UI tests'},405);
  if(path.endsWith('/browser'))return state.browser?state.browser():reply({feedId:state.feed,revision:state.revision,session:state.session},state.browserStatus);
  if(path.startsWith('/assistant/conversation'))return reply({feedId:state.feed,cursor:1,head:1,runDeadlineAt:state.deadline,members:[{id:'member:1',name:'민수'}],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],decisions:path.includes('member=')?[]:state.decisions});
  if(path==='/assistant/works')return reply({feedId:state.feed,works:state.works});
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:1,snapshot:path.includes('mission=')?{revision:state.revision,value:state.mission}:null});
  if(path==='/missions/mission%3A1')return reply({revision:state.revision,value:state.mission});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  return reply({},503);
 });
 return {app,state};
}
const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
const pane=(app:ReturnType<typeof harness>)=>find(app,'pane-effect');
const checkout=async(app:ReturnType<typeof harness>)=>{const fold=descendants(app.node('chat-log')).find(n=>n.tagName==='BUTTON'&&n.className==='chat-fold')!;await fold.fire('click');await settle();};
const refresh=async(app:ReturnType<typeof harness>)=>{await app.node('chat-latest').fire('click');await settle();};
const openWork=async(app:ReturnType<typeof harness>)=>{await runInContext("paneOpen('mission:1','work:1','Order');loadMission('mission:1')",app.context);await settle();};
function deferred(){let release!:(value:ReturnType<typeof reply>)=>void;const promise=new Promise<ReturnType<typeof reply>>(resolve=>release=resolve);return {promise,release};}

 test('checkout shows only observed text and readonly masked fields through the existing decision binding',async()=>{
 const {app}=fixture();await settle();await checkout(app);
 assert.match(pane(app).textContent,/Observed checkout/);assert.match(pane(app).textContent,/<script>not executable<\/script>/);
 assert.equal(find(app,'browser-address').value,'https://shop.example.com/checkout');
 const inputs=descendants(pane(app)).filter(n=>n.tagName==='INPUT');assert.equal(inputs.length,3);assert.ok(inputs.every(n=>(n as any).readOnly===true));
 assert.equal(find(app,'browser-field-0').value,'Observed recipient');assert.equal(find(app,'browser-field-1').value,'••••');assert.ok(!inputs.some(n=>n.value.includes('never show')));
 assert.match(pane(app).textContent,/페이지 2개 읽음/);assert.equal(pane(app).attributes.get('data-session-id'),'browser:1');assert.doesNotMatch(pane(app).textContent,/browser:1/);assert.equal(descendants(pane(app)).some(n=>['IFRAME','FORM','A','SCRIPT'].includes(n.tagName)),false);
 const query=app.calls.find(c=>c.path.endsWith('/browser'))!;assert.equal(query.path,'/missions/mission%3A1/works/work%3A1/browser');assert.equal(query.options.headers['X-Massion-Feed'],'feed:a');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

for(const kind of ['none','failure','malformed','wrong-feed','old-revision'])test(kind+' observation leaves checkout unavailable without fabricating page data',async()=>{
 const {app,state}=fixture();if(kind==='none')state.session=null;if(kind==='failure')state.browserStatus=503;if(kind==='malformed')state.session.page.fields=null;
 if(kind==='wrong-feed')state.browser=async()=>reply({feedId:'feed:b',revision:2,session:state.session});
 if(kind==='old-revision')state.browser=async()=>reply({feedId:state.feed,revision:-1,session:state.session});
 await settle();await checkout(app);assert.match(pane(app).textContent,/사용 불가/);assert.doesNotMatch(pane(app).textContent,/Observed checkout|Toner|Saved address/);
});

test('newer browser read wins when the older response finishes last',async()=>{
 const {app,state}=fixture(),first=deferred(),second=deferred();await settle();let reads=0;state.browser=()=>++reads===1?first.promise:second.promise;
 await checkout(app);await checkout(app);
 second.release(reply({feedId:state.feed,revision:2,session:{...state.session,page:page('Newest page')}}));await settle();assert.match(pane(app).textContent,/Newest page/);
 first.release(reply({feedId:state.feed,revision:2,session:{...state.session,page:page('Old page')}}));await settle();assert.match(pane(app).textContent,/Newest page/);assert.doesNotMatch(pane(app).textContent,/Old page/);
});

for(const change of ['feed','thread','decision','decision-change','tab','epoch'])test(change+' change clears a shown page and rejects a held browser response',async()=>{
 const {app,state}=fixture();await settle();await checkout(app);assert.match(pane(app).textContent,/Observed checkout/);
 const hold=deferred();state.browser=()=>hold.promise;await checkout(app);
 if(change==='feed'){state.feed='feed:b';await refresh(app);}
 if(change==='thread'){runInContext("chatOpenThread('member:1','민수');chatOpenThread('')",app.context);await settle();}
 if(change==='decision'){state.decisions=[];await refresh(app);}
 if(change==='decision-change'){state.decisions[0]!.effect.request.total=35000;await refresh(app);}
 if(change==='tab')runInContext("paneOpen('mission:1','other','Other')",app.context);
 if(change==='epoch')runInContext('requireReconnect();renderShell()',app.context);
 assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);
 hold.release(reply({feedId:'feed:a',revision:2,session:state.session}));await settle();assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);
});

for(const deadline of ['payment','run'])test(deadline+' deadline clears a cached page without an event and fences late replies',async()=>{
 const {app,state}=fixture();let now=Date.now();app.context.Date=class extends Date{static override now(){return now;}};
 const timers=new Map<number,{run:()=>void;delay:number}>();let next=0;app.context.setTimeout=(run:()=>void,delay:number)=>{timers.set(++next,{run,delay});return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 if(deadline==='payment')state.decisions[0]!.effect.request.expiresAt=now+30000;else state.deadline=now+30000;
 await settle();await checkout(app);assert.match(pane(app).textContent,/Observed checkout/);
 const due=[...timers.values()].filter(t=>t.delay>0&&t.delay<=31000);assert.ok(due.length);now+=31000;for(const timer of due)timer.run();await settle();
 assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('Work opens a generic browser tab and activity counts only stored pages',async()=>{
 const {app}=fixture();await settle();await openWork(app);
 const open=find(app,'work-browser-work:1');assert.ok(open,'Work needs a browser opener');
 const telemetry=find(app,'work-browser-pages-work:1');assert.equal(telemetry.textContent,'페이지 2개 읽음');
 const activity=find(app,'work-browser-activity-work:1');assert.match(activity.textContent,/페이지 2개 읽음/);
 await open.fire('click');await settle();assert.equal(pane(app).hidden,false);assert.match(pane(app).textContent,/Observed checkout/);
 assert.ok(find(app,'pane-tab-browser:mission:1/work:1'));assert.equal(find(app,'browser-field-0').value,'Observed recipient');
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('a detached Work browser opener cannot read a replaced snapshot',async()=>{
 const {app}=fixture();await settle();await openWork(app);const open=find(app,'work-browser-work:1');assert.ok(open);
 runInContext('snapshot.revision++;renderMission()',app.context);const count=app.calls.filter(c=>c.path.endsWith('/browser')).length;await open.fire('click');await settle();assert.equal(app.calls.filter(c=>c.path.endsWith('/browser')).length,count);
});

test('conversation fold derives read telemetry and first-read time from the stored Work',async()=>{
 const {app}=fixture();await settle();await openWork(app);
 const node=runInContext("chatFold({id:'turn:1',work:{missionId:'mission:1',workId:'work:1',startedAt:0,endedAt:0}})",app.context) as Node;
 assert.match(node.textContent,/페이지 2개 읽음/);
});

test('generic browser tabs use only stored page titles and keep selected observed fields readonly',async()=>{
 const {app,state}=fixture();state.mission.works[0].browserSession.pages=[{...page('Search results'),readId:'read:0',at:at-60000},{...page('Library form'),readId:'read:1'}, {...page('Review request'),readId:'read:2'}];
 state.session={...state.session,pagesRead:3,page:state.mission.works[0].browserSession.pages[2]};
 await settle();await openWork(app);await find(app,'work-browser-work:1').fire('click');await settle();
 const tabs=descendants(pane(app)).filter(n=>n.attributes.get('role')==='tab');assert.deepEqual(tabs.map(n=>n.textContent),['Search results','Library form','Review request']);
 await find(app,'browser-page-tab-1').fire('click');assert.match(pane(app).textContent,/Library form/);assert.equal(find(app,'browser-page-tab-1').attributes.get('aria-selected'),'true');
 assert.equal(find(app,'browser-member').children[1]!.textContent,'하나');assert.equal((find(app,'browser-field-0') as any).readOnly,true);
});

test('an unknown payment retains its committed browser fold with no second payment action',async()=>{
 const {app,state}=fixture();state.decisions[0]!.effect.status='unknown';await settle();await openWork(app);await refresh(app);
 const fold=descendants(app.node('chat-log')).find(n=>n.tagName==='BUTTON'&&n.className==='chat-fold'&&n.textContent.includes('페이지 2개 읽음'));assert.ok(fold);
 await fold.fire('click');await settle();assert.match(pane(app).textContent,/Observed checkout/);assert.equal(descendants(app.node('chat-log')).some(n=>n.tagName==='BUTTON'&&n.textContent==='34,000원 결제'),false);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});


test('an unknown payment fold uses committed summary telemetry before a Mission is selected',async()=>{
 const {app,state}=fixture();state.decisions[0]!.effect.status='unknown';state.works=[{missionId:'mission:1',missionRevision:2,workId:'work:1',title:'Order',turnId:'turn:1',memberId:null,started:true,unknown:true,execution:'blocked',acceptance:'pending',browser:{startedAt:at-60000,pagesRead:2}}];await settle();
 assert.equal(runInContext('snapshot',app.context),null);
 const fold=descendants(app.node('chat-log')).find(n=>n.tagName==='BUTTON'&&n.className==='chat-fold'&&n.textContent.includes('페이지 2개 읽음'));assert.ok(fold);await fold.fire('click');await settle();assert.match(pane(app).textContent,/Observed checkout/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});


test('historical unknown Work folds and activity use stored summary reads without selecting a Mission',async()=>{
 const {app,state}=fixture();state.decisions=[];const work={missionId:'mission:1',missionRevision:2,workId:'work:1',title:'Order',turnId:'turn:1',memberId:null,started:true,unknown:true,execution:'blocked',acceptance:'pending',browser:{startedAt:at-60000,pagesRead:2}};state.works=[work];await settle();
 assert.equal(runInContext('snapshot',app.context),null);assert.match(app.node('activity-list').textContent,/페이지 2개 읽음/);
 const fold=runInContext('chatFold('+JSON.stringify({id:'turn:1',work})+')',app.context) as Node;assert.match(fold.textContent,/페이지 2개 읽음/);
});

for(const deadline of ['payment','run'])test(deadline+' expiry rejects an in-flight page even if no refresh event arrives',async()=>{
 const {app,state}=fixture();let now=Date.now();app.context.Date=class extends Date{static override now(){return now;}};
 if(deadline==='payment')state.decisions[0]!.effect.request.expiresAt=now+30000;else state.deadline=now+30000;
 const hold=deferred();state.browser=()=>hold.promise;await settle();await checkout(app);now+=31000;
 hold.release(reply({feedId:state.feed,revision:2,session:state.session}));await settle();assert.match(pane(app).textContent,/사용 불가/);assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);
});

test('a generic page read cannot return into a newer Work revision',async()=>{
 const {app,state}=fixture();await settle();await openWork(app);const hold=deferred();state.browser=()=>hold.promise;
 await find(app,'work-browser-work:1').fire('click');await settle();runInContext('snapshot.revision++;renderShell()',app.context);
 hold.release(reply({feedId:state.feed,revision:2,session:state.session}));await settle();assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);
});


test('a historical browser fold precedes the unknown-result reply and its Copy button',async()=>{
 const fixture=await loadFixture('B5'),app=harness(async path=>{const r=fixture.routes[path]??(path.startsWith('/events?')?fixture.routes['/events']:undefined);return r?reply(r.body,r.status):reply({},503);});app.context.Date=class extends Date{static override now(){return fixture.now;}};await settle();
 const log=app.node('chat-log'),fold=log.children.findIndex(n=>n.className==='chat-fold'),response=log.children.findIndex(n=>n.className==='chat-reply');
 assert.ok(fold>=0);assert.ok(response>fold,'The recorded browser fold must precede the response and Copy action');assert.match(log.children[fold]!.textContent,/페이지 4개 읽음/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

for(const kind of ['generic','checkout'])for(const change of ['revision','mission'])test(kind+' browser tab rebinds on explicit selection after '+change+' changes',async()=>{
 const {app,state}=fixture();await settle();await openWork(app);if(kind==='generic')await find(app,'work-browser-work:1').fire('click');else await checkout(app);await settle();
 const key=runInContext('paneActive',app.context) as string;assert.match(pane(app).textContent,/Observed checkout/);
 if(change==='revision'){state.revision++;runInContext('snapshot.revision++;renderShell()',app.context);}else runInContext("paneOpen('other','other-work','Other');selectedId='other';snapshot={revision:99,value:{id:'other',works:[]}};renderPane()",app.context);
 await runInContext('paneSelect('+JSON.stringify(key)+')',app.context);await settle();assert.match(pane(app).textContent,/Observed checkout/);assert.equal(runInContext('selectedId',app.context),'mission:1');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
