import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
const usage={feedId:'feed:a',cursor:1,revision:2,period:'2026-11',timezone:'Asia/Seoul',unit:'output-tokens',limit:100,spent:80,knownOutputTokens:80,inputTokens:200,cost:null,reserved:10,members:[{memberId:null,inputTokens:200,outputTokens:80,unknown:false}],decisions:[]};
function fixture(options:{lost?:boolean;reads?:((n:number)=>Promise<any>) }={}){
 let reads=0;const app=harness(async(path,request)=>{
  if(path==='/assistant/usage'){if(request?.method==='POST'){if(options.lost)throw new Error('Lost response');return reply({status:'committed'});}return options.reads?reply(await options.reads(++reads)):reply(usage);}
  if(path==='/assistant/decisions'){if(options.lost)throw new Error('Lost answer');return reply({status:'committed'});}
  if(path.startsWith('/assistant/conversation'))return reply({feedId:'feed:a',cursor:1,head:1,segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:[]},turns:[],members:[],decisions:[]});
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:1,events:[]});
  if(path.startsWith('/read-state'))return reply({feedId:'feed:a',cursor:1,snapshot:null});return reply({},503);
 });return app;
}
const node=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
test('usage reads recorded period totals and provides Change and a real Refresh read',async()=>{
 const app=fixture();await settle();runInContext('shellShow("settings");settingsOpen("usage")',app.context);await settle();
 const cycle=app.all().find(n=>n.className==='set-row set-usage-cycle')!;assert.equal(cycle.textContent,'사용률—초기화 시각—');assert.match(app.node('settings-usage-body').textContent,/80.*월 예산.*100/s);assert.ok(node(app,'monthly-budget-change'));const before=app.calls.filter(c=>c.path==='/assistant/usage').length;
 await node(app,'monthly-budget-refresh').fire('click');await settle();assert.equal(app.calls.filter(c=>c.path==='/assistant/usage').length,before+1);
 await node(app,'monthly-budget-change').fire('click');const field=node(app,'monthly-budget-limit');field.value='200';await field.fire('input');await node(app,'monthly-budget-form').fire('submit');await settle();const post=app.calls.find(c=>c.path==='/assistant/usage'&&c.options?.method==='POST')!;assert.equal(JSON.parse(post.options.body).limit,200);assert.equal(JSON.parse(post.options.body).expectedRevision,2);
});
test('a late usage read cannot overwrite a newer read or display another database totals',async()=>{
 let release!:(v:any)=>void;const app=fixture({reads:async n=>n===1?await new Promise(r=>release=r):{...usage,spent:90}});await settle();runInContext('shellShow("settings");settingsOpen("usage")',app.context);await settle();
 runInContext('void settingsLoad("usage")',app.context);await settle();release({...usage,spent:5});await settle();assert.equal(runInContext('settingsUsage.spent',app.context),90);
 runInContext('chatView.feedId="feed:b";renderSettings()',app.context);assert.doesNotMatch(app.node('settings-usage-body').textContent,/90 출력 토큰/);
});
test('an unknown monthly decision answer keeps its original identity and cannot be resent from a stale read',async()=>{
 const app=fixture({lost:true});await settle();const d={id:'monthly-budget:2026-11:0',at:1,title:'월간 예산',question:'이번 달 예산을 다 썼어요',rows:[['지금','100']],action:'예산 늘리기',state:'open',budget:{revision:2,limit:200}};
 runInContext('chatView.decisions='+JSON.stringify([d])+';renderChat()',app.context);await runInContext('chatDecide('+JSON.stringify(d.id)+',"act")',app.context);await settle();
 runInContext('chatView.decisions='+JSON.stringify([d])+';renderChat()',app.context);assert.match(app.node('chat-log').textContent,/확인 중/);await runInContext('chatDecide('+JSON.stringify(d.id)+',"act")',app.context);await settle();
 const posts=app.calls.filter(c=>c.path==='/assistant/decisions'&&c.options?.method==='POST');assert.equal(posts.length,1);assert.equal(JSON.parse(posts[0]!.options.body).limit,200);assert.equal(JSON.parse(posts[0]!.options.body).expectedRevision,2);
});

test('offline budget edits and decisions do not consume single-send identities',async()=>{
 const app=fixture();await settle();runInContext('shellShow("settings");settingsOpen("usage")',app.context);await settle();await node(app,'monthly-budget-change').fire('click');const field=node(app,'monthly-budget-limit');field.value='200';await field.fire('input');runInContext('navigator.onLine=false',app.context);await node(app,'monthly-budget-form').fire('submit');await settle();assert.equal(app.storage.has('massion.monthly-budget:feed:a:2'),false);assert.equal(app.calls.filter(c=>c.path==='/assistant/usage'&&c.options?.method==='POST').length,0);
 const d={id:'monthly-budget:2026-11:0',at:1,title:'월간 예산',question:'이번 달 예산을 다 썼어요',rows:[['지금','100']],action:'예산 늘리기',state:'open',budget:{revision:2,limit:200}};runInContext('chatView.decisions='+JSON.stringify([d])+';renderChat()',app.context);await runInContext('chatDecide('+JSON.stringify(d.id)+',"act")',app.context);assert.equal(app.storage.has('massion.budget-decision:feed:a:'+d.id),false);
});

test('a proven pre-transport failure releases the budget draft key while an unchanged read retains the draft',async()=>{
 const app=fixture();await settle();runInContext('shellShow("settings");settingsOpen("usage")',app.context);await settle();await node(app,'monthly-budget-change').fire('click');const field=node(app,'monthly-budget-limit');field.value='200';await field.fire('input');await runInContext('(async()=>{const info=await protocol.connection();info.features={...info.features,commands:false};})()',app.context);await node(app,'monthly-budget-form').fire('submit');await settle();assert.equal(app.storage.has('massion.monthly-budget:feed:a:2'),false);assert.equal(node(app,'monthly-budget-limit').value,'200');
 await runInContext('(async()=>{const info=await protocol.connection();info.features={...info.features,commands:true};})()',app.context);await node(app,'monthly-budget-form').fire('submit');await settle();assert.equal(app.calls.filter(c=>c.path==='/assistant/usage'&&c.options?.method==='POST').length,1);
 const d={id:'monthly-budget:2026-11:0',at:1,title:'월간 예산',question:'이번 달 예산을 다 썼어요',rows:[['지금','100']],action:'예산 늘리기',state:'open',budget:{revision:2,limit:200}};await runInContext('(async()=>{const info=await protocol.connection();info.features={...info.features,commands:false};})()',app.context);runInContext('chatView.decisions='+JSON.stringify([d])+';renderChat()',app.context);await runInContext('chatDecide('+JSON.stringify(d.id)+',"act")',app.context);assert.equal(app.storage.has('massion.budget-decision:feed:a:'+d.id),false);
});
