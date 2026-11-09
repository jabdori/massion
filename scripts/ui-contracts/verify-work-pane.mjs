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

const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'.runtime/work-pane-interactions'),run=promisify(execFile),rows=[];
await mkdir(out,{recursive:true});const config=join(out,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',TZ:'Asia/Seoul'});
for(const theme of ['dark','light'])for(const screen of ['B7','B7-fail','B7-unknown','B8']){
 const host=await startFixtureHost(screen),session='massion-room-'+randomUUID().slice(0,8);
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{cwd:root,env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){assert.notEqual(step.action,'offline');await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  await browser('wait','.work-room:not([hidden])');await evaluate(`globalThis.roomCommands=0;const roomFetch=globalThis.fetch;globalThis.fetch=(path,options)=>{if(path==='/protocol/request'&&JSON.parse(options.body).kind==='command')roomCommands++;return roomFetch(path,options)}`);
  const measure=()=>evaluate(`(()=>{const card=document.querySelector('.work-room:not([hidden])'),rect=card.getBoundingClientRect(),pane=document.getElementById('work-pane'),visible=el=>!!el&&el.checkVisibility({checkVisibilityCSS:true});return {width:rect.width,wide:paneWideOn,overflow:document.documentElement.scrollWidth>innerWidth,title:card.querySelector('h3').textContent,stop:visible(card.querySelector('.room-stop')),compact:visible(card.querySelector('.room-compact')),detail:visible(card.querySelector('.room-detail')),dashboard:[document.getElementById('mission-purpose'),document.getElementById('event-list'),document.getElementById('pane-people')].some(visible),unknown:snapshot.value.works.find(w=>w.id===paneTabs.find(t=>t.key===paneActive).workId).effects.some(e=>e.status==='unknown'),pending:!!unknownOperation}})()`);
  const initial=await measure();assert.equal(initial.dashboard,false);assert.equal(initial.overflow,false);assert.equal(initial.compact,!initial.wide);assert.equal(initial.detail,initial.wide);
  if(screen==='B7')assert.equal(initial.stop,true);if(screen==='B7-unknown')assert.equal(initial.unknown,true);
  const summary='.work-room:not([hidden]) > .room-inspection > summary';await browser('click',summary);
  assert.equal(await evaluate(`document.querySelector('.work-room:not([hidden]) > .room-inspection').open`),true);
  await browser('click',summary);await browser('click','#pane-widen');
  const toggled=await measure();assert.equal(toggled.wide,!initial.wide);assert.equal(toggled.detail,toggled.wide);assert.equal(toggled.compact,!toggled.wide);assert.equal(toggled.title,initial.title);assert.equal(toggled.unknown,initial.unknown);
  assert.equal(await evaluate(`document.getElementById('pane-widen').getAttribute('aria-label')`),toggled.wide?'좁히기':'넓히기');
  await browser('set','viewport','390','844');const mobile=await measure();assert.equal(mobile.overflow,false);
  await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate(`document.activeElement.id`),'chat-input');assert.equal(await evaluate(`!!unknownOperation`),false);assert.equal(await evaluate(`roomCommands`),0);
  rows.push({screen,theme,initial,toggled,mobile,inspection:true,closeFocus:'chat-input',commands:0});console.log(screen+' ('+theme+'): room interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(join(out,'report.json'),JSON.stringify(rows,null,2)+'\n');
