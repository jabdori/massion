/** Minimal conversation surface: one continuing conversation, one input, one Work slot per turn updated in place (docs/architecture/conversation-cards.md). Labels only; replies speak for themselves. */
import {representativeName} from './surface-shell.ts';
export const chatStyle=String.raw`.conversation{max-width:760px;margin:0 auto 22px;padding:0 4px}.chat-log{display:flex;flex-direction:column;gap:10px}.chat-owner{align-self:flex-end;max-width:80%;margin:0;padding:9px 14px;border-radius:16px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}.chat-reply{align-self:flex-start;max-width:90%;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.chat-state{align-self:flex-start;margin:0;color:var(--muted);font-size:.9em}.chat-card{align-self:stretch;display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:var(--bg-1)}.chat-card-open{flex:1;display:flex;gap:10px;align-items:center;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}.chat-card-open:focus-visible{outline:3px solid #5dc0ea}.chat-card strong{flex:1;overflow-wrap:anywhere}.chat-card-state{color:var(--muted)}.chat-nav{display:flex;justify-content:center;gap:8px}.chat-form{display:flex;gap:8px;align-items:flex-end;margin-top:14px}.chat-form textarea{flex:1}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.chat-card{align-items:flex-start}.chat-card-open{align-items:flex-start}.chat-card-open .state{margin-top:4px}.chat-card-main{flex:1;min-width:0;display:grid;gap:7px}.chat-card-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.chat-card .chat-card-head strong{flex:0 1 auto;min-width:0}.chat-card-head .chat-card-state{font-size:13px}.chat-card-who{display:flex;gap:6px;align-items:center;color:var(--fg-3);font-size:13px;white-space:nowrap}.chat-chips{display:flex;gap:5px;flex-wrap:wrap}.chip{padding:1px 7px;border-radius:4px;background:var(--bg-3);color:var(--fg-2);font-size:12px;font-weight:600}.chip.check{background:transparent;border:1px solid var(--line-strong);color:var(--fg-3)}.chat-steps{color:var(--fg-3);font-size:13px;font-variant-numeric:tabular-nums}
.app .chat-fold{align-self:flex-start;min-height:0;padding:2px 0;border:0;background:none;color:var(--fg-3);font-weight:500;font-size:13px}.app .chat-fold:hover{color:var(--fg)}
.chat-exception{align-self:stretch;display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line-strong);border-radius:10px;padding:10px 14px;background:var(--bg-1)}.chat-exception-main{flex:1;min-width:0}.chat-exception-head{margin:0}.chat-exception-head::before{content:'';display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:var(--halt);vertical-align:middle}.chat-exception-state{margin-left:8px;color:var(--halt);font-size:13px}.chat-exception-fact{margin:4px 0 0 15px;color:var(--fg-2);font-size:13px}.chat-actions{display:flex;gap:8px;flex:none}.app .chat-actions button{min-height:30px;padding:4px 12px;font-size:13px}
.chat-system,.chat-date{align-self:center;margin:0;color:var(--fg-4);font-size:12px;display:flex;gap:10px;align-items:center}.app .chat-system button{min-height:0;padding:0;border:0;background:none;color:var(--fg-2);font-size:12px}
.chat-briefing{align-self:stretch;border-radius:10px;padding:12px 16px;background:var(--bg-2)}.chat-briefing p{margin:0 0 6px;color:var(--fg-3)}.chat-briefing p strong{color:var(--fg)}.chat-briefing ul{margin:0;padding-left:18px}.app .chat-briefing li button{min-height:0;padding:0;border:0;background:none;color:var(--fg);font-weight:650;text-decoration:underline;text-underline-offset:3px}
.chat-decision{align-self:stretch;padding:14px 16px;border:1px solid #4a3c15;border-radius:12px;background:#231d0e}.chat-decision-head{display:flex;gap:8px;align-items:baseline;margin:0 0 10px}.chat-decision-head strong{font-size:15px}.chat-decision-head span{margin-left:auto;color:var(--fg-4);font-size:12px}.chat-decision dl{margin:0 0 12px;display:grid;grid-template-columns:76px 1fr;row-gap:3px;font-size:13px}.chat-decision dt{color:var(--fg-4)}.chat-decision dd{margin:0;color:var(--fg-2)}.chat-decision .chat-actions button{border-color:var(--line-strong);background:transparent;color:var(--fg)}.chat-decision .chat-actions button:first-child{border-color:#f0bc4b;background:#f0bc4b;color:#241d07}
@media (max-width:600px){.chat-card-open,.chat-exception{flex-wrap:wrap}.chat-card-main{flex-basis:calc(100% - 25px)}.chat-card-who{margin-left:21px}.chat-exception-main{flex-basis:100%}}`;
export const chatPanel=String.raw`<section id="conversation" class="conversation" aria-label="Conversation"><div class="chat-nav"><button id="chat-earlier" type="button" class="quiet" hidden>Earlier</button><button id="chat-latest" type="button" class="quiet" hidden>Latest</button></div><div id="chat-log" class="chat-log" role="log" aria-live="polite"></div><p id="chat-status" class="chat-state" role="status" hidden></p><form id="chat-form" class="chat-form"><label for="chat-input" class="visually-hidden">Message</label><textarea id="chat-input" rows="2" maxlength="4096" placeholder="Message"></textarea><button id="chat-send" type="submit">Send</button></form></section>`;
export const chatClient=String.raw`
// chatThread is '' for the Representative or a member ID for that member's one 1:1 conversation (members.md); each keeps its own draft.
let chatDraftKey='massion.workbench.chat-draft',chatThread='',chatThreadName='';
// chatRep keeps the Representative's latest read: the sidebar's Work lines and the activity list's decisions stay while a member conversation is open.
let chatView=null,chatRep=null,chatReadDone=null,chatSegment=null,chatReading=false,chatAgain=false,chatSending=false,chatPendingTimer=0;
// Nodes are kept by message and turn ID so a reread never moves or recreates what is already shown: focus stays and the live log announces only new items.
const chatCards=new Map(),chatNodes=new Map(),chatStarting=new Set(),chatClosing=new Set(),chatDeciding=new Set();
// target is the segment and revision of a submission whose outcome is unknown: a retry goes there, where its message would sit, so the host replays it however far the head moved.
function chatDraft(){try{const value=JSON.parse(storage.get(chatDraftKey)||'null'),target=value&&value.target;return value&&typeof value.text==='string'&&typeof value.commandId==='string'?{text:value.text,commandId:value.commandId,target:target&&Number.isSafeInteger(target.segment)&&target.segment>=1&&Number.isSafeInteger(target.expectedRevision)&&target.expectedRevision>=0?{segment:target.segment,expectedRevision:target.expectedRevision}:null}:{text:'',commandId:'',target:null};}catch{return {text:'',commandId:'',target:null};}}
/** Records the target only while the stored draft is still this command, so an edit made while sending stays a new message. */
function chatPin(commandId,target){const draft=chatDraft();if(draft.commandId===commandId)storage.set(chatDraftKey,JSON.stringify({text:draft.text,commandId,target}));}
const chatReasons={assistant_route_missing:'no route',assistant_route_stale:'route unusable',settings_pending:'settings saving',settings_changed:'settings changed',default_route_missing:'no default route',default_route_stale:'default route unusable',assistant_intake_unsupported:'Mission not supported',host_busy:'host busy',host_draining:'host stopping',intake_conflict:'Mission changed',work_not_admitted:'refused'};
function chatReason(list){const code=Array.isArray(list)&&list[0]&&typeof list[0].code==='string'?list[0].code:'';return Object.hasOwn(chatReasons,code)?chatReasons[code]:code.replace(/^assistant_/,'').replaceAll('_',' ');}
function chatTurnLabel(turn){if(turn.displayStatus==='not_started'){const reason=chatReason(turn.diagnostics);return 'Not sent'+(reason?' · '+reason:'');}if(turn.displayStatus==='unknown')return 'Result unknown · not resent';if(turn.displayStatus==='failed')return 'No answer · not retried';if(turn.displayStatus==='pending')return '…';return '';}
function chatCardLabel(turn){const work=turn.work,result=turn.outcome;
 if(!work){if(result&&result.work.status==='unknown')return 'Unknown whether created';const reason=result?chatReason(result.work.diagnostics):'';return 'Not created'+(reason?' · '+reason:'');}
 if(work.acceptance==='accepted')return 'Done';if(work.acceptance==='failed'||work.acceptance==='stale')return 'Check failed';if(work.unknown)return 'Result unknown';if(work.execution==='cancelled')return 'Cancelled';
 if(!work.started){const reason=result&&result.run.status==='not_started'?chatReason(result.run.diagnostics):'';return 'Not started'+(reason?' · '+reason:'');}
 if(work.execution==='blocked')return 'Stopped';if(work.execution==='waiting')return 'Waiting';return 'Working';}
function chatShow(text){$('chat-status').textContent=text;$('chat-status').hidden=!text;}
function chatControls(){$('chat-send').disabled=chatSending;$('chat-earlier').hidden=!(chatView&&chatView.segment&&chatView.segment.previous);$('chat-latest').hidden=!chatSegment;}
const chatTime=at=>new Date(at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'}),chatDay=at=>new Date(at).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'});
/** What a turn's slot shows (conversation-cards.md): a card while open, then a folded line, with an exception card or a grey line when it ended badly or was closed. */
function chatKind(turn){const w=turn.work;if(!w)return turn.outcome&&turn.outcome.work.status==='unknown'?'unknown':'card';
 if(w.acceptance==='accepted')return 'done';if(w.unknown)return 'unknown';if(w.execution==='cancelled')return 'closed';if(w.acceptance==='failed'||w.acceptance==='stale')return 'failed';if(!w.started||w.starting)return 'card';return w.execution==='blocked'?'failed':'card';}
/** One element per turn, reused on every read, so a Work card changes in place and never duplicates. The card body and Start are sibling buttons. */
function chatCard(turn){
 let card=chatCards.get(turn.id);
 if(!card){card=element('div',undefined,'chat-card');card.id='chat-card-'+turn.id;const open=element('button',undefined,'chat-card-open');open.type='button';card.chatTitle=element('strong');card.chatState=element('span',undefined,'chat-card-state');
  const head=element('span',undefined,'chat-card-head'),main=element('span',undefined,'chat-card-main');head.append(card.chatTitle,card.chatState);card.chatRing=element('span',undefined,'state');card.chatRing.setAttribute('aria-hidden','true');
  // Every Work today has one writer and an independent check (ADR 0002 §5); named roles arrive with internal teams.
  card.chatChips=element('span',undefined,'chat-chips');card.chatChips.append(element('span','Write','chip'),element('span','Check','chip check'));card.chatSteps=element('span',undefined,'chat-steps');main.append(head,card.chatChips,card.chatSteps);
  card.chatWho=element('span',undefined,'chat-card-who');const avatar=element('span','${representativeName.slice(0,1)}','avatar');avatar.setAttribute('aria-hidden','true');card.chatElapsed=element('span');card.chatWho.append(avatar,element('span','${representativeName}'),card.chatElapsed);
  open.append(card.chatRing,main,card.chatWho);open.addEventListener('click',()=>void shellOpenWork(turn.id));
  card.chatStart=element('button','Start','secondary');card.chatStart.type='button';card.chatStart.addEventListener('click',()=>void startChatWork(turn.id));card.append(open,card.chatStart);chatCards.set(turn.id,card);}
 const w=turn.work,steps=w&&w.steps,running=w&&w.started&&w.execution!=='blocked'&&Number.isSafeInteger(w.startedAt);
 card.chatTitle.textContent=w?w.title:turn.proposal.title;card.chatState.textContent=chatCardLabel(turn);card.chatWho.hidden=card.chatChips.hidden=!w;
 card.chatSteps.textContent=steps&&Number.isSafeInteger(steps.done)&&Number.isSafeInteger(steps.total)&&steps.total>0?steps.done+'/'+steps.total:'';card.chatSteps.hidden=!card.chatSteps.textContent;
 card.chatElapsed.textContent=running?Math.max(1,Math.round((Date.now()-w.startedAt)/60000))+' min':'';
 card.chatStart.hidden=!(w&&!w.started&&w.acceptance==='pending'&&w.execution!=='cancelled'&&!chatStarting.has(turn.id));return card;
}
function chatButton(label,run,className='secondary'){const button=element('button',label,className);button.type='button';button.addEventListener('click',()=>void run());return button;}
/** Rebuilds a keyed node's content only when what it says changed, so rereads keep focus on its buttons. */
function chatKeyed(key,tag,className,signature,build){let node=chatNodes.get(key);if(!node){node=element(tag,undefined,className);node.id='chat-'+key;chatNodes.set(key,node);}if(node.chatSignature!==signature){node.chatSignature=signature;node.replaceChildren(...build());}node.hidden=false;return node;}
// ponytail: no durable end time yet, so no minutes; 'Worked for N min' once the Work records one.
function chatFold(turn){const node=chatKeyed('fold-'+turn.id,'button','chat-fold','Worked',()=>[element('span','Worked ›')]);if(!node.chatBound){node.chatBound=true;node.type='button';node.addEventListener('click',()=>void shellOpenWork(turn.id));}return node;}
function chatSystem(key,text,buttons=[]){return chatKeyed('system-'+key,'p','chat-system',text+'|'+buttons.map(b=>b[0]).join('|'),()=>[element('span',text),...buttons.map(([label,run])=>chatButton(label,run))]);}
/** Result unknown offers Check only: an unknown outcome is never resent (ADR 0002 §8). Failure offers Retry and Close. */
function chatException(turn,kind){
 const title=turn.work?turn.work.title:turn.proposal.title,fact=kind==='unknown'?(turn.work?'Not resent':'Unknown whether created'):chatCardLabel(turn),busy=chatClosing.has(turn.id);
 return chatKeyed('exception-'+turn.id,'div','chat-exception',[kind,title,fact,busy].join('|'),()=>{const main=element('div',undefined,'chat-exception-main'),head=element('p',undefined,'chat-exception-head'),actions=element('div',undefined,'chat-actions');
  head.append(element('strong',title),element('span',kind==='unknown'?'Result unknown':'Failed','chat-exception-state'));main.append(head,element('p',fact,'chat-exception-fact'));
  if(kind==='unknown')actions.append(chatButton('Check',()=>readChat()));else actions.append(chatButton('Retry',()=>chatRetry(turn.id),''),chatButton('Close',()=>chatCloseWork(turn.id)));for(const button of actions.children)button.disabled=busy;return [main,actions];});
}
/** The host's optional decisions and briefings (conversation-cards.md); malformed entries are skipped. */
const chatText=value=>typeof value==='string'&&value.length>0&&value.length<=2000;
function chatDecisions(view=chatView){return (Array.isArray(view&&view.decisions)?view.decisions:[]).filter(d=>d&&chatText(d.id)&&Number.isSafeInteger(d.at)&&chatText(d.title)&&chatText(d.question)&&chatText(d.action)&&Array.isArray(d.rows)&&d.rows.every(r=>Array.isArray(r)&&r.length===2&&chatText(r[0])&&typeof r[1]==='string')&&(d.form===undefined||d.form==='member')&&(d.state==='open'||d.state==='later'||d.state==='done'&&chatText(d.line)));}
/** Members from the latest read, for the sidebar and the name of an open member conversation. */
function chatMembers(){const view=chatView||chatRep;return (Array.isArray(view&&view.members)?view.members:[]).filter(m=>m&&chatText(m.id)&&chatText(m.name));}
function chatName(){return chatThread?(chatMembers().find(m=>m.id===chatThread)||{name:chatThreadName}).name:'${representativeName}';}
/** Opens the Representative ('') or a member conversation in the page; a switch drops the shown nodes and reads that thread. */
function chatOpenThread(id,name=''){
 if(id!==chatThread){if(chatSending)return;chatThread=id;chatThreadName=name;chatDraftKey='massion.workbench.chat-draft'+(id?':'+id:'');chatView=null;chatSegment=null;chatCards.clear();chatNodes.clear();$('chat-log').replaceChildren();$('chat-input').value=chatDraft().text;void readChat();}
 shellShow('chat');$('chat-input').setAttribute('placeholder',chatThread?'Message '+chatName():'Message');$('chat-input').focus();renderShell();}
function chatBriefings(){return (Array.isArray(chatView&&chatView.briefings)?chatView.briefings:[]).filter(b=>b&&chatText(b.id)&&Number.isSafeInteger(b.at)&&chatText(b.title)&&Array.isArray(b.turnIds)&&b.turnIds.every(chatText));}
function chatDecision(d){
 if(d.state==='later')return chatSystem(d.id,'Later: '+d.question,[['Ask again',()=>chatDecide(d.id,'ask')]]);if(d.state==='done')return chatSystem(d.id,d.line);
 const busy=chatDeciding.has(d.id),node=chatKeyed('decision-'+d.id,'section','chat-decision',JSON.stringify([d.question,d.at,d.rows,d.action,busy]),()=>{const head=element('p',undefined,'chat-decision-head'),rows=element('dl'),actions=element('div',undefined,'chat-actions');
  head.append(element('strong',d.question),element('span',chatTime(d.at)));for(const [label,value] of d.rows)rows.append(element('dt',label),element('dd',value));
  actions.append(chatButton(d.action,()=>d.form==='member'?memberOpen(d.id):chatDecide(d.id,'act'),''),chatButton('Later',()=>chatDecide(d.id,'later')));for(const button of actions.children)button.disabled=busy;return [head,rows,actions];});
 node.setAttribute('aria-label',d.question);return node;
}
/** Bullets name the Work and its current state from the turn, so a briefing never carries its own counts. */
function chatBriefing(b,turns){const named=b.turnIds.map(id=>turns.get(id)).filter(turn=>turn&&turn.work);
 return chatKeyed('briefing-'+b.id,'div','chat-briefing',JSON.stringify([b.title,b.at,named.map(turn=>[turn.id,turn.work.title,chatCardLabel(turn)])]),()=>{const head=element('p'),list=element('ul');head.append(element('strong',b.title),element('span',' | '+chatDay(b.at)+' '+chatTime(b.at)));
  for(const turn of named){const item=element('li');item.append(chatButton(turn.work.title,()=>shellOpenWork(turn.id),''),element('span',' '+chatCardLabel(turn)));list.append(item);}return [head,list];});}
function chatSlot(turn){const kind=chatKind(turn);if(kind==='card')return [chatCard(turn)];const shown=turn.work?[chatFold(turn)]:[];
 if(kind==='unknown'||kind==='failed')shown.push(chatException(turn,kind));else if(kind==='closed')shown.push(chatSystem('closed:'+turn.id,'Closed: '+turn.work.title));return shown;}
function chatNode(key,text,className){let node=chatNodes.get(key);if(!node){node=element('p',undefined,className);chatNodes.set(key,node);}if(node.textContent!==text)node.textContent=text;node.hidden=!text;return node;}
function renderChat(){
 const view=chatView;if(!view)return;const turns=new Map(view.turns.map(turn=>[turn.id,turn])),items=[];let day='';
 // Decisions and briefings sit before the first owner message that started after them; a date line opens each day.
 // ponytail: they carry no segment, so an earlier segment shows none; filter by the segment's time span if old ones are missed there.
 const extras=chatSegment?[]:[...chatDecisions().map(d=>({at:d.at,node:()=>chatDecision(d)})),...chatBriefings().map(b=>({at:b.at,node:()=>chatBriefing(b,turns)}))].sort((a,b)=>a.at-b.at);
 const dated=(at,node)=>{if(Number.isSafeInteger(at)&&chatDay(at)!==day){day=chatDay(at);items.push(chatNode('date:'+day,day,'chat-date'));}items.push(node);};
 for(const message of view.segment?view.segment.messages:[]){
  const turn=message.role==='owner'?turns.get('assistant-turn:'+message.id):turns.get(message.turnId);
  if(message.role==='owner'&&turn&&Number.isSafeInteger(turn.at))while(extras.length&&extras[0].at<turn.at){const extra=extras.shift();dated(extra.at,extra.node());}
  dated(message.role==='owner'&&turn?turn.at:null,chatNode(message.id,message.text,message.role==='owner'?'chat-owner':'chat-reply'));if(!turn)continue;
  // The state line always follows its message, empty when there is nothing to say, so a later reply only appends.
  if(message.role==='owner')items.push(chatNode('state:'+turn.id,chatTurnLabel(turn),'chat-state'));
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
 try{do{chatAgain=false;const thread=chatThread,query=[chatSegment?'segment='+chatSegment:'',thread?'member='+encodeURIComponent(thread):''].filter(Boolean).join('&'),{response,body}=await request('/assistant/conversation'+(query?'?'+query:''));
  // A read for a thread the owner already left is dropped and the current one is read instead.
  if(thread!==chatThread){chatAgain=true;continue;}
  if(!response.ok||!Number.isSafeInteger(body.head)||!Array.isArray(body.turns)||body.segment!==null&&(!body.segment||!Array.isArray(body.segment.messages)))throw new Error('Conversation unavailable');
  chatView=body;if(!thread)chatRep=body;renderChat();if($('chat-status').textContent==='Unavailable')chatShow('');}while(chatAgain);}
 catch{if(!$('chat-status').textContent)chatShow('Unavailable');}finally{chatReading=false;chatControls();
  // A host that dies mid-turn leaves it pending and emits nothing more; the read turns it unknown after its deadline, so a shown pending turn is read again, also after a failed read.
  // ponytail: fixed interval because the view carries no deadlineAt; schedule at the deadline once the read exposes it.
  // A host's own start in flight emits nothing if it is refused before activation, so a card that shows it is read again too.
  // A running card's elapsed minutes come from the read, so it is read again each minute while one shows.
  clearTimeout(chatPendingTimer);const turns=chatView?chatView.turns:[],wait=turns.some(turn=>turn.displayStatus==='pending'||turn.work&&turn.work.starting)?10000:turns.some(turn=>chatKind(turn)==='card'&&turn.work&&turn.work.started)?60000:0;chatPendingTimer=wait?setTimeout(()=>void readChat(),wait):0;}
}
/** A replaced database invalidates every shown message and card: clear them and read the conversation of the current one. */
// A replaced database may not hold the open member, so the conversation falls back to the Representative and its draft.
function chatReset(){paneTabs=[];paneActive='';paneMission='';storage.remove(seenKey);renderPane();chatThread='';chatThreadName='';chatDraftKey='massion.workbench.chat-draft';$('chat-input').value=chatDraft().text;$('chat-input').setAttribute('placeholder','Message');if(!$('page-chat').hidden)shellShow('chat');chatView=null;chatRep=null;chatSegment=null;chatCards.clear();chatNodes.clear();$('chat-log').replaceChildren();chatControls();renderShell();void readChat();}
async function openChatWork(turnId){const turn=chatRep&&chatRep.turns.find(t=>t.id===turnId);if(!turn||!turn.work||busy||loading)return;const loaded=await loadMission(turn.work.missionId);if(!loaded||!snapshot||snapshot.value.id!==turn.work.missionId)return;document.getElementById('work-heading-'+turn.work.workId)?.focus();}
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
 if(new TextEncoder().encode(text).length>4096){chatShow('Too long');return;}
 const draft=chatDraft(),same=draft.text===text&&!!draft.commandId,commandId=same?draft.commandId:crypto.randomUUID();let pinned=same?draft.target:null;storage.set(chatDraftKey,JSON.stringify({text,commandId,target:pinned}));
 chatSending=true;chatShow('');chatControls();
 try{
  if(chatSegment||!chatView){chatSegment=null;await readChat();}
  for(let attempt=0;attempt<2;attempt++){
   const view=chatView,segment=view&&view.segment;const target=pinned??(!segment?{segment:1,expectedRevision:0}:segment.full?{segment:view.head+1,expectedRevision:0}:{segment:view.head,expectedRevision:segment.revision});chatPin(commandId,target);
   const {response,body}=await request('/assistant/messages',{method:'POST',headers:{'Content-Type':'application/json',...(view&&view.feedId?{'X-Massion-Feed':view.feedId}:{})},body:JSON.stringify({commandId,...target,text,...(chatThread?{member:chatThread}:{})})},130000);
   // The private draft clears only on its committed receipt, and only while the input still holds the sent text: an edit made while waiting is unsent and stays.
   // A conflict commits nothing, so the same command ID is reused.
   if(response.ok){if($('chat-input').value===text){storage.remove(chatDraftKey);$('chat-input').value='';}await readChat();return;}
   // A changed database is not a revision race: the message goes to it only on the owner's next Send.
   // A conflict proves the message is not at its target (the host replays from there first; a feed conflict means the target belongs to a replaced database), so the target is dropped and the next try reads the head.
   // A draining host refuses before that replay, so its refusal keeps the target.
   const feed=body.reason==='feed',refused=response.status===400||response.status===409||response.status===503&&body.outcome==='rejected';if(response.status===409){pinned=null;chatPin(commandId,null);}
   await readChat();if(response.status===409&&attempt===0&&!feed&&!/^answer_in_progress/.test(body.error||''))continue;
   // Only a refusal before the commit is "not sent"; any other answer may follow a stored message, so the result is unknown and Send replays it at the kept target.
   chatShow(/^answer_in_progress/.test(body.error||'')?'Answer in progress':feed?'Not sent · database changed':refused?'Not sent':'Result unknown');return;
  }
 }catch{chatShow('Result unknown');await readChat();}finally{chatSending=false;chatControls();}
}
function chatEvents(events){if(events.some(event=>typeof event.aggregateId==='string'&&(event.aggregateId.startsWith('assistant-conversation:')||chatView&&chatView.turns.some(turn=>turn.work&&turn.work.missionId===event.aggregateId))))void readChat();}
$('chat-input').value=chatDraft().text;
$('chat-input').addEventListener('input',()=>{const text=$('chat-input').value,draft=chatDraft();storage.set(chatDraftKey,JSON.stringify(draft.text===text?draft:{text,commandId:'',target:null}));});
$('chat-form').addEventListener('submit',event=>{event.preventDefault();void sendChat();});
$('chat-earlier').addEventListener('click',()=>{if(!chatView||!chatView.segment||!chatView.segment.previous)return;chatSegment=chatView.segment.number-1;void readChat();});
$('chat-latest').addEventListener('click',()=>{chatSegment=null;void readChat();});
void readChat();
`;
