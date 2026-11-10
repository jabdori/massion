#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const root=fileURLToPath(new URL('../../',import.meta.url)),out=join(root,'.runtime/table-interactions'),run=promisify(execFile),rows=[];
await mkdir(out,{recursive:true});const config=join(out,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',TZ:'Asia/Seoul'});
const sessionRoot=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-table'],{cwd:root,env})).stdout.trim();
for(const theme of ['dark','light']){
 const host=await startFixtureHost('B18-room-b'),session=sessionRoot+'-'+theme;
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{cwd:root,env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=join(out,theme+'-clock.js');await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser(step.action,step.selector);if(step.readySelector)await browser('wait',step.readySelector);}
  await browser('wait','.work-room:not([hidden]) .typed-result-table');
  const measure=()=>evaluate(`(()=>{const table=document.querySelector('.work-room:not([hidden]) .typed-result-table');return {headers:[...table.querySelectorAll('th')].map(n=>[n.textContent,n.scope]),cells:[...table.querySelectorAll('td')].map(n=>n.textContent),links:table.querySelectorAll('a,img,script').length,overflow:document.documentElement.scrollWidth>innerWidth,wide:paneWideOn}})()`);
  const initial=await measure();assert.deepEqual(initial.headers,[['회사','col'],['요금제','col'],['월 요금','col'],['출처','col']]);assert.equal(initial.cells.length,24);assert.equal(initial.cells[2],'9,900원');assert.equal(initial.cells[22],'12,500원');assert.equal(initial.links,0);
  assert.match(await evaluate(`document.querySelector('.chat-card:has(.chat-steps)')?.parentElement.textContent`),/표 1개 · 확인 대기/);
  await browser('snapshot');await browser('screenshot',join(out,theme+'-compact.png'));
  await browser('click','#pane-widen');const expanded=await measure();assert.equal(expanded.wide,!initial.wide);assert.deepEqual(expanded.cells,initial.cells);await browser('screenshot',join(out,theme+'-expanded.png'));
  await browser('set','viewport','390','844');const mobile=await measure();assert.equal(mobile.overflow,false);assert.deepEqual(mobile.cells,initial.cells);await browser('screenshot',join(out,theme+'-mobile.png'));
  await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate(`document.activeElement.id`),'chat-input');
  rows.push({theme,initial,expanded,mobile,closed:true});console.log(theme+': typed table interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(join(out,'report.json'),JSON.stringify(rows,null,2)+'\n');
