import test from 'node:test';
import assert from 'node:assert/strict';
import {runInContext} from 'node:vm';
import {harness,reply,settle,Node} from './support/workbench-client.ts';

const at=Date.UTC(2026,10,5,5,11);
const payment={kind:'payment',adapterId:'fixture-payment',checkoutId:'checkout:1',item:'레이저 토너 검정',quantity:1,subtotal:31000,shipping:3000,total:34000,currency:'KRW',merchant:'오피스몰',origin:'https://shop.example.com',destination:'집 · 저장된 주소',method:'카드 끝자리 0000',expiresAt:Date.now()+19*60000,cancellation:'결제 후 취소 신청 가능',pagesRead:3,startedAt:at-3*60000};
const external={kind:'external-member',adapterId:'fixture-external',deviceId:'device:1',deviceName:'내 노트북',agentId:'agent:1',agentName:'Claude Code',instruction:'깨지는 테스트 고치기',scope:'massion'};
function decision(request:any=payment){return {id:'decision:1',at,title:'토너 주문',question:'34,000원 결제할까요?',rows:[['상품',request.item||request.instruction]],action:request.kind==='payment'?'34,000원 결제':'맡기기',state:'open',effect:{kind:request.kind,missionId:'mission:1',workId:'work:1',effectId:'effect:1',status:'pending',request}};}
function fixture(d:any=decision()){
 const state={decisions:[d],feed:'feed:a',hold:null as Promise<void>|null,deadline:undefined as number|undefined,memberDecisions:[] as any[],answer:reply({}),head:1,readHold:null as Promise<void>|null};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){if(state.hold)await state.hold;return state.answer;}
  if(path.startsWith('/assistant/conversation')){if(state.readHold)await state.readHold;const segment=Number(new URLSearchParams(path.split('?')[1]).get('segment')||state.head);return reply({feedId:state.feed,cursor:1,head:state.head,runDeadlineAt:state.deadline,segment:{number:segment,revision:1,closed:false,full:false,previous:segment>1?'assistant-conversation:'+String(segment-1):null,messages:[]},turns:[],decisions:path.includes('member=')?state.memberDecisions:state.decisions,members:[{id:'member:1',name:'민수'}]});}
  if(path==='/assistant/works')return reply({feedId:state.feed,works:[]});
  if(path.startsWith('/read-state'))return reply({feedId:state.feed,cursor:1,snapshot:null});
  if(path.startsWith('/events'))return reply({feedId:state.feed,cursor:1,events:[]});
  return reply({},503);
 });
 return {app,state};
}
const find=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id)!;
const descendants=(node:Node):Node[]=>[node,...node.children.flatMap(descendants)];
const button=(node:Node,text:string)=>descendants(node).find(n=>n.tagName==='BUTTON'&&n.textContent===text)!;
const refresh=async(app:ReturnType<typeof harness>)=>{await app.node('chat-latest').fire('click');await settle();};
const posts=(app:ReturnType<typeof harness>)=>app.calls.filter(c=>c.options?.method==='POST');

test('payment opens an unavailable browser pane without exposing checkout fields or another payment control',async()=>{
 const {app}=fixture();await settle();const card=find(app,'chat-decision-decision:1');
 const open=button(app.node('chat-log'),'3분 동안 작업 · 페이지 3개 읽음');assert.ok(open);await open.fire('click');await settle();
 const pane=find(app,'pane-effect');assert.equal(pane.hidden,false);
 for(const value of ['shop.example.com','오피스몰','레이저 토너 검정','31,000원','3,000원','34,000원','집 · 저장된 주소','카드 끝자리 0000'])assert.ok(!pane.textContent.includes(value),value);
 assert.match(pane.textContent,/사용 불가/);assert.deepEqual(descendants(card).filter(n=>n.tagName==='BUTTON').map(n=>n.textContent),['34,000원 결제','나중에']);
 assert.equal(descendants(pane).some(n=>n.tagName==='IFRAME'||n.tagName==='A'),false);
 assert.equal(posts(app).length,0);
 await button(card,'34,000원 결제').fire('click');await settle();
 assert.deepEqual(JSON.parse(posts(app)[0]!.options.body),{commandId:JSON.parse(posts(app)[0]!.options.body).commandId,decisionId:'decision:1',answer:'act'});
});

test('unknown effects offer readback only, including a malformed open-state projection',async()=>{
 const d=decision();d.effect.status='unknown';const {app}=fixture(d);await settle();
 const log=app.node('chat-log');assert.match(log.textContent,/결과 모름/);assert.equal(button(log,'34,000원 결제'),undefined);assert.ok(button(log,'확인'));
 await button(log,'확인').fire('click');await settle();assert.equal(posts(app).length,0);
});

test('detached or changed decision buttons cannot send a stale payment',async()=>{
 const {app,state}=fixture();await settle();const old=button(find(app,'chat-decision-decision:1'),'34,000원 결제');
 state.decisions=[{...decision(),effect:{...decision().effect,request:{...payment,total:35000}}}];await refresh(app);
 await old.fire('click');await settle();assert.equal(posts(app).length,0);
});

test('an in-flight answer cannot reread or render into a subsequently selected member thread',async()=>{
 const {app,state}=fixture();await settle();let release!:()=>void;state.hold=new Promise<void>(r=>release=r);
 await button(find(app,'chat-decision-decision:1'),'34,000원 결제').fire('click');await settle();
 runInContext("chatOpenThread('member:1','민수')",app.context);await settle();const reads=app.calls.length;
 release();await settle();assert.equal(app.calls.length,reads);assert.equal(app.node('chat-log').textContent,'');assert.equal(posts(app).length,1);
});

test('external received and later states use recorded lines without claiming remote execution',async()=>{
 const d={...decision(external),title:'깨지는 테스트 고치기',question:'노트북의 Claude Code에게 처음 맡길까요?',state:'done',line:'노트북의 Claude Code에게 맡김 09:13'};d.effect.status='succeeded';
 const {app,state}=fixture(d);await settle();assert.match(app.node('activity-list').textContent,/노트북의 Claude Code에게 맡김/);assert.doesNotMatch(app.node('chat-log').textContent,/실행 중|완료/);
 state.decisions=[{...d,state:'later',line:'노트북의 Claude Code에게 맡기기'}];await refresh(app);
 assert.match(app.node('chat-log').textContent,/나중에: 노트북의 Claude Code에게 맡기기/);assert.ok(button(app.node('chat-log'),'다시 묻기'));
});

test('an arrival receipt remains received when the effect status is unknown',async()=>{
 const d={...decision(external),state:'done',line:'내 노트북의 Claude Code에게 맡김 09:13',effect:{...decision(external).effect,status:'unknown',claimedAt:at,answer:'act',receipt:{idempotencyKey:'key',remoteId:'remote:1',outcome:'received',detail:'접수'}}};
 const {app}=fixture(d);await settle();assert.match(app.node('chat-log').textContent,/맡김/);assert.match(app.node('chat-log').textContent,/응답 대기/);assert.match(app.node('chat-log').textContent,/받은 답 없음/);assert.doesNotMatch(app.node('chat-log').textContent,/결과 모름|실행 중|완료/);
});

test('lost approval replies cannot enable a second payment on stale readback',async()=>{
 const {app}=fixture();await settle();await button(find(app,'chat-decision-decision:1'),'34,000원 결제').fire('click');await settle();
 const act=button(app.node('chat-log'),'34,000원 결제');if(act)await act.fire('click');await settle();assert.equal(posts(app).length,1);
});

test('an open checkout follows read replacements and cannot be approved after expiry',async()=>{
 const {app,state}=fixture();await settle();await button(app.node('chat-log'),'3분 동안 작업 · 페이지 3개 읽음').fire('click');await settle();
 state.decisions=[{...decision(),effect:{...decision().effect,request:{...payment,total:35000,subtotal:32000,expiresAt:Date.now()-1}}}];await refresh(app);
 assert.doesNotMatch(find(app,'pane-effect').textContent,/35,000원/);
 const act=button(find(app,'chat-decision-decision:1'),'34,000원 결제');assert.equal(act.disabled,true);await act.fire('click');await settle();assert.equal(posts(app).length,0);
});

test('a decision removed from the latest read leaves no cached checkout details',async()=>{
 const {app,state}=fixture();await settle();await button(app.node('chat-log'),'3분 동안 작업 · 페이지 3개 읽음').fire('click');await settle();
 state.decisions=[];await refresh(app);assert.doesNotMatch(find(app,'pane-effect').textContent,/레이저 토너|34,000원/);
});

test('old buttons remain fenced across a database feed replacement and overlapping clicks',async()=>{
 const {app,state}=fixture();await settle();const old=button(find(app,'chat-decision-decision:1'),'34,000원 결제');state.feed='feed:b';await refresh(app);
 await old.fire('click');await settle();assert.equal(posts(app).length,0);
 const current=button(find(app,'chat-decision-decision:1'),'34,000원 결제');await Promise.all([current.fire('click'),current.fire('click')]);await settle();assert.equal(posts(app).length,1);assert.equal(posts(app)[0]!.options.headers['X-Massion-Feed'],'feed:b');
});

test('payment later and reasking post only the server decision identity',async()=>{
 const {app,state}=fixture();await settle();await button(find(app,'chat-decision-decision:1'),'나중에').fire('click');await settle();assert.equal(JSON.parse(posts(app)[0]!.options.body).answer,'later');
 state.decisions=[{...decision(),state:'later',line:'34,000원 결제'}];await refresh(app);await button(app.node('chat-log'),'다시 묻기').fire('click');await settle();
 assert.deepEqual(Object.keys(JSON.parse(posts(app)[1]!.options.body)).sort(),['answer','commandId','decisionId']);assert.equal(JSON.parse(posts(app)[1]!.options.body).answer,'ask');
});

test('a pending payment Work is marked decision pending in the sidebar',async()=>{
 const {app}=fixture();await settle();const label=runInContext("shellWorkLabel({missionId:'mission:1',workId:'work:1',execution:'waiting',acceptance:'pending',unknown:false})",app.context);assert.equal(label,'결정 대기');
});


test('external admission shows an agent icon and opens devices without answering the decision',async()=>{
 const d=decision(external);d.rows=[['받는 곳','Claude Code · 내 노트북'],['보낼 내용','요청 한 문장 · 저장소 이름 massion · 테스트 이름 1개']];
 const {app}=fixture(d);await settle();const card=find(app,'chat-decision-decision:1'),target=descendants(card).find(n=>n.tagName==='DD')!;
 assert.equal(target.textContent,'CClaude Code · 내 노트북');assert.ok(target.children.some(n=>n.className==='avatar'&&n.attributes.get('aria-hidden')==='true'));
 const open=button(card,'기기 보기');assert.ok(open);await open.fire('click');await settle();assert.equal(runInContext('settingsShown',app.context),'devices');assert.equal(posts(app).length,0);
});


test('expired payments stop scheduling while an overdue run still refreshes after one second',async()=>{
 const now=Date.now(),d=decision();d.effect.request={...payment,expiresAt:now+30000};const {app,state}=fixture(d);await settle();app.context.Date=class extends Date{static now(){return now;}};
 const timers=new Map<number,{delay:number}>();let next=0;app.context.setTimeout=(_run:()=>void,delay:number)=>{timers.set(++next,{delay});return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 await refresh(app);assert.equal(timers.get(runInContext('chatPendingTimer',app.context))!.delay,30000);
 state.deadline=now-1;await refresh(app);assert.equal(timers.get(runInContext('chatPendingTimer',app.context))!.delay,1000);
 state.deadline=undefined;state.decisions=[{...d,effect:{...d.effect,request:{...payment,expiresAt:now-1}}}];await refresh(app);assert.equal(runInContext('chatPendingTimer',app.context),0);
});


test('member skill and app decisions remain visible and support later, ask and act',async()=>{
 const {app,state}=fixture();await settle();
 for(const id of ['skill-decision:one','app-decision:one']){
  const {effect,...d}=decision();state.memberDecisions=[{...d,id,action:'Change'}];runInContext("chatOpenThread('member:1','민수')",app.context);await refresh(app);
  const card=find(app,'chat-decision-'+id);assert.ok(card&&app.node('chat-log').contains(card));await button(card,'나중에').fire('click');await settle();
  state.memberDecisions=[{...d,id,state:'later'}];await refresh(app);await button(app.node('chat-log'),'다시 묻기').fire('click');await settle();
  state.memberDecisions=[{...d,id}];await refresh(app);await descendants(find(app,'chat-decision-'+id)).find(n=>n.tagName==='BUTTON')!.fire('click');await settle();
  assert.deepEqual(posts(app).filter(p=>JSON.parse(p.options.body).decisionId===id).map(p=>JSON.parse(p.options.body).answer),['later','ask','act']);
 }
});

test('only a same-feed confirmed pre-admission rejection unlocks an effect decision',async()=>{
 for(const kind of ['rejected','unknown','wrong-feed'] as const){
  const {app,state}=fixture();await settle();state.answer=reply(kind==='unknown'?{outcome:'unknown'}:{outcome:'rejected',phase:'admission',feedId:kind==='wrong-feed'?'feed:b':'feed:a'},403);
  await button(find(app,'chat-decision-decision:1'),'34,000원 결제').fire('click');await settle();
  if(kind==='rejected'){assert.ok(button(app.node('chat-log'),'34,000원 결제'));await button(app.node('chat-log'),'나중에').fire('click');await settle();assert.deepEqual(posts(app).map(p=>JSON.parse(p.options.body).answer),['act','later']);}
  else {assert.equal(button(app.node('chat-log'),'34,000원 결제'),undefined);assert.equal(posts(app).length,1);}
 }
});


test('deferred decisions rebind Ask again after earlier/latest segment navigation',async()=>{
 const d={...decision(),state:'later',line:'34,000원 결제'}, {app,state}=fixture(d);state.head=2;await settle();
 const old=button(app.node('chat-log'),'다시 묻기');assert.ok(old);
 await app.node('chat-earlier').fire('click');await settle();assert.equal(runInContext('chatSegment',app.context),1);assert.equal(button(app.node('chat-log'),'다시 묻기'),undefined);
 await app.node('chat-latest').fire('click');await settle();assert.equal(runInContext('chatSegment',app.context),null);
 await old.fire('click');await settle();assert.equal(posts(app).length,0);
 await button(app.node('chat-log'),'다시 묻기').fire('click');await settle();assert.equal(posts(app).length,1);assert.equal(JSON.parse(posts(app)[0]!.options.body).answer,'ask');
});

test('unchanged checkout expires locally while the scheduled read is held',async()=>{
 let now=Date.now();const d=decision();d.effect.request={...payment,expiresAt:now+30000};const {app,state}=fixture(d);await settle();app.context.Date=class extends Date{static now(){return now;}};
 const timers=new Map<number,{run:()=>void;delay:number}>();let next=0;app.context.setTimeout=(run:()=>void,delay:number)=>{timers.set(++next,{run,delay});return next;};app.context.clearTimeout=(id:number)=>timers.delete(id);
 runInContext('chatScheduleRead()',app.context);const timer=timers.get(runInContext('chatPendingTimer',app.context))!;
 const generation=runInContext('chatGeneration',app.context),before=JSON.stringify(state.decisions);assert.equal(button(app.node('chat-log'),'34,000원 결제').disabled,false);
 let release!:()=>void;state.readHold=new Promise<void>(r=>{release=r;});now+=timer.delay;timer.run();
 try{assert.equal(button(app.node('chat-log'),'34,000원 결제').disabled,true);assert.equal(button(app.node('chat-log'),'나중에').disabled,false);await button(app.node('chat-log'),'34,000원 결제').fire('click');assert.equal(posts(app).length,0);}
 finally{state.readHold=null;release();await settle();}
 assert.equal(timer.delay,30000);assert.equal(JSON.stringify(state.decisions),before);assert.equal(runInContext('chatGeneration',app.context),generation);assert.equal(button(app.node('chat-log'),'34,000원 결제').disabled,true);
});

test('typed intent approval pins the shown hash and never displays payment success or unknown execution',async()=>{
 const request={kind:'payment-intent',payee:'공급처',amountMinor:34000,currency:'KRW',purpose:'물품 구매',sourceReference:'document:quote'},d={...decision(request),question:'34,000원 결제 승인할까요?',rows:[['받는 곳',request.payee],['금액','34,000원']],action:'승인',effect:{...decision(request).effect,requestHash:'a'.repeat(64)}};
 const {app,state}=fixture(d);await settle();const card=find(app,'chat-decision-decision:1');assert.ok(button(card,'거절'));await button(card,'승인')!.fire('click');await settle();
 assert.equal(JSON.parse(posts(app)[0]!.options!.body as string).requestHash,'a'.repeat(64));
 state.decisions=[{...d,state:'done',line:'승인됨 · Massion 미실행',effect:{...d.effect,answer:'act'}}];await refresh(app);
 assert.match(app.node('chat-log').textContent,/승인됨 · Massion 미실행/);assert.doesNotMatch(app.node('chat-log').textContent,/결제 완료|응답 없음/);assert.equal(posts(app).length,1);
});
test('typed decline is explicit and detached controls cannot answer a changed intent or feed',async()=>{
 const request={kind:'payment-intent',item:'Fixture intent'},d={...decision(request),action:'승인',effect:{...decision(request).effect,requestHash:'a'.repeat(64)}};
 const {app,state}=fixture(d);await settle();const old=button(find(app,'chat-decision-decision:1'),'승인')!;
 state.decisions=[{...d,effect:{...d.effect,requestHash:'b'.repeat(64)}}];await refresh(app);await old.fire('click');assert.equal(posts(app).length,0);
 const decline=button(find(app,'chat-decision-decision:1'),'거절')!;await decline.fire('click');await settle();assert.equal(JSON.parse(posts(app)[0]!.options!.body as string).answer,'reject');
 state.feed='feed:b';await refresh(app);await old.fire('click');assert.equal(posts(app).length,1);
});
