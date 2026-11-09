import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startFixtureHost,loadFixture} from './fixture-host.ts';
import {workbenchReady,visibleTextBudgetExpression,visibleBudgets,parseCheck} from './report.ts';
const run=promisify(execFile),session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-rooms'])).stdout.trim(),out=process.cwd()+'/'+(process.env.UI_CONTRACTS_OUTPUT||'docs/acceptance/work-telemetry/rooms'),rows=[];
await mkdir('.runtime/room-visual',{recursive:true});await mkdir(out,{recursive:true});await writeFile('.runtime/room-visual/browser-config.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const screen of ['B18','B18-room-b','B22-room-steps'])for(const theme of ['dark','light']){
 const fixture=await loadFixture(screen),stem=screen+'-'+theme,host=await startFixtureHost(fixture),contractPath=process.cwd()+'/docs/product/screens/contracts/'+screen+'.json',contract=JSON.parse(await readFile(contractPath,'utf8'));
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',process.cwd()+'/.runtime/room-visual/browser-config.json','--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=process.cwd()+'/.runtime/room-visual/clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser('wait','--fn',workbenchReady);await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
  await browser('screenshot',out+'/'+stem+'.png');const snapshot=await browser('snapshot'),rendered=await evaluate(visibleTextBudgetExpression),jsonPath=out+'/'+stem+'.snapshot.json';await writeFile(out+'/'+stem+'.snapshot.txt',snapshot.snapshot+'\n');await writeFile(jsonPath,JSON.stringify({data:{snapshot:snapshot.snapshot},visibleTextBudget:visibleBudgets(rendered,Object.keys(contract.text_budget||{}))},null,2)+'\n');
  let output;try{output=(await run(process.execPath,['scripts/ui-contracts/contract-check.mjs',jsonPath,contractPath])).stdout;}catch(error){if(error.code!==1)throw error;output=error.stdout;}await writeFile(out+'/'+stem+'.contract.txt',output);const check=parseCheck(output);
  const observed=await evaluate(`(()=>{const root=document.querySelector('.work-room:not([hidden])'),chat=document.querySelector('#chat-log');return {pane:root?.innerText||'',status:root?.querySelector('.room-status')?.innerText,people:[...root?.querySelector('.room-people')?.children||[]].map(n=>n.getAttribute('aria-label')),header:!!root?.querySelector('.room-procedure>header'),steps:[...root?.querySelectorAll('.room-steps>li')||[]].map(n=>({text:n.innerText,time:[...n.querySelectorAll('time')].map(t=>t.textContent)})),messages:[...root?.querySelectorAll('.room-worker-results article')||[]].map(n=>n.innerText),chat:chat.innerText,times:[...chat.querySelectorAll('.chat-byline time')].map(t=>({text:t.textContent,font:getComputedStyle(t).fontFamily})),caption:root?.querySelector('.room-check-detail')?.textContent,legacy:!!root?.querySelector('[id^="work-evidence-summary-"]')};})()`);
  assert.ok(observed.times.every(t=>/mono/i.test(t.font)),'Conversation timestamps use the time token');assert.doesNotMatch(observed.chat,/추론|반박|확인에 전달/);
  if(screen==='B18-room-b'){
   assert.match(observed.status,/확인 대기\s*22분/);assert.equal(observed.header,false);assert.equal(observed.steps.length,6);assert.match(observed.steps[0].text,/3\/3/);assert.match(observed.steps[1].text,/C사.*연간 요금만 공개/s);assert.match(observed.steps[2].text,/건너뜀 · 표만 요청/);assert.match(observed.steps[4].text,/대기/);assert.match(observed.steps[5].text,/다음 단계/);assert.equal(observed.messages.length,4);assert.match(observed.messages[0],/퀼.*→.*조사.*13:52/s);assert.match(observed.messages[1],/조사.*→.*퀼.*14:00/s);assert.match(observed.messages[3],/표 정리.*→.*퀼.*14:07/s);
  }
  if(screen==='B22-room-steps'){
   assert.equal(observed.header,false);assert.deepEqual(observed.people,['주노','확인']);assert.equal(observed.steps.length,4);assert.match(observed.steps[0].text,/읽기.*4\/11.*실행 중.*10:40/s);assert.match(observed.steps[1].text,/다음 단계.*절차 고침: 테스트 먼저 돌리기 · 확인 대기.*10:44/s);assert.equal(observed.caption,'');assert.match(observed.chat,/절차 고침: 테스트 먼저 돌리기 · 확인 대기.*10:44/s);assert.doesNotMatch(observed.pane,/요청한 결과와 근거 확인/);
   await browser('click','#chat-log .chat-system button');assert.equal(await evaluate('document.activeElement.classList.contains("room-step")'),true);
  }
  if(screen!=='B18'){assert.equal(observed.legacy,false);await browser('click','#pane-widen');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('click','#pane-widen');}
  await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',out+'/'+stem+'-mobile.png');
  if(screen!=='B18'){await browser('click','#pane-close');assert.equal(await evaluate('document.getElementById("work-pane").hidden'),true);}
  rows.push({screen,theme,check,observed,mobileOverflow:false});console.log(stem+': visual telemetry assertions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/interactions.json',JSON.stringify(rows,null,2)+'\n');
