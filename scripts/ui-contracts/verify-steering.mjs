import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {loadFixture,startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';
const exec=promisify(execFile),out=resolve('.runtime/rf-interactions'),rows=[];
await mkdir(out,{recursive:true});await writeFile(out+'/browser.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
const session=(await exec('agent-browser',['session','id','--scope','worktree','--prefix','massion-rf'])).stdout.trim();
for(const theme of ['dark','light'])for(const screen of ['B7-churn','B7-fail']){
 const fixture=await loadFixture(screen),host=await startFixtureHost(fixture),work=fixture.routes['/missions/intake'].body.value.works.find(w=>w.title==='이탈 원인 조사');
 const browser=async(...args)=>{const {stdout}=await exec('agent-browser',['--config',out+'/browser.json','--session',session+'-'+screen+'-'+theme,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  await writeFile(out+'/clock.js',`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);
  await browser('open','--init-script',out+'/clock.js');await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of fixture.steps){await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  const label=await evaluate(`Array.from(document.querySelectorAll('.chat-system button')).find(b=>b.textContent.startsWith('방향 바꿈: 이탈 원인 조사')).textContent`);assert.match(label,/방향 바꿈: 이탈 원인 조사 · \d+:\d+/);
  await browser('click','#pane-close');await browser('find','role','button','click','--name',label);await browser('wait','.work-room');
  let snapshot=(await browser('snapshot')).snapshot;assert.match(snapshot,/이탈 원인 조사/);assert.match(snapshot,screen==='B7-churn'?/실행 중/:/확인 실패/);
  assert.match(await evaluate(`document.querySelector('#work-pane').textContent`),/절차/);
  await browser('screenshot',out+'/'+screen+'-'+theme+'.png');await writeFile(out+'/'+screen+'-'+theme+'.txt',snapshot);
  await browser('click','#pane-widen');assert.equal(await evaluate(`document.querySelector('#pane-widen').getAttribute('aria-pressed')`),'true');
  await browser('click','#pane-widen');await browser('click','#work-room-check-'+work.id);
  await browser('set','viewport','390','900');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
  await browser('screenshot',out+'/'+screen+'-'+theme+'-mobile.png');
  rows.push({screen,theme,link:label,opensExactWork:true,telemetry:true,expanded:true,check:true,mobileOverflow:false});console.log(screen+'/'+theme+': link, telemetry, expand, check and mobile passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/interactions.json',JSON.stringify(rows,null,2)+'\n');
