import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const run=promisify(execFile),out=process.cwd()+'/docs/acceptance/room-residuals/interactions',rows=[];
await mkdir(out,{recursive:true});await mkdir('.runtime/room-residuals',{recursive:true});
const config=process.cwd()+'/.runtime/room-residuals/browser-config.json';await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',TZ:'Asia/Seoul'});
for(const theme of ['dark','light'])for(const screen of ['B7-churn','B8-done','B8-fail','B15','B22-room','B22-room-steps']){
 const host=await startFixtureHost(screen),session='massion-residuals-'+randomUUID().slice(0,8),stem=screen+'-'+theme;
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=process.cwd()+'/.runtime/room-residuals/browser-clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  await evaluate(`globalThis.residualCommands=0;const originalFetch=fetch;globalThis.fetch=(path,options)=>{if(path==='/protocol/request'&&JSON.parse(options.body).kind==='command')residualCommands++;return originalFetch(path,options)}`);
  for(const step of host.fixture.steps){assert.notEqual(step.action,'offline');await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  if(screen==='B7-churn'){
   const steps=await evaluate(`(()=>{const card=document.querySelector('.work-room:not([hidden])');return {rows:card.querySelectorAll('.room-steps>li').length,progress:card.querySelector('.room-progress').textContent,titles:[...card.querySelectorAll('.room-steps>li>span:nth-child(2)')].map(n=>n.textContent)}})()`);
   assert.equal(steps.rows,Number(steps.progress.split('/')[1]));assert.ok(!steps.titles.includes('이탈 원인 조사'));
  }
  if(screen.startsWith('B8')){
   assert.equal(await evaluate(`(()=>{const card=document.querySelector('.work-room:not([hidden])'),work=snapshot.value.works.find(w=>w.id===card.id.slice('work-card-'.length)),details=[...card.querySelectorAll('.room-flow details')];return details.length===work.tasks.filter(t=>t.result).length&&details.every(d=>!d.open&&!d.querySelector('pre').checkVisibility({checkVisibilityCSS:true}))})()`),true);
   const disclosure='.work-room:not([hidden]) .room-flow details';await browser('click',disclosure+' summary');
   assert.equal(await evaluate(`document.querySelector(${JSON.stringify(disclosure+' pre')}).checkVisibility({checkVisibilityCSS:true})`),true);
   await browser('screenshot',out+'/'+stem+'-result.png');await browser('click',disclosure+' summary');
  }
  if(screen==='B15')assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);
  if(screen==='B22-room'){
   assert.equal(await evaluate(`document.getElementById('pane-app').firstElementChild.textContent`),'GitHub');
   await browser('click','[id="pane-tab-intake/pr84"]');await browser('wait','.work-room:not([hidden])');
  }
  if(screen.startsWith('B22')){
   assert.equal(await evaluate(`(()=>{const people=document.querySelector('.work-room:not([hidden]) .room-people'),line=document.getElementById('work-room-handoff-pr84');return people.tagName==='UL'&&[...people.children].every(n=>n.tagName==='LI')&&line.checkVisibility({checkVisibilityCSS:true})&&people.lastElementChild.textContent==='확인'})()`),true);
   await browser('click','#pane-widen');await browser('click','#pane-widen');
  }
  for(const width of [1440,390]){
   await browser('set','viewport',String(width),'900');
   assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
   if(width===390&&screen.startsWith('B8')){
    const disclosure='.work-room:not([hidden]) .room-flow details';await browser('click',disclosure+' summary');
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);
    await browser('screenshot',out+'/'+stem+'-mobile-result.png');await browser('click',disclosure+' summary');
   }
  }
  await browser('screenshot',out+'/'+stem+'-mobile.png');
  if(screen!=='B15'){await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);}
  const commands=await evaluate('residualCommands');assert.equal(commands,0);rows.push({screen,theme,desktop:true,mobile:true,commands});console.log(stem+': passed');
 }finally{try{await browser('close');}finally{await host.close();}}
}
await writeFile(out+'/report.json',JSON.stringify(rows,null,2)+'\n');
