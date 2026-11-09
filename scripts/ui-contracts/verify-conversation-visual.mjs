#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'.runtime/conversation-visual-gate'),run=promisify(execFile),rows=[];
await mkdir(out,{recursive:true});const config=join(out,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',TZ:'Asia/Seoul'});
for(const theme of ['dark','light'])for(const screen of ['B1-signin','B2','B5','B11','B18','B21-name']){
 const host=await startFixtureHost(screen),session='massion-visual-'+screen.toLowerCase()+'-'+theme+'-'+randomUUID().slice(0,8);
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{cwd:root,env,timeout:45000,maxBuffer:2e6});const reply=JSON.parse(stdout);assert.ok(reply.success,reply.error);return reply.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=join(out,session+'.js');await writeFile(clock,`{const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);if(screen!=='B1-signin')await browser('wait',host.fixture.readySelector);
  for(const step of host.fixture.steps){assert.notEqual(step.action,'offline','Visual gate fixtures use connected read-only state');await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  let emptyLog;
  if(screen==='B1-signin'){
   emptyLog=await evaluate(`(()=>{const log=document.getElementById('chat-log'),scroll=document.getElementById('chat-scroll');return {exists:!!log,height:log?.getBoundingClientRect().height,children:log?.children.length,display:log&&getComputedStyle(log).display,flexGrow:log&&getComputedStyle(log).flexGrow,viewportHeight:scroll.getBoundingClientRect().height}})()`);
   assert.ok(emptyLog.exists&&emptyLog.height>0,'empty conversation log must occupy its viewport: '+JSON.stringify(emptyLog));assert.equal(emptyLog.children,0);
  }
  const measured=await evaluate(`(()=>{const style=el=>getComputedStyle(el),form=document.getElementById('chat-form'),permission=document.getElementById('chat-permission');return {permission:{text:permission.textContent.trim(),icons:permission.querySelectorAll('svg').length,background:style(permission).backgroundColor},pointerRing:style(form).outlineStyle,draftCopy:!!document.getElementById('chat-draft-copy'),dates:[...document.querySelectorAll('.chat-date')].map(el=>({text:el.textContent,before:getComputedStyle(el,'::before').content,after:getComputedStyle(el,'::after').content,align:style(el).justifyContent})),avatars:[...document.querySelectorAll('.band .avatar,.chat-byline .avatar,#chat-mentions .avatar,#side-member-member-quill>.avatar,#side-member-member-juno>.avatar')].filter(el=>!el.hidden).map(el=>({letter:el.textContent,shape:el.getAttribute('data-shape'),mask:style(el).maskImage,radius:style(el).borderRadius,background:style(el).backgroundColor})),activeHints:[...document.querySelectorAll('.side-row[aria-current=page] kbd')].map(el=>style(el).opacity)}})()`);
  measured.shield=await evaluate(`(()=>{const icon=document.querySelector('#chat-permission svg');return {path:icon.querySelector('path').getAttribute('d'),width:icon.getBoundingClientRect().width,height:icon.getBoundingClientRect().height,viewBox:icon.getAttribute('viewBox'),strokeWidth:getComputedStyle(icon).strokeWidth,fill:getComputedStyle(icon).fill}})()`);
  assert.deepEqual(measured.shield,{path:'M12 3.5l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-5z',width:14,height:14,viewBox:'0 0 24 24',strokeWidth:'1.75px',fill:'none'},screen+' '+theme+' shared artboard shield');
  measured.github=await evaluate(`(()=>{const button=[...document.querySelectorAll('#rail-apps button')].find(el=>el.getAttribute('aria-label')==='GitHub'),mark=button?.querySelector('.app-branch');return !button?null:{text:button.textContent,icon:!!mark,width:mark?.getBoundingClientRect().width,height:mark?.getBoundingClientRect().height,mask:mark&&getComputedStyle(mark).maskImage,hidden:mark?.getAttribute('aria-hidden')}})()`);
  if(['B5','B18'].includes(screen))assert.ok(measured.github,'GitHub fixture rail entry');
  if(measured.github){assert.equal(measured.github.text,'');assert.equal(measured.github.icon,true);assert.equal(measured.github.width,18);assert.equal(measured.github.height,18);assert.notEqual(measured.github.mask,'none');assert.equal(measured.github.hidden,'true');}
  if(emptyLog)measured.emptyLog=emptyLog;
  assert.deepEqual(measured.permission,{text:'기본 권한',icons:2,background:'rgba(0, 0, 0, 0)'},screen+' '+theme+' permission');assert.equal(measured.pointerRing,'none',screen+' '+theme+' pointer focus');assert.equal(measured.draftCopy,false);
  for(const date of measured.dates){assert.ok(['none','normal'].includes(date.before));assert.ok(['none','normal'].includes(date.after));assert.equal(date.align,'center');}
  for(const avatar of measured.avatars.filter(a=>['퀼','주'].includes(a.letter))){assert.equal(avatar.shape,'square');assert.equal(avatar.mask,'none');assert.equal(avatar.radius,'6px');if(avatar.letter==='퀼')assert.equal(avatar.background,theme==='dark'?'rgb(63, 200, 203)':'rgb(0, 79, 153)');}
  assert.ok(measured.activeHints.every(opacity=>opacity==='0'));
  if(screen==='B11'){
   measured.popup=await evaluate(`(()=>{const row=document.querySelector('.chat-mention-manage'),popup=document.getElementById('chat-mentions');return {border:getComputedStyle(row).borderTopWidth,radius:getComputedStyle(row).borderRadius,icon:getComputedStyle(row.querySelector('.chat-manage-icon')).maskImage!=='none',shadow:getComputedStyle(popup).boxShadow,visible:!popup.hidden}})()`);
   assert.equal(measured.popup.border,'1px');assert.equal(measured.popup.radius,'0px');assert.equal(measured.popup.icon,true);assert.equal(measured.popup.visible,true);if(theme==='light')assert.notEqual(measured.popup.shadow,'none');
  }
  if(screen==='B11'||screen==='B18'){
   await browser('click','#chat-input');assert.equal(await evaluate(`getComputedStyle(document.getElementById('chat-form')).outlineStyle`),'none');
   await browser('press','Tab');await browser('press','Shift+Tab');measured.keyboard=await evaluate(`({active:document.activeElement.id,visible:document.activeElement.matches(':focus-visible'),ring:getComputedStyle(document.getElementById('chat-form')).outlineWidth,color:getComputedStyle(document.getElementById('chat-form')).outlineColor})`);
   assert.equal(measured.keyboard.active,'chat-input');assert.equal(measured.keyboard.visible,true);assert.equal(measured.keyboard.ring,'2px');assert.equal(measured.keyboard.color,theme==='dark'?'rgb(131, 137, 147)':'rgb(93, 93, 93)');
   await browser('click','#chat-input');assert.equal(await evaluate(`getComputedStyle(document.getElementById('chat-form')).outlineStyle`),'none');
  }
  if(screen==='B21-name'){
   const before=await evaluate(`({thread:chatThread,key:chatDraftKey,name:document.getElementById('member-name').value,draft:document.getElementById('chat-input').value})`);
   for(const shortcut of ['Meta+2','Control+2']){await browser('press',shortcut);assert.deepEqual(await evaluate(`({thread:chatThread,key:chatDraftKey,name:document.getElementById('member-name').value,draft:document.getElementById('chat-input').value})`),before);assert.equal(await evaluate(`document.activeElement.id`),'member-name');}
   await evaluate(`document.getElementById('member-create').focus()`);for(const shortcut of ['Alt+ArrowDown','Alt+ArrowUp']){await browser('press',shortcut);assert.equal(await evaluate(`document.activeElement.id`),'member-create');assert.equal(await evaluate(`chatDraftKey`),before.key);}
   assert.equal(await evaluate(`chatOpenThread('member-quill')`),false);await browser('click','#member-close');await browser('press','Meta+2');await browser('wait','--fn',`chatThread==='member-quill'&&!chatReading`);
   measured.modal={shortcutsBlocked:true,directCallerBlocked:true,draftsPreserved:true,shortcutResumesAfterClose:true};
  }
  if(screen==='B5'){
   assert.deepEqual(measured.dates.map(date=>date.text),['11월 5일 (목) 14:08']);
   measured.unknown=await evaluate(`(()=>{const card=document.getElementById('chat-exception-assistant-turn:m:toner');return {time:card.querySelector('.chat-exception-time')?.textContent,fact:card.querySelector('.chat-exception-fact').textContent,lead:document.querySelector('.chat-reply .chat-message-text').textContent,buttons:[...card.querySelectorAll('button')].map(el=>el.textContent)}})()`);
   assert.equal(measured.unknown.time,'14:12');assert.equal(measured.unknown.fact,'결제 요청에 응답 없음 · 다시 보내지 않음');assert.equal(measured.unknown.lead,'지난 주문과 같은 토너를 찾아 결제 직전에서 멈췄어요.');assert.deepEqual(measured.unknown.buttons,['확인','닫기']);
   await browser('click','[id="chat-exception-assistant-turn:m:toner"] .chat-actions button:last-child');await browser('wait','#quarantine-reason-toner');
   measured.review=await evaluate(`({focus:document.activeElement.id,ack:document.getElementById('quarantine-ack-toner').checked,unknown:snapshot.value.works.find(w=>w.id==='toner').effects.some(e=>e.status==='unknown'),closed:!!snapshot.value.works.find(w=>w.id==='toner').runtimeRecovery})`);
   assert.deepEqual(measured.review,{focus:'quarantine-reason-toner',ack:false,unknown:true,closed:false});
  }
  rows.push({screen,theme,measured});console.log(screen+' ('+theme+'): visual assertions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(join(out,'measurements.json'),JSON.stringify(rows,null,2)+'\n');
