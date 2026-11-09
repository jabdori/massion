import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/member-work.md, surface: Work lines and activity from the host Work list, member avatar on cards and in the room, Worked for N min, steering tag.
const T0=Date.UTC(2026,10,5,1,14);
const quill={id:'member-q',name:'Quill',look:{shape:'drop',color:'agent-1'},modelGroup:'default'};
type Row={workId:string;title:string;memberId:string|null;execution:string;acceptance:string;started:boolean;startedAt?:number|null;endedAt?:number|null;turnId?:string};
const row=(r:Row)=>({missionId:'intake',missionRevision:3,unknown:false,startedAt:T0,endedAt:null,segment:1,turnId:'assistant-turn:m:'+r.workId.padEnd(32,'0'),...r});
function fixture(initial:{works?:Row[];turns?:any[];messages?:any[];memberThread?:{messages:any[];turns:any[]}}={}){
 const state={works:(initial.works??[]).map(row),feedId:'feed:a',hold:null as null|Promise<void>,chatHold:null as null|Promise<void>,chatStatus:200,worksStatus:200,worksBody:undefined as unknown,worksCalls:0,members:[quill],turns:initial.turns??[],messages:initial.messages??[]};
 const view=(member:string|null)=>({feedId:state.feedId,cursor:1,head:1,members:state.members,...(member?{member:{id:member,name:'Quill'},decisions:[]}:{decisions:[]}),
  segment:{number:1,revision:1,closed:false,full:false,previous:null,messages:member?initial.memberThread?.messages??[]:state.messages},turns:member?initial.memberThread?.turns??[]:state.turns});
 const app=harness(async(path)=>{
  if(path==='/assistant/works'){state.worksCalls++;const snapshot=structuredClone(state.worksBody??{feedId:state.feedId,works:state.works}),status=state.worksStatus,hold=state.hold;if(hold)await hold;return reply(snapshot,status);}
  if(path.startsWith('/assistant/conversation')){const member=new URLSearchParams(path.split('?')[1]??'').get('member'),snapshot=structuredClone(view(member)),hold=state.chatHold,status=state.chatStatus;if(hold)await hold;return reply(snapshot,status);}
  if(path.startsWith('/events'))return reply({feedId:state.feedId,cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
const kids=(node:Node)=>node.children.filter(child=>!child.hidden);
const memberLines=(app:ReturnType<typeof harness>)=>{const li=app.all().find(n=>n.id==='side-member-member-q')?.parentElement;const ul=li?.children.find(c=>c.tagName==='UL');return ul?kids(ul).map(n=>n.textContent):[];};

test('Work lines come from the host Work list: the Representative\'s and each member\'s running Work, also Work outside the shown segment; activity lists them all',async()=>{
 const {app}=fixture({works:[{workId:'w3',title:'Churn causes',memberId:'member-q',execution:'active',acceptance:'pending',started:true},{workId:'w2',title:'Price table',memberId:'member-q',execution:'waiting',acceptance:'pending',started:true},{workId:'w1',title:'Weekly totals',memberId:null,execution:'active',acceptance:'pending',started:true},{workId:'w0',title:'Old summary',memberId:null,execution:'settled',acceptance:'accepted',started:true}]});
 await settle();
 assert.deepEqual(kids(app.node('side-work')).map(n=>n.textContent),['Weekly totals실행 중','Old summary완료'],'the shown segment has no cards; the lines still show');
 assert.deepEqual(memberLines(app),['Churn causes실행 중','Price table확인 대기']);
 await app.node('activity-toggle').fire('click');
 const titles=kids(app.node('activity-list')).map(li=>li.children[0]!.children.find(c=>c.tagName==='STRONG')!.textContent);assert.deepEqual(titles,['Price table','Churn causes','Weekly totals','Old summary']);
 const marks=kids(app.node('activity-list'))[0]!.children[0]!.children.find(c=>c.className==='marks')!;assert.equal(marks.children[0]!.textContent,'Q','a member Work shows its member');
});

test('a slower earlier Work list answer never replaces a newer one; a replaced database clears the list',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'First',memberId:null,execution:'active',acceptance:'pending',started:true}]});await settle();
 let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const slow=runInContext('shellWorksLoad()',app.context);
 state.hold=null;state.works=[row({workId:'w2',title:'Second',memberId:null,execution:'active',acceptance:'pending',started:true})];await runInContext('shellWorksLoad()',app.context);await settle();
 release();await slow;await settle();
 assert.deepEqual(kids(app.node('side-work')).map(n=>n.textContent.replace('실행 중','')),['Second']);
 state.feedId='feed:b';state.works=[];await runInContext('chatReset()',app.context);await settle();
 assert.deepEqual(kids(app.node('side-work')),[],'the replaced database\'s list is read anew');
});

test('a Work that ends without an event updates its line on the next minute read, also while a member conversation is open',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Weekly totals',memberId:null,execution:'active',acceptance:'pending',started:true}]});await settle();
 assert.notEqual(runInContext('chatPendingTimer',app.context),0,'a running listed Work keeps the minute read');
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const timers=new Map<number,{run:()=>void;delay:number}>();let next=0;
 app.context.setTimeout=(run:()=>void,delay:number)=>{const id=++next;timers.set(id,{run,delay});return id;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 await runInContext('readChat()',app.context);await settle();
 const timer=timers.get(runInContext('chatPendingTimer',app.context))!;assert.equal(timer.delay,60000);
 state.works=[row({workId:'w1',title:'Weekly totals',memberId:null,execution:'settled',acceptance:'accepted',started:true,endedAt:T0+240000})];
 timer.run();await settle();
 assert.deepEqual(kids(app.node('side-work')).map(n=>n.textContent),['Weekly totals완료'],'the Representative\'s line follows the host list, not the last Representative read');
 assert.equal(runInContext('chatPendingTimer',app.context),0,'no running Work remains to poll');
});

test('cards and the room show the member who holds the Work; a finished Work folds to Worked for N min',async()=>{
 const turn=(id:string,work:any)=>({id:'assistant-turn:m:'+id,messageId:'m:'+id,status:'answered',displayStatus:'answered',at:T0,proposal:{title:work.title},outcome:{missionId:'intake',work:{status:'admitted',diagnostics:[]},run:{status:'requested',diagnostics:[]}},work:{missionId:'intake',missionRevision:3,workId:work.workId,title:work.title,execution:work.execution,acceptance:work.acceptance,started:true,starting:false,startedAt:T0,unknown:false,steps:{done:0,total:2},...work}});
 const a='a'.repeat(32),b='b'.repeat(32);
 const {app}=fixture({messages:[{id:'m:'+a,role:'owner',turnId:null,text:'Find churn causes'},{id:'r:assistant-turn:m:'+a,role:'representative',turnId:'assistant-turn:m:'+a,text:'Quill will.'},{id:'m:'+b,role:'owner',turnId:null,text:'Totals'},{id:'r:assistant-turn:m:'+b,role:'representative',turnId:'assistant-turn:m:'+b,text:'Done soon.'}],
  turns:[turn(a,{workId:'w1',title:'Churn causes',execution:'active',acceptance:'pending',memberId:'member-q'}),turn(b,{workId:'w2',title:'Totals',execution:'settled',acceptance:'accepted',memberId:null,endedAt:T0+4*60000})]});
 await settle();
 const card=app.all().find(n=>n.id==='chat-card-assistant-turn:m:'+a)!;assert.match(card.textContent,/Churn causes.*Quill/);assert.doesNotMatch(card.textContent,/하나/);
 assert.equal(app.all().find(n=>n.id==='chat-fold-assistant-turn:m:'+b)!.textContent,'4분 동안 작업 ›');
 await card.children[0]!.fire('click');await settle();
 assert.match(app.node('pane-people').textContent,/^QQuill.*확인$/,'the member holds the producing seat; Check is last');
});

test('a member message that steered a Work carries the steering tag',async()=>{
 const m='c'.repeat(32);
 const {app}=fixture({memberThread:{messages:[{id:'m:'+m,role:'owner',turnId:null,text:'Annual plans only.'},{id:'r:assistant-turn:m:'+m,role:'representative',turnId:'assistant-turn:m:'+m,text:'Sure.'}],turns:[{id:'assistant-turn:m:'+m,messageId:'m:'+m,status:'answered',displayStatus:'answered',at:T0,steer:{missionId:'intake',workId:'w1',status:'recorded',title:'Churn causes'}}]}});
 await settle();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 assert.equal(app.all().find(n=>n.id==='chat-system-steer-assistant-turn:m:'+m)!.textContent,'방향 바꿈: Churn causes · '+new Date(T0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));
});

test('a changed Work-list feed replaces the old list and rereads member identities',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Old database',memberId:null,execution:'active',acceptance:'pending',started:true}]});await settle();
 state.feedId='feed:b';state.works=[row({workId:'w2',title:'New database',memberId:'member-q',execution:'active',acceptance:'pending',started:true})];
 await runInContext('shellWorksLoad()',app.context);await settle();
 assert.deepEqual(kids(app.node('side-work')),[]);assert.deepEqual(memberLines(app),['New database실행 중']);
 assert.equal(runInContext('chatView.feedId',app.context),'feed:b');assert.doesNotMatch(app.node('activity-list').textContent,/Old database/);
});

test('reset clears Work immediately and a late old-feed answer cannot restore it, even if the new list is unavailable',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Old database',memberId:'member-q',execution:'active',acceptance:'pending',started:true}]});await settle();
 let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const old=runInContext('shellWorksLoad()',app.context);
 state.feedId='feed:b';state.hold=null;state.worksStatus=503;runInContext('chatReset()',app.context);
 assert.deepEqual(memberLines(app),[]);assert.equal(app.node('activity-list').textContent,'');await settle();release();await old;await settle();
 assert.deepEqual(memberLines(app),[]);assert.equal(app.node('activity-list').textContent,'');
});

test('reset discards an old conversation response before it can repopulate cards or member identities',async()=>{
 const id='d'.repeat(32),{app,state}=fixture({messages:[{id:'m:'+id,role:'owner',turnId:null,text:'Old message'}]});await settle();
 let release=()=>{};state.chatHold=new Promise<void>(r=>{release=r;});const old=runInContext('readChat()',app.context);
 state.chatHold=null;state.feedId='feed:b';state.messages=[];runInContext('chatReset()',app.context);await settle();
 release();await old;await settle();assert.equal(app.node('chat-log').textContent,'');assert.equal(runInContext('chatView.feedId',app.context),'feed:b');
});

test('an off-segment member Work opens the same tab from its line and activity, and refreshes on intake events',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Earlier member Work',memberId:'member-q',execution:'active',acceptance:'pending',started:true}]});await settle();
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 await app.all().find(n=>n.id==='side-line-intake/w1')!.fire('click');await settle();
 assert.match(app.node('pane-people').textContent,/^QQuill확인$/);assert.equal(kids(app.node('pane-tabs')).length,1);
 await app.all().find(n=>n.id==='activity-row-intake/w1')!.fire('click');await settle();assert.equal(kids(app.node('pane-tabs')).length,1);
 assert.ok(app.calls.some(c=>c.path==='/missions/intake'),'both entries use the existing Mission reader');
 state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted',endedAt:T0+240000}];
 runInContext('chatEvents([{aggregateId:"intake"}])',app.context);await settle();
 assert.deepEqual(memberLines(app),['Earlier member Work완료']);assert.match(app.node('activity-list').textContent,/Earlier member Work.*완료/);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('an unavailable or malformed Work list never falls back to the shown conversation, and malformed rows are skipped',async()=>{
 const work=row({workId:'w1',title:'Only in the conversation',memberId:null,execution:'active',acceptance:'pending',started:true});
 const {app,state}=fixture({turns:[{id:work.turnId,work}]});await settle();
 state.worksStatus=503;await runInContext('shellWorksLoad()',app.context);await settle();assert.deepEqual(kids(app.node('side-work')),[]);
 state.worksStatus=200;state.worksBody={feedId:'feed:a',works:[null,{...work,workId:null},{...work,execution:'invented'},work]};
 await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(kids(app.node('side-work')).length,1);
 state.worksBody={feedId:'feed:a',works:null};await runInContext('shellWorksLoad()',app.context);await settle();assert.equal(kids(app.node('side-work')).length,1,'a malformed read keeps the last good list');
 assert.notEqual(runInContext('chatPendingTimer',app.context),0,'a failed refresh does not stop polling a running Work');
});

test('folded durations use whole elapsed minutes, never wall time, and missing or invalid times stay untimed',async()=>{
 const {app}=fixture();await settle();
 for(const [startedAt,endedAt,want] of [[T0,T0+299999,'4분 동안 작업 ›'],[T0,T0+1000,'1분 동안 작업 ›'],[T0,null,'작업함 ›'],[null,T0,'작업함 ›'],[T0,T0-1,'작업함 ›']] as const){
  app.context.durationWork={startedAt,endedAt};assert.equal(runInContext('chatFold({id:"duration",work:durationWork}).textContent',app.context),want);
 }
});

test('steering is shown only when recorded, keeps its node on reread and treats the title as text',async()=>{
 const id='e'.repeat(32),steer={missionId:'intake',workId:'w1',status:'not_recorded',title:'<img src=x>'},turn={id:'assistant-turn:m:'+id,messageId:'m:'+id,status:'answered',displayStatus:'answered',at:T0,steer};
 const {app}=fixture({memberThread:{messages:[{id:'m:'+id,role:'owner',turnId:null,text:'Annual plans only.'},{id:'r:'+turn.id,role:'representative',turnId:turn.id,text:'Sure.'}],turns:[turn]}});await settle();
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();assert.equal(app.all().find(n=>n.id==='chat-system-steer-'+turn.id),undefined);
 steer.status='recorded';await runInContext('readChat()',app.context);await settle();const tag=app.all().find(n=>n.id==='chat-system-steer-'+turn.id)!;
 assert.equal(tag.textContent,'방향 바꿈: <img src=x> · '+new Date(T0).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}));assert.equal(tag.children[0]!.tagName,'SPAN');assert.equal(tag.className,'chat-system');
 await runInContext('readChat()',app.context);await settle();assert.equal(tag.detaches,0);assert.equal(app.all().find(n=>n.id==='chat-system-steer-'+turn.id),tag);
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

test('a new conversation feed clears old Work even when the replacement list cannot be read',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Old database',memberId:'member-q',execution:'active',acceptance:'pending',started:true}]});await settle();
 state.feedId='feed:b';state.worksStatus=503;await runInContext('readChat()',app.context);await settle();
 assert.deepEqual(memberLines(app),[]);assert.equal(app.node('activity-list').textContent,'');
});

test('a waiting Work remains inspectable and keeps minute polling, including in member chat',async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Churn causes',memberId:'member-q',execution:'active',acceptance:'pending',started:true}]});await settle();
 assert.deepEqual(memberLines(app),['Churn causes실행 중']);assert.notEqual(runInContext('chatPendingTimer',app.context),0);
 state.works=[{...state.works[0]!,execution:'waiting'}];await runInContext('readChat()',app.context);await settle();
 assert.deepEqual(memberLines(app),['Churn causes확인 대기']);assert.match(app.node('activity-list').textContent,/Churn causes.*확인 대기/);assert.notEqual(runInContext('chatPendingTimer',app.context),0);
 await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();assert.deepEqual(memberLines(app),['Churn causes확인 대기']);assert.notEqual(runInContext('chatPendingTimer',app.context),0);
});

test('card polling follows active execution and check waits while start-in-flight keeps the short clock',async()=>{
 const work={...row({workId:'w1',title:'Churn causes',memberId:'member-q',execution:'waiting',acceptance:'pending',started:true}),starting:false};
 const turn={id:work.turnId,messageId:'m:card',status:'answered',displayStatus:'answered',proposal:{title:work.title},work};
 const {app,state}=fixture({turns:[turn],messages:[{id:'reply',role:'representative',turnId:turn.id,text:'On it.'}]});await settle();
 const card=app.all().find(n=>n.id==='chat-card-'+turn.id)!;
 assert.match(card.textContent,/확인 대기/);assert.match(card.textContent,/\d+분/);assert.notEqual(runInContext('chatPendingTimer',app.context),0);
 const timers=new Map<number,number>();let next=0;app.context.setTimeout=(_run:()=>void,delay:number)=>{timers.set(++next,delay);return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 for(const [execution,starting,delay] of [['active',false,60000],['waiting',false,60000],['queued',false,0],['blocked',false,0],['settled',false,0],['queued',true,10000]] as const){
  state.turns[0].work={...work,execution,starting};await runInContext('readChat()',app.context);await settle();
  assert.equal(timers.get(runInContext('chatPendingTimer',app.context))??0,delay,execution+(starting?' starting':''));
 }
});

test('an unresolved member identity stays neutral on its card, activity row and room, then follows the roster',async()=>{
 const work=row({workId:'w1',title:'Churn causes',memberId:'member-q',execution:'active',acceptance:'pending',started:true}),turn={id:work.turnId,messageId:'m:card',status:'answered',displayStatus:'answered',proposal:{title:work.title},work};
 const {app,state}=fixture({works:[work],turns:[turn],messages:[{id:'reply',role:'representative',turnId:turn.id,text:'On it.'}]});state.members=[];await settle();await runInContext('readChat()',app.context);await settle();
 const card=app.all().find(n=>n.id==='chat-card-'+turn.id)!,who=app.all().find(n=>card.contains(n)&&n.className==='chat-card-who')!;
 const neutral=(avatar:Node,label?:Node)=>{assert.equal(avatar.textContent,'');assert.equal(avatar.style.background,'var(--agent-0)');assert.equal(avatar.attributes.has('data-shape'),false);if(label)assert.equal(label.textContent,'');};
 neutral(who.children[0]!,who.children[1]!);
 const activityAvatar=()=>kids(app.node('activity-list'))[0]!.children[0]!.children.find(n=>n.className==='marks')!.children[0]!;neutral(activityAvatar());
 await card.children[0]!.fire('click');await settle();neutral(app.node('pane-people').children[0]!,app.node('pane-people').children[1]!);
 state.members=[quill];await runInContext('readChat()',app.context);await settle();assert.equal(who.children[0]!.textContent,'Q');assert.equal(who.children[1]!.textContent,'Quill');assert.equal(activityAvatar().textContent,'Q');assert.equal(app.node('pane-people').textContent,'QQuill확인');
 state.members=[];await runInContext('readChat()',app.context);await settle();neutral(who.children[0]!,who.children[1]!);neutral(activityAvatar());neutral(app.node('pane-people').children[0]!,app.node('pane-people').children[1]!);
});

test('unknown steering offers only read-only Check and changes to Steered only after a recorded read',async()=>{
 const id='f'.repeat(32),steer={missionId:'intake',workId:'w1',status:'unknown',title:'Churn causes'},turn={id:'assistant-turn:m:'+id,messageId:'m:'+id,status:'answered',displayStatus:'answered',steer};
 const {app}=fixture({memberThread:{messages:[{id:turn.messageId,role:'owner',turnId:null,text:'Annual plans only.'}],turns:[turn]}});await settle();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const line=app.all().find(n=>n.id==='chat-system-steer-'+turn.id);assert.ok(line,'unknown steering stays visible');assert.equal(line.className,'chat-system');assert.equal(line.children[0]!.textContent,'결과 모름: Churn causes');assert.doesNotMatch(line.textContent,/방향 바꿈/);
 const buttons=line.children.filter(n=>n.tagName==='BUTTON');assert.deepEqual(buttons.map(n=>n.textContent),['확인']);
 const reads=()=>app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length,before=reads();await buttons[0]!.fire('click');await settle();assert.ok(reads()>before);assert.equal(line.children[0]!.textContent,'결과 모름: Churn causes');assert.equal(line.detaches,0);
 steer.status='recorded';await buttons[0]!.fire('click');await settle();assert.equal(line.textContent,'방향 바꿈: Churn causes');assert.equal(line.children.filter(n=>n.tagName==='BUTTON').length,0);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

function steeringFixture(options:{storage?:Map<string,string>;storageFault?:'read'|'write'|'remove'}={}){
 const id='9'.repeat(32),turn={id:'assistant-turn:m:'+id,messageId:'m:'+id,status:'answered',displayStatus:'answered',steer:{missionId:'intake',workId:'w1',title:'Churn causes',status:'proposed'}};
 const state={feed:'feed:a',head:2,turn,hold:null as Promise<void>|null,fail:false,postStatus:200,postBody:{status:'unknown'} as unknown,chatHold:null as Promise<void>|null,chatStatus:200,reads:0,receiptsAtPost:[] as [string,string][]};
 const app=harness(async(path,options)=>{
  if(path==='/assistant/steering'){state.receiptsAtPost=[...app.storage].filter(([key])=>key.startsWith('massion.workbench.steering:'));const hold=state.hold,fail=state.fail,body=structuredClone(state.postBody),status=state.postStatus;if(hold)await hold;if(fail)throw new Error('Lost answer');return reply(body,status);}
  if(path.startsWith('/assistant/conversation')){state.reads++;const query=new URLSearchParams(path.split('?')[1]??''),member=query.get('member'),segment=Number(query.get('segment')??state.head);const body={feedId:state.feed,cursor:1,head:state.head,members:[quill],...(member?{member:{id:member,name:quill.name}}:{}),decisions:[],segment:{number:segment,revision:7,previous:segment>1?'previous':null,closed:false,full:false,messages:member?[{id:turn.messageId,role:'owner',turnId:null,text:'Annual plans only.'}]:[]},turns:member?[structuredClone(turn)]:[]},status=state.chatStatus;if(state.chatHold)await state.chatHold;return reply(body,status);}
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[]});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  return reply({error:'Not configured'},503);
 },{},options.storageFault,{storage:options.storage});
 const line=()=>app.all().find(n=>n.id==='chat-system-steer-'+turn.id),apply=()=>line()?.children.find(n=>n.tagName==='BUTTON'&&n.textContent==='Churn causes에 반영'),posts=()=>app.calls.filter(c=>c.options?.method==='POST');
 const open=async()=>{await settle();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();};
 return {app,state,line,apply,posts,open};
}

test('steering proposals only POST on an explicit click, with exact server-derived identity and view feed; double click sends once',async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();assert.ok(apply(),'a proposal offers Apply');assert.equal(line()!.className,'chat-system');
 await runInContext('readChat()',app.context);await settle();runInContext('chatEvents([{aggregateId:"assistant-conversation:member:member-q:2"}])',app.context);await settle();assert.equal(posts().length,0,'reads never confirm proposals');
 runInContext('feedId="stale-global-feed"',app.context);let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});const button=apply()!;
 await button.fire('click');await button.fire('click');await settle();assert.equal(posts().length,1);assert.equal(apply()!.disabled,true);
 assert.equal(posts()[0]!.path,'/assistant/steering');assert.deepEqual(JSON.parse(posts()[0]!.options.body),{member:'member-q',segment:2,turnId:state.turn.id});assert.equal(posts()[0]!.options.headers['X-Massion-Feed'],'feed:a');
 state.turn.steer.status='recorded';release();await settle();assert.equal(line()!.textContent,'방향 바꿈: Churn causes');assert.equal(posts().length,1);
});

for(const move of ['thread','thread-return','segment','segment-return','feed','reset'] as const)test('a detached steering Apply cannot send after '+move,async()=>{
 const {app,state,apply,posts,open}=steeringFixture();await open();const old=apply();assert.ok(old,'proposal button exists');
 if(move.startsWith('thread')){await app.node('side-representative').fire('click');await settle();if(move==='thread-return')await open();}
 else if(move.startsWith('segment')){await app.node('chat-earlier').fire('click');await settle();if(move==='segment-return'){await app.node('chat-latest').fire('click');await settle();}}
 else {if(move==='feed')state.feed='feed:b';runInContext('chatReset()',app.context);await open();}
 await old.fire('click');await settle();assert.equal(posts().length,0,'the previous choice never becomes authority for the current view');
});

for(const outcome of ['lost','http-error','unconfirmed-success'] as const)test('an '+outcome+' Apply answer keeps only Check while the read still says proposed, including after leaving and returning',async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();const button=apply();assert.ok(button,'proposal button exists');
 state.fail=outcome==='lost';state.postStatus=outcome==='http-error'?503:200;await button.fire('click');await settle();
 assert.equal(posts().length,1);assert.match(line()!.textContent,/^결과 모름: Churn causes확인$/);assert.equal(apply(),undefined);
 const before=state.reads;await line()!.children.find(n=>n.tagName==='BUTTON')!.fire('click');await settle();assert.ok(state.reads>before);assert.equal(posts().length,1);
 await app.node('side-representative').fire('click');await open();assert.equal(apply(),undefined);assert.match(line()!.textContent,/^결과 모름:/);
 state.turn.steer.status='not_recorded';await runInContext('readChat()',app.context);await settle();assert.equal(apply(),undefined);assert.equal(line(),undefined);assert.equal(posts().length,1);
});

for(const move of ['thread','segment','reset'] as const)test('a late Apply response does not change or reread the view after '+move,async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});assert.ok(apply(),'proposal button exists');await apply()!.fire('click');await settle();
 if(move==='thread')await app.node('side-representative').fire('click');else if(move==='segment')await app.node('chat-earlier').fire('click');else {state.feed='feed:b';runInContext('chatReset()',app.context);await open();}
 await settle();const before={reads:state.reads,text:app.node('chat-log').textContent,heading:app.node('page-heading').textContent};release();await settle();
 assert.equal(state.reads,before.reads);assert.equal(app.node('chat-log').textContent,before.text);assert.equal(app.node('page-heading').textContent,before.heading);assert.equal(posts().length,1);
 if(move==='reset')assert.equal(line()!.textContent,'Churn causes에 반영','an old-feed reply cannot settle the new feed proposal');
});

for(const move of ['thread-return','same-feed-reset'] as const)test('an in-flight Apply revisited after '+move+' offers Check without waiting for its old response',async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});assert.ok(apply());await apply()!.fire('click');await settle();
 if(move==='thread-return')await app.node('side-representative').fire('click');else runInContext('chatReset()',app.context);await open();
 try{assert.equal(line()!.textContent,'결과 모름: Churn causes확인');assert.equal(apply(),undefined);await line()!.children.find(n=>n.tagName==='BUTTON')!.fire('click');await settle();assert.equal(posts().length,1);}finally{release();await settle();}
});

for(const status of ['recorded','unknown','not_recorded'] as const)test('a replaced proposal button cannot Apply after a read reports '+status,async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();const old=apply();assert.ok(old);state.turn.steer.status=status;await runInContext('readChat()',app.context);await settle();
 await old.fire('click');await settle();assert.equal(posts().length,0);assert.equal(apply(),undefined);if(status==='not_recorded')assert.equal(line(),undefined);
});

for(const resolved of ['recorded','not_recorded'] as const)test('a saved steering receipt survives reload with proposed and unknown reads until '+resolved,async()=>{
 const storage=new Map<string,string>(),first=steeringFixture({storage});await first.open();first.state.fail=true;await first.apply()!.fire('click');await settle();
 assert.equal(first.posts().length,1);assert.equal(first.state.receiptsAtPost.length,1,'receipt is durable before transmission');const receipt=first.state.receiptsAtPost[0]![0];
 const reloaded=steeringFixture({storage});await reloaded.open();assert.equal(reloaded.apply(),undefined);assert.equal(reloaded.line()!.textContent,'결과 모름: Churn causes확인');assert.ok(storage.has(receipt));
 await reloaded.line()!.children.find(n=>n.tagName==='BUTTON')!.fire('click');await settle();assert.equal(reloaded.apply(),undefined);assert.ok(storage.has(receipt),'proposed after a read does not authorize resending');
 reloaded.state.turn.steer.status='unknown';await runInContext('readChat()',reloaded.app.context);await settle();assert.ok(storage.has(receipt),'unknown does not clear the receipt');
 reloaded.state.turn.steer.status=resolved;await runInContext('readChat()',reloaded.app.context);await settle();assert.equal(storage.has(receipt),false,'only the known authoritative result clears the receipt');
 assert.equal(first.posts().length+reloaded.posts().length,1);assert.equal(reloaded.apply(),undefined);
});

test('a steering receipt write failure prevents any POST',async()=>{
 const {app,apply,posts,open}=steeringFixture({storageFault:'write'});await open();const button=apply();assert.ok(button);await button.fire('click');await settle();
 assert.equal(posts().length,0);assert.equal([...app.storage].some(([key])=>key.startsWith('massion.workbench.steering:')),false);
});

test('an already-rendered Apply in another client checks the saved receipt before sending',async()=>{
 const storage=new Map<string,string>(),first=steeringFixture({storage}),second=steeringFixture({storage});await first.open();await second.open();const old=second.apply();assert.ok(old);
 first.state.fail=true;await first.apply()!.fire('click');await settle();await old.fire('click');await settle();
 assert.equal(first.posts().length+second.posts().length,1);assert.equal(second.apply(),undefined);assert.equal(second.line()!.textContent,'결과 모름: Churn causes확인');
});

for(const held of [false,true])test('active member Work stays in the sidebar across Representative / Quill / Representative with recorded steering'+(held?' and held Work reads':''),async()=>{
 const id='8'.repeat(32),turn={id:'assistant-turn:m:'+id,messageId:'m:'+id,status:'answered',displayStatus:'answered',steer:{missionId:'intake',workId:'w1',title:'Churn causes',status:'recorded'}};
 const {app,state}=fixture({works:[{workId:'w1',title:'Churn causes',memberId:'member-q',execution:'active',acceptance:'pending',started:true}],memberThread:{messages:[{id:turn.messageId,role:'owner',turnId:null,text:'Annual plans only.'}],turns:[turn]}});await settle();
 const visible=()=>{assert.equal(app.node('side-members').hidden,false);assert.deepEqual(memberLines(app),['Churn causes실행 중']);assert.equal(state.works[0]!.execution,'active');};visible();
 let release=()=>{};if(held){state.hold=new Promise<void>(r=>{release=r;});void runInContext('shellWorksLoad()',app.context);}
 try{
  await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');visible();await settle();visible();assert.equal(app.node('page-heading').textContent,'QQuill');assert.match(app.node('chat-log').textContent,/방향 바꿈: Churn causes/);
  state.hold=null;await app.node('side-representative').fire('click');visible();await settle();visible();assert.equal(app.node('page-heading').textContent,'하하나');
 }finally{release();await settle();}
 visible();assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0,'viewing recorded steering never applies another instruction');
});

for(const chatStatus of [200,503])test('the initial global Work list lands across a thread switch while member chat is held'+(chatStatus===503?' then unavailable':''),async()=>{
 const {app,state}=fixture({works:[{workId:'w1',title:'Churn causes',memberId:'member-q',execution:'active',acceptance:'pending',started:true}]});
 let releaseWorks=()=>{},releaseChat=()=>{};state.hold=new Promise<void>(r=>{releaseWorks=r;});await settle();
 assert.equal(state.worksCalls,1);assert.deepEqual(memberLines(app),[],'the first Work list has not arrived');
 state.chatHold=new Promise<void>(r=>{releaseChat=r;});state.chatStatus=chatStatus;await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 try{
  releaseWorks();await settle();assert.equal(state.worksCalls,1,'no newer list request superseded the held one');assert.deepEqual(memberLines(app),['Churn causes실행 중'],'global Work is not bound to the selected conversation');
  state.hold=null;state.worksStatus=503;releaseChat();await settle();assert.deepEqual(memberLines(app),['Churn causes실행 중'],'an unavailable subsequent read keeps the received list');
  assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
 }finally{releaseWorks();releaseChat();await settle();}
});

for(const receipt of [false,true])test('a known '+(receipt?'idempotent receipt':'committed confirmation')+' clears its pending marker before a delayed follow-up read',async()=>{
 const {app,state,apply,posts,line,open}=steeringFixture();await open();state.postBody={missionId:'intake',workId:'w1',status:'recorded',...(receipt?{replayed:true}:{})};state.turn.steer.status='recorded';
 let release=()=>{};state.chatHold=new Promise<void>(r=>{release=r;});await apply()!.fire('click');await settle();
 try{assert.equal([...app.storage].some(([key])=>key.startsWith('massion.workbench.steering:')),false,'the exact POST outcome resolves its receipt before GET completes');assert.equal(runInContext('[...chatSteering.values()].some(entry=>entry.busy)',app.context),false);assert.equal(line()!.textContent,'방향 바꿈: Churn causes');assert.equal(posts().length,1);}finally{release();await settle();}
 assert.equal(line()!.textContent,'방향 바꿈: Churn causes');assert.equal(apply(),undefined);
});

test('a definite refusal followed by proposed offers a fresh Apply, but only another owner click sends',async()=>{
 const {app,state,apply,posts,open}=steeringFixture();await open();state.postBody={status:'not_recorded'};const old=apply()!;await old.fire('click');await settle();
 assert.equal(posts().length,1);assert.ok(apply());assert.equal(apply()!.disabled,false);assert.equal([...app.storage].some(([key])=>key.startsWith('massion.workbench.steering:')),false);
 await runInContext('readChat()',app.context);await settle();await old.fire('click');await settle();assert.equal(posts().length,1,'refresh and detached original Apply do not retry');
 state.postBody={status:'unknown'};await apply()!.fire('click');await settle();assert.equal(posts().length,2);assert.equal(apply(),undefined);
});

for(const [status,reason] of [[503,'drain'],[409,'feed']] as const)test('a structured '+reason+' rejection resolves the attempt without treating its HTTP status alone as proof',async()=>{
 const {app,state,apply,posts,open}=steeringFixture();await open();state.postStatus=status;state.postBody={outcome:'rejected',reason};await apply()!.fire('click');await settle();
 assert.ok(apply());assert.equal(apply()!.disabled,false);assert.equal(runInContext('chatSteering.size',app.context),0);assert.equal([...app.storage].some(([key])=>key.startsWith('massion.workbench.steering:')),false);assert.equal(posts().length,1);
});

for(const body of [null,[],{},'recorded',{status:true},{status:'replayed'},{status:'proposed'},{error:'Bad request'}])test('an invalid or unresolved confirmation body '+JSON.stringify(body)+' keeps Check and its receipt',async()=>{
 const {app,state,apply,posts,line,open}=steeringFixture();await open();state.postBody=body;state.postStatus=body&&typeof body==='object'&&'error' in body?400:200;await apply()!.fire('click');await settle();
 assert.equal(apply(),undefined);assert.equal(line()!.textContent,'결과 모름: Churn causes확인');assert.equal([...app.storage].filter(([key])=>key.startsWith('massion.workbench.steering:')).length,1);assert.equal(posts().length,1);
});

test('a late known result cannot clear or reread a newer same-key attempt',async()=>{
 const {app,state,apply,posts,open}=steeringFixture();await open();let releaseOld=()=>{},releaseNew=()=>{};state.hold=new Promise<void>(r=>{releaseOld=r;});state.postBody={status:'not_recorded'};await apply()!.fire('click');await settle();
 state.turn.steer.status='not_recorded';await runInContext('readChat()',app.context);await settle();state.turn.steer.status='proposed';await runInContext('readChat()',app.context);await settle();
 state.hold=new Promise<void>(r=>{releaseNew=r;});state.postBody={status:'unknown'};await apply()!.fire('click');await settle();const marker=[...app.storage].find(([key])=>key.startsWith('massion.workbench.steering:'))!,reads=state.reads;
 try{releaseOld();await settle();assert.equal(state.reads,reads,'the older attempt cannot launch a read over the new attempt');assert.equal(app.storage.get(marker[0]),marker[1]);assert.equal(apply()!.disabled,true);assert.equal(posts().length,2);}finally{releaseOld();releaseNew();await settle();}
 assert.equal(apply(),undefined);
});

for(const move of ['thread-return','segment','feed'] as const)test('a late known refusal after '+move+' keeps its unresolved receipt and does not redraw',async()=>{
 const {app,state,line,apply,open}=steeringFixture();await open();let release=()=>{};state.hold=new Promise<void>(r=>{release=r;});state.postBody={status:'not_recorded'};await apply()!.fire('click');await settle();
 const marker=[...app.storage].find(([key])=>key.startsWith('massion.workbench.steering:'))!;
 if(move==='thread-return'){await app.node('side-representative').fire('click');await open();}else if(move==='segment'){await app.node('chat-earlier').fire('click');await settle();}else{state.feed='feed:b';runInContext('chatReset()',app.context);await open();}
 const before={reads:state.reads,text:line()?.textContent};release();await settle();assert.equal(state.reads,before.reads);assert.equal(line()?.textContent,before.text);assert.equal(app.storage.get(marker[0]),marker[1]);
});

for(const replay of [false,true])for(const read of ['failed','proposed'] as const)test('a known '+(replay?'replayed':'committed')+' POST stays Steered after a '+read+' GET until the authoritative read catches up',async()=>{
 const {app,state,apply,posts,line,open}=steeringFixture();await open();state.postBody={missionId:'intake',workId:'w1',status:'recorded',...(replay?{replayed:true}:{})};state.chatStatus=read==='failed'?503:200;
 await apply()!.fire('click');await settle();
 const known=()=>{assert.equal(line()!.textContent,'방향 바꿈: Churn causes');assert.equal(apply(),undefined);assert.equal(line()!.children.some(n=>n.tagName==='BUTTON'),false);assert.equal(posts().length,1);};known();
 assert.equal([...app.storage].some(([key])=>key.startsWith('massion.workbench.steering:')),false,'the pending receipt clears once the POST result is known');
 await runInContext('readChat()',app.context);await settle();known();
 state.chatStatus=200;state.turn.steer.status='unknown';await runInContext('readChat()',app.context);await settle();known();
 state.turn.steer.status='recorded';await runInContext('readChat()',app.context);await settle();known();assert.equal(runInContext('chatSteering.size',app.context),0,'the authoritative terminal read retires the local result');
});

test('a replacement database does not inherit a locally known recorded POST result',async()=>{
 const {app,state,line,apply,posts,open}=steeringFixture();await open();state.postBody={status:'recorded'};await apply()!.fire('click');await settle();assert.equal(line()!.textContent,'방향 바꿈: Churn causes');
 state.feed='feed:b';state.turn.steer.status='not_recorded';await runInContext('readChat()',app.context);await settle();await open();assert.equal(line(),undefined);assert.equal(apply(),undefined);assert.equal(posts().length,1);
});

test('a stale negative read cannot erase an exact committed confirmation response',async()=>{
 const {app,state,apply,posts,line,open}=steeringFixture();await open();state.postBody={status:'recorded'};state.turn.steer.status='not_recorded';
 await apply()!.fire('click');await settle();assert.equal(line()!.textContent,'방향 바꿈: Churn causes');assert.equal(apply(),undefined);assert.equal(posts().length,1);
 state.turn.steer.status='recorded';await runInContext('readChat()',app.context);await settle();assert.equal(runInContext('chatSteering.size',app.context),0);assert.equal(line()!.textContent,'방향 바꿈: Churn causes');
});

test('a late global Work list activates a recorded steering link without another conversation read',async()=>{
 const turn={id:'assistant-turn:m:late',messageId:'m:late',status:'answered',displayStatus:'answered',steer:{missionId:'intake',workId:'w1',status:'recorded',title:'Finished result'}};
 const {app,state}=fixture({memberThread:{messages:[{id:'m:late',role:'owner',turnId:null,text:'Change the scope.'}],turns:[turn]}});await settle();await app.all().find(n=>n.id==='side-member-member-q')!.fire('click');await settle();
 const line=app.all().find(n=>n.id==='chat-system-steer-'+turn.id)!;assert.equal(line.children[0]!.tagName,'SPAN');const reads=app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length;
 state.works=[row({workId:'w1',title:'Finished result',memberId:'member-q',execution:'settled',acceptance:'accepted',started:true})];
 let release=()=>{};state.hold=new Promise<void>(resolve=>{release=resolve;});const pending=runInContext('shellWorksLoad()',app.context);await settle();assert.equal(line.children[0]!.tagName,'SPAN');release();await pending;await settle();
 assert.equal(line.children[0]!.tagName,'BUTTON');assert.equal(app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length,reads);assert.equal(runInContext('chatPendingTimer',app.context),0);assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});

for(const projection of ['turn','shell'] as const)test('a fake clock refreshes an eventless waiting Work from '+projection,async()=>{
 const work=row({workId:'clocked',title:'Clocked check',memberId:'member-q',execution:'waiting',acceptance:'pending',started:true}),turn={id:work.turnId,messageId:'m:clocked',status:'answered',displayStatus:'answered',proposal:{title:work.title},work};
 const {app,state}=fixture(projection==='turn'?{turns:[turn],messages:[{id:'r:clocked',role:'representative',turnId:turn.id,text:'Checking.'}]}:{works:[work]});await settle();
 let now=T0+60000;app.context.Date=class extends Date{static now(){return now;}};
 const timers=new Map<number,{run:()=>void;delay:number}>();let sequence=0;app.context.setTimeout=(run:()=>void,delay:number)=>{const id=++sequence;timers.set(id,{run,delay});return id;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 await runInContext('readChat()',app.context);await settle();const timer=timers.get(runInContext('chatPendingTimer',app.context));assert.equal(timer?.delay,60000,'waiting has the same minute clock as active execution');
 const reads=app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length,lists=state.worksCalls;
 if(projection==='turn')assert.match(app.all().find(n=>n.id==='chat-card-'+turn.id)!.textContent,/1분/);else state.works=[{...state.works[0]!,execution:'settled',acceptance:'accepted',endedAt:T0+180000}];
 now+=120000;timer!.run();await settle();assert.ok(app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length>reads);assert.ok(state.worksCalls>lists);
 if(projection==='turn'){assert.match(app.all().find(n=>n.id==='chat-card-'+turn.id)!.textContent,/3분/);assert.equal(timers.get(runInContext('chatPendingTimer',app.context))?.delay,60000);}else{assert.deepEqual(memberLines(app),['Clocked check완료']);assert.equal(runInContext('chatPendingTimer',app.context),0);}
 assert.equal(app.calls.filter(c=>c.options?.method==='POST').length,0);
});
