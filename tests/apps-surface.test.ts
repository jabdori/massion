import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {copy} from '../src/ui-copy.ts';
import {loadFixture} from '../scripts/ui-contracts/fixture-host.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

const sequence=(...parts:string[])=>new RegExp(parts.map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*'));

// docs/architecture/apps.md, Surface: Settings > Apps (B23, B23-github), the install card (B24, B24-done), the rail and app page (B22) and the Work room tab (B22-room).
const sourceFixture=await loadFixture('B23');
const T0=Date.UTC(2026,10,5,10,31);
const perms={read:['Repositories','Pull requests','Check results'],write:[],network:['api.github.com'],files:['Work folder · read'],secrets:[{slot:'github-token',label:'GitHub token'}],events:['PR opened','PR merged']};
const github={id:'app-github',name:'GitHub',origin:'catalog',memberId:null,version:'1.4.0',enabled:true,installedAt:T0,check:null,permissions:perms,contributes:{page:{title:'GitHub'},roomTab:{prefix:'PR #'},templates:['Code review'],skills:['PR summary'],procedures:['PR review'],tools:['gh']},versions:[{index:1,version:'1.3.2',at:T0-2*86400000,current:false},{index:2,version:'1.4.0',at:T0,current:true}]};
const page={title:'GitHub',meta:'jabdori/massion',groups:[{title:'Open',rows:[{id:'84',title:'feat(assistant): answer the owner and start Representative Work',meta:'#84 · 2026-11-05 10:28',state:'Open'}]},{title:'Merged',rows:[{id:'83',title:'feat(assistant): store the continuing assistant conversation',meta:'#83',state:'Merged'}]}]};
const item={title:'feat(assistant): answer the owner and start Representative Work #84',meta:'Open · jabdori · feat/assistant-conversation-turns → main',groups:[{title:'Files 2',rows:[{id:'src/assistant-service.ts',title:'src/assistant-service.ts',meta:'+206 −0'}]}],fields:[['Changes','+769 −39']]};
function fixture(installed=true,decisions:any[]=[],extra:any[]=[],members:any[]=[],rail:any[]=[{id:'app-github',name:'GitHub',page:true,item:true,roomTab:'PR #'}],view?:(body:any,headers:Record<string,string>)=>unknown,installedApp=github){
 const posted:{path:string;body:any}[]=[];
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'&&path==='/assistant/apps/view'){const b=JSON.parse(options.body);if(view)return reply(await view(b,options.headers??{}));return reply(b.app==='app-github'&&b.handler==='page'&&b.ref===undefined?page:b.handler==='item'&&b.ref==='84'?item:{error:'x'});}
  if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return reply({status:'committed',revision:2});}
  if(path==='/assistant/apps')return reply({feedId:'feed:a',revision:3,apps:installed?[installedApp,...extra]:[],catalog:[{id:'github',name:'GitHub',description:'Pull requests',installed}]});
  if(path==='/missions/intake')return reply(structuredClone(sourceFixture.routes[path]!.body));
  if(path==='/assistant/schedules')return reply({feedId:'feed:a',revision:1,schedules:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members,decisions,apps:installed?rail:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });
 return {app,posted};
}
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found;};
const open=async(app:ReturnType<typeof harness>)=>{await app.node('me-settings').fire('click');await settle();await app.node('settings-nav-apps').fire('click');await settle();};

test('Settings > Apps lists installed apps and the catalog; Install asks in the Representative conversation',async()=>{
 const {app,posted}=fixture(false);await settle();await open(app);
 const body=app.node('settings-apps-body');assert.match(body.textContent,sequence(copy('ui.settings.installed-count',{count:0}),copy('settings.text.03'),copy('settings.heading.13'),'GitHub','Pull requests',copy('settings.link.04')));
 await button(body,copy('settings.link.04'))[0]!.fire('click');await settle();
 assert.deepEqual([posted.at(-1)!.path,posted.at(-1)!.body.action,posted.at(-1)!.body.catalogId],['/assistant/apps','install','github']);
 assert.equal(app.node('page-chat').hidden,false,'the card is answered in the conversation');
});

test('an installed app opens its page: permissions, what it adds, versions with roll back, and turn off',async()=>{
 const {app,posted}=fixture();await settle();await open(app);
 const body=app.node('settings-apps-body');assert.match(body.textContent,sequence(copy('ui.settings.installed-count',{count:1}),'GitHub','1.4.0',copy('ui.panel.on')));assert.doesNotMatch(body.textContent,sequence(copy('settings.heading.13')),'nothing left to recommend');
 await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 const detail=app.node('settings-apps-body');
 assert.match(detail.textContent,sequence('‹ '+copy('ui.apps'),'GitHub','1.4.0 · ',copy('settings.link.05'),copy('settings.button.04')));
 assert.match(detail.textContent,sequence(copy('sidebar.heading.01'),copy('ui.panel.tools'),'Repositories · Pull requests · Check results',copy('settings.text.02'),'api.github.com',copy('sidebar.button.14'),'Work folder · read',copy('settings.text.05'),'GitHub token',copy('settings.text.04'),'PR opened · PR merged'));
 assert.match(detail.textContent,sequence(copy('settings.heading.12'),copy('ui.panel.member-templates'),'Code review',copy('settings.heading.07'),'PR summary',copy('settings.heading.09'),'PR review',copy('ui.panel.tools'),'gh',copy('ui.panel.screens'),'GitHub · '+copy('ui.panel.app-tab',{title:'PR'})));
 assert.match(detail.textContent,sequence(copy('settings.heading.04'),'1.4.0',copy('ui.panel.current-version',{date:''}),'1.3.2',copy('settings.button.13')));
 assert.doesNotMatch(detail.textContent,/assistant|Lead|sandbox/i);
 await button(detail,copy('settings.button.13'))[0]!.fire('click');await settle();assert.deepEqual([posted.at(-1)!.body.action,posted.at(-1)!.body.appId,posted.at(-1)!.body.version],['rollback','app-github',1]);
 await button(app.node('settings-apps-body'),copy('settings.button.04'))[0]!.fire('click');await settle();assert.deepEqual(posted.at(-1)!.body.action,'disable');
});

test('the install card shows its detail line and rows; the done line offers Remove',async()=>{
 const card={id:'app-decision:1',at:T0,title:'GitHub',question:'Install GitHub app?',detail:'GitHub · 1.4.0',rows:[['Read','Repositories · Pull requests'],['Write','None']],action:'Install',state:'open'};
 const {app,posted}=fixture(false,[card]);await settle();
 const node=app.all().find(n=>n.id==='chat-decision-app-decision:1')!;assert.match(node.textContent,sequence('Install GitHub app?','GitHub · 1.4.0','Read','Repositories · Pull requests','Write','None',copy('settings.link.04'),copy('conversation.button.04')));
 await button(node,copy('settings.link.04'))[0]!.fire('click');await settle();assert.deepEqual([posted.at(-1)!.path,posted.at(-1)!.body.answer],['/assistant/decisions','act']);
 const done=fixture(true,[{...card,state:'done',line:'GitHub app installed',remove:'app-github'}]);await settle();
 const line=done.app.all().find(n=>n.id==='chat-system-app-decision:1')!;assert.match(line.textContent,sequence('GitHub app installed',copy('conversation.link.24')));
 await button(line,copy('conversation.link.24'))[0]!.fire('click');await settle();assert.deepEqual([done.posted.at(-1)!.path,done.posted.at(-1)!.body.action,done.posted.at(-1)!.body.appId],['/assistant/apps','remove','app-github']);
});

test('an installed app adds a rail icon; its page lists the app view in the sidebar and opens an item; a matching Work gets the app tab',async()=>{
 const {app,posted}=fixture();await settle();
 const rail=app.node('rail-apps');assert.equal(rail.hidden,false);const icon=rail.children[0]!;assert.equal(icon.attributes.get('aria-label'),'GitHub');assert.equal(icon.children[0]!.className,'app-branch');assert.equal(icon.children[0]!.textContent,'');assert.equal(icon.children[0]!.attributes.get('aria-hidden'),'true');
 await icon.fire('click');await settle();
 assert.equal(app.node('page-app').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(icon.attributes.get('aria-current'),'page');
 const side=app.node('side-app');assert.equal(side.hidden,false);assert.match(side.textContent,sequence('GitHub','jabdori/massion',copy('sidebar.text.01'),'feat(assistant): answer the owner','#84',copy('sidebar.button.07'),copy('sidebar.link.12')));
 await app.all().find(n=>n.id==='app-row-84')!.fire('click');await settle();
 assert.match(app.node('app-view').textContent,sequence('answer the owner and start Representative Work #84',copy('sidebar.text.01'),'jabdori','+769 −39',copy('ui.pages.files',{count:2}),'src/assistant-service.ts','+206'));
 assert.doesNotMatch(app.node('app-view').textContent,/변경|−0/);
 // The Work room tab: a Work whose title names PR #84 gets a second tab drawn by the app.
 (app.context as any).paneOpen('mission:m','work:w','PR #84 review');await settle();
 const tabs=app.node('pane-tabs').children.map(t=>t.children[0]!.textContent);assert.deepEqual(tabs,['PR #84 review','PR #84']);
 await app.node('pane-tabs').children[1]!.children[0]!.fire('click');await settle();
 assert.equal(app.node('pane-app').hidden,false);assert.equal(app.node('pane-body').hidden,true);assert.match(app.node('pane-app').textContent,/파일 2/);
 const source=button(app.node('pane-app'),'GitHub')[0];assert.ok(source,'the app item has a source navigation control before its heading');
 assert.equal(app.node('pane-app').children[0],source);
 await source.fire('click');await settle();assert.equal(app.node('page-app').hidden,false);assert.equal(posted.length,0);
 await button(side,copy('sidebar.link.12'))[0]!.fire('click');await settle();assert.equal(app.node('page-settings').hidden,false);assert.match(app.node('settings-apps-body').textContent,sequence(copy('sidebar.heading.01')));
});

test('GitHub file deltas retain counts, omit zero deletions and draw only valid bounded proportions',async()=>{
 const {app}=fixture(true,[],[],[],undefined,b=>b.handler==='page'?page:{title:'PR #84',groups:[{title:'Files 4',rows:[{id:'a',title:'a.ts',meta:'+12 −3'},{id:'b',title:'b.ts',meta:'+0 −0'},{id:'c',title:'c.ts',meta:'opaque metadata'},{id:'d',title:'d.ts',meta:'+3 −0'}]}]});await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 const view=app.node('app-view');assert.match(view.textContent,/\+12 −3.*\+0.*opaque metadata/);assert.doesNotMatch(view.textContent,/−0/);
 const bars=app.all().filter(n=>n.className==='app-diff-bar');assert.equal(bars.length,3);
 assert.deepEqual(bars.map(b=>b.children.map(n=>n.style.width)),[['80%','20%'],['0%','0%'],['20%','0%']]);
});

test('app sidebar search and a folded merged group preserve real row selection without product writes',async()=>{
 const {app,posted}=fixture();await settle();await app.node('rail-apps').children[0]!.fire('click');await settle();
 const byId=(id:string)=>app.all().find(n=>n.id===id)!;
 assert.equal(app.node('sidebar-search').hidden,false);
 assert.equal(byId('app-row-83'),undefined);await byId('app-group-1').fire('click');assert.ok(byId('app-row-83'));
 app.node('sidebar-query').value='nothing matches';await app.node('sidebar-query').fire('input');assert.equal(byId('app-row-84'),undefined);
 assert.deepEqual(posted,[]);
});

test('removing the selected app returns shared search before clearing its sidebar',async()=>{
 const {app}=fixture();await settle();await app.node('rail-apps').children[0]!.fire('click');await settle();
 runInContext('appsList=[];renderAppSide()',app.context);
 assert.equal(app.node('sidebar-search').parentElement?.id,'sidebar-controls');
 await app.node('rail-chat').fire('click');assert.equal(app.node('page-chat').hidden,false);
});

test('generic app rows retain provider metadata and state',async()=>{
 const {app}=fixture(true,[],[],[],[{id:'app-notes',name:'Notes',page:true,item:false,roomTab:null}],()=>({title:'Notes',groups:[{title:'Recent',rows:[{id:'n1',title:'First note',meta:'Saved',state:'Failed'}]}]}));await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 assert.match(app.node('side-app').textContent,/First note.*Saved · Failed/);
});

test('self-made apps are listed apart with their maker and source Work',async()=>{
 const made={...github,id:'app-made',name:'PR list fetcher',origin:'self-made',memberId:'member-juno',version:'0.1.0',source:{missionId:'intake',workId:'pr84',title:'PR #84 review'},contributes:{templates:[],skills:[],procedures:[],tools:['pr-list']}};
 const {app}=fixture(true,[],[made],[{id:'member-juno',name:'주노',shape:'round'}]);await settle();await open(app);
 assert.match(app.node('settings-apps-body').textContent,sequence(copy('ui.settings.installed-count',{count:1}),'GitHub',copy('ui.settings.self-made-count',{count:1}),'PR list fetcher','0.1.0 · '+copy('ui.panel.made-by',{member:'주노'})+' · PR #84 review',copy('ui.panel.on')));
 const headings=app.node('settings-apps-body').children.filter(n=>n.tagName==='H3');assert.deepEqual(headings.map(n=>n.textContent),['설치됨 1','직접 만든 앱 1']);assert.ok(headings.every(n=>n.children.length===1),'counts are separate spans for approved spacing');assert.deepEqual(headings.map(n=>n.children[0]!.textContent),['1','1']);
 const source=button(app.node('settings-apps-body'),'PR #84 review ›')[0];assert.ok(source,'the recorded source Work is navigable');
 for(let parent=source.parentElement;parent;parent=parent.parentElement)assert.notEqual(parent.tagName,'BUTTON','source actions are never nested in an app button');
 await source.fire('click');await settle();assert.equal(app.node('page-chat').hidden,false);assert.equal(app.calls.some(c=>c.path==='/missions/intake'),true);
 assert.equal(app.node('pane-tabs').children[0]!.children[0]!.textContent,'PR #84 review');
 assert.ok(app.all().find(n=>n.id==='work-card-pr84'),'the recorded source Work is loaded into the existing pane');
 assert.equal(app.calls.some(c=>c.options?.method==='POST'&&c.path!=='/assistant/apps/view'),false);
});

test('a page-only app shows its page view and asks for no item; a page without rows shows its fields',async()=>{
 const asked:any[]=[],notes={title:'Notes',meta:'Today',fields:[['Owner','jabdori']],groups:[{title:'Recent',rows:[{id:'n1',title:'First note'}]}]};
 const {app}=fixture(true,[],[],[],[{id:'app-notes',name:'Notes',page:true,item:false,roomTab:null}],b=>{asked.push(b);return notes;});await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 assert.deepEqual(asked.map(b=>b.handler),['page'],'no item request for an app without an item handler');
 assert.match(app.node('app-view').textContent,/Notes.*Today.*Owner.*jabdori.*Recent.*First note/);
 const empty=fixture(true,[],[],[],undefined,b=>({title:'GitHub',fields:[['Repository','jabdori/massion']],groups:[]}));await settle();
 await empty.app.node('rail-apps').children[0]!.fire('click');await settle();assert.match(empty.app.node('app-view').textContent,/GitHub.*Repository.*jabdori\/massion/);
});

test('a late page response for an earlier open never replaces the app shown now',async()=>{
 const pending:(()=>void)[]=[],views:Record<string,any>={'app-a':{title:'A page',groups:[{title:'A',rows:[{id:'1',title:'A row'}]}]},'app-b':{title:'B page',groups:[{title:'B',rows:[{id:'2',title:'B row'}]}]}};const asked:any[]=[];
 const {app}=fixture(true,[],[],[],[{id:'app-a',name:'A',page:true,item:true,roomTab:null},{id:'app-b',name:'B',page:true,item:true,roomTab:null}],b=>{asked.push(b);return b.handler==='item'?{title:b.app+' item '+b.ref,groups:[]}:new Promise(done=>pending.push(()=>done(views[b.app])));});await settle();
 const [a,b]=app.node('rail-apps').children;await a!.fire('click');await b!.fire('click');await settle();
 pending[1]!();await settle();pending[0]!();await settle();
 // Selecting a row draws the sidebar again from the shared page.
 await app.all().find(n=>n.id==='app-row-2')!.fire('click');await settle();
 assert.match(app.node('side-app').textContent,/B page.*B row/);assert.doesNotMatch(app.node('side-app').textContent,/A row/);
 assert.deepEqual(asked.filter(x=>x.handler==='item').map(x=>[x.app,x.ref]),[['app-b','2'],['app-b','2']]);assert.match(app.node('app-view').textContent,/app-b item 2/);
});

test('app views carry the database feed: the page asks with the conversation feed, its rows with the feed the page came from',async()=>{
 const asked:[string,string|undefined][]=[];
 const {app}=fixture(true,[],[],[],undefined,(b,h)=>{asked.push([b.handler,h['X-Massion-Feed']]);return b.handler==='page'?{...page,feedId:'feed:page'}:item;});await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 await app.all().find(n=>n.id==='app-group-1')!.fire('click');await app.all().find(n=>n.id==='app-row-83')!.fire('click');await settle();
 assert.deepEqual(asked,[['page','feed:a'],['item','feed:page'],['item','feed:page']]);
});

test('every app read draws only its newest request: an item selected A, B, A again and a room tab left and reopened',async()=>{
 const pending:{b:any;done:()=>void}[]=[];
 const {app}=fixture(true,[],[],[],undefined,b=>b.handler==='page'?page:new Promise(done=>{const n=pending.length+1;pending.push({b,done:()=>done({title:'item '+b.ref+' #'+n,groups:[]})});}));await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 await app.all().find(n=>n.id==='app-group-1')!.fire('click');
 const row=(id:string)=>app.all().find(n=>n.id==='app-row-'+id)!;
 await row('83').fire('click');await row('84').fire('click');await settle();
 // The first row opens with the page (#1); then 83 (#2), 84 (#3), 84 again (#4). The newest answers first; the older ones arrive late.
 await row('84').fire('click');await settle();pending[3]!.done();await settle();pending[1]!.done();pending[2]!.done();pending[0]!.done();await settle();
 assert.equal(app.node('app-view').textContent,'item 84 #4');
 pending.length=0;
 (app.context as any).paneOpen('mission:m','work:w','PR #84 review');await settle();
 const tabs=app.node('pane-tabs').children;await tabs[1]!.children[0]!.fire('click');await settle();await tabs[0]!.children[0]!.fire('click');await settle();await tabs[1]!.children[0]!.fire('click');await settle();
 pending[1]!.done();await settle();pending[0]!.done();await settle();
 assert.equal(app.node('pane-app').children.find(n=>n.tagName==='H2')?.textContent,'item 84 #2');assert.doesNotMatch(app.node('pane-app').textContent,/#1/);
});

test('a late Settings > Apps read never replaces a newer one',async()=>{
 const pending:(()=>void)[]=[];let reads=0;
 const app=harness(async(path,options)=>{
  if(path==='/assistant/apps'&&!options?.method){const n=++reads;return new Promise(done=>pending.push(()=>done(reply({feedId:'feed:a',revision:n,apps:[{...github,version:n===1?'old':'1.4.0'}],catalog:[]}))));}
  if(path==='/assistant/schedules')return reply({feedId:'feed:a',revision:1,schedules:[]});
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,members:[],decisions:[],apps:[],segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });await settle();
 await open(app);await app.node('settings-nav-apps').fire('click');await settle();
 pending[1]!();await settle();pending[0]!();await settle();
 assert.match(app.node('settings-apps-body').textContent,/1\.4\.0/);assert.doesNotMatch(app.node('settings-apps-body').textContent,/old/);
});

test('a self-made install card opens its exact source Work without installing',async()=>{
 const source={missionId:'intake',workId:'w-done',title:'PR #84 review'},card={id:'app-decision:source',at:T0,title:'PR list fetcher',question:'Install?',rows:[['Source',source.title]],source,action:'Install',state:'open'};
 const {app,posted}=fixture(false,[card]);await settle();
 const node=app.all().find(n=>n.id==='chat-decision-app-decision:source')!,link=button(node,'PR #84 review ›')[0];assert.ok(link);
 await link.fire('click');await settle();assert.equal(app.node('work-pane').hidden,false);assert.ok(app.calls.some(c=>c.path==='/missions/intake'));assert.equal(posted.length,0);
});

test('Settings app search filters loaded installed, self-made and recommended rows without a request or focus loss',async()=>{
 const made={...github,id:'app-made',name:'PR list fetcher',origin:'self-made',memberId:'member-juno',source:{missionId:'intake',workId:'w-done',title:'PR #84 review'}};
 const {app}=fixture(true,[],[made],[{id:'member-juno',name:'주노'}]);await settle();await open(app);
 const search=app.all().find(n=>n.id==='settings-app-search');assert.ok(search,'the approved app search is present');
 assert.equal(search.type,'search');assert.equal(search.attributes.get('aria-label'),copy('settings.textbox.01'));
 const row=(id:string)=>app.all().find(n=>n.id==='settings-app-'+id)!;
 const calls=app.calls.length;search.focus();search.value='  PR #84  ';await search.fire('input');
 assert.equal(row('app-github').hidden,true);assert.equal(row('app-made').hidden,false);
 assert.equal((app.context as any).document.activeElement,search);assert.equal(app.calls.length,calls);
 search.value='GITHUB';await search.fire('input');assert.equal(row('app-github').hidden,false);assert.equal(row('app-made').hidden,true);
 search.value='';await search.fire('input');assert.equal(row('app-made').hidden,false);
 const catalog=fixture(false);await settle();await open(catalog.app);
 const find=catalog.app.all().find(n=>n.id==='settings-app-search')!;
 const install=button(catalog.app.node('settings-apps-body'),copy('settings.link.04'))[0]!;
 find.value='missing';await find.fire('input');assert.equal(install.parentElement!.hidden,true);
 find.value='pull requests';await find.fire('input');assert.equal(install.parentElement!.hidden,false);
 assert.equal(catalog.posted.length,0);
});

test('Settings contributions use the host page title and an existing Open action without inventing a list or member bindings',async()=>{
 const data={...github,contributes:{...github.contributes,page:{title:'Release notes'}}};
 const {app}=fixture(true,[],[],[],undefined,undefined,data);await settle();await open(app);
 await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 const body=app.node('settings-apps-body');assert.match(body.textContent,sequence(copy('ui.panel.screens'),'Release notes',copy('ui.panel.app-tab',{title:'PR'})));
 assert.doesNotMatch(body.textContent,/Release notes 목록|주노|퀼/);
 const link=button(body,copy('settings.link.06'))[0];assert.ok(link,'the contributed page has a real Open action');
 await link.fire('click');await settle();assert.equal(app.node('page-app').hidden,false);
 assert.equal(app.calls.some(c=>c.path==='/assistant/apps/view'),true);
});

test('Settings app detail never reveals secret values or claims an unproduced credential state',async()=>{
 const sentinel='private-value-must-stay-in-host';
 const data={...github,permissions:{...perms,secrets:[{...perms.secrets[0]!,value:sentinel}]},tokenStatus:'expired'};
 const {app}=fixture(true,[],[],[],undefined,undefined,data);await settle();await open(app);
 await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 const body=app.node('settings-apps-body');assert.match(body.textContent,/GitHub token/);assert.doesNotMatch(body.textContent,new RegExp(sentinel+'|저장됨|만료됨'));
 assert.equal(button(body,copy('settings.button.06')).length,0);
 assert.equal(app.all().filter(n=>n.type==='password'&&body.contains(n)).length,0);
 assert.equal(app.node('app-connect-panel').hidden,true);assert.equal(app.node('app-connect-token').value,'');
 assert.equal(JSON.stringify([...app.storage.values(),...app.calls.map(c=>c.options?.body??'')]).includes(sentinel),false);
});

test('overlapping Settings app commands send once and keep unknown outcomes read-only',async()=>{
 for(const action of ['install','disable','rollback']){
  const {app,posted}=fixture(action!=='install');await settle();await open(app);
  if(action!=='install'){await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();}
  const original=(app.context as any).request;let release!:()=>void;
  const gate=new Promise<void>(done=>{release=done;});
  (app.context as any).request=async(path:string,options:any)=>{const result=await original(path,options);if(path==='/assistant/apps'&&options?.method==='POST'){await gate;throw Error('Response lost');}return result;};
  const label=copy(action==='install'?'settings.link.04':action==='disable'?'settings.button.04':'settings.button.13');
  const control=button(app.node('settings-apps-body'),label)[0]!;
  await control.fire('click');await control.fire('click');await settle();
  assert.equal(posted.length,1,action+' is admitted only once while busy');assert.equal(posted[0]!.body.action,action);assert.ok(posted[0]!.body.commandId);
  release();await settle();assert.equal(posted.length,1,'a lost response never triggers a resend');
 }
});

test('GitHub links use exact host review identities and show retained commits',async()=>{
 const target={repository:'jabdori/massion',number:84,headSha:'cf2a4b325b3954e04ba4a4e3ddfa58ded8b6de66',url:'https://github.com/jabdori/massion/pull/84'};
 const review={missionId:'intake',workId:'pr84',title:'PR #84 검토',memberId:'member-juno',progress:{done:4,total:11},reading:true,deadlineAt:Date.now()+60000};
 const {app,posted}=fixture(true,[],[],[{id:'member-juno',name:'주노'}],undefined,b=>b.handler==='page'?{...page,groups:[{...page.groups[0],rows:[{...page.groups[0]!.rows[0],github:target,reviews:[review]}]},page.groups[1]]}:{...item,github:target,reviews:[review],groups:[...item.groups,{title:'Commits 1',rows:[{id:target.headSha,title:'Change',meta:'cf2a4b3 · 2026-11-05 10:28'}]}]});await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 const external=app.all().find(n=>n.tagName==='A'&&n.attributes.get('href')===target.url);assert.ok(external);assert.equal(external.attributes.get('rel'),'noopener noreferrer');
 assert.match(app.node('side-app').textContent,/주노가 보는 중/);assert.match(app.node('app-view').textContent,/PR #84 검토 주노 · 실행 중 읽기 4\/11.*작업 중.*커밋 1.*Change.*10:28/);
 const link=app.all().find(n=>n.attributes.get('role')==='link'&&n.textContent.startsWith('PR #84 검토'));assert.ok(link);await link.fire('click');await settle();
 assert.equal(app.calls.some(c=>c.path==='/missions/intake'),true);assert.equal(posted.length,0);
});

test('a replaced database invalidates pending GitHub reads and clears cached review context',async()=>{
 let release!:(value:unknown)=>void;
 const {app}=fixture(true,[],[],[],undefined,b=>b.handler==='page'?new Promise(done=>{release=done;}):item);await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 runInContext('appsRail({feedId:"feed:b",apps:[]})',app.context);release(page);await settle();
 assert.doesNotMatch(app.node('side-app').textContent,/feat\(assistant\)/);assert.equal(app.node('app-view').textContent,'');
});

test('binding a PR sends once, retains unknown locks and releases confirmed rejections for an owner retry',async()=>{
 for(const failure of ['none','unknown','capture-reject','attach-reject']){
  const {app}=fixture();await settle();
  (app.context as any).bindFailure=failure;
  runInContext(`
   globalThis.bindCalls=[];globalThis.bindRelease=null;
   globalThis.bindTab={key:'review-tab',appTab:{id:'app-github',ref:'84',missionId:'intake',workId:'fresh'}};
   globalThis.bindView={github:{repository:'jabdori/massion',number:84,headSha:'a'.repeat(40),url:'https://github.com/jabdori/massion/pull/84'}};
   snapshot={revision:1,value:{id:'intake',documents:[],works:[{id:'fresh',execution:'queued',acceptance:'pending',effects:[],assignments:[],attempts:[{status:'queued'}],tasks:[{status:'queued'}]}]}};
   selectedId='intake';feedId='feed:a';paneActive=bindTab.key;busy=false;loading=false;reconnectRequired=false;unknownOperation=null;recoveryProblem=null;
   write=async(path,body)=>{bindCalls.push({path,body});if(path.endsWith('/documents')){await new Promise(done=>{bindRelease=done;});if(bindFailure==='unknown'){unknownOperation={commandId:body.commandId};return false;}if(bindFailure==='capture-reject')return false;snapshot.value.documents.push({...body.document,contentSha256:'b'.repeat(64)});snapshot.revision++;}if(path.endsWith('/work-source')&&bindFailure==='attach-reject')return false;return true;};
   globalThis.bindButton=document.createElement('button');
   void appsBindReview(bindTab,bindView,bindButton);void appsBindReview(bindTab,bindView,bindButton);
  `,app.context);await settle();
  assert.equal((app.context as any).bindCalls.length,1);(app.context as any).bindRelease();await settle();
  const calls=(app.context as any).bindCalls;assert.equal(calls.length,['unknown','capture-reject'].includes(failure)?1:2);
  const doc=JSON.parse(calls[0].body.document.content);assert.equal(doc.headSha,'a'.repeat(40));assert.equal(doc.format,'github-review/v1');
  if(['none','attach-reject'].includes(failure)){assert.equal(calls[1].path,'/missions/intake/work-source');assert.equal(calls[1].body.expectedRevision,2);assert.equal(calls[1].body.workId,'fresh');}
  assert.equal(runInContext("appBindings.has('feed:a:intake/fresh')",app.context),['none','unknown'].includes(failure));
  if(failure.endsWith('reject')){assert.equal((app.context as any).bindButton.disabled,false);(app.context as any).bindFailure='none';const count=calls.length;runInContext('void appsBindReview(bindTab,bindView,bindButton)',app.context);await settle();assert.equal(calls.length,count+1);(app.context as any).bindRelease();await settle();assert.equal(calls.length,count+2);}
 }
});

test('the catalog update control reuses install admission and the owner decision path',async()=>{
 const old={...github,update:{catalogId:'github',version:'1.4.1'}};
 const {app,posted}=fixture(true,[],[],[],undefined,undefined,old);await settle();await open(app);await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 await button(app.node('settings-apps-body'),copy('ui.action.update'))[0]!.fire('click');await settle();assert.equal(posted.length,1);assert.equal(posted[0]!.body.action,'install');assert.equal(posted[0]!.body.catalogId,'github');
});

test('a completed page refresh preserves a PR selected while that refresh was pending',async()=>{
 let pages=0,release!:(value:unknown)=>void;
 const {app}=fixture(true,[],[],[],undefined,b=>b.handler==='page'?(++pages===1?page:new Promise(done=>release=done)):{title:'Selected PR '+b.ref,groups:[]});await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();runInContext('void appsRefresh()',app.context);await settle();
 await app.all().find(n=>n.id==='app-group-1')!.fire('click');await app.all().find(n=>n.id==='app-row-83')!.fire('click');await settle();assert.equal(app.node('app-view').textContent,'Selected PR 83');
 release(page);await settle();assert.equal(app.node('app-view').textContent,'Selected PR 83');assert.equal(runInContext('appItem',app.context),'83');
});
