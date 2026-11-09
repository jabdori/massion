#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const root=fileURLToPath(new URL('../../',import.meta.url)),output=join(root,'docs/acceptance/E3d2'),run=promisify(execFile),rows=[];
await mkdir(output,{recursive:true});
await mkdir(join(root,'.runtime'),{recursive:true});
const config=join(root,'.runtime/e3d2-native-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000',AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const theme of ['dark','light'])for(const screen of ['B10','B12','B17','B22']){
 const session='massion-pages-'+randomUUID().slice(0,8),host=await startFixtureHost(screen);
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{cwd:root,env,timeout:45000,maxBuffer:1024*1024});const reply=JSON.parse(stdout);assert.equal(reply.success,true,reply.error);return reply.data;};
 const evaluate=async expression=>(await browser('eval','-b',Buffer.from(expression).toString('base64'))).result;
 try{
  await browser('open',host.url);await browser('set','viewport','1440','900');await browser('wait','--fn',workbenchReady);
  if(screen==='B10'){
   await browser('click','#rail-results');await browser('wait','#results-rows .result-name');
   assert.notEqual(await evaluate('document.activeElement.id'),'results-query');assert.equal(await evaluate("document.querySelector('.results-search .glyph-search')!==null"),true);
   await browser('fill','#results-query','요일별');await evaluate('readChat()');
   const measured=await evaluate(`({query:document.getElementById('results-query').value,rows:document.getElementById('results-rows').children.length,searchVisible:document.getElementById('sidebar-search').checkVisibility()})`);
   assert.equal(measured.query,'요일별');assert.equal(measured.rows,1);assert.equal(measured.searchVisible,true);rows.push({screen,theme,measured});
  }else if(screen==='B12'){
   await browser('click','#rail-me');await browser('click','#me-settings');await browser('click','#settings-nav-memory');await browser('wait','#memory-query');
   const measured=await evaluate("({active:document.activeElement.id,width:document.querySelector('#page-settings .settings-stack').getBoundingClientRect().width,titleSize:getComputedStyle(document.getElementById('settings-memory-title')).fontSize,advancedVisible:document.getElementById('settings-nav-advanced').checkVisibility(),magnifier:document.querySelector('#memory-query-wrap .glyph-search')!==null})");
   assert.notEqual(measured.active,'memory-query');assert.equal(measured.width,640);assert.equal(measured.titleSize,'22px');assert.equal(measured.advancedVisible,false);assert.equal(measured.magnifier,true);rows.push({screen,theme,measured});
  }else if(screen==='B17'){
   await browser('click','#rail-schedules');await browser('wait','#schedule-active');
   const measured=await evaluate(`(()=>{const el=document.getElementById('schedule-active'),r=el.getBoundingClientRect(),knob=getComputedStyle(el,'::after');return {width:r.width,height:r.height,knobWidth:parseFloat(knob.width),knobHeight:parseFloat(knob.height),knobColor:knob.backgroundColor,searchVisible:document.getElementById('sidebar-search').checkVisibility()}})()`);
   assert.equal(await evaluate("getComputedStyle(document.getElementById('schedule-copy')).opacity"),'0');
   assert.equal(measured.width,34);assert.equal(measured.height,20);assert.equal(measured.knobWidth,16);assert.equal(measured.knobHeight,16);if(theme==='light')assert.equal(measured.knobColor,'rgb(255, 255, 255)');assert.equal(measured.searchVisible,true);rows.push({screen,theme,measured});
  }else{
   await browser('click','#rail-app-app-github');await browser('wait','#app-view h2');
   assert.equal(await evaluate(`['Open','Merged','Changes','Files'].some(label=>document.getElementById('app-view').innerText.includes(label))`),false);
   await evaluate('appsList=[];renderAppSide();true');await browser('click','#rail-chat');
   const measured=await evaluate(`({searchVisible:document.getElementById('sidebar-search').checkVisibility(),parent:document.getElementById('sidebar-search').parentElement.id,chatVisible:document.getElementById('page-chat').checkVisibility()})`);
   assert.equal(measured.searchVisible,true);assert.equal(measured.parent,'sidebar-controls');assert.equal(measured.chatVisible,true);rows.push({screen,theme,measured});
  }
 }finally{try{await browser('close');}finally{await host.close();}}
}
await writeFile(join(output,'native-interactions.json'),JSON.stringify({rows},null,2)+'\n');
console.log(rows.length+' native page checks passed; fixture-only, headless, no product commands.');
