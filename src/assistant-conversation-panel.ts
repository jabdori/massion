import {copy} from './ui-copy.ts';
/** Minimal conversation surface: one continuing conversation, one input, one Work slot per turn updated in place (docs/architecture/conversation-cards.md). Labels only; replies speak for themselves. */
import {representativeName} from './surface-shell.ts';
export const chatStyle=String.raw`.conversation{max-width:var(--conversation-max-width);margin:0 auto 22px;padding:0 4px}.chat-log{display:flex;flex-direction:column;gap:var(--space-10)}.chat-owner{align-self:flex-end;max-width:80%;margin:0;padding:9px 14px;border-radius:16px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}.chat-reply{align-self:flex-start;max-width:90%;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.chat-state{align-self:flex-start;margin:0;color:var(--muted);font-size:.9em}.chat-card{align-self:stretch;display:flex;gap:var(--space-10);align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--bg-1)}.chat-card-open{flex:1;display:flex;gap:var(--space-10);align-items:center;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}.chat-card-open:focus-visible{outline:var(--focus-width) solid var(--focus-ring)}.chat-card strong{flex:1;overflow-wrap:anywhere}.chat-card-state{color:var(--muted)}.chat-send-failure{color:var(--halt)}.app #chat-status button{min-height:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-decoration:underline;text-underline-offset:3px}.chat-nav{display:flex;justify-content:center;gap:8px}.chat-form{display:flex;gap:8px;align-items:flex-end;margin-top:14px}.chat-form textarea{flex:1}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.chat-card{align-items:flex-start}.chat-card-open{align-items:flex-start}.chat-card-open .state{margin-top:4px}.chat-card-main{flex:1;min-width:0;display:grid;gap:7px}.chat-card-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.chat-card .chat-card-head strong{flex:0 1 auto;min-width:0}.chat-card-head .chat-card-state{font-size:var(--type-conversation-button-size)}.chat-card-who{display:flex;gap:6px;align-items:center;color:var(--fg-3);font-size:var(--type-conversation-button-size);white-space:nowrap}.chat-chips{display:flex;gap:5px;flex-wrap:wrap}.chip{padding:1px 7px;border-radius:4px;background:var(--bg-3);color:var(--fg-2);font-size:var(--type-conversation-text-size);font-weight:600}.chip.check{background:transparent;border:1px solid var(--line-strong);color:var(--fg-3)}.chat-steps{color:var(--fg-3);font-size:var(--type-conversation-button-size);font-variant-numeric:tabular-nums}
.app .chat-fold{align-self:flex-start;min-height:0;padding:2px 0;border:0;background:none;color:var(--fg-3);font-weight:500;font-size:var(--type-conversation-button-size)}.app .chat-fold:hover{color:var(--fg)}
.chat-exception{align-self:stretch;display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line-strong);border-radius:10px;padding:10px 14px;background:var(--bg-1)}.chat-exception-main{flex:1;min-width:0}.chat-exception-head{margin:0}.chat-exception-head::before{content:'';display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:var(--halt);vertical-align:middle}.chat-exception-state{margin-left:8px;color:var(--halt);font-size:var(--type-conversation-button-size)}.chat-exception-fact{margin:4px 0 0 15px;color:var(--fg-2);font-size:var(--type-conversation-button-size)}.chat-actions{display:flex;gap:8px;flex:none}.app .chat-actions button{min-height:30px;padding:4px 12px;font-size:var(--type-conversation-button-size)}
.chat-system,.chat-date{align-self:center;margin:0;color:var(--fg-4);font-size:var(--type-conversation-text-size);display:flex;gap:var(--space-10);align-items:center}.app .chat-system button{min-height:0;padding:0;border:0;background:none;color:var(--fg-2);font-size:var(--type-conversation-text-size)}
.chat-briefing{align-self:stretch;border-radius:10px;padding:12px 16px;background:var(--bg-2)}.chat-briefing p{margin:0 0 6px;color:var(--fg-3)}.chat-briefing p strong{color:var(--fg)}.chat-briefing ul{margin:0;padding-left:18px}.app .chat-briefing li button{min-height:0;padding:0;border:0;background:none;color:var(--fg);font-weight:650;text-decoration:underline;text-underline-offset:3px}
.chat-decision{align-self:stretch;padding:14px 16px;border:1px solid var(--gate-border);border-radius:var(--card-decision-radius);background:var(--gate-wash)}.chat-decision-head{display:flex;gap:8px;align-items:baseline;margin:0 0 10px}.chat-decision-head strong{font-size:15px}.chat-decision-head span{margin-left:auto;color:var(--fg-4);font-size:var(--type-conversation-text-size)}.chat-decision-detail{margin:-8px 0 10px;color:var(--fg-3);font-size:var(--type-conversation-text-size)}.chat-decision dl{margin:0 0 12px;display:grid;grid-template-columns:100px minmax(0,1fr);gap:3px 12px;font-size:var(--type-conversation-button-size)}.chat-decision dt{color:var(--fg-4)}.chat-decision dd{margin:0;color:var(--fg-2)}.chat-decision .chat-actions button{border-color:var(--line-strong);background:transparent;color:var(--fg)}.chat-decision .chat-actions button:first-child{border-color:var(--gate);background:var(--gate);color:var(--gate-ink)}
@media (max-width:600px){.chat-card-open,.chat-exception{flex-wrap:wrap}.chat-card-main{flex-basis:calc(100% - 25px)}.chat-card-who{margin-left:21px}.chat-exception-main{flex-basis:100%}}`;
export const chatPanel=String.raw`<section id="conversation" class="conversation" aria-label="${copy('ui.conversation')}"><div class="chat-nav"><button id="chat-earlier" type="button" class="quiet" hidden>${copy('ui.earlier')}</button><button id="chat-latest" type="button" class="quiet" hidden>${copy('ui.latest')}</button></div><div id="chat-log" class="chat-log" role="log" aria-live="polite"></div><p id="chat-status" class="chat-state" role="status" hidden></p><form id="chat-form" class="chat-form"><label for="chat-input" class="visually-hidden">${copy('ui.message',{member:representativeName})}</label><textarea id="chat-input" rows="2" maxlength="4096" placeholder="${copy('ui.message',{member:representativeName})}"></textarea><button id="chat-send" type="submit">${copy('composer.button.03')}</button></form></section>`;
export const chatClient=String.raw`
// chatThread is '' for the Representative or a member ID for that member's one 1:1 conversation (members.md); each keeps its own draft.
let chatDraftKey='massion.workbench.chat-draft',chatThread='',chatThreadName='';
// chatRep keeps the Representative's decisions while a member conversation is open; Work lines use the host list.
let chatView=null,chatRep=null,chatReadDone=null,chatSegment=null,chatReading=false,chatAgain=false,chatSending=false,chatPendingTimer=0,chatGeneration=0,chatSendFailed=false,chatDisconnected=false;
// Nodes are kept by message and turn ID so a reread never moves or recreates what is already shown: focus stays and the live log announces only new items.
const chatCards=new Map(),chatNodes=new Map(),chatStarting=new Set(),chatClosing=new Set(),chatDeciding=new Set();
const chatSteering=new Map(),chatSteerKey=choice=>JSON.stringify([choice.feed,choice.member,choice.segment,choice.turnId]),chatSteerReceipt=key=>'massion.workbench.steering:'+key;
// target is the segment and revision of a submission whose outcome is unknown: a retry goes there, where its message would sit, so the host replays it however far the head moved.
function chatDraft(){try{const value=JSON.parse(storage.get(chatDraftKey)||'null'),target=value&&value.target;return value&&typeof value.text==='string'&&typeof value.commandId==='string'?{text:value.text,commandId:value.commandId,target:target&&Number.isSafeInteger(target.segment)&&target.segment>=1&&Number.isSafeInteger(target.expectedRevision)&&target.expectedRevision>=0?{segment:target.segment,expectedRevision:target.expectedRevision}:null}:{text:'',commandId:'',target:null};}catch{return {text:'',commandId:'',target:null};}}
/** Records the target only while the stored draft is still this command, so an edit made while sending stays a new message. */
function chatPin(commandId,target){const draft=chatDraft();if(draft.commandId===commandId)storage.set(chatDraftKey,JSON.stringify({text:draft.text,commandId,target}));}
const chatReasons={assistant_route_missing:copy('ui.reason-route-missing'),assistant_route_stale:copy('ui.reason-route-stale'),settings_pending:copy('ui.reason-settings-pending'),settings_changed:copy('ui.reason-settings-changed'),default_route_missing:copy('ui.reason-default-missing'),default_route_stale:copy('ui.reason-default-stale'),assistant_intake_unsupported:copy('ui.reason-intake-unsupported'),host_busy:copy('ui.reason-host-busy'),host_draining:copy('ui.reason-host-draining'),intake_conflict:copy('ui.reason-intake-conflict'),work_not_admitted:copy('ui.reason-work-not-admitted')};
function chatReason(list){const code=Array.isArray(list)&&list[0]&&typeof list[0].code==='string'?list[0].code:'';return Object.hasOwn(chatReasons,code)?chatReasons[code]:'';}
function chatTurnLabel(turn){if(turn.displayStatus==='not_started'){const reason=chatReason(turn.diagnostics);return reason?copy('ui.not-sent-reason',{reason}):copy('ui.not-sent');}if(turn.displayStatus==='unknown')return copy('conversation.text.01');if(turn.displayStatus==='failed')return copy('ui.no-answer');if(turn.displayStatus==='pending')return '…';return '';}
function chatCardLabel(turn){const work=turn.work,result=turn.outcome;
 if(!work){if(result&&result.work.status==='unknown')return copy('ui.creation-unknown');const reason=result?chatReason(result.work.diagnostics):'';return reason?copy('ui.not-created-reason',{reason}):copy('ui.not-created');}
 if(work.acceptance==='accepted')return copy('sidebar.status.03');if(work.acceptance==='failed'||work.acceptance==='stale')return copy('ui.check-failed');if(work.unknown)return copy('conversation.text.01');if(work.execution==='cancelled')return copy('ui.cancelled');
 if(!work.started){const reason=result&&result.run.status==='not_started'?chatReason(result.run.diagnostics):'';return reason?copy('ui.not-started-reason',{reason}):copy('ui.not-started');}
 if(work.execution==='blocked')return copy('ui.stopped');if(work.execution==='waiting')return copy('ui.waiting');return copy('sidebar.status.05');}
function chatConnection(disconnected){chatDisconnected=disconnected;const status=$('chat-connection');status.textContent=copy('header.status.01');status.hidden=!(disconnected||chatSendFailed||reconnectRequired);}
function chatClearFailed(){if(!chatSendFailed)return;chatSendFailed=false;chatConnection(chatDisconnected);chatShow('');}
function chatFailed(failed){const key=failed.key,current=chatDraft();chatSendFailed=true;chatConnection(chatDisconnected);if(chatDraftKey!==key||current.commandId!==failed.commandId||current.text!==failed.text||$('chat-input').value!==failed.text){chatShow(copy('conversation.text.01'));return;}const status=$('chat-status');status.replaceChildren(element('span',copy('ui.not-sent')+' · ','chat-send-failure'),chatButton(copy('composer.button.02'),()=>{const draft=chatDraft();if(chatDraftKey===key&&draft.commandId===failed.commandId&&draft.text===failed.text&&$('chat-input').value===failed.text)return sendChat();},''));status.hidden=false;}
function chatShow(text){$('chat-status').textContent=text;$('chat-status').hidden=!text;}
function chatControls(){$('chat-send').disabled=chatSending;$('chat-earlier').hidden=!(chatView&&chatView.segment&&chatView.segment.previous);$('chat-latest').hidden=!chatSegment;}
const chatTime=at=>new Date(at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),chatDay=at=>{const date=new Date(at);return copy('ui.date',{month:date.getMonth()+1,day:date.getDate(),weekday:copy('ui.weekday-'+date.getDay())})};
/** What a turn's slot shows (conversation-cards.md): a card while open, then a folded line, with an exception card or a grey line when it ended badly or was closed. */
function chatKind(turn){const w=turn.work;if(!w)return turn.outcome&&turn.outcome.work.status==='unknown'?'unknown':'card';
 if(w.acceptance==='accepted')return 'done';if(w.unknown)return 'unknown';if(w.execution==='cancelled')return 'closed';if(w.acceptance==='failed'||w.acceptance==='stale')return 'failed';if(!w.started||w.starting)return 'card';return w.execution==='blocked'?'failed':'card';}
/** One element per turn, reused on every read, so a Work card changes in place and never duplicates. The card body and Start are sibling buttons. */
function chatCard(turn){
 let card=chatCards.get(turn.id);
 if(!card){card=element('div',undefined,'chat-card');card.id='chat-card-'+turn.id;const open=element('button',undefined,'chat-card-open');open.type='button';card.chatTitle=element('strong');card.chatState=element('span',undefined,'chat-card-state');
  const head=element('span',undefined,'chat-card-head'),main=element('span',undefined,'chat-card-main');head.append(card.chatTitle,card.chatState);card.chatRing=element('span',undefined,'state');card.chatRing.setAttribute('aria-hidden','true');
  // Every Work today has one writer and an independent check (ADR 0002 §5); named roles arrive with internal teams.
  card.chatChips=element('span',undefined,'chat-chips');card.chatChips.append(element('span',copy('ui.write'),'chip'),element('span',copy('settings.chip.02'),'chip check'));card.chatSteps=element('span',undefined,'chat-steps');main.append(head,card.chatChips,card.chatSteps);
  card.chatWho=element('span',undefined,'chat-card-who');const avatar=element('span','${representativeName.slice(0,1)}','avatar');avatar.setAttribute('aria-hidden','true');card.chatElapsed=element('span');card.chatWho.append(avatar,element('span','${representativeName}'),card.chatElapsed);
  open.append(card.chatRing,main,card.chatWho);open.addEventListener('click',()=>void shellOpenWork(turn.id));
  card.chatStart=element('button',copy('ui.start'),'secondary');card.chatStart.type='button';card.chatStart.addEventListener('click',()=>void startChatWork(turn.id));card.append(open,card.chatStart);chatCards.set(turn.id,card);}
 const w=turn.work,steps=w&&w.steps,running=w&&w.started&&w.execution==='active'&&Number.isSafeInteger(w.startedAt);
 card.chatTitle.textContent=w?w.title:turn.proposal.title;card.chatState.textContent=chatCardLabel(turn);card.chatWho.hidden=card.chatChips.hidden=!w;
 shellWorkIdentity(card.chatWho.children[0],card.chatWho.children[1],w);
 card.chatSteps.textContent=steps&&Number.isSafeInteger(steps.done)&&Number.isSafeInteger(steps.total)&&steps.total>0?steps.done+'/'+steps.total:'';card.chatSteps.hidden=!card.chatSteps.textContent;
 card.chatElapsed.textContent=running?copy('ui.minutes',{duration:Math.max(1,Math.round((Date.now()-w.startedAt)/60000))}):'';
 card.chatStart.hidden=!(w&&!w.started&&w.acceptance==='pending'&&w.execution!=='cancelled'&&!chatStarting.has(turn.id));return card;
}
function chatButton(label,run,className='secondary'){const button=element('button',label,className);button.type='button';button.addEventListener('click',()=>void run());return button;}
/** Rebuilds a keyed node's content only when what it says changed, so rereads keep focus on its buttons. */
function chatKeyed(key,tag,className,signature,build){let node=chatNodes.get(key);if(!node){node=element(tag,undefined,className);node.id='chat-'+key;chatNodes.set(key,node);}if(node.chatSignature!==signature){node.chatSignature=signature;node.replaceChildren(...build());}node.hidden=false;return node;}
function chatFold(turn){const w=turn.work,timed=Number.isSafeInteger(w.startedAt)&&Number.isSafeInteger(w.endedAt)&&w.endedAt>=w.startedAt,label=timed?copy('ui.worked-duration',{duration:Math.max(1,Math.floor((w.endedAt-w.startedAt)/60000))}):copy('ui.worked'),node=chatKeyed('fold-'+turn.id,'button','chat-fold',label,()=>[element('span',label)]);if(!node.chatBound){node.chatBound=true;node.type='button';node.addEventListener('click',()=>void shellOpenWork(turn.id));}return node;}
function chatSystem(key,text,buttons=[]){return chatKeyed('system-'+key,'p','chat-system',text+'|'+buttons.map(b=>b[0]).join('|'),()=>[element('span',text),...buttons.map(([label,run])=>chatButton(label,run))]);}
function chatSteerCurrent(choice){return choice.generation===chatGeneration&&choice.member===chatThread&&choice.selection===chatSegment&&chatView&&choice.feed===chatView.feedId&&choice.segment===chatView.segment?.number&&chatView.member?.id===choice.member;}
/** Model output proposes only. An explicit click binds the stored message and target on the host. */
function chatSteerLine(turn){const steer=turn.steer;if(!steer)return null;
 const choice={feed:chatView.feedId,member:chatThread,segment:chatView.segment?.number,turnId:turn.id,generation:chatGeneration,selection:chatSegment},key=chatSteerKey(choice);
 if(steer.status==='recorded'||steer.status==='not_recorded'&&!chatSteering.get(key)?.recorded){chatSteering.delete(key);storage.remove(chatSteerReceipt(key));}
 if(!chatText(steer.title))return null;
 if(steer.status==='recorded'||chatSteering.get(key)?.recorded)return chatSystem('steer-'+turn.id,copy('ui.steered-title',{title:steer.title}));
 const pending=chatSteering.get(key),receipt=storage.get(chatSteerReceipt(key));
 if(steer.status==='unknown'||steer.status==='proposed'&&(!storage.readable||!pending&&receipt!==null||pending&&(!pending.busy||pending.generation!==chatGeneration)))return chatSystem('steer-'+turn.id,copy('ui.unknown-title',{title:steer.title}),[[copy('settings.chip.02'),()=>readChat()]]);
 if(steer.status!=='proposed'||!chatText(choice.feed)||!chatText(choice.member)||!Number.isSafeInteger(choice.segment)||choice.segment<1||!chatSteerCurrent(choice))return null;
 return chatKeyed('system-steer-'+turn.id,'p','chat-system',JSON.stringify([choice,steer.title,!!pending]),()=>{const apply=chatButton(copy('ui.apply-title',{title:steer.title}),()=>chatApplySteer(choice,apply));apply.disabled=!!pending;return [apply];});
}
async function chatApplySteer(choice,button){
 if(!chatSteerCurrent(choice)||$('page-chat').hidden||!$('chat-log').contains(button)||button.disabled)return;
 const turn=chatView.turns.find(t=>t.id===choice.turnId),key=chatSteerKey(choice);if(turn?.steer?.status!=='proposed'||chatSteering.has(key))return;
 if(storage.get(chatSteerReceipt(key))!==null||!storage.readable){renderChat();return;}
 // Persist before sending so a reload cannot turn an unseen commit back into Apply.
 const pending={busy:true,generation:choice.generation,receipt:crypto.randomUUID()};
 if(!storage.set(chatSteerReceipt(key),pending.receipt)){chatShow(copy('ui.unavailable'));return;}
 chatSteering.set(key,pending);renderChat();let outcome=null;
 try{const {body}=await request('/assistant/steering',{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':choice.feed},body:JSON.stringify({member:choice.member,segment:choice.segment,turnId:choice.turnId})});outcome=body;}
 catch{}finally{
  // Only this attempt's explicit result can resolve its receipt; HTTP codes alone prove nothing.
  if(chatSteering.get(key)===pending){pending.busy=false;
   if(chatSteerCurrent(choice)&&storage.get(chatSteerReceipt(key))===pending.receipt){
    if(outcome&&typeof outcome==='object'&&!Array.isArray(outcome)&&(outcome.status==='recorded'||outcome.status==='not_recorded'||outcome.outcome==='rejected')){
     if(outcome.status==='recorded')pending.recorded=true;else chatSteering.delete(key);storage.remove(chatSteerReceipt(key));
     if(pending.recorded)renderChat();
    }
    await readChat();if(chatSteerCurrent(choice)&&(!chatSteering.has(key)||chatSteering.get(key)===pending))renderChat();
   }
  }
 }
}
/** Result unknown offers Check only: an unknown outcome is never resent (ADR 0002 §8). Failure offers Retry and Close. */
function chatException(turn,kind){
 const title=turn.work?turn.work.title:turn.proposal.title,fact=kind==='unknown'?(turn.work?copy('ui.not-resent'):copy('ui.creation-unknown')):chatCardLabel(turn),busy=chatClosing.has(turn.id);
 return chatKeyed('exception-'+turn.id,'div','chat-exception',[kind,title,fact,busy].join('|'),()=>{const main=element('div',undefined,'chat-exception-main'),head=element('p',undefined,'chat-exception-head'),actions=element('div',undefined,'chat-actions');
  head.append(element('strong',title),element('span',kind==='unknown'?copy('conversation.text.01'):copy('conversation.status.02'),'chat-exception-state'));main.append(head,element('p',fact,'chat-exception-fact'));
  if(kind==='unknown')actions.append(chatButton(copy('settings.chip.02'),()=>readChat()));else actions.append(chatButton(copy('conversation.button.07'),()=>chatRetry(turn.id),''),chatButton(copy('dialog.button.03'),()=>chatCloseWork(turn.id)));for(const button of actions.children)button.disabled=busy;return [main,actions];});
}
/** The host's optional decisions and briefings (conversation-cards.md); malformed entries are skipped. */
const chatText=value=>typeof value==='string'&&value.length>0&&value.length<=2000;
function chatDecisions(view=chatView){return (Array.isArray(view&&view.decisions)?view.decisions:[]).filter(d=>d&&chatText(d.id)&&Number.isSafeInteger(d.at)&&chatText(d.title)&&chatText(d.question)&&chatText(d.action)&&Array.isArray(d.rows)&&d.rows.every(r=>Array.isArray(r)&&r.length===2&&chatText(r[0])&&typeof r[1]==='string')&&(d.form===undefined||d.form==='member')&&(d.detail===undefined||chatText(d.detail))&&(d.remove===undefined||chatText(d.remove))&&(d.state==='open'||d.state==='later'||d.state==='done'&&chatText(d.line)));}
/** Members from the latest read, for the sidebar and the name of an open member conversation. */
function chatMembers(){const view=chatView||chatRep;return (Array.isArray(view&&view.members)?view.members:[]).filter(m=>m&&chatText(m.id)&&chatText(m.name));}
function chatName(){return chatThread?(chatMembers().find(m=>m.id===chatThread)||{name:chatThreadName}).name:'${representativeName}';}
/** Opens the Representative ('') or a member conversation in the page at its head and returns true; a switch refused while a send is pending returns false and changes nothing. A switch drops the shown nodes and reads that thread, and reopening the thread shown at an earlier segment returns to the head, where briefings and exception cards are. */
function chatOpenThread(id,name=''){
 if(id!==chatThread){if(chatSending)return false;chatClearFailed();protocol.invalidate('chat-view');++chatGeneration;chatThread=id;chatThreadName=name;chatDraftKey='massion.workbench.chat-draft'+(id?':'+id:'');chatView=null;chatSegment=null;chatCards.clear();chatNodes.clear();$('chat-log').replaceChildren();$('chat-input').value=chatDraft().text;void readChat();}
 else if(chatSegment!==null){protocol.invalidate('chat-view');++chatGeneration;chatSegment=null;void readChat();}
 shellShow('chat');$('chat-input').setAttribute('placeholder',copy('ui.message',{member:chatName()}));$('chat-input').setAttribute('aria-label',copy('ui.message',{member:chatName()}));$('chat-input').focus();renderShell();return true;}
function chatBriefings(){return (Array.isArray(chatView&&chatView.briefings)?chatView.briefings:[]).filter(b=>b&&chatText(b.id)&&Number.isSafeInteger(b.at)&&chatText(b.title)&&Array.isArray(b.turnIds)&&b.turnIds.every(chatText));}
/** Schedule runs that failed or whose result is unknown (results-and-schedules.md), drawn like a Work's exception card. Unknown offers Check and Close, never Retry. */
function chatRunExceptions(){return (Array.isArray(chatView&&chatView.exceptions)?chatView.exceptions:[]).filter(e=>e&&chatText(e.id)&&Number.isSafeInteger(e.at)&&chatText(e.title)&&(e.state==='failed'||e.state==='unknown')&&chatText(e.fact)&&chatText(e.scheduleId)&&chatText(e.runId)&&Array.isArray(e.actions)&&e.actions.every(a=>['check','retry','close'].includes(a))&&!(e.state==='unknown'&&e.actions.includes('retry')));}
function chatRunException(e){return chatKeyed('run-exception-'+e.id,'div','chat-exception',JSON.stringify([e.title,e.state,e.fact,e.actions]),()=>{const main=element('div',undefined,'chat-exception-main'),head=element('p',undefined,'chat-exception-head'),actions=element('div',undefined,'chat-actions');
 head.append(element('strong',e.title),element('span',e.state==='unknown'?copy('conversation.text.01'):copy('conversation.status.02'),'chat-exception-state'));main.append(head,element('p',e.fact,'chat-exception-fact'));
 for(const a of e.actions)actions.append(a==='check'?chatButton(copy('settings.chip.02'),()=>readChat()):a==='retry'?chatButton(copy('conversation.button.07'),()=>scheduleAct({action:'run',scheduleId:e.scheduleId,retryOf:e.runId}),''):chatButton(copy('dialog.button.03'),()=>scheduleAct({action:'close',scheduleId:e.scheduleId,runId:e.runId})));return [main,actions];});}
function chatDecisionAction(action){const keys={'Add member':'conversation.link.14',Install:'settings.link.04',Update:'ui.action.update',Change:'conversation.button.09'},version=/^Use v(\d+)$/.exec(action);return version?copy('ui.action.use-version',{version:version[1]}):Object.hasOwn(keys,action)?copy(keys[action]):action;}
function chatDecision(d){
 if(d.state==='later')return chatSystem(d.id,copy('ui.later-question',{question:d.question}),[[copy('conversation.button.06'),()=>chatDecide(d.id,'ask')]]);if(d.state==='done')return chatSystem(d.id,d.line,d.remove?[[copy('conversation.link.24'),()=>appsPost({action:'remove',appId:d.remove})]]:[]);
 const busy=chatDeciding.has(d.id),node=chatKeyed('decision-'+d.id,'section','chat-decision',JSON.stringify([d.question,d.detail,d.at,d.rows,d.action,busy]),()=>{const head=element('p',undefined,'chat-decision-head'),rows=element('dl'),actions=element('div',undefined,'chat-actions');
  head.append(element('strong',d.question),element('span',chatTime(d.at)));for(const [label,value] of d.rows)rows.append(element('dt',label),element('dd',value));
  actions.append(chatButton(chatDecisionAction(d.action),()=>d.form==='member'?memberOpen(d.id):chatDecide(d.id,'act'),''),chatButton(copy('conversation.button.04'),()=>chatDecide(d.id,'later')));for(const button of actions.children)button.disabled=busy;return [head,...(d.detail?[element('p',d.detail,'chat-decision-detail')]:[]),rows,actions];});
 node.setAttribute('aria-label',d.question);return node;
}
/** Bullets name the Work and its current state from the turn, so a briefing never carries its own counts. */
// A briefing from an earlier segment carries its own turns, read from that segment.
function chatBriefing(b,turns){const own=Array.isArray(b.turns)?b.turns:[],named=b.turnIds.map(id=>turns.get(id)??own.find(turn=>turn&&turn.id===id)).filter(turn=>turn&&turn.work);
 return chatKeyed('briefing-'+b.id,'div','chat-briefing',JSON.stringify([b.title,b.at,named.map(turn=>[turn.id,turn.work.title,chatCardLabel(turn)])]),()=>{const head=element('p'),list=element('ul');head.append(element('strong',b.title),element('span',' | '+chatDay(b.at)+' '+chatTime(b.at)));
  for(const turn of named){const item=element('li');item.append(chatButton(turn.work.title,()=>shellOpenWork(turn.id),''),element('span',' '+chatCardLabel(turn)));list.append(item);}return [head,list];});}
function chatSlot(turn){const kind=chatKind(turn);if(kind==='card')return [chatCard(turn)];const shown=turn.work?[chatFold(turn)]:[];
 if(kind==='unknown'||kind==='failed')shown.push(chatException(turn,kind));else if(kind==='closed')shown.push(chatSystem('closed:'+turn.id,copy('ui.closed-title',{title:turn.work.title})));return shown;}
function chatNode(key,text,className){let node=chatNodes.get(key);if(!node){node=element('p',undefined,className);chatNodes.set(key,node);}if(node.textContent!==text)node.textContent=text;node.hidden=!text;return node;}
function renderChat(){
 const view=chatView;if(!view)return;const turns=new Map(view.turns.map(turn=>[turn.id,turn])),items=[];let day='';
 // Decisions and briefings sit before the first owner message that started after them; a date line opens each day.
 // ponytail: they carry no segment, so an earlier segment shows none; filter by the segment's time span if old ones are missed there.
 const extras=chatSegment?[]:[...chatDecisions().map(d=>({at:d.at,node:()=>chatDecision(d)})),...chatBriefings().map(b=>({at:b.at,node:()=>chatBriefing(b,turns)})),...chatRunExceptions().map(e=>({at:e.at,node:()=>chatRunException(e)}))].sort((a,b)=>a.at-b.at);
 const dated=(at,node)=>{if(Number.isSafeInteger(at)&&chatDay(at)!==day){day=chatDay(at);items.push(chatNode('date:'+day,day,'chat-date'));}items.push(node);};
 for(const message of view.segment?view.segment.messages:[]){
  const turn=message.role==='owner'?turns.get('assistant-turn:'+message.id):turns.get(message.turnId);
  if(message.role==='owner'&&turn&&Number.isSafeInteger(turn.at))while(extras.length&&extras[0].at<turn.at){const extra=extras.shift();dated(extra.at,extra.node());}
  dated(message.role==='owner'&&turn?turn.at:null,chatNode(message.id,message.text,message.role==='owner'?'chat-owner':'chat-reply'));if(!turn)continue;
  // The state line always follows its message, empty when there is nothing to say, so a later reply only appends.
  if(message.role==='owner'){items.push(chatNode('state:'+turn.id,chatTurnLabel(turn),'chat-state'));const steer=chatSteerLine(turn);if(steer)items.push(steer);}
  else if(turn.proposal)items.push(...chatSlot(turn));
 }
 for(const extra of extras)dated(extra.at,extra.node());
 const log=$('chat-log'),shown=[...log.children],page=$('page-chat'),stick=!(page.scrollHeight>0)||page.scrollHeight-page.scrollTop-page.clientHeight<80;
 // Moves only nodes out of place, so a slot that changes kind or an entry placed in between keeps focus elsewhere and the live log announces only what is new.
 const keep=new Set(items);for(const node of [...log.children])if(!keep.has(node))node.remove();items.forEach((node,index)=>{if(log.children[index]!==node)log.insertBefore(node,log.children[index]??null);});
 if(stick)page.scrollTop=page.scrollHeight;
 chatControls();renderShell();
}
/** One read loop at a time; a caller during a read waits for the loop that will cover its thread, so a send right after a switch targets the new thread's head. */
function readChat(){if(chatReading){chatAgain=true;return chatReadDone;}chatReading=true;return chatReadDone=chatReadLoop();}
async function chatReadLoop(){
 try{do{chatAgain=false;try{const thread=chatThread,segment=chatSegment,query=[segment?'segment='+segment:'',thread?'member='+encodeURIComponent(thread):''].filter(Boolean).join('&'),{response,body}=await request('/assistant/conversation'+(query?'?'+query:''),{scope:'chat-view'});
  // A named segment that the read shows is the head is read again as the head view, where decisions, briefings and run exceptions show.
  if(segment!==null&&segment===chatSegment&&body.head===segment){chatSegment=null;chatAgain=true;continue;}
  if(!response.ok||!Number.isSafeInteger(body.head)||!Array.isArray(body.turns)||body.segment!==null&&(!body.segment||!Array.isArray(body.segment.messages)))throw new Error('Conversation unavailable');
  if([chatView&&chatView.feedId,chatRep&&chatRep.feedId,shellWorksFeed].some(feed=>feed&&feed!==body.feedId)){chatReset();continue;}
  chatView=body;chatConnection(false);if(!thread)chatRep=body;renderChat();if($('chat-status').textContent===copy('ui.unavailable'))chatShow('');
  }catch(error){if(error.name==='StaleProtocolReplyError'){chatAgain=true;continue;}throw error;}
 }while(chatAgain);return true;}
 catch{chatConnection(true);return false;}finally{chatReading=false;chatControls();void shellWorksLoad();chatScheduleRead();}
}
function chatScheduleRead(){
  // A host that dies mid-turn leaves it pending and emits nothing more; the read turns it unknown after its deadline, so a shown pending turn is read again, also after a failed read.
  // ponytail: fixed interval because the view carries no deadlineAt; schedule at the deadline once the read exposes it.
  // A host's own start in flight emits nothing if it is refused before activation, so a card that shows it is read again too.
  // A running card's elapsed minutes come from the read, so it is read again each minute while one shows.
  // A schedule run still in time emits nothing when its host dies, so the conversation is read again just after its deadline to show the unknown-result card.
  clearTimeout(chatPendingTimer);const turns=chatView?chatView.turns:[],due=chatView&&Number.isSafeInteger(chatView.runDeadlineAt)?Math.max(1000,chatView.runDeadlineAt-Date.now()+1000):0,every=turns.some(turn=>turn.displayStatus==='pending'||turn.work&&turn.work.starting)?10000:turns.some(turn=>chatKind(turn)==='card'&&turn.work&&turn.work.started&&turn.work.execution==='active')||shellWorks.some(w=>w.started&&w.execution==='active'&&shellRank(w)===1)?60000:0,wait=every&&due?Math.min(every,due):every||due;chatPendingTimer=wait?setTimeout(()=>void readChat(),wait):0;
}
/** A replaced database invalidates every shown message and card: clear them and read the conversation of the current one. */
// A replaced database may not hold the open member, so the conversation falls back to the Representative and its draft.
function chatReset(){protocol.invalidate('chat-view');++chatGeneration;++shellWorksSequence;shellWorks=[];shellWorksFeed='';paneTabs=[];paneActive='';paneMission='';storage.remove(seenKey);renderPane();chatThread='';chatThreadName='';chatDraftKey='massion.workbench.chat-draft';$('chat-input').value=chatDraft().text;$('chat-input').setAttribute('placeholder',copy('ui.message',{member:chatName()}));$('chat-input').setAttribute('aria-label',copy('ui.message',{member:chatName()}));if(!$('page-chat').hidden)shellShow('chat');chatView=null;chatRep=null;chatSegment=null;chatCards.clear();chatNodes.clear();$('chat-log').replaceChildren();chatControls();renderShell();void readChat();}
/** A Representative turn by ID, also one a briefing carries from an earlier segment, so its Work links open. */
function chatWorkTurn(turnId){const listed=shellWorks.find(w=>w.turnId===turnId);if(listed)return {id:turnId,work:listed};if(!chatRep)return;return chatRep.turns.find(t=>t.id===turnId)??(Array.isArray(chatRep.briefings)?chatRep.briefings:[]).flatMap(b=>b&&Array.isArray(b.turns)?b.turns:[]).find(t=>t&&t.id===turnId);}
async function openChatWork(turnId){const turn=chatWorkTurn(turnId);if(!turn||!turn.work||busy||loading)return;const loaded=await loadMission(turn.work.missionId);if(!loaded||!snapshot||snapshot.value.id!==turn.work.missionId)return;document.getElementById('work-heading-'+turn.work.workId)?.focus();}
async function startChatWork(turnId){
 const turn=chatView&&chatView.turns.find(t=>t.id===turnId);if(!turn||!turn.work||busy||chatSending||chatStarting.has(turnId))return;const work=turn.work;
 // One request per card at a time; the card label from the reread, not a status line, says how it ended.
 chatStarting.add(turnId);renderChat();
 try{await request('/missions/'+encodeURIComponent(work.missionId)+'/run',{method:'POST',headers:{'Content-Type':'application/json',...(feedId?{'X-Massion-Feed':feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),workId:work.workId,expectedRevision:work.missionRevision})},130000);}
 catch{}finally{chatStarting.delete(turnId);await readChat();renderChat();}
}
/** Retry sends nothing: the owner's original request goes back into the input so the conditions can change before a new Send.
 * Typed text and a draft whose result is unknown are kept: the draft's command ID is what lets Send replay it instead of sending it twice. */
function chatRetry(turnId){const turn=chatView&&chatView.turns.find(t=>t.id===turnId),message=turn&&chatView.segment&&chatView.segment.messages.find(m=>m.id===turn.messageId);if(!message)return;const input=$('chat-input');if(chatDraft().commandId||input.value.trim()&&input.value!==message.text){input.focus();return;}input.value=message.text;storage.set(chatDraftKey,JSON.stringify({text:message.text,commandId:'',target:null}));$('chat-input').focus();}
/** Close records the owner's cancel once at the card's revision; whatever the answer, the next read says how it ended and nothing is retried. */
async function chatCloseWork(turnId){
 const turn=chatView&&chatView.turns.find(t=>t.id===turnId);if(!turn||!turn.work||chatClosing.has(turnId))return;const work=turn.work;chatClosing.add(turnId);renderChat();
 try{await request('/missions/'+encodeURIComponent(work.missionId)+'/commands',{method:'POST',headers:{'Content-Type':'application/json',...(feedId?{'X-Massion-Feed':feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),expectedRevision:work.missionRevision,command:{type:'cancel',workId:work.workId}})});}
 catch{}finally{chatClosing.delete(turnId);await readChat();renderChat();}
}
/** A decision answer is sent once; a lost answer is not resent, the next read shows the decision's state. */
async function chatDecide(decisionId,answer){
 if(chatDeciding.has(decisionId))return;chatDeciding.add(decisionId);renderChat();
 try{await request('/assistant/decisions',{method:'POST',headers:{'Content-Type':'application/json',...(chatView&&chatView.feedId?{'X-Massion-Feed':chatView.feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),decisionId,answer})});}
 catch{}finally{chatDeciding.delete(decisionId);await readChat();renderChat();}
}
async function sendChat(){
 const text=$('chat-input').value;if(chatSending||!text.trim())return;
 if(new TextEncoder().encode(text).length>4096){chatShow(copy('ui.too-long'));return;}
 const draft=chatDraft(),same=draft.text===text&&!!draft.commandId,commandId=same?draft.commandId:crypto.randomUUID();let pinned=same?draft.target:null;storage.set(chatDraftKey,JSON.stringify({text,commandId,target:pinned}));
 const failed={key:chatDraftKey,commandId,text};chatSending=true;chatShow('');chatControls();
 try{
  if(chatSegment||!chatView){chatSegment=null;if(!await readChat()){chatFailed(failed);return;}}
  for(let attempt=0;attempt<2;attempt++){
   const view=chatView,segment=view&&view.segment;const target=pinned??(!segment?{segment:1,expectedRevision:0}:segment.full?{segment:view.head+1,expectedRevision:0}:{segment:view.head,expectedRevision:segment.revision});chatPin(commandId,target);
   const {response,body}=await request('/assistant/messages',{method:'POST',headers:{'Content-Type':'application/json',...(view&&view.feedId?{'X-Massion-Feed':view.feedId}:{})},body:JSON.stringify({commandId,...target,text,...(chatThread?{member:chatThread}:{})})},130000);
   // The private draft clears only on its committed receipt, and only while the input still holds the sent text: an edit made while waiting is unsent and stays.
   // A conflict commits nothing, so the same command ID is reused.
   if(response.ok){chatSendFailed=false;chatConnection(false);chatShow('');if($('chat-input').value===text){storage.remove(chatDraftKey);$('chat-input').value='';}await readChat();return;}
   // A changed database is not a revision race: the message goes to it only on the owner's next Send.
   // A conflict proves the message is not at its target (the host replays from there first; a feed conflict means the target belongs to a replaced database), so the target is dropped and the next try reads the head.
   // A draining host refuses before that replay, so its refusal keeps the target.
   const feed=body.reason==='feed',refused=response.status===400||response.status===409||response.status===503&&body.outcome==='rejected';if(response.status===409){pinned=null;chatPin(commandId,null);}
   await readChat();if(response.status===409&&attempt===0&&!feed&&!/^answer_in_progress/.test(body.error||''))continue;
   // Only a refusal before the commit is "not sent"; any other answer may follow a stored message, so the result is unknown and Send replays it at the kept target.
   if(/^answer_in_progress/.test(body.error||''))chatShow(copy('ui.answer-in-progress'));else chatFailed(failed);return;
  }
 }catch{chatFailed(failed);await readChat();}finally{chatSending=false;chatControls();}
}
function chatEvents(events){if(events.some(event=>typeof event.aggregateId==='string'&&(event.aggregateId.startsWith('assistant-conversation:')||shellWorks.some(w=>w.missionId===event.aggregateId)||chatView&&chatView.turns.some(turn=>turn.work&&turn.work.missionId===event.aggregateId))))void readChat();}
$('chat-input').value=chatDraft().text;
$('chat-input').setAttribute('aria-label',copy('ui.message',{member:chatName()}));
$('chat-input').addEventListener('input',()=>{chatClearFailed();const text=$('chat-input').value,draft=chatDraft();storage.set(chatDraftKey,JSON.stringify(draft.text===text?draft:{text,commandId:'',target:null}));});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();void sendChat();});
$('chat-earlier').addEventListener('click',()=>{if(!chatView||!chatView.segment||!chatView.segment.previous)return;protocol.invalidate('chat-view');++chatGeneration;chatSegment=chatView.segment.number-1;void readChat();});
$('chat-latest').addEventListener('click',()=>{protocol.invalidate('chat-view');++chatGeneration;chatSegment=null;void readChat();});
void readChat();
`;
