import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startFixtureHost,loadFixture} from './fixture-host.ts';
import {workbenchReady,visibleTextBudgetExpression,visibleBudgets,parseCheck} from './report.ts';
import {applyRoom,validateRoom} from '../../src/member-rooms.ts';
import {memberProcedures} from '../../src/internal-teams.ts';
const run=promisify(execFile),session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-q14'])).stdout.trim(),out=process.cwd()+'/docs/acceptance/q14-ui',rows=[];
await mkdir('.runtime/q14',{recursive:true});await mkdir(out,{recursive:true});await writeFile('.runtime/q14/browser-config.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const screen of ['B18','B18-room-b','B22-room','B22-room-steps'])for(const theme of ['dark','light']){
 const fixture=await loadFixture(screen),work=fixture.routes['/missions/intake'].body.value.works.find(w=>w.id===(screen.startsWith('B22')?'pr84':'pricing'));
 const content='현재 요금은 월 12달러입니다.',hostActor={id:'runtime-representative',roles:['representative']},root=work.id+':root';
 work.team=memberProcedures(null,screen.startsWith('B22')?'member-juno':'member-quill');work.execution='active';work.acceptance='pending';delete work.verdict;delete work.record;
 work.artifact={id:'fixture-artifact',kind:'text',path:'fixture',version:1,sha256:createHash('sha256').update(content).digest('hex')};
 work.assignments=[];work.tasks=[{id:root,parentId:null,status:'active'}];work.effects=[];
 for(const [slot,actor] of [['executor','producer'],['challenge','challenger'],['answer','producer'],['verifier','checker']]){work.tasks.push({id:work.id+':'+slot,parentId:root,status:'settled'});work.assignments.push({id:slot,taskId:work.id+':'+slot,actorId:actor,role:slot==='verifier'?'verifier':'executor',model:{provider:'fixture',model:'small',configVersion:'v1',reason:'Fixture',evidenceClass:'fixture'},extensionVersion:'v1'});}
 applyRoom(work,{type:'open-room',workId:work.id,content,producerAssignmentId:'executor',challengerAssignmentId:'challenge'},hostActor);
 for(const [slot,output] of [['challenge',{kind:'challenge',text:'요금 변경일이 빠져 있습니다.',quote:'월 12달러'}],['answer',{kind:'concede',text:'변경일은 확인하지 못했습니다.',quote:''}]]){work.effects.push({id:slot,taskId:work.id+':'+slot,status:'succeeded',target:'fixture',authority:'fixture',receipt:JSON.stringify({status:'completed',output:JSON.stringify(output)})});applyRoom(work,{type:'record-room-turn',workId:work.id,effectId:slot},hostActor);}
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
  await browser('wait','.room-transcript');const text=await evaluate('document.querySelector(".room-transcript").textContent');assert.match(text,/반박/);assert.match(text,/추론/);assert.match(text,/월 12달러/);assert.match(text,/확인에 전달/);
  await browser('screenshot',out+'/'+stem+'-transcript.png');await browser('click','#pane-widen');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',out+'/'+stem+'-mobile.png');await browser('click','#pane-close');assert.equal(await evaluate('document.getElementById("work-pane").hidden'),true);
  rows.push({screen,theme,check,transcript:true,toggle:true,mobileOverflow:false,close:true});console.log(stem+': '+JSON.stringify(check)+'; room interactions passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/interactions.json',JSON.stringify(rows,null,2)+'\n');
