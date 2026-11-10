import {copy} from './ui-copy.ts';

// Host-owned entry beside the conversation, independent of the Work pane (ADR 0003 §4, 0005 §5).
// Only command identity and outcome survive dispatch; token bytes never enter recovery state.
export const appConnectStyle=String.raw`.app-connect-panel{flex:0 0 min(var(--pane-base-width),46%);min-width:0;display:flex;flex-direction:column;border-left:1px solid var(--line);background:var(--bg-1)}.app-connect-bar{height:var(--header-height);display:flex;align-items:center;gap:var(--space-8);padding:0 var(--space-12);border-bottom:1px solid var(--line)}.app-connect-bar [role=tab]{font-weight:600;color:var(--fg);font-size:var(--type-sidebar-link-size)}.app-connect-bar button{margin-left:auto}.app-connect-body{padding:var(--space-28) calc(var(--space-12) * 2)}.app-connect-body form{display:grid;gap:var(--space-12);margin:0}.app-connect-body label{color:var(--fg);font-weight:600;font-size:var(--type-sidebar-link-size)}.app .app-connect-body input{background:var(--bg-2);color:var(--fg);border:1px solid var(--line-strong);border-radius:var(--chip-radius)}.app-connect-actions{display:flex;gap:var(--space-8);align-items:center}.app .app-connect-actions button{min-height:30px;padding:var(--space-4) var(--space-12);font-size:var(--type-conversation-button-size)}.app .app-connect-actions button+button{border:1px solid var(--line);background:none;color:var(--fg-3)}#app-connect-status{color:var(--fg-3);font-size:var(--type-conversation-text-size)}@media(max-width:900px){.app-connect-panel{position:fixed;z-index:7;inset:0 0 0 var(--rail-width)}}`;
export const appConnectPanel=String.raw`<section id="app-connect-panel" class="app-connect-panel" aria-labelledby="app-connect-title" hidden><div class="app-connect-bar"><div role="tablist"><span id="app-connect-title" role="tab" aria-selected="true"></span></div><button id="app-connect-close" type="button" class="icon" aria-label="${copy('pane.link.02')}">×</button></div><div class="app-connect-body"><form id="app-connect-form"><label id="app-connect-label" for="app-connect-token"></label><input id="app-connect-token" type="password" autocomplete="off" required><div class="app-connect-actions"><button id="app-connect-submit" type="submit">${copy('conversation.button.12')}</button><button id="app-connect-cancel" type="button">${copy('conversation.link.25')}</button></div></form><p id="app-connect-status" role="status" hidden></p></div></section>`;
export const appConnectClient=String.raw`
let appConnectChoice=null,appConnectSequence=0;
const appConnectOutcomes=new Map(),appConnectKey=(feed,id)=>JSON.stringify([feed,id]);
function appConnectClose(focus=false){++appConnectSequence;appConnectChoice?.controller?.abort();appConnectChoice=null;$('app-connect-token').value='';$('app-connect-panel').hidden=true;if(focus)$('chat-input').focus();}
function appConnectCurrent(choice){return appConnectChoice===choice&&choice.sequence===appConnectSequence&&choice.thread===chatThread&&choice.segment===chatSegment&&choice.feed===chatView?.feedId&&choice.feed===feedId&&choice.epoch===connectionEpoch&&!reconnectRequired;}
function appConnectValidate(){if(!appConnectChoice)return;const d=chatDecisions().find(d=>d.id===appConnectChoice.id);if(!appConnectCurrent(appConnectChoice)||!d?.connection||d.state!=='open'||d.connection.connected||JSON.stringify(d.connection)!==appConnectChoice.connection)appConnectClose();}
function appConnectOpen(id){
 const d=chatDecisions().find(d=>d.id===id);if(!d?.connection||d.connection.connected||d.state!=='open'||reconnectRequired||chatView?.feedId!==feedId||chatDeciding.has(id))return;
 appConnectClose();appConnectChoice={id,sequence:appConnectSequence,thread:chatThread,segment:chatSegment,feed:chatView.feedId,epoch:connectionEpoch,connection:JSON.stringify(d.connection)};
 $('app-connect-title').textContent=d.title;const label=copy('pane.textbox.01',{work_title:d.title});$('app-connect-label').textContent=label;$('app-connect-token').setAttribute('aria-label',label);
 const outcome=d.connection.pending===true||appConnectOutcomes.get(appConnectKey(chatView.feedId,id));$('app-connect-token').disabled=$('app-connect-submit').disabled=!!outcome;$('app-connect-status').textContent=outcome?copy('conversation.text.01'):'';$('app-connect-status').hidden=!outcome;$('app-connect-panel').hidden=false;if(!outcome)$('app-connect-token').focus();
}
$('app-connect-token').type='password';$('app-connect-token').setAttribute('autocomplete','off');
$('app-connect-close').addEventListener('click',()=>appConnectClose(true));$('app-connect-cancel').addEventListener('click',()=>appConnectClose(true));
$('app-connect-panel').addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();appConnectClose(true);}});
$('app-connect-form').addEventListener('submit',async event=>{
 event.preventDefault();const choice=appConnectChoice,input=$('app-connect-token');
 if(!choice||!appConnectCurrent(choice)||input.disabled||!input.value.trim()){input.value='';return;}
 const key=appConnectKey(choice.feed,choice.id);if(appConnectOutcomes.has(key)){input.value='';return;}
 appConnectOutcomes.set(key,'pending');input.disabled=$('app-connect-submit').disabled=true;
 const controller=new AbortController();choice.controller=controller;
 try{
  // Use the client port without storing token bytes in recoverable operation state.
  let pending;try{pending=request('/assistant/apps/connect',{method:'POST',headers:{'Content-Type':'application/json','X-Massion-Feed':choice.feed},body:JSON.stringify({commandId:crypto.randomUUID(),decisionId:choice.id,token:input.value}),signal:controller.signal},15000);}finally{input.value='';}
  const {response,body}=await pending;
  const status=response.ok&&['committed','replayed'].includes(body?.status)?'committed':response.status===409&&body?.status==='conflict'?'conflict':'unknown';if(status==='conflict')appConnectOutcomes.delete(key);else appConnectOutcomes.set(key,status);
  if(!appConnectCurrent(choice))return;
  if(status==='committed'){appConnectClose(true);await readChat();}
  else if(status==='conflict'){appConnectClose(true);await readChat();}
  else{$('app-connect-status').textContent=copy('conversation.text.01');$('app-connect-status').hidden=false;}
 }catch{appConnectOutcomes.set(key,'unknown');if(appConnectCurrent(choice)){$('app-connect-status').textContent=copy('conversation.text.01');$('app-connect-status').hidden=false;}}
 finally{delete choice.controller;}
});
`;
