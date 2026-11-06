import test from 'node:test';
import assert from 'node:assert/strict';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/apps.md, Surface: Settings > Apps (B23, B23-github), the install card (B24, B24-done), the rail and app page (B22) and the Work room tab (B22-room).
const T0=Date.UTC(2026,10,5,10,31);
const perms={read:['Repositories','Pull requests','Check results'],write:[],network:['api.github.com'],files:['Work folder · read'],secrets:[{slot:'github-token',label:'GitHub token'}],events:['PR opened','PR merged']};
const github={id:'app-github',name:'GitHub',origin:'catalog',memberId:null,version:'1.4.0',enabled:true,installedAt:T0,check:null,permissions:perms,contributes:{page:{title:'GitHub'},roomTab:{prefix:'PR #'},templates:['Code review'],skills:['PR summary'],procedures:['PR review'],tools:['gh']},versions:[{index:1,version:'1.3.2',at:T0-2*86400000,current:false},{index:2,version:'1.4.0',at:T0,current:true}]};
const page={title:'GitHub',meta:'jabdori/massion',groups:[{title:'Open',rows:[{id:'84',title:'feat(assistant): answer the owner and start Representative Work',meta:'#84 · 2026-11-05 10:28',state:'Open'}]},{title:'Merged',rows:[{id:'83',title:'feat(assistant): store the continuing assistant conversation',meta:'#83',state:'Merged'}]}]};
const item={title:'feat(assistant): answer the owner and start Representative Work #84',meta:'Open · jabdori · feat/assistant-conversation-turns → main',groups:[{title:'Files 2',rows:[{id:'src/assistant-service.ts',title:'src/assistant-service.ts',meta:'+206 −0'}]}],fields:[['Changes','+769 −39']]};
function fixture(installed=true,decisions:any[]=[],extra:any[]=[],members:any[]=[],rail:any[]=[{id:'app-github',name:'GitHub',page:true,item:true,roomTab:'PR #'}],view?:(body:any,headers:Record<string,string>)=>unknown){
 const posted:{path:string;body:any}[]=[];
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'&&path==='/assistant/apps/view'){const b=JSON.parse(options.body);if(view)return reply(await view(b,options.headers??{}));return reply(b.app==='app-github'&&b.handler==='page'&&b.ref===undefined?page:b.handler==='item'&&b.ref==='84'?item:{error:'x'});}
  if(options?.method==='POST'){posted.push({path,body:JSON.parse(options.body)});return reply({status:'committed',revision:2});}
  if(path==='/assistant/apps')return reply({feedId:'feed:a',revision:3,apps:installed?[github,...extra]:[],catalog:[{id:'github',name:'GitHub',description:'Pull requests',installed}]});
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
 const body=app.node('settings-apps-body');assert.match(body.textContent,/Installed.*None.*Recommended.*GitHub.*Pull requests.*Install/);
 await button(body,'Install')[0]!.fire('click');await settle();
 assert.deepEqual([posted.at(-1)!.path,posted.at(-1)!.body.action,posted.at(-1)!.body.catalogId],['/assistant/apps','install','github']);
 assert.equal(app.node('page-chat').hidden,false,'the card is answered in the conversation');
});

test('an installed app opens its page: permissions, what it adds, versions with roll back, and turn off',async()=>{
 const {app,posted}=fixture();await settle();await open(app);
 const body=app.node('settings-apps-body');assert.match(body.textContent,/Installed 1.*GitHub.*1\.4\.0.*On/);assert.doesNotMatch(body.textContent,/Recommended/,'nothing left to recommend');
 await app.all().find(n=>n.id==='settings-app-app-github')!.fire('click');await settle();
 const detail=app.node('settings-apps-body');
 assert.match(detail.textContent,/‹ Apps.*GitHub.*1\.4\.0 · Installed .*Open.*Turn off/);
 assert.match(detail.textContent,/Permissions.*Tools.*Repositories · Pull requests · Check results.*Network.*api\.github\.com.*Files.*Work folder · read.*Token.*GitHub token.*Events.*PR opened · PR merged/);
 assert.match(detail.textContent,/Adds.*Member templates.*Code review.*Skills.*PR summary.*Procedures.*PR review.*Tools.*gh.*Screens.*GitHub page · PR tab/);
 assert.match(detail.textContent,/Versions.*1\.4\.0.*Current version.*1\.3\.2.*Roll back to this version/);
 assert.doesNotMatch(detail.textContent,/assistant|Lead|sandbox/i);
 await button(detail,'Roll back to this version')[0]!.fire('click');await settle();assert.deepEqual([posted.at(-1)!.body.action,posted.at(-1)!.body.appId,posted.at(-1)!.body.version],['rollback','app-github',1]);
 await button(app.node('settings-apps-body'),'Turn off')[0]!.fire('click');await settle();assert.deepEqual(posted.at(-1)!.body.action,'disable');
});

test('the install card shows its detail line and rows; the done line offers Remove',async()=>{
 const card={id:'app-decision:1',at:T0,title:'GitHub',question:'Install GitHub app?',detail:'GitHub · 1.4.0',rows:[['Read','Repositories · Pull requests'],['Write','None']],action:'Install',state:'open'};
 const {app,posted}=fixture(false,[card]);await settle();
 const node=app.all().find(n=>n.id==='chat-decision-app-decision:1')!;assert.match(node.textContent,/Install GitHub app\?.*GitHub · 1\.4\.0.*Read.*Repositories · Pull requests.*Write.*None.*Install.*Later/);
 await button(node,'Install')[0]!.fire('click');await settle();assert.deepEqual([posted.at(-1)!.path,posted.at(-1)!.body.answer],['/assistant/decisions','act']);
 const done=fixture(true,[{...card,state:'done',line:'GitHub app installed',remove:'app-github'}]);await settle();
 const line=done.app.all().find(n=>n.id==='chat-system-app-decision:1')!;assert.match(line.textContent,/GitHub app installed.*Remove/);
 await button(line,'Remove')[0]!.fire('click');await settle();assert.deepEqual([done.posted.at(-1)!.path,done.posted.at(-1)!.body.action,done.posted.at(-1)!.body.appId],['/assistant/apps','remove','app-github']);
});

test('an installed app adds a rail icon; its page lists the app view in the sidebar and opens an item; a matching Work gets the app tab',async()=>{
 const {app}=fixture();await settle();
 const rail=app.node('rail-apps');assert.equal(rail.hidden,false);const icon=rail.children[0]!;assert.equal(icon.attributes.get('aria-label'),'GitHub');
 await icon.fire('click');await settle();
 assert.equal(app.node('page-app').hidden,false);assert.equal(app.node('page-chat').hidden,true);assert.equal(icon.attributes.get('aria-current'),'page');
 const side=app.node('side-app');assert.equal(side.hidden,false);assert.match(side.textContent,/GitHub.*jabdori\/massion.*Open.*feat\(assistant\): answer the owner.*#84.*Merged.*App settings/);
 await app.all().find(n=>n.id==='app-row-84')!.fire('click');await settle();
 assert.match(app.node('app-view').textContent,/answer the owner and start Representative Work #84.*Open · jabdori.*Changes.*\+769 −39.*Files 2.*src\/assistant-service\.ts.*\+206 −0/);
 // The Work room tab: a Work whose title names PR #84 gets a second tab drawn by the app.
 (app.context as any).paneOpen('mission:m','work:w','PR #84 review');await settle();
 const tabs=app.node('pane-tabs').children.map(t=>t.children[0]!.textContent);assert.deepEqual(tabs,['PR #84 review','PR #84']);
 await app.node('pane-tabs').children[1]!.children[0]!.fire('click');await settle();
 assert.equal(app.node('pane-app').hidden,false);assert.equal(app.node('pane-body').hidden,true);assert.match(app.node('pane-app').textContent,/Files 2/);
 await button(side,'App settings')[0]!.fire('click');await settle();assert.equal(app.node('page-settings').hidden,false);assert.match(app.node('settings-apps-body').textContent,/Permissions/);
});

test('self-made apps are listed apart with their maker and source Work',async()=>{
 const made={...github,id:'app-made',name:'PR list fetcher',origin:'self-made',memberId:'member-juno',version:'0.1.0',source:{missionId:'intake',workId:'w-done',title:'PR #84 review'},contributes:{templates:[],skills:[],procedures:[],tools:['pr-list']}};
 const {app}=fixture(true,[],[made],[{id:'member-juno',name:'주노',shape:'round'}]);await settle();await open(app);
 assert.match(app.node('settings-apps-body').textContent,/Installed 1.*GitHub.*Self-made apps 1.*PR list fetcher.*0\.1\.0 · Made by 주노 · PR #84 review.*On/);
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
 await app.all().find(n=>n.id==='app-row-83')!.fire('click');await settle();
 assert.deepEqual(asked,[['page','feed:a'],['item','feed:page'],['item','feed:page']]);
});

test('every app read draws only its newest request: an item selected A, B, A again and a room tab left and reopened',async()=>{
 const pending:{b:any;done:()=>void}[]=[];
 const {app}=fixture(true,[],[],[],undefined,b=>b.handler==='page'?page:new Promise(done=>{const n=pending.length+1;pending.push({b,done:()=>done({title:'item '+b.ref+' #'+n,groups:[]})});}));await settle();
 await app.node('rail-apps').children[0]!.fire('click');await settle();
 const row=(id:string)=>app.all().find(n=>n.id==='app-row-'+id)!;
 await row('83').fire('click');await row('84').fire('click');await settle();
 // The first row opens with the page (#1); then 83 (#2), 84 (#3), 84 again (#4). The newest answers first; the older ones arrive late.
 await row('84').fire('click');await settle();pending[3]!.done();await settle();pending[1]!.done();pending[2]!.done();pending[0]!.done();await settle();
 assert.equal(app.node('app-view').textContent,'item 84 #4');
 pending.length=0;
 (app.context as any).paneOpen('mission:m','work:w','PR #84 review');await settle();
 const tabs=app.node('pane-tabs').children;await tabs[1]!.children[0]!.fire('click');await settle();await tabs[0]!.children[0]!.fire('click');await settle();await tabs[1]!.children[0]!.fire('click');await settle();
 pending[1]!.done();await settle();pending[0]!.done();await settle();
 assert.equal(app.node('pane-app').textContent,'item 84 #2');
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
