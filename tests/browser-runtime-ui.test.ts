import {workCardFacts} from '../src/assistant-service.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {apply,createMission} from '../src/domain.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle,Node} from './support/workbench-client.ts';

const at=Date.UTC(2026,10,10,3),owner={id:'owner',roles:['owner'] as const};
const screenshot={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',width:1,height:1};
const page=(title='Observed checkout')=>({screenshot,readId:'read:1',expectedRevision:1,inputHash:'a'.repeat(64),at,address:'https://shop.example.com/checkout',title,blocks:['Observed item <script>not executable</script>'],fields:[{label:'Recipient',value:'Observed recipient',masked:false},{label:'Card',value:'never show this',masked:true}]});
const request={kind:'payment',adapterId:'fixture-payment',checkoutId:'checkout:1',item:'Toner',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'Shop',origin:'https://shop.example.com',destination:'Saved address',method:'Saved card',expiresAt:Date.now()+60000,cancellation:'Cancel',pagesRead:9,startedAt:at-60000};
function decision(){return {id:'decision:1',at,title:'Order',question:'Pay?',rows:[['Item','Toner']],action:'34,000원 결제',state:'open',effect:{kind:'payment',missionId:'mission:1',workId:'work:1',effectId:'effect:1',status:'pending',request:{...request}}};}
function fixture(){
 let mission=createMission({id:'mission:1',purpose:'Observed Work',scope:'local',constraints:[],criteria:{version:1,description:'Review',oracle:'manual'}},owner);
 mission=apply(mission,{type:'admit-work',workId:'work:1',title:'Order',budget:8},owner).value;
 mission.works[0]!.execution='active';
 const state={feed:'feed:a',revision:2,decisions:[decision()],deadline:undefined as number|undefined,mission:mission as any,session:{id:'browser:1',active:true,startedAt:at-60000,pagesRead:2,page:page()} as any,works:[] as any[],browserStatus:200,browser:undefined as undefined|(()=>Promise<ReturnType<typeof reply>>)};
 state.session.pages=[{...page(),readId:'read:0',at:at-60000},page()];
 state.mission.works[0].browserSession={id:'browser:1',pages:state.session.pages.map(({screenshot,...p}:any)=>p)};
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
 app.context.URL=URL;
 return {app,state};
}
const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
const pane=(app:ReturnType<typeof harness>)=>find(app,'pane-effect');
const checkout=async(app:ReturnType<typeof harness>)=>{const fold=descendants(app.node('chat-log')).find(n=>n.tagName==='BUTTON'&&n.className==='chat-fold')!;await fold.fire('click');await settle();};
const refresh=async(app:ReturnType<typeof harness>)=>{await app.node('chat-latest').fire('click');await settle();};
const openWork=async(app:ReturnType<typeof harness>)=>{await runInContext("paneOpen('mission:1','work:1','Order');loadMission('mission:1')",app.context);await settle();};
function deferred(){let release!:(value:ReturnType<typeof reply>)=>void;const promise=new Promise<ReturnType<typeof reply>>(resolve=>release=resolve);return {promise,release};}

const pageTabs=(app:ReturnType<typeof harness>)=>descendants(app.node('pane-tabs')).filter(n=>n.attributes.get('role')==='tab');
const visibleText=(node:Node):string=>node.hidden||node.className.split(' ').includes('visually-hidden')?'':node.children.length?node.children.map(visibleText).join(''):node.textContent;

test('checkout renders a read-only PNG, one browser tab and a domain pill without visible metadata or form controls',async()=>{
 const {app}=fixture();await settle();await checkout(app);
 const image=find(app,'browser-screenshot');assert.ok(image);assert.equal(image.tagName,'IMG');assert.equal(image.attributes.get('src'),'data:image/png;base64,'+screenshot.data);assert.equal(image.attributes.get('alt'),'브라우저 페이지');
 assert.equal(find(app,'browser-address').textContent,'shop.example.com');assert.equal(find(app,'browser-address').tagName,'SPAN');
 assert.deepEqual(pageTabs(app).map(n=>n.textContent),['브라우저']);assert.equal(descendants(pane(app)).some(n=>n.attributes.get('role')==='tablist'),false);
 assert.doesNotMatch(visibleText(pane(app)),/Recipient|Card|https:/);
 assert.match(find(app,'browser-page-alternative').textContent,/Observed checkout/);assert.match(find(app,'browser-page-alternative').textContent,/••••/);assert.doesNotMatch(pane(app).textContent,/never show this/);
 assert.ok(find(app,'browser-page-alternative').className.includes('visually-hidden'));assert.equal(pane(app).attributes.get('data-session-id'),'browser:1');
 assert.equal(descendants(pane(app)).some(n=>['INPUT','IFRAME','FORM','A','SCRIPT','BUTTON'].includes(n.tagName)),false);
 const query=app.calls.find(c=>c.path.endsWith('/browser'))!;assert.equal(query.path,'/missions/mission%3A1/works/work%3A1/browser');assert.equal(query.options.headers['X-Massion-Feed'],'feed:a');assert.ok([...app.storage.values()].every(value=>!value.includes(screenshot.data))); assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

for(const kind of ['wrong-mime','empty','bad-base64','zero-width','bad-height'])test(kind+' image never falls back to structured page text',async()=>{
 const {app,state}=fixture();state.session.page={...page()};
 if(kind==='legacy')delete state.session.page.screenshot;
 else state.session.page.screenshot={...screenshot,...(kind==='wrong-mime'?{mimeType:'image/svg+xml'}:kind==='empty'?{data:''}:kind==='bad-base64'?{data:'not an image URL'}:kind==='zero-width'?{width:0}:{height:1.5})};
 await settle();await checkout(app);assert.match(pane(app).textContent,/사용 불가/);assert.doesNotMatch(pane(app).textContent,/Observed|Recipient|Card/);assert.equal(descendants(pane(app)).some(n=>n.tagName==='IMG'),false);
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
 assert.doesNotMatch(pane(app).textContent,/Observed checkout|Observed item/);assert.doesNotMatch(pageTabs(app).map(n=>n.textContent).join(' '),/Observed/);
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

test('Work opens its observed image and activity counts only stored pages',async()=>{
 const {app}=fixture();await settle();await openWork(app);
 const open=find(app,'work-browser-work:1');assert.ok(open,'Work needs a browser opener');
 const telemetry=find(app,'work-browser-pages-work:1');assert.equal(telemetry.textContent,'페이지 2개 읽음');
 const activity=find(app,'work-browser-activity-work:1');assert.match(activity.textContent,/페이지 2개 읽음/);
 await open.fire('click');await settle();assert.equal(pane(app).hidden,false);assert.match(pane(app).textContent,/Observed checkout/);
 assert.ok(find(app,'browser-screenshot'));assert.equal(pageTabs(app).length,2);
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

test('generic browser tabs use observed titles and select the matching image with keyboard navigation',async()=>{
 const {app,state}=fixture();state.mission.works[0].browserSession.pages=[{...page('이용 안내'),readId:'read:0',at:at-60000},{...page('빈 시간'),readId:'read:1'}, {...page('신청'),readId:'read:2'}];
 state.mission.works[0].browserSession.pages[1].screenshot={...screenshot,width:2};
 state.session={...state.session,pagesRead:3,pages:structuredClone(state.mission.works[0].browserSession.pages),page:state.mission.works[0].browserSession.pages[2]};
 state.mission.works[0].browserSession.pages=state.mission.works[0].browserSession.pages.map(({screenshot,...p}:any)=>p);
 await settle();await openWork(app);await find(app,'work-browser-work:1').fire('click');await settle();
 const tabs=pageTabs(app);assert.deepEqual(tabs.map(n=>n.textContent),['이용 안내','빈 시간','신청']);
 await find(app,'browser-page-tab-1').fire('click');assert.match(pane(app).textContent,/빈 시간/);assert.equal(find(app,'browser-page-tab-1').attributes.get('aria-selected'),'true');
 assert.equal(find(app,'browser-member').children[1]!.textContent,'하나');assert.equal(find(app,'browser-screenshot').attributes.get('width'),'2');
 assert.notEqual(find(app,'browser-member').className,'pane-people');
 const keydown=find(app,'browser-page-tab-1').listeners.get('keydown')![0]!;keydown({key:'ArrowRight',preventDefault(){}});assert.equal(find(app,'browser-page-tab-2').attributes.get('aria-selected'),'true');
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
 assert.ok(fold>=0);assert.ok(response>fold,'The recorded browser fold must precede the response and Copy action');const stored=(fixture.routes['/missions/intake']!.body as any).value.works.find((w:any)=>w.effects.some((e:any)=>e.status==='unknown'));assert.ok(log.children[fold]!.textContent.includes('페이지 '+stored.browserSession.pages.length+'개 읽음'));
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

for(const kind of ['generic','checkout'])for(const change of ['revision','mission'])test(kind+' browser tab rebinds on explicit selection after '+change+' changes',async()=>{
 const {app,state}=fixture();await settle();await openWork(app);if(kind==='generic')await find(app,'work-browser-work:1').fire('click');else await checkout(app);await settle();
 const key=runInContext('paneActive',app.context) as string;assert.match(pane(app).textContent,/Observed checkout/);
 if(change==='revision'){state.revision++;runInContext('snapshot.revision++;renderShell()',app.context);}else runInContext("paneOpen('other','other-work','Other');selectedId='other';snapshot={revision:99,value:{id:'other',works:[]}};renderPane()",app.context);
 await runInContext('paneSelect('+JSON.stringify(key)+')',app.context);await settle();assert.match(pane(app).textContent,/Observed checkout/);assert.equal(runInContext('selectedId',app.context),'mission:1');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('opening checkout ignores the revision of an unrelated selected Mission',async()=>{
 const {app}=fixture();await settle();runInContext("selectedId='other';snapshot={revision:999,value:{id:'other',works:[]}}",app.context);await checkout(app);assert.match(pane(app).textContent,/Observed checkout/);assert.equal(find(app,'browser-address').textContent,'shop.example.com');assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});


test('checkout ignores a previously selected historical page and always shows the current image',async()=>{
 const {app,state}=fixture();state.session.pages[0]={...page('Old observation'),readId:'read:0',screenshot:{...screenshot,width:2}};
 await settle();await openWork(app);await find(app,'work-browser-work:1').fire('click');await settle();await find(app,'browser-page-tab-0').fire('click');assert.equal(find(app,'browser-screenshot').attributes.get('width'),'2');
 await checkout(app);assert.equal(find(app,'browser-screenshot').attributes.get('width'),'1');assert.deepEqual(pageTabs(app).map(n=>n.textContent),['브라우저']);
});

test('generic browser uses validated response history when no snapshot history matches',async()=>{
 const {app,state}=fixture();state.works=[{missionId:'mission:1',missionRevision:2,workId:'work:1',title:'Order',turnId:'turn:1',memberId:null,started:true,unknown:false,execution:'active',acceptance:'pending',browser:{startedAt:at-60000,pagesRead:2}}];await settle();await openWork(app);delete state.mission.works[0].browserSession;
 state.session.pages=[{...page('이용 안내'),readId:'read:0'},state.session.page];
 await find(app,'work-browser-work:1').fire('click');await settle();
 assert.deepEqual(pageTabs(app).map(n=>n.textContent),['이용 안내','Observed checkout']);
 state.session.pages[1]={...page('Different latest'),readId:'read:other'};
 await runInContext('browserClear();renderPane()',app.context);await settle();assert.deepEqual(pageTabs(app).map(n=>n.textContent),['Observed checkout']);
});

for(const identity of ['representative','member','unknown'])test(identity+' actor uses the recorded Work identity without inventing an unknown member',async()=>{
 const {app,state}=fixture();state.works=[{missionId:'mission:1',missionRevision:2,workId:'work:1',title:'Order',turnId:'turn:1',memberId:identity==='representative'?null:identity==='member'?'member:1':'missing',started:true,unknown:false,execution:'active',acceptance:'pending'}];
 await settle();await checkout(app);const member=app.all().find(n=>n.id==='browser-member');
 if(identity==='unknown')assert.equal(member,undefined);else{assert.ok(member);assert.equal(member.children[1]!.textContent,identity==='representative'?'하나':'민수');assert.equal(member.parentElement?.id,'browser-page');}
});

for(const execution of ['active','waiting','queued','settled','blocked'])test(execution+' Work only shows live browser chat activity while actively running',async()=>{
 const {app}=fixture();await settle();await openWork(app);
 const node=runInContext('chatTurnState('+JSON.stringify({id:'turn:activity',displayStatus:'replied',work:{missionId:'mission:1',workId:'work:1',started:execution!=='queued',unknown:false,execution,acceptance:'pending'}})+')',app.context) as Node;
 if(execution==='active')assert.equal(node.textContent,'작업 중 · 페이지 2개 읽음');else assert.doesNotMatch(node.textContent,/페이지/);
 const noReads=runInContext("chatTurnState({id:'no-reads',displayStatus:'replied',work:{missionId:'mission:1',workId:'other',started:true,unknown:false,execution:'active',acceptance:'pending'}})",app.context) as Node;assert.doesNotMatch(noReads.textContent,/페이지/);
});


test('an image load failure shows the bounded sanitized fallback',async()=>{
 const {app}=fixture();await settle();await checkout(app);await find(app,'browser-screenshot').fire('error');assert.match(find(app,'browser-page').textContent,/이미지는 작업 후 보관하지 않아요/);assert.doesNotMatch(find(app,'browser-page').textContent,/never show this/);
});


for(const displayStatus of ['unknown','not_started','failed'])test(displayStatus+' turn cannot be relabelled as live browser activity',async()=>{
 const {app}=fixture();await settle();await openWork(app);
 const node=runInContext('chatTurnState('+JSON.stringify({id:'turn:status',displayStatus,work:{missionId:'mission:1',workId:'work:1',started:true,unknown:false,execution:'active',acceptance:'pending'}})+')',app.context) as Node;assert.doesNotMatch(node.textContent,/작업 중|페이지/);
});

test('response history takes precedence over an older snapshot history',async()=>{
 const {app,state}=fixture();state.session.pages=[{...page('응답의 이용 안내'),readId:'response:0'},state.session.page];
 await settle();await openWork(app);await find(app,'work-browser-work:1').fire('click');await settle();assert.deepEqual(pageTabs(app).map(n=>n.textContent),['응답의 이용 안내','Observed checkout']);
});

for(const reason of ['settled','cancelled','waiting','disconnect'])test('live image is removed on '+reason,async()=>{const {app,state}=fixture();await settle();await openWork(app);await find(app,'work-browser-work:1').fire('click');await settle();assert.ok(find(app,'browser-screenshot'));if(reason==='disconnect')runInContext('requireReconnect()',app.context);else{state.mission.works[0].execution=reason;await runInContext("loadMission('mission:1')",app.context);await settle();}assert.equal(descendants(pane(app)).some(n=>n.tagName==='IMG'),false);assert.equal(runInContext('!!browserRead?.session?.page?.screenshot',app.context),false);});

test('history renders only sanitized structure after restart without a live image',async()=>{const {app,state}=fixture();delete state.session.page.screenshot;state.session.pages=state.session.pages.map(({screenshot,...p}:any)=>p);await settle();await checkout(app);assert.equal(descendants(pane(app)).some(n=>n.tagName==='IMG'),false);assert.match(pane(app).textContent,/Observed checkout/);assert.match(pane(app).textContent,/••••/);assert.doesNotMatch(pane(app).textContent,/never show this/);});

for(const pending of [false,true])test('narrow navigation clears images and rejects '+(pending?'in-flight':'cached')+' pixels',async()=>{
 const {app,state}=fixture();runInContext('window.matchMedia=()=>({matches:true})',app.context);const hold=deferred();if(pending)state.browser=()=>hold.promise;
 await settle();await checkout(app);if(!pending)assert.ok(find(app,'browser-screenshot'));
 runInContext("shellShow('settings')",app.context);assert.equal(runInContext('paneVisible()',app.context),false);
 if(pending){hold.release(reply({feedId:state.feed,revision:2,session:state.session}));await settle();}
 assert.equal(runInContext('browserRead===null',app.context),true);assert.equal(descendants(pane(app)).some(n=>n.tagName==='IMG'),false);
});

test('no-image cards deduplicate and bound excerpts, keeping masked labels and markers together',async()=>{
 const {app,state}=fixture();const observed={...page('주문 / 결제'),screenshot:undefined,blocks:['주문 / 결제','주문 / 결제','장바구니','상품 설명입니다','상품 설명입니다',...Array.from({length:12},(_,i)=>'보관한 내용 '+i+' '.repeat(i))],fields:[{label:'결제 수단',value:'do not display',masked:true}]};state.session.page=observed;state.session.pages=[observed];state.session.pagesRead=1;
 await settle();await checkout(app);const content=find(app,'browser-page'),nodes=descendants(content);assert.equal(nodes.filter(n=>n.tagName==='H3'&&n.textContent==='주문 / 결제').length,1);assert.equal(nodes.filter(n=>n.className==='browser-excerpt').length,3);assert.equal(content.textContent.split('주문 / 결제').length-1,1);assert.match(content.textContent,/이미지는 작업 후 보관하지 않아요/);assert.doesNotMatch(content.textContent,/do not display|장바구니/);
 const label=nodes.find(n=>n.tagName==='DT'&&n.textContent==='결제 수단')!;assert.ok(label);assert.match(label.parentElement!.textContent,/결제 수단.*••••.*가림/);
});

test('empty structural observations show a non-retention notice without a blank page or invented heading',async()=>{
 const {app,state}=fixture();state.session.page={...page(''),screenshot:undefined,blocks:['','  '],fields:[]};state.session.pages=[state.session.page];state.session.pagesRead=1;await settle();await checkout(app);
 const content=find(app,'browser-page');assert.match(content.textContent,/이미지는 작업 후 보관하지 않아요/);assert.equal(descendants(content).some(n=>['H3','DL','IMG'].includes(n.tagName)),false);assert.equal(find(app,'browser-address').textContent,'shop.example.com');assert.equal(pane(app).textContent,'shop.example.com페이지 이미지는 작업 후 보관하지 않아요.');
});

test('page-read evidence uses stored title, domain and timestamp without replacing named procedures',async()=>{
 const {app}=fixture();await settle();await openWork(app);const steps=find(app,'work-browser-evidence-work:1');assert.ok(steps);assert.equal(steps.children.length,2);assert.match(steps.textContent,/Observed checkout.*shop.example.com/);assert.equal(descendants(steps).filter(n=>n.tagName==='TIME').length,2);assert.doesNotMatch(steps.textContent,/https:|checkout\//);
});

for(const live of [false,true])test('private-tainted pane uses host copy only with '+(live?'ephemeral pixels':'no retained image'),async()=>{
 const {app,state}=fixture(),p={readId:'private:1',expectedRevision:1,inputHash:'a'.repeat(64),at,address:'https://shop.example.com',tainted:true,summary:{textBlocks:3,frames:0,privateFields:1,fields:[{kind:'number',length:3,private:true}]},...(live?{screenshot}:{})};state.session.page=p;state.session.pages=[p];state.session.pagesRead=1;state.mission.works[0].browserSession.pages=[{...p,screenshot:undefined}];
 await settle();await checkout(app);assert.equal(descendants(pane(app)).some(n=>n.tagName==='IMG'),live);assert.equal(find(app,'browser-address').textContent,'shop.example.com');assert.match(find(app,'browser-page-alternative').textContent,/비공개 페이지.*비공개 입력값이 있어 상세 내용은 보관하지 않아요/);assert.doesNotMatch(pane(app).textContent,/Observed|Recipient|Card|456/);assert.ok([...app.storage.values()].every(value=>!value.includes(screenshot.data)));
});

test('Work steps and effects render only typed environment facts with pinned labels, including false facts',async()=>{
 const {app,state}=fixture(),work=state.mission.works[0];
 work.runtimeRun={environment:{definition:{facts:[{id:'submitted',label:'전송 상태',kind:'state'},{id:'confirmed',label:'접수 확인',kind:'order-confirmation'}]}}};
 work.tasks.push({id:'task:observed',parentId:work.tasks[0].id,status:'active',step:{title:'관찰',role:'확인',dependsOn:[]},environment:{records:[{index:0,at,kind:'observed',observation:{observationId:'observation:1',facts:{submitted:true,confirmed:false,undeclared:true},pageReadId:'read:1'}}]}});
 state.session.page=page('Page text claims everything is confirmed');await settle();await openWork(app);
 const card=find(app,'work-card-work:1'),step=find(app,'work-step-work:1-task:observed');assert.match(step.textContent,/전송 상태 · 확인됨/);assert.match(step.textContent,/접수 확인 · 미확인/);
 assert.doesNotMatch(card.textContent,/undeclared|Page text claims|결제 완료/);assert.ok(find(app,'work-browser-work:1'));assert.equal(find(app,'work-browser-evidence-work:1'),undefined);
 app.context.environmentSummary={id:'turn:observed',work:{missionId:'mission:1',workId:'work:1',missionRevision:2,title:'양식 작성',started:true,execution:'active',acceptance:'pending',...workCardFacts(work)}};const summary=runInContext('chatCard(environmentSummary)',app.context);assert.match(summary.textContent,/전송 상태 확인됨/);assert.match(summary.textContent,/접수 확인 미확인/);assert.match(runInContext('shellResultSummary(environmentSummary.work)',app.context),/접수 확인 미확인/);
 const facts=descendants(card).filter(n=>n.className==='room-field');assert.ok(facts.some(n=>n.textContent.includes('전송 상태확인됨')));assert.ok(facts.some(n=>n.textContent.includes('접수 확인미확인')));
});
test('environment effects show declared deliveries and unexecuted intents without duplicate provider rows',async()=>{
 const {app,state}=fixture(),work=state.mission.works[0],intent={kind:'payment-intent',payee:'공급처',amountMinor:100,currency:'USD',purpose:'신청',sourceReference:'work:work:1'};
 work.runtimeRun={environment:{definition:{facts:[],elements:[{id:'pay',gates:[{kind:'payment',intent}]}]}}};work.tasks.push({id:'task:environment',parentId:work.tasks[0].id,status:'settled',step:{title:'내부 단계',role:'확인',dependsOn:[]},environment:{plan:{operations:[{kind:'act',element:'pay'}]},records:[{kind:'intent-approved',index:0,at,approvedAt:at,reference:{id:'entry'}}]}});
 work.effects=[{id:'model-call',taskId:'task:environment',status:'succeeded',target:'Fixture provider',authority:'grant',providerDispatch:{}},{id:'observed',taskId:'task:environment',status:'succeeded',target:'Observation',authority:'environment-observation:read'},{id:'delivered',taskId:'task:environment',status:'succeeded',target:'신청서 제출',authority:'environment:hash'}];
 await settle();await openWork(app);const card=find(app,'work-card-work:1'),effects=descendants(card).find(n=>n.className.includes('room-section')&&n.children[0]?.textContent==='전송 1회 보장')!;assert.ok(effects);assert.match(effects.textContent,/신청서 제출완료/);assert.match(effects.textContent,/공급처1.00 USD승인됨 · 미실행/);assert.doesNotMatch(effects.textContent,/내부 단계|Fixture provider|Observation/);
});
test('live page telemetry opens the retained browser and detached links cannot cross a thread',async()=>{
 const {app}=fixture();await settle();await openWork(app);app.context.observedTurn={id:'turn:live',displayStatus:'running',work:{missionId:'mission:1',workId:'work:1',missionRevision:2,title:'Order',started:true,execution:'active',acceptance:'pending'}};
 const link=runInContext('chatTurnState(observedTurn)',app.context);assert.equal(link.attributes.get('role'),'link');await link.fire('click');await settle();assert.equal(pane(app).hidden,false);assert.match(pane(app).textContent,/Observed checkout/);
 const reads=app.calls.length;runInContext("chatThread='different';++chatGeneration",app.context);await link.fire('click');await settle();assert.equal(app.calls.length,reads);
});
test('recorded room statements expose the existing Copy action with their exact quoted grounds',async()=>{
 const {app,state}=fixture();state.mission.works[0].room={messages:[{kind:'proposal',text:'관찰된 결과',quote:'주문 확인',at,status:'admitted',assignmentId:'fixture'}]};app.context.copied=[];runInContext('navigator.clipboard={writeText:async text=>copied.push(text)}',app.context);await settle();await openWork(app);
 const transcript=app.all().find(n=>n.className==='room-transcript')!,copy=descendants(transcript).find(n=>n.tagName==='BUTTON'&&n.attributes.get('aria-label')==='복사');assert.ok(copy);await copy.fire('click');await settle();assert.deepEqual(Array.from(app.context.copied as string[]),['관찰된 결과\n주문 확인']);
});
test('native environment details retain an unknown provider outcome',async()=>{
 const {app,state}=fixture(),work=state.mission.works[0];work.runtimeRun={environment:{definition:{facts:[],elements:[]}}};
 work.tasks.push({id:'task:read',parentId:work.tasks[0].id,status:'active',step:{title:'결과 조회',role:'조회',dependsOn:[]}});
 work.effects=[{id:'call',taskId:'task:read',status:'unknown',target:'fixture',authority:'grant',providerDispatch:{}}];work.execution='blocked';
 await settle();await openWork(app);const effects=app.all().find(n=>n.className.includes('room-section')&&n.children[0]?.textContent==='전송 1회 보장')!;assert.ok(effects);assert.match(effects.textContent,/결과 조회/);assert.match(effects.textContent,/결과 모름/);
 const identity=app.all().find(n=>n.className==='room-worker-identity'&&n.textContent.includes('결과 조회'))!;assert.ok(identity);assert.match(identity.textContent,/결과 모름/);assert.doesNotMatch(identity.textContent,/실행 중/);
});
