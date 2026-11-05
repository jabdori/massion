/** Minimal conversation surface: one continuing conversation, one input, Work cards updated in place. Labels only; replies speak for themselves. */
export const chatStyle=String.raw`.conversation{max-width:760px;margin:0 auto 22px;padding:0 4px}.chat-log{display:flex;flex-direction:column;gap:10px}.chat-owner{align-self:flex-end;max-width:80%;margin:0;padding:9px 14px;border-radius:16px;background:var(--soft);white-space:pre-wrap;overflow-wrap:anywhere}.chat-reply{align-self:flex-start;max-width:90%;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.chat-state{align-self:flex-start;margin:0;color:var(--muted);font-size:.9em}.chat-card{align-self:stretch;display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:10px;padding:10px 14px;background:#fff}.chat-card-open{flex:1;display:flex;gap:10px;align-items:center;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}.chat-card-open:focus-visible{outline:3px solid #377dba}.chat-card strong{flex:1;overflow-wrap:anywhere}.chat-card-state{color:var(--muted)}.chat-nav{display:flex;justify-content:center;gap:8px}.chat-form{display:flex;gap:8px;align-items:flex-end;margin-top:14px}.chat-form textarea{flex:1}.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}`;
export const chatPanel=String.raw`<section id="conversation" class="conversation" aria-label="Conversation"><div class="chat-nav"><button id="chat-earlier" type="button" class="quiet" hidden>Earlier</button><button id="chat-latest" type="button" class="quiet" hidden>Latest</button></div><div id="chat-log" class="chat-log" role="log" aria-live="polite"></div><p id="chat-status" class="chat-state" role="status" hidden></p><form id="chat-form" class="chat-form"><label for="chat-input" class="visually-hidden">Message</label><textarea id="chat-input" rows="2" maxlength="4096" placeholder="Message"></textarea><button id="chat-send" type="submit">Send</button></form></section>`;
export const chatClient=String.raw`
const chatDraftKey='massion.workbench.chat-draft';
let chatView=null,chatSegment=null,chatReading=false,chatAgain=false,chatSending=false,chatPendingTimer=0;
// Nodes are kept by message and turn ID so a reread never moves or recreates what is already shown: focus stays and the live log announces only new items.
const chatCards=new Map(),chatNodes=new Map(),chatStarting=new Set();
// target is the segment and revision of a submission whose outcome is unknown: a retry goes there, where its message would sit, so the host replays it however far the head moved.
function chatDraft(){try{const value=JSON.parse(storage.get(chatDraftKey)||'null'),target=value&&value.target;return value&&typeof value.text==='string'&&typeof value.commandId==='string'?{text:value.text,commandId:value.commandId,target:target&&Number.isSafeInteger(target.segment)&&target.segment>=1&&Number.isSafeInteger(target.expectedRevision)&&target.expectedRevision>=0?{segment:target.segment,expectedRevision:target.expectedRevision}:null}:{text:'',commandId:'',target:null};}catch{return {text:'',commandId:'',target:null};}}
/** Records the target only while the stored draft is still this command, so an edit made while sending stays a new message. */
function chatPin(commandId,target){const draft=chatDraft();if(draft.commandId===commandId)storage.set(chatDraftKey,JSON.stringify({text:draft.text,commandId,target}));}
const chatReasons={assistant_route_missing:'no route',assistant_route_stale:'route unusable',settings_pending:'settings saving',settings_changed:'settings changed',default_route_missing:'no default route',default_route_stale:'default route unusable',assistant_intake_unsupported:'Mission not supported',host_busy:'host busy',host_draining:'host stopping',intake_conflict:'Mission changed',work_not_admitted:'refused'};
function chatReason(list){const code=Array.isArray(list)&&list[0]&&typeof list[0].code==='string'?list[0].code:'';return Object.hasOwn(chatReasons,code)?chatReasons[code]:code.replace(/^assistant_/,'').replaceAll('_',' ');}
function chatTurnLabel(turn){if(turn.displayStatus==='not_started'){const reason=chatReason(turn.diagnostics);return 'Not sent'+(reason?' · '+reason:'');}if(turn.displayStatus==='unknown')return 'Result unknown · not resent';if(turn.displayStatus==='failed')return 'No answer · not retried';if(turn.displayStatus==='pending')return '…';return '';}
function chatCardLabel(turn){const work=turn.work,result=turn.outcome;
 if(!work){if(result&&result.work.status==='unknown')return 'Unknown whether created';const reason=result?chatReason(result.work.diagnostics):'';return 'Not created'+(reason?' · '+reason:'');}
 if(work.acceptance==='accepted')return 'Done';if(work.acceptance==='failed'||work.acceptance==='stale')return 'Check failed';if(work.execution==='cancelled')return 'Cancelled';
 if(!work.started){const reason=result&&result.run.status==='not_started'?chatReason(result.run.diagnostics):'';return 'Not started'+(reason?' · '+reason:'');}
 if(work.execution==='blocked')return 'Stopped';if(work.execution==='waiting')return 'Waiting';return 'Working';}
function chatShow(text){$('chat-status').textContent=text;$('chat-status').hidden=!text;}
function chatControls(){$('chat-send').disabled=chatSending;$('chat-earlier').hidden=!(chatView&&chatView.segment&&chatView.segment.previous);$('chat-latest').hidden=!chatSegment;}
/** One element per turn, reused on every read, so a Work card changes in place and never duplicates. The card body and Start are sibling buttons. */
function chatCard(turn){
 let card=chatCards.get(turn.id);
 if(!card){card=element('div',undefined,'chat-card');card.id='chat-card-'+turn.id;const open=element('button',undefined,'chat-card-open');open.type='button';card.chatTitle=element('strong');card.chatState=element('span',undefined,'chat-card-state');open.append(card.chatTitle,card.chatState);open.addEventListener('click',()=>void openChatWork(turn.id));
  card.chatStart=element('button','Start','secondary');card.chatStart.type='button';card.chatStart.addEventListener('click',()=>void startChatWork(turn.id));card.append(open,card.chatStart);chatCards.set(turn.id,card);}
 card.chatTitle.textContent=turn.work?turn.work.title:turn.proposal.title;card.chatState.textContent=chatCardLabel(turn);
 card.chatStart.hidden=!(turn.work&&!turn.work.started&&turn.work.acceptance==='pending'&&turn.work.execution!=='cancelled'&&!chatStarting.has(turn.id));return card;
}
function chatNode(key,text,className){let node=chatNodes.get(key);if(!node){node=element('p',undefined,className);chatNodes.set(key,node);}if(node.textContent!==text)node.textContent=text;node.hidden=!text;return node;}
function renderChat(){
 const view=chatView;if(!view)return;const turns=new Map(view.turns.map(turn=>[turn.id,turn])),items=[];
 for(const message of view.segment?view.segment.messages:[]){
  items.push(chatNode(message.id,message.text,message.role==='owner'?'chat-owner':'chat-reply'));
  const turn=message.role==='owner'?turns.get('assistant-turn:'+message.id):turns.get(message.turnId);if(!turn)continue;
  // The state line always follows its message, empty when there is nothing to say, so a later reply only appends.
  if(message.role==='owner')items.push(chatNode('state:'+turn.id,chatTurnLabel(turn),'chat-state'));
  else if(turn.proposal)items.push(chatCard(turn));
 }
 const log=$('chat-log'),shown=[...log.children];
 if(shown.length<=items.length&&shown.every((node,index)=>node===items[index]))log.append(...items.slice(shown.length));else log.replaceChildren(...items);
 chatControls();
}
async function readChat(){
 if(chatReading){chatAgain=true;return;}chatReading=true;
 try{do{chatAgain=false;const {response,body}=await request('/assistant/conversation'+(chatSegment?'?segment='+chatSegment:''));
  if(!response.ok||!Number.isSafeInteger(body.head)||!Array.isArray(body.turns)||body.segment!==null&&(!body.segment||!Array.isArray(body.segment.messages)))throw new Error('Conversation unavailable');
  chatView=body;renderChat();if($('chat-status').textContent==='Unavailable')chatShow('');}while(chatAgain);}
 catch{if(!$('chat-status').textContent)chatShow('Unavailable');}finally{chatReading=false;chatControls();
  // A host that dies mid-turn leaves it pending and emits nothing more; the read turns it unknown after its deadline, so a shown pending turn is read again, also after a failed read.
  // ponytail: fixed interval because the view carries no deadlineAt; schedule at the deadline once the read exposes it.
  // A host's own start in flight emits nothing if it is refused before activation, so a card that shows it is read again too.
  clearTimeout(chatPendingTimer);chatPendingTimer=chatView&&chatView.turns.some(turn=>turn.displayStatus==='pending'||turn.work&&turn.work.starting)?setTimeout(()=>void readChat(),10000):0;}
}
/** A replaced database invalidates every shown message and card: clear them and read the conversation of the current one. */
function chatReset(){chatView=null;chatSegment=null;chatCards.clear();chatNodes.clear();$('chat-log').replaceChildren();chatControls();void readChat();}
async function openChatWork(turnId){const turn=chatView&&chatView.turns.find(t=>t.id===turnId);if(!turn||!turn.work||busy||loading)return;const loaded=await loadMission(turn.work.missionId);if(!loaded||!snapshot||snapshot.value.id!==turn.work.missionId)return;document.getElementById('work-heading-'+turn.work.workId)?.focus();}
async function startChatWork(turnId){
 const turn=chatView&&chatView.turns.find(t=>t.id===turnId);if(!turn||!turn.work||busy||chatSending||chatStarting.has(turnId))return;const work=turn.work;
 // One request per card at a time; the card label from the reread, not a status line, says how it ended.
 chatStarting.add(turnId);renderChat();
 try{await request('/missions/'+encodeURIComponent(work.missionId)+'/run',{method:'POST',headers:{'Content-Type':'application/json',...(feedId?{'X-Massion-Feed':feedId}:{})},body:JSON.stringify({commandId:crypto.randomUUID(),workId:work.workId,expectedRevision:work.missionRevision})},130000);}
 catch{}finally{chatStarting.delete(turnId);await readChat();renderChat();}
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
   const {response,body}=await request('/assistant/messages',{method:'POST',headers:{'Content-Type':'application/json',...(view&&view.feedId?{'X-Massion-Feed':view.feedId}:{})},body:JSON.stringify({commandId,...target,text})},130000);
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
