import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startFixtureHost,loadFixture} from '../../scripts/ui-contracts/fixture-host.ts';
import {workbenchReady,visibleTextBudgetExpression,visibleBudgets,parseCheck} from '../../scripts/ui-contracts/report.ts';
import {validateTeamProcedure} from '../../src/internal-teams.ts';
const run=promisify(execFile),session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-q13'])).stdout.trim(),out=process.cwd()+'/docs/acceptance/q13-ui',rows=[];
await mkdir('.runtime/q13',{recursive:true});await mkdir(out,{recursive:true});
await writeFile('.runtime/q13/browser-config.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const [screen,theme] of [['B7-teams','dark'],['B7-teams','light'],['B8-teams','dark']]){
 const base=await loadFixture('B7-churn'),team=JSON.parse(await readFile('tests/fixtures/internal-teams/B7-teams.json','utf8')),expanded=screen==='B8-teams'?JSON.parse(await readFile('tests/fixtures/internal-teams/B8-teams.json','utf8')):{};
 const fixture={...base,...team,...expanded,routes:{...base.routes,...team.routes,...expanded.routes}};
 const stem=screen+'-'+theme,host=await startFixtureHost(fixture),contractPath=process.cwd()+'/docs/product/screens/contracts/B7-churn.json',contract=JSON.parse(await readFile(contractPath,'utf8'));
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',process.cwd()+'/.runtime/q13/browser-config.json','--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 const work=host.fixture.routes['/missions/intake'].body.value.works[0];validateTeamProcedure(work.team,work.assistantSource.memberId);
 try{
  const clock=process.cwd()+'/.runtime/q13/browser-clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport',String(contract.viewport.width),String(contract.viewport.height));await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser('wait','--fn',workbenchReady);await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  await browser('wait','.work-room');await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
  assert.equal(await evaluate('Date.now()'),host.fixture.now);assert.equal(await evaluate(`matchMedia('(prefers-color-scheme: ${theme})').matches`),true);
  await evaluate(`globalThis.q13Commands=0;const q13Fetch=globalThis.fetch;globalThis.fetch=(path,options)=>{if(path==='/protocol/request'&&JSON.parse(options.body).kind==='command')q13Commands++;return q13Fetch(path,options)}`);
  const state=await evaluate(`(()=>{const card=document.querySelector('.work-room:not([hidden])'),wide=document.getElementById('app').classList.contains('wide'),list=card.querySelector(wide?'.room-flow':'.room-steps'),result=card.querySelector('.room-worker-results');return {wide,people:[...card.querySelector('.room-people').children].map(n=>n.textContent),text:list.textContent,results:result?.textContent,rows:list.querySelectorAll('li').length,flat:[...card.querySelectorAll('.room-steps li')].every(n=>[...n.children].every(c=>c.children.length===0)),resultAfterProcedure:!!(card.querySelector('.room-procedure').compareDocumentPosition(result)&Node.DOCUMENT_POSITION_FOLLOWING),duration:card.querySelector('.room-status time').textContent,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
  assert.deepEqual(state.people,['퀼퀼','조사','분류','설문','요약','확인']);assert.equal(state.flat,true);assert.equal(state.resultAfterProcedure,true);
  assert.equal(state.duration,'4분');assert.match(state.results,/퀼.*조사.*지난 90일 해지 41건/);
  if(state.wide)assert.match(state.text,/해지 내역 수집.*퀼.*조사.*지난 90일 해지 41건/);else assert.doesNotMatch(state.text,/퀼|지난 90일 해지 41건/);
  assert.match(state.text,/건너뜀 · 기존 설문 활용/);assert.doesNotMatch(state.text,/Skipped/);assert.match(state.text,/선행 단계 · 고객 분류/);assert.equal(state.overflow,false);
  await browser('screenshot',out+'/'+stem+'.png');const snapshot=await browser('snapshot');await writeFile(out+'/'+stem+'.snapshot.txt',snapshot.snapshot+'\n');
  const rendered=await evaluate(visibleTextBudgetExpression),visibleTextBudget=visibleBudgets(rendered,Object.keys(contract.text_budget||{}));
  const jsonPath=out+'/'+stem+'.snapshot.json';await writeFile(jsonPath,JSON.stringify({data:{snapshot:snapshot.snapshot},visibleTextBudget},null,2)+'\n');
  let check=null;
  if(screen==='B7-teams'){
   let output;try{output=(await run(process.execPath,['scripts/ui-contracts/contract-check.mjs',jsonPath,contractPath])).stdout;}catch(error){if(error.code!==1)throw error;output=error.stdout;}
   await writeFile(out+'/'+stem+'.contract.txt',output);check={contract:'B7-churn',...parseCheck(output),budgetFailures:output.split('\n').filter(line=>/^  FAIL  budget /.test(line)),forbiddenFailures:output.split('\n').filter(line=>/^  FAIL  forbidden /.test(line))};
   assert.deepEqual(check.budgetFailures,[]);assert.deepEqual(check.forbiddenFailures,[]);
  }
  await browser('click','.room-inspection > summary');assert.equal(await evaluate(`document.querySelector('.work-room:not([hidden]) > .room-inspection').open`),true);await browser('screenshot',out+'/'+stem+'-inspection.png');
  await browser('click','.room-inspection > summary');await browser('click','#pane-widen');assert.equal(await evaluate(`document.getElementById('app').classList.contains('wide')`),!state.wide);
  await browser('set','viewport','390','844');assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false);await browser('screenshot',out+'/'+stem+'-mobile.png');
  await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate(`q13Commands`),0);
  rows.push({screen,theme,now:host.fixture.now,...state,check,scope:check?'Matching B7-churn contract':'B8 structural and interaction check only; no printer contract comparison',inspection:true,toggle:true,mobileOverflow:false,commands:0,fixture:'tests/fixtures/internal-teams/'+screen+'.json'});
  console.log(stem+': '+JSON.stringify(check||{structural:true})+'; interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/interactions.json',JSON.stringify(rows,null,2)+'\n');
