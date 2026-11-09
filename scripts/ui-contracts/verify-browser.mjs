import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';
const run=promisify(execFile),out=resolve('.runtime/browser-interactions');await mkdir(out,{recursive:true});
const session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-browser-rb'])).stdout.trim(),config=out+'/browser.json';await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000',TZ:'Asia/Seoul'});
const rows=[];
for(const screen of ['B4','B15'])for(const theme of ['dark','light']){
 const host=await startFixtureHost(screen),browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const r=JSON.parse(stdout);assert.ok(r.success,r.error);return r.data;},evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=out+'/clock.js';await writeFile(clock,`{const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  await evaluate(`globalThis.browserCommands=0;const original=fetch;globalThis.fetch=(p,o)=>{if(p==='/protocol/request'&&JSON.parse(o.body).kind==='command')browserCommands++;return original(p,o)}`);
  for(const step of host.fixture.steps){await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  await browser('wait','#browser-page');
  const count=await evaluate(`document.querySelectorAll('#pane-effect [role=tab]').length`);assert.equal(count,screen==='B15'?3:1);
  for(let index=0;index<count;index++){
   await browser('click','#browser-page-tab-'+index);
   const page=await evaluate(`(()=>{const p=document.getElementById('pane-effect');return {address:document.getElementById('browser-address').value,title:document.querySelector('#browser-page h3').textContent,readonly:[...p.querySelectorAll('input')].every(i=>i.readOnly),dangerous:!!p.querySelector('iframe,form,script'),commands:browserCommands}})()`);assert.equal(page.readonly,true);assert.equal(page.dangerous,false);assert.equal(page.commands,0);assert.match(page.address,screen==='B15'?/^https:\/\/library.example.com\//:/^https:\/\/shop.example.com\//);rows.push({screen,theme,index,...page});await browser('screenshot',out+'/'+screen+'-'+theme+'-'+index+'.png');
  }
  if(screen==='B15'){await browser('press','ArrowLeft');assert.equal(await evaluate(`document.getElementById('browser-page-tab-1').getAttribute('aria-selected')`),'true');}
  await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',out+'/'+screen+'-'+theme+'-mobile.png');await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate('browserCommands'),0);
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/report.json',JSON.stringify(rows,null,2)+'\n');console.log('Browser tabs, readonly forms, masked values, mobile overflow and close verified:',rows.length,'page/theme states');
