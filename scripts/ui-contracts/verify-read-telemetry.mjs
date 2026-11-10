import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const run=promisify(execFile),out=process.cwd()+'/.runtime/read-telemetry-interactions',rows=[];
await mkdir(out,{recursive:true});const config=out+'/browser-config.json';await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
const base=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-rn'])).stdout.trim();
for(const theme of ['dark','light']){
 const host=await startFixtureHost('B22-room'),session=base+'-'+theme+'-'+randomUUID().slice(0,6);
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=out+'/clock-'+theme+'.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser('wait','--fn',workbenchReady);await browser(step.action,step.selector);if(step.readySelector)await browser('wait',step.readySelector);}
  const statuses=await evaluate(`[...document.querySelectorAll('#pane-app .app-file-read')].map(n=>n.textContent)`);assert.deepEqual(statuses,['읽음','읽음','읽음','읽음','읽는 중']);
  const work=await evaluate(`(()=>{const tab=paneTabs.find(t=>t.key===paneActive),w=snapshot.value.works.find(w=>w.id===tab.appTab.workId);return {id:w.id,pinned:w.team.procedures[0].body.steps,original:w.tasks.find(t=>t.procedureEdit).step.title,applied:w.tasks.find(t=>t.procedureEdit).procedureEdit.title}})()`);
  assert.deepEqual(work.pinned,['읽기','테스트 돌리기']);assert.equal(work.original,'테스트 돌리기');assert.equal(work.applied,'테스트 먼저 돌리기');
  assert.equal(await evaluate(`!!document.querySelector('#chat-log .chat-step-notes .chat-reply .chat-copy')`),true);
  await browser('screenshot',out+'/'+theme+'-files.png');await writeFile(out+'/'+theme+'-files.snapshot.txt',(await browser('snapshot')).snapshot+'\n');
  await browser('click','#chat-log .chat-step-notes .chat-system button');await browser('wait','--fn',`paneActive===${JSON.stringify('intake/'+work.id)}&&!loading`);
  assert.equal(await evaluate(`document.activeElement.id`),'work-step-'+work.id+'-'+work.id+':step:1');
  await browser('screenshot',out+'/'+theme+'-steps.png');await browser('click','#pane-widen');assert.equal(await evaluate(`document.getElementById('app').classList.contains('wide')`),true);
  await browser('set','viewport','390','844');assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);await browser('screenshot',out+'/'+theme+'-mobile.png');
  await browser('set','viewport','1440','900');await browser('click','#pane-widen');await browser('click',`[id="pane-tab-app:app-github:84:intake/${work.id}"]`);await browser('wait','#pane-app h2');
  await evaluate(`(async()=>{const OriginalDate=Date,deadline=snapshot.value.works.find(w=>w.id===${JSON.stringify(work.id)}).runtimeRun.ownership.deadlineAt;globalThis.Date=class extends OriginalDate{static now(){return deadline+1}};await appsTabLoad(paneTabs.find(t=>t.key===paneActive));})()`);
  const expired=await evaluate(`[...document.querySelectorAll('#pane-app .app-file-read')].map(n=>n.textContent)`);assert.deepEqual(expired,['읽음','읽음','읽음','읽음','결과 모름']);
  rows.push({theme,statuses,expired,pinned:work.pinned,original:work.original,applied:work.applied,noteNavigation:true,mobileOverflow:false});console.log(theme+': file receipts, acknowledgement, note navigation, wide/mobile and deadline passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/report.json',JSON.stringify(rows,null,2)+'\n');
