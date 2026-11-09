import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startFixtureHost,loadFixture} from './fixture-host.ts';
import {workbenchReady,visibleTextBudgetExpression,visibleBudgets,parseCheck} from './report.ts';
import {applyRoom,validateRoom} from '../../src/member-rooms.ts';
import {memberProcedures} from '../../src/internal-teams.ts';
import {hash} from '../../src/domain.ts';
const run=promisify(execFile),session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-q14'])).stdout.trim(),out=process.cwd()+'/'+(process.env.UI_CONTRACTS_OUTPUT||'docs/acceptance/q14-ui'),rows=[];
await mkdir('.runtime/q14',{recursive:true});await mkdir(out,{recursive:true});await writeFile('.runtime/q14/browser-config.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const screen of ['B18','B18-room-b','B22-room','B22-room-steps'])for(const theme of ['dark','light']){
 const fixture=await loadFixture(screen),target=fixture.steps.findLast(s=>s.readySelector?.startsWith('#work-heading-'))?.readySelector.slice('#work-heading-'.length)??'pricing',work=fixture.routes['/missions/intake'].body.value.works.find(w=>w.id===target);
 const coding=screen.startsWith('B22'),content=coding?'테스트 1개 통과':'월 12달러',hostActor={id:'runtime-representative',roles:['representative']},root=work.id+':root';
 work.team=memberProcedures(null,screen.startsWith('B22')?'member-juno':'member-quill');work.execution='active';work.acceptance='pending';delete work.verdict;delete work.record;
 work.artifact={id:'fixture-artifact',kind:'text',path:'fixture',version:1,sha256:createHash('sha256').update(content).digest('hex')};
 const workers=work.tasks.filter(t=>t.step);if(!workers.length)for(const [i,title] of ['출처 확인','가격 정리'].entries())workers.push({id:work.id+':step:'+i,parentId:work.id+':executor',status:i?'active':'settled',step:{title,role:i?'정리':'조사',dependsOn:[]}});work.team.procedures[0].body.steps=workers.map(t=>t.step.title);work.team.procedures[0].hash=hash(work.team.procedures[0].body);work.assignments=[];work.tasks=[{id:root,parentId:null,status:'active'},...workers];work.effects=[];
 for(const [slot,actor] of [['executor','producer'],['challenge','challenger'],['answer','producer'],['verifier','checker']]){work.tasks.push({id:work.id+':'+slot,parentId:root,status:slot==='verifier'?'queued':'active'});work.assignments.push({id:slot,taskId:work.id+':'+slot,actorId:actor,role:slot==='verifier'?'verifier':'executor',model:{provider:'fixture',model:'small',configVersion:'v1',reason:'Fixture',evidenceClass:'fixture'},extensionVersion:'v1'});}
 applyRoom(work,{type:'open-room',workId:work.id,content,producerAssignmentId:'executor',challengerAssignmentId:'challenge'},hostActor,fixture.now-120000);
 for(const [slot,output] of [['challenge',{kind:'challenge',text:coding?'변경 파일 테스트 누락':'요금 변경일 누락',quote:content}],['answer',{kind:'concede',text:coding?'변경 파일 테스트 미확인':'변경일 미확인',quote:''}]]){work.effects.push({id:slot,taskId:work.id+':'+slot,status:'succeeded',target:'fixture',authority:'fixture',receipt:JSON.stringify({status:'completed',output:JSON.stringify(output)})});applyRoom(work,{type:'record-room-turn',workId:work.id,effectId:slot},hostActor,fixture.now-(slot==='challenge'?60000:30000));}
 validateRoom(work);for(const route of Object.values(fixture.routes)){const snapshot=route.body?.snapshot;if(snapshot?.value?.id==='intake')snapshot.value=structuredClone(fixture.routes['/missions/intake'].body.value);}
 const stem=screen+'-'+theme,host=await startFixtureHost(fixture),contractPath=process.cwd()+'/docs/product/screens/contracts/'+screen+'.json',contract=JSON.parse(await readFile(contractPath,'utf8'));
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',process.cwd()+'/.runtime/q14/browser-config.json','--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const r=JSON.parse(stdout);assert.ok(r.success,r.error);return r.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=process.cwd()+'/.runtime/q14/clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser('wait','--fn',workbenchReady);await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  await evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
  await browser('screenshot',out+'/'+stem+'.png');const snapshot=await browser('snapshot'),rendered=await evaluate(visibleTextBudgetExpression),jsonPath=out+'/'+stem+'.snapshot.json';await writeFile(out+'/'+stem+'.snapshot.txt',snapshot.snapshot+'\n');await writeFile(jsonPath,JSON.stringify({data:{snapshot:snapshot.snapshot},visibleTextBudget:visibleBudgets(rendered,Object.keys(contract.text_budget||{}))},null,2)+'\n');
  let output;try{output=(await run(process.execPath,['scripts/ui-contracts/contract-check.mjs',jsonPath,contractPath])).stdout;}catch(error){if(error.code!==1)throw error;output=error.stdout;}await writeFile(out+'/'+stem+'.contract.txt',output);const check=parseCheck(output);
  if(screen==='B18')await browser('click','[id="chat-card-assistant-turn:m:pricing"] .chat-card-open');
  if(screen==='B22-room')await browser('click','[id="pane-tab-intake/pr84"]');
  await browser('wait','#chat-log .room-transcript');const text=await evaluate('document.querySelector("#chat-log .room-transcript").textContent');assert.match(text,/반박/);assert.match(text,/추론/);assert.ok(text.includes(content));assert.match(text,/확인에 전달/);assert.equal(await evaluate('document.querySelectorAll("#chat-log .room-transcript article .chat-byline time").length>=3'),true);
  const pane=await evaluate(`(()=>{const root=document.querySelector('.work-room:not([hidden])');return {text:root.innerText,transcript:!!root.querySelector('.room-transcript'),legacy:!!root.querySelector('[id^="work-evidence-summary-"]'),steps:[...root.querySelectorAll('.room-steps li')].map(n=>n.children[1].textContent),stop:!!root.querySelector('.room-stop'),inspectionOpen:root.querySelector('.room-inspection').open}})()`);
  assert.equal(pane.transcript,false);assert.equal(pane.legacy,false);assert.equal(pane.inspectionOpen,false);assert.equal(pane.stop,true);assert.doesNotMatch(pane.text,/추론|pr84|실행: active|검증: pending|시도 \/ 예산|측정 사용량|기준·기억·근거|선택한 원문 문서|원래 조직 역할/);if(coding)assert.deepEqual(pane.steps,['읽기','테스트 돌리기','확인','기록']);
  await browser('screenshot',out+'/'+stem+'-transcript.png');await browser('click','#pane-widen');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',out+'/'+stem+'-mobile.png');await browser('click','#pane-close');assert.equal(await evaluate('document.getElementById("work-pane").hidden'),true);
  rows.push({screen,theme,check,pane,transcriptInConversation:true,toggle:true,mobileOverflow:false,close:true});console.log(stem+': '+JSON.stringify(check)+'; room interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/interactions.json',JSON.stringify(rows,null,2)+'\n');
