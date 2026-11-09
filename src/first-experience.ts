import {copy} from './ui-copy.ts';
export const firstStyle=String.raw`.first-signin.page-body{height:100vh;width:100%;display:grid;place-content:center;padding:24px;text-align:center}.first-signin-actions{display:grid;gap:10px;width:min(300px,calc(100vw - 48px))}.first-logo{display:grid;place-items:center;width:44px;height:44px;margin:0 auto 8px;border:1px solid var(--line-strong);border-radius:12px;font-size:22px;font-weight:650}.first-signin h1{font-size:28px;letter-spacing:-.03em;margin-bottom:24px}.first-signin button{background:var(--fg);color:var(--bg-0);border-color:var(--line);font-size:14px}.first-signin #first-chatgpt{background:transparent;color:var(--fg);border-color:var(--line-strong)}.first-signin a{text-decoration:none;color:var(--fg-3);font-size:13px;margin-top:10px}.first-signin p{font-size:13px;color:var(--fg-3)}.app .first-suggestions>a{display:flex;align-items:center;gap:12px;width:100%;min-height:38px;margin:0;padding:0 4px;border:0;border-radius:8px;background:transparent;color:var(--fg);text-decoration:none;font-size:14px}.first-letter{display:grid;place-items:center;flex:none;width:24px;height:24px;border-radius:6px;background:var(--bg-3);color:var(--fg-3);font-size:12px}.app .first-suggestions>a:last-child{color:var(--fg-3)}.app #first-mail-ask{padding:0;border:0;background:transparent;color:var(--fg-2);font:inherit;text-decoration:none}.first-picker{padding:14px 16px;border-radius:14px;background:var(--bg-1)}.first-picker p{margin:0 0 10px;font-weight:600}.first-picker [role=radiogroup]{display:grid}.app .first-radio{display:flex;align-items:center;gap:12px;min-height:38px;padding:6px 4px;border:0;background:transparent;color:var(--fg);font-size:14px;text-align:left;font-weight:400}.first-radio::before{content:'';width:14px;height:14px;border:1px solid var(--fg-3);border-radius:50%;box-sizing:border-box;flex:none}.first-radio[aria-checked=true]::before{background:var(--fg);box-shadow:inset 0 0 0 3px var(--bg-1)}.first-picker>a,.first-mail a{display:inline-flex;align-items:center;min-height:30px;padding:4px 14px;margin-top:12px;border-radius:8px;background:var(--fg);color:var(--bg-0);text-decoration:none;font-size:13px}.first-mail{align-self:stretch}.first-mail p{margin:0}.first-mail a{margin-right:8px;background:var(--gate);color:var(--gate-ink)}.first-mail a.secondary{background:transparent;border:1px solid var(--line-strong);color:var(--fg)}.app .first-suggestions>a:hover,.first-radio:hover{background:var(--bg-3)}`;
export const firstPanel=String.raw`<div role="region" id="first-signin" class="first-signin page-body" aria-labelledby="first-title" hidden><div class="first-signin-actions"><span class="first-logo" aria-hidden="true">${copy('page.heading.01')[0]}</span><h1 id="first-title">${copy('page.heading.01')}</h1><button id="first-claude" type="button">${copy('page.button.02')}</button><button id="first-chatgpt" type="button">${copy('page.button.01')}</button><a id="first-other" href="#">${copy('page.link.05')}</a><p id="first-login-status" role="status" hidden></p><button id="first-login-check" type="button" hidden>${copy('ui.first.login-check')}</button></div></div>`;
export const firstClient=String.raw`
let firstReset=false,firstPicker=false,firstSelected='calculation',firstOther=false,firstLoginBusy=false;
const firstLoginCommands=new Map();
function firstEmpty(){return !firstReset&&Array.isArray(connectionCatalog?.logins)&&!!chatView&&!chatThread&&!chatSegment&&!chatView.turns.length&&!shellWorks.length&&!chatView.segment?.messages.some(m=>m.role==='owner');}
function firstRoute(){const logins=connectionCatalog?.logins,signin=firstEmpty()&&!firstOther&&Array.isArray(logins)&&!logins.some(l=>l.status==='detected')&&!connectionCatalog.connections.length;$('first-signin').hidden=!signin;$('app').hidden=signin;}
function firstLink(id,label,run){const link=element('a',label);link.id=id;link.href='#';if(id==='first-mail-later')link.className='secondary';link.addEventListener('click',event=>{event.preventDefault();void run();});return link;}
function firstMailKey(){return 'massion.first-mail:'+chatView.feedId;}
function firstPick(selection){if(!firstEmpty())return;firstPicker=true;firstSelected=selection;renderChat();}
async function firstAssign(){if(!firstEmpty()||chatSending||chatDraft().commandId||$('chat-input').value.trim()){$('chat-input').focus();return;}
 const generation=chatGeneration,feed=chatView.feedId,text=firstSelected==='calculation'?copy('ui.first.calculation'):copy('conversation.link.17');
 await readChat();if(generation!==chatGeneration||feed!==chatView?.feedId||!firstEmpty()||$('chat-input').value.trim())return;
 $('chat-input').value=text;await sendChat();
}
function firstItems(){
 firstRoute();const items=[];
 if(chatView?.greeting&&(!chatView.segment||chatView.segment.number===1))items.push(chatMessage({id:chatView.greeting.id,role:'representative',text:chatView.greeting.text},null));
 if(!firstEmpty())return items;
 const mail=chatDecisions().find(d=>d.id==='mail-connect');
 if(firstPicker||mail){
  if(!chatView.apps?.some(a=>a.id==='gmail')){
   const later=storage.get(firstMailKey())==='later'||mail?.state==='later';
   if(later)items.push(chatKeyed('first-mail-later','p','chat-system','later',()=>[element('span',copy('ui.first.mail-later')),firstLink('first-mail-ask',copy('conversation.button.06'),()=>{storage.remove(firstMailKey());renderChat();})]));
   else items.push(chatKeyed('first-mail-open','section','chat-decision first-mail','open',()=>[element('p',copy('ui.first.mail-question')),firstLink('first-mail-connect',copy('conversation.button.12'),()=>{shellShow('settings');settingsOpen('apps');}),firstLink('first-mail-later',copy('conversation.button.04'),()=>{storage.set(firstMailKey(),'later');renderChat();})]));
  }
  items.push(chatKeyed('first-picker','section','first-picker',firstSelected,()=>{const group=element('div');group.setAttribute('role','radiogroup');group.setAttribute('aria-label',copy('ui.member-work'));
   for(const [value,key] of [['calculation','conversation.link.26'],['daily','conversation.link.17']]){const radio=chatButton(copy(key),()=>firstPick(value),'first-radio');radio.id='first-radio-'+value;radio.setAttribute('role','radio');radio.setAttribute('aria-checked',String(firstSelected===value));radio.tabIndex=firstSelected===value?0:-1;radio.addEventListener('keydown',event=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();firstPick(value==='calculation'?'daily':'calculation');document.getElementById('first-radio-'+firstSelected)?.focus();}});group.append(radio);}
   return [element('p',copy('ui.first.question')),group,firstLink('first-assign',copy('conversation.button.08'),firstAssign)];}));
 }else{
  if(!chatView.segment?.messages.length)items.push(chatMessage({id:'first-greeting',role:'representative',text:copy('ui.first.greeting',{member:chatName()})},null));
  items.push(chatKeyed('first-suggestions','section','first-picker first-suggestions','suggestions',()=>[element('p',copy('ui.first.question')),...[['summary','conversation.link.18'],['calculation','conversation.link.26'],['daily','conversation.link.17'],['other','conversation.link.16']].map(([value,key],index)=>{const letter=element('span',String.fromCharCode(65+index),'first-letter');letter.setAttribute('aria-hidden','true');const link=firstLink('first-'+value,'',()=>{if(value==='other'||value==='summary'){$('chat-input').value=value==='summary'?copy(key):'';$('chat-input').focus();chatControls();}else firstPick(value);});link.append(letter,element('span',copy(key)));return link;})]));
 }
 return items;
}
async function firstLogin(providerType){if(firstLoginBusy)return;firstLoginBusy=true;$('first-claude').disabled=true;$('first-chatgpt').disabled=true;
 const epoch=connectionEpoch,key=providerType;let commandId=firstLoginCommands.get(key);if(!commandId){commandId='login:'+crypto.randomUUID();firstLoginCommands.set(key,commandId);}
 try{const {response}=await request('/connection-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({providerType,commandId})});if(epoch!==connectionEpoch)return;$('first-login-status').textContent=response.ok?copy('ui.first.login-pending'):copy('ui.unavailable');}
 catch{if(epoch===connectionEpoch)$('first-login-status').textContent=copy('conversation.text.01');}
 finally{firstLoginBusy=false;$('first-claude').disabled=false;$('first-chatgpt').disabled=false;$('first-login-status').hidden=false;$('first-login-check').hidden=false;}
}
$('first-claude').addEventListener('click',()=>firstLogin('claude-code-cli'));
$('first-chatgpt').addEventListener('click',()=>firstLogin('codex-cli'));
$('first-login-check').addEventListener('click',async()=>{await refreshConnections();firstRoute();});
$('first-other').addEventListener('click',event=>{event.preventDefault();firstOther=true;firstRoute();shellShow('settings');settingsOpen('connections');});
`;
