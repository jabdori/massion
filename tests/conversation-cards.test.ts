import test from 'node:test';
import assert from 'node:assert/strict';
import {chatStyle} from '../src/assistant-conversation-panel.ts';
import {workbenchPage} from '../src/workbench.ts';
import {harness,reply,settle} from './support/workbench-client.ts';
import type {Node} from './support/workbench-client.ts';

// docs/architecture/conversation-cards.md: one slot per Work that changes in place, exception cards with only the safe action, decision cards as the only yellow.
type Work={workId:string;title:string;execution:string;acceptance:string;started:boolean;unknown?:boolean;startedAt?:number|null;steps?:{done:number;total:number}};
type Entry={text:string;at?:number;work?:Work;outcome?:'unknown'|'not_created'};
const T0=Date.UTC(2026,10,5,0,40);
function fixture(entries:Entry[],extra:{decisions?:unknown[];briefings?:unknown[]}={}){
 const criteria={version:1,description:'Answer the owner request',oracle:'bounded-text-review/v1'};
 const state={entries,extra,revision:2,cursor:1,events:[] as any[],posted:[] as {path:string;body:any}[],answer:200};
 const works=()=>state.entries.flatMap(e=>e.work?[e.work]:[]);
 const mission=()=>({id:'intake',version:1,purpose:'Owner requests',scope:'local',constraints:[],criteria,works:works().map(w=>({id:w.workId,title:w.title,missionVersion:1,criteria,execution:w.execution,acceptance:w.acceptance,tasks:[],attempts:[{id:'attempt:1',number:1,criteria,status:'queued',modelVersions:[]}],assignments:[],effects:[],appliedMemoryVersions:[],budget:{limit:8,reserved:0,measured:0}})),memories:[],growth:[],relations:[]});
 const view=()=>{const messages:any[]=[],turns:any[]=[];state.entries.forEach((e,i)=>{const id=String(i+1).repeat(32),turn='assistant-turn:m:'+id;messages.push({id:'m:'+id,role:'owner',turnId:null,text:e.text},{id:'r:'+turn,role:'representative',turnId:turn,text:'Okay.'});
  const w=e.work;turns.push({id:turn,messageId:'m:'+id,status:'answered',displayStatus:'answered',...(e.at?{at:e.at}:{}),...(w||e.outcome?{proposal:{title:w?.title??'Lost one'}}:{}),
   ...(w?{outcome:{work:{status:'admitted',diagnostics:[]},run:{status:'started',diagnostics:[]}},work:{missionId:'intake',missionRevision:state.revision,workId:w.workId,title:w.title,execution:w.execution,acceptance:w.acceptance,started:w.started,startedAt:w.startedAt??null,unknown:!!w.unknown,steps:w.steps??{done:0,total:2}}}:e.outcome?{outcome:{work:{status:e.outcome,diagnostics:[]},run:{status:'off',diagnostics:[]}}}:{})});});
  return {feedId:'feed:a',cursor:state.cursor,head:1,segment:{number:1,revision:9,closed:false,full:false,previous:null,messages},turns,...state.extra};};
 const app=harness(async(path,options)=>{
  if(options?.method==='POST'){state.posted.push({path,body:JSON.parse(options.body)});return reply({},state.answer);}
  if(path==='/assistant/works')return reply({feedId:'feed:a',works:view().turns.filter(t=>t.work).map(t=>({memberId:null,endedAt:null,segment:1,...t.work,turnId:t.id})).reverse()});
  if(path.startsWith('/assistant/conversation'))return reply(view());
  if(path.startsWith('/events'))return reply({feedId:'feed:a',cursor:state.cursor,events:state.events});
  if(path.startsWith('/read-state'))return reply({feedId:'feed:a',cursor:1,snapshot:{revision:state.revision,value:mission()}});
  if(path==='/missions/intake')return reply({revision:state.revision,value:mission()});
  return reply({error:'Not configured'},503);
 });
 return {app,state};
}
const turnId=(n:number)=>'assistant-turn:m:'+String(n).repeat(32);
const byId=(app:ReturnType<typeof harness>,id:string)=>app.all().find(n=>n.id===id);
const button=(node:Node,label:string)=>{const found:Node[]=[];const visit=(n:Node)=>{if(n.tagName==='BUTTON'&&n.textContent===label)found.push(n);n.children.forEach(visit);};visit(node);return found[0];};
const shown=(app:ReturnType<typeof harness>)=>app.node('chat-log').children.filter(n=>!n.hidden);
const posts=(app:ReturnType<typeof harness>)=>app.calls.filter(c=>c.options?.method==='POST');

test('a running Work is one card with assignee, role chips, steps and elapsed minutes, and folds into one line in the same place when done',async()=>{
 const running:Work={workId:'work:a',title:'Churn causes',execution:'active',acceptance:'pending',started:true,startedAt:Date.now()-45*60000,steps:{done:1,total:2}};
 const {app,state}=fixture([{text:'Find churn causes',at:T0,work:running},{text:'Thanks',at:T0+60000}]);await settle();
 const card=byId(app,'chat-card-'+turnId(1))!;assert.ok(card);assert.equal(card.className,'chat-card');
 for(const part of ['Churn causes','작업 중','하나','45분','작성','확인','1/2'])assert.ok(card.textContent.includes(part),part);
 const chips=card.children.flatMap(function all(n:Node):Node[]{return [n,...n.children.flatMap(all)];}).filter(n=>/\bchip\b/.test(n.className));
 assert.deepEqual(chips.map(c=>[c.textContent,/\bcheck\b/.test(c.className)]),[['작성',false],['확인',true]]);
 const slot=shown(app).indexOf(card);assert.ok(slot>0);
 state.entries[0]!.work={...running,execution:'settled',acceptance:'accepted',steps:{done:2,total:2}};await app.node('chat-latest').fire('click');await settle();
 assert.ok(!shown(app).includes(card),"replaced in place");const line=byId(app,'chat-fold-'+turnId(1))!;assert.equal(line.tagName,'BUTTON');assert.equal(line.textContent,'작업함 ›');assert.equal(shown(app).indexOf(line),slot,'the folded line takes the card slot');
 assert.equal(app.node('work-pane').hidden,true);await line.fire('click');await settle();assert.equal(app.node('work-pane').hidden,false);
 // Work room participants (members.md): the producing seat, its role chip, and Check last.
 assert.equal(app.node('pane-people').hidden,false);assert.equal(app.node('pane-people').textContent,'하하나확인','B7: the Representative and Check, no role chip for a Work it holds alone');assert.equal((app.context as any).document.activeElement.id,'work-heading-work:a');
 assert.equal(posts(app).length,0);
});

test('a result-unknown Work shows an exception card whose Check only reads again, never resends or closes',async()=>{
 const {app}=fixture([{text:'Order toner',at:T0,work:{workId:'work:u',title:'Toner order',execution:'blocked',acceptance:'pending',started:true,unknown:true}},{text:'Where is it?',at:T0,outcome:'unknown'}]);await settle();
 const card=byId(app,'chat-exception-'+turnId(1))!;assert.ok(card);assert.match(card.textContent,/Toner order.*결과 모름.*다시 보내지 않음/);
 assert.equal(button(card,'다시 시도'),undefined);assert.equal(button(card,'닫기'),undefined);assert.ok(byId(app,'chat-fold-'+turnId(1)),'the Work itself folds');
 const lost=byId(app,'chat-exception-'+turnId(2))!;assert.match(lost.textContent,/Lost one.*결과 모름.*생성 결과 모름/);assert.equal(byId(app,'chat-fold-'+turnId(2)),undefined,'no Work to open');
 const reads=app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length;
 await button(card,'확인')!.fire('click');await settle();
 assert.ok(app.calls.filter(c=>c.path.startsWith('/assistant/conversation')).length>reads);assert.equal(posts(app).length,0);
 assert.match(app.node('activity-list').textContent,/Toner order.*결과 모름/);assert.equal(app.node('side-work').children.length,0,'Work lines show running Work only');
});

test('a failed Work offers Retry, which refills the input with the original request, and Close, which records cancel once and shows a grey line',async()=>{
 const {app,state}=fixture([{text:'Find churn causes with two sources',at:T0,work:{workId:'work:f',title:'Churn causes',execution:'settled',acceptance:'failed',started:true}}]);await settle();
 const card=byId(app,'chat-exception-'+turnId(1))!;assert.match(card.textContent,/Churn causes.*실패.*확인 실패/);assert.equal(button(card,'확인'),undefined);
 await button(card,'다시 시도')!.fire('click');await settle();assert.equal(app.node('chat-input').value,'Find churn causes with two sources');assert.equal((app.context as any).document.activeElement.id,'chat-input');assert.equal(posts(app).length,0,'Retry sends nothing by itself');
 state.answer=500;await button(card,'닫기')!.fire('click');await settle();
 assert.equal(posts(app).length,1,'an unknown close is not retried');const sent=state.posted[0]!;assert.equal(sent.path,'/missions/intake/commands');
 assert.deepEqual(Object.keys(sent.body).sort(),['command','commandId','expectedRevision']);assert.deepEqual(sent.body.command,{type:'cancel',workId:'work:f'});assert.equal(sent.body.expectedRevision,2);
 state.entries[0]!.work={...state.entries[0]!.work!,execution:'cancelled'};await app.node('chat-latest').fire('click');await settle();
 assert.ok(!shown(app).includes(card),"replaced in place");const line=byId(app,'chat-system-closed:'+turnId(1))!;assert.equal(line.textContent,'닫힘: Churn causes');assert.ok(byId(app,'chat-fold-'+turnId(1)));
});

test('decision cards are yellow with a question, time, rows, the action and Later; Later and done leave grey lines; open decisions rank first in activity',async()=>{
 const decision={id:'decision:1',at:T0+30*60000,title:'Rounding rule',question:'Round once on the total?',rows:[['Now','Per line · TOTAL 4 cents'],['After','Once on the total · 3 cents']],action:'Change',state:'open'};
 const {app,state}=fixture([{text:'Find churn causes',at:T0,work:{workId:'work:a',title:'Churn causes',execution:'active',acceptance:'pending',started:true}},{text:'Total please',at:T0+60*60000}],{decisions:[decision,{id:'bad'}]});await settle();
 const card=byId(app,'chat-decision-decision:1')!;assert.ok(card);assert.equal(card.className,'chat-decision');assert.equal(card.attributes.get('aria-label'),'Round once on the total?');
 const time=new Date(decision.at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
 for(const part of ['Round once on the total?',time,'Now','Per line · TOTAL 4 cents','After'])assert.ok(card.textContent.includes(part),part);
 assert.ok(button(card,'바꾸기'));assert.ok(button(card,'나중에'));assert.doesNotMatch(card.textContent,/next time|don.t ask/i);
 const order=shown(app);assert.ok(order.indexOf(card)>order.indexOf(byId(app,'chat-card-'+turnId(1))!)&&order.indexOf(card)<order.findIndex(n=>n.textContent==='Total please'),'placed at its time');
 assert.equal(byId(app,'chat-decision-bad'),undefined,'malformed decisions are ignored');
 const rows=app.node('activity-list').children;assert.match(rows[0]!.textContent,/Rounding rule.*Round once on the total\?/);
 await button(card,'나중에')!.fire('click');await settle();
 assert.deepEqual(state.posted.map(p=>[p.path,Object.keys(p.body).sort(),p.body.decisionId,p.body.answer]),[['/assistant/decisions',['answer','commandId','decisionId'],'decision:1','later']]);
 state.extra.decisions=[{...decision,state:'later'}];await app.node('chat-latest').fire('click');await settle();
 assert.ok(!shown(app).includes(card),"replaced in place");const later=byId(app,'chat-system-decision:1')!;assert.match(later.textContent,/^나중에: Round once on the total\?다시 묻기$/);
 await button(later,'다시 묻기')!.fire('click');await settle();assert.equal(state.posted.at(-1)!.body.answer,'ask');
 assert.doesNotMatch(app.node('activity-list').children[0]!.textContent,/Rounding rule/,'a deferred decision is not waiting');
 state.extra.decisions=[{...decision,state:'done',line:'Rounding changed'}];await app.node('chat-latest').fire('click');await settle();assert.equal(later.textContent,'Rounding changed');
});

test('a briefing is one grey card whose bullets link to Work with its current state, and date lines separate days',async()=>{
 const day2=T0+24*3600000;
 const {app}=fixture([{text:'Find churn causes',at:T0,work:{workId:'work:a',title:'Churn causes',execution:'active',acceptance:'pending',started:true}},{text:'Morning',at:day2+3600000}],{briefings:[{id:'briefing:1',at:day2,title:'Morning briefing',turnIds:[turnId(1),'assistant-turn:missing']}]});await settle();
 const brief=byId(app,'chat-briefing-briefing:1')!;assert.ok(brief);
 assert.match(brief.textContent,new RegExp('^Morning briefing \\| '+'11월 6일 금요일'));
 assert.match(brief.textContent,/Churn causes 작업 중/);assert.doesNotMatch(brief.textContent,/missing/);
 const dates=shown(app).filter(n=>n.className==='chat-date').map(n=>n.textContent);assert.equal(dates.length,2);
 const order=shown(app);assert.ok(order.indexOf(brief)>order.findIndex(n=>n.className==='chat-date'&&n.textContent===dates[1])&&order.indexOf(brief)<order.findIndex(n=>n.textContent==='Morning'));
 await button(brief,'Churn causes')!.fire('click');await settle();assert.equal(app.node('work-pane').hidden,false);assert.equal((app.context as any).document.activeElement.id,'work-heading-work:a');
});

test('yellow role tokens are consumed only by decision card styles',()=>{
 const style=chatStyle;
 for(const rule of style.split('}'))if(/var\(--gate/.test(rule))assert.match(rule.trim(),/^(@media[^{]*\{)?\.chat-decision/,rule);
 assert.match(style,/\.chat-decision\{[^}]*var\(--gate-wash\)/);
});

test('a closed Work whose outcome is still unknown keeps its exception card, and unknown Work ranks as an exception even while waiting',async()=>{
 const {app}=fixture([{text:'Order toner',at:T0,work:{workId:'work:c',title:'Toner order',execution:'cancelled',acceptance:'pending',started:true,unknown:true}},{text:'Ask the vendor',at:T0,work:{workId:'work:w',title:'Vendor question',execution:'waiting',acceptance:'pending',started:true,unknown:true}},{text:'Find churn causes',at:T0,work:{workId:'work:a',title:'Churn causes',execution:'active',acceptance:'pending',started:true}}]);await settle();
 for(const n of [1,2]){const card=byId(app,'chat-exception-'+turnId(n))!;assert.ok(card,'exception '+n);assert.match(card.textContent,/결과 모름.*다시 보내지 않음/);assert.ok(button(card,'확인'));assert.equal(button(card,'닫기'),undefined);}
 assert.equal(byId(app,'chat-system-closed:'+turnId(1)),undefined,'a plain cancel does not answer an unknown outcome');
 assert.deepEqual(app.node('side-work').children.map(n=>n.textContent),['Churn causes작업 중'],'Work lines show running Work only');
 assert.deepEqual(app.node('activity-list').children.map(n=>n.children[0]!.children[0]!.textContent),['Vendor question','Toner order','Churn causes'],'unknown before running');
});

test('a Work stopped after starting offers Retry and Close; a refused Close is not resent and the card stays',async()=>{
 const {app,state}=fixture([{text:'Find churn causes',at:T0,work:{workId:'work:s',title:'Churn causes',execution:'blocked',acceptance:'pending',started:true}}]);await settle();
 const card=byId(app,'chat-exception-'+turnId(1))!;assert.match(card.textContent,/Churn causes.*실패.*중지됨/);assert.ok(button(card,'다시 시도'));
 state.answer=409;await button(card,'닫기')!.fire('click');await settle();
 assert.equal(posts(app).length,1);assert.ok(shown(app).includes(card));assert.equal(button(card,'닫기')!.disabled,false);
});

test('Retry keeps typed text and never replaces a draft whose delivery is unknown',async()=>{
 const {app}=fixture([{text:'Find churn causes',at:T0,work:{workId:'work:f',title:'Churn causes',execution:'settled',acceptance:'failed',started:true}}]);await settle();
 const card=byId(app,'chat-exception-'+turnId(1))!,input=app.node('chat-input'),key='massion.workbench.chat-draft';
 input.value='A new note';await input.fire('input');await button(card,'다시 시도')!.fire('click');await settle();
 assert.equal(input.value,'A new note');assert.equal((app.context as any).document.activeElement.id,'chat-input');
 const unknown=JSON.stringify({text:'Order toner',commandId:'cmd-1',target:{segment:1,expectedRevision:9}});input.value='Order toner';app.storage.set(key,unknown);
 await button(card,'다시 시도')!.fire('click');await settle();assert.equal(input.value,'Order toner');assert.equal(app.storage.get(key),unknown);
 input.value='';app.storage.delete(key);await button(card,'다시 시도')!.fire('click');await settle();assert.equal(input.value,'Find churn causes');
});

test('a slot that changes kind moves no other entry, so focus elsewhere stays and the live log does not re-announce',async()=>{
 const running:Work={workId:'work:a',title:'Churn causes',execution:'active',acceptance:'pending',started:true};
 const {app,state}=fixture([{text:'Find churn causes',at:T0,work:running},{text:'Order toner',at:T0+60000,work:{workId:'work:f',title:'Toner order',execution:'settled',acceptance:'failed',started:true}}]);await settle();
 const other=byId(app,'chat-exception-'+turnId(2))!,before=shown(app).filter(n=>n.id!=='chat-card-'+turnId(1));
 state.entries[0]!.work={...running,execution:'settled',acceptance:'accepted'};await app.node('chat-latest').fire('click');await settle();
 assert.ok(byId(app,'chat-fold-'+turnId(1)));for(const node of before)assert.equal(node.detaches,0,node.id||node.textContent);assert.ok(shown(app).includes(other));
});

test('a briefing read from an earlier segment shows and opens the Work it carries after the conversation rolls over',async()=>{
 const old={id:'assistant-turn:old',messageId:'old',status:'answered',displayStatus:'answered',at:T0-3600000,proposal:{title:'Old receipts'},work:{missionId:'intake',missionRevision:2,workId:'work:old',title:'Old receipts',execution:'settled',acceptance:'accepted',started:true}};
 const {app}=fixture([{text:'Morning',at:T0+3600000}],{briefings:[{id:'briefing:2',at:T0,title:'Morning briefing',turnIds:[old.id],turns:[old]}]});await settle();
 assert.match(byId(app,'chat-briefing-briefing:2')!.textContent,/Old receipts/);
 await button(byId(app,'chat-briefing-briefing:2')!,'Old receipts')!.fire('click');await settle();assert.equal(app.node('work-pane').hidden,false,'its Work link opens the Work');
});


test('send status follows the composer and structural borders stay quiet',()=>{
 assert.ok(workbenchPage.indexOf('id="chat-status"')>workbenchPage.indexOf('id="chat-form"'));
 assert.match(chatStyle,/#chat-status\{[^}]*margin:var\(--space-6\)/);
 for(const selector of ['sidebar','pane']){
  const rule=new RegExp('\\.'+selector+'\\{([^}]+)\\}').exec(workbenchPage)![1]!;
  assert.ok(!rule.includes('var(--line-strong)'),selector);
 }
});
