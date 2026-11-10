#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

const run=promisify(execFile),out=resolve(process.env.UI_CONTRACTS_OUTPUT||'.runtime/result-facts-interactions'),rows=[];
await mkdir(out,{recursive:true});const runtime=resolve('.runtime/result-facts-browser');await mkdir(runtime,{recursive:true});const config=join(runtime,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',TZ:'Asia/Seoul'});
const sessionRoot=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-facts'],{env})).stdout.trim();
for(const theme of ['dark','light'])for(const screen of ['B9','B7-done','B7-fail','B8-done','B8-fail']){
 const host=await startFixtureHost(screen),session=sessionRoot+'-'+screen.toLowerCase()+'-'+theme,stem=screen+'-'+theme;
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=join(runtime,stem+'-clock.js');await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  await evaluate(`globalThis.factCommands=0;const originalFetch=globalThis.fetch;globalThis.fetch=(path,options)=>{if(path==='/protocol/request'&&JSON.parse(options.body).kind==='command')factCommands++;return originalFetch(path,options)}`);
  for(const step of host.fixture.steps){await browser('click',step.selector);if(step.readySelector)await browser('wait',step.readySelector);}
  const summary=await evaluate(`document.getElementById('activity-list').innerText`);
  if(screen==='B9'){
   assert.match(summary,/해지 사유 41건을 기업 9건, 그 외 32건으로 나눴어요/);assert.match(await evaluate(`document.getElementById('chat-log').innerText`),/나누기 완료 · 원인 정리 중/);
   await browser('click','#header-profile');const work=host.fixture.routes['/missions/intake'].body.value.works.find(w=>w.title==='이탈 원인 조사');await browser('click','[id="activity-row-intake/'+work.id+'"]');
  }else assert.match(summary,/요금제 6개를 표 1개로 정리했어요. 확인 대기예요./);
  if(['B7-fail','B8-fail'].includes(screen)){
   assert.match(summary,/기업 고객 원인 1개가 근거 2건이에요/);assert.equal(host.fixture.routes['/missions/intake'].body.value.works.find(w=>w.title==='이탈 원인 조사').record,undefined);
   assert.doesNotMatch(await evaluate(`document.querySelector('.work-room:not([hidden])').innerText`),/massion-facts/);
  }
  if(await evaluate(`document.getElementById('app').classList.contains('wide')`))await browser('click','#pane-widen');
  await browser('wait','.work-room');await evaluate('document.fonts.ready');await browser('screenshot',join(out,stem+'-compact.png'));await writeFile(join(out,stem+'.snapshot.txt'),(await browser('snapshot')).snapshot+'\n');
  await browser('click','#pane-widen');assert.equal(await evaluate(`document.getElementById('app').classList.contains('wide')`),true);await browser('screenshot',join(out,stem+'-expanded.png'));
  const flow=await evaluate(`(()=>{const list=document.querySelector('.work-room:not([hidden]) .room-flow');return {alignment:[...list.querySelectorAll('.room-worker')].map(worker=>{const title=worker.querySelector('.room-worker-identity').firstElementChild,time=worker.closest('li').querySelector('time');return {title:title.textContent,delta:Math.abs(title.getBoundingClientRect().top-time.getBoundingClientRect().top)}}),summaries:[...list.querySelectorAll('summary')].map(n=>({text:n.textContent,nativeMarker:getComputedStyle(n,'::-webkit-details-marker').display,marker:getComputedStyle(n).listStyleType,chevron:n.querySelector('.room-flow-chevron')?.getBoundingClientRect().width??0})),first:[...list.children].findIndex(n=>n.querySelector('details'))+1}})()`);
  if(screen.startsWith('B8-')){await evaluate(`document.querySelector('.room-flow-section').scrollIntoView({block:'start'})`);await browser('screenshot',join(out,stem+'-flow.png'));}
  assert.ok(flow.alignment.every(row=>row.delta<=2),JSON.stringify(flow.alignment));assert.ok(flow.summaries.every(row=>row.marker==='none'&&row.chevron>=10),JSON.stringify(flow.summaries));assert.ok(flow.summaries.every(row=>!['프린터 토너 주문','작성','확인'].includes(row.text)));
  if(flow.first){const selector='.room-flow > li:nth-child('+flow.first+') details';assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).open`),false);await browser('click',selector+' > summary');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).open`),true);await browser('press','Enter');assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).open`),false);}

  await browser('click','#pane-widen');await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',join(out,stem+'-mobile.png'));
  if(screen.startsWith('B8-')){await browser('click','#pane-widen');await evaluate(`document.querySelector('.room-flow-section').scrollIntoView({block:'start'})`);assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',join(out,stem+'-mobile-flow.png'));}
  await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate('factCommands'),0);
  rows.push({screen,theme,summary,flow,desktop:true,expanded:true,mobile:true,closed:true,commands:0});console.log(stem+': business summaries and pane interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(join(out,'interactions.json'),JSON.stringify(rows,null,2)+'\n');
