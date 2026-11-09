import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {loadFixture,startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';
const run=promisify(execFile),session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-q14-selection'])).stdout.trim(),out=process.cwd()+'/docs/acceptance/q14-ui',rows=[];
await mkdir('.runtime/q14',{recursive:true});await mkdir(out,{recursive:true});await writeFile('.runtime/q14/selection-browser.json','{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]'});
for(const theme of ['dark','light']){
 const fixture=await loadFixture('B7'),snapshot=fixture.routes['/missions/intake'].body,work=snapshot.value.works[0];
 work.execution='queued';work.acceptance='pending';work.tasks=[{id:work.id+':root',parentId:null,status:'queued'}];work.effects=[];work.assignments=[];work.budget={limit:16,reserved:0,measured:0};delete work.runtimeRun;delete work.artifact;delete work.verdict;delete work.record;delete work.endedAt;
 for(const response of Object.values(fixture.routes)){if(response.body?.snapshot?.value?.id==='intake')response.body.snapshot=structuredClone(snapshot);for(const w of response.body?.works??[]){if(w.workId===work.id)Object.assign(w,{execution:'queued',acceptance:'pending',started:false,startedAt:null,endedAt:null});}for(const turn of response.body?.turns??[]){if(turn.work?.workId===work.id)Object.assign(turn.work,{execution:'queued',acceptance:'pending',started:false,startedAt:null,endedAt:null});}}
 const connections=['executor','reviewer'].map(id=>({id,label:id==='executor'?'예제 작성':'예제 확인',backend:'model-provider',providerKind:'fixture',protocol:'openai-chat-completions/v1',model:'fixture-'+id,endpoint:'http://127.0.0.1:1/v1/chat/completions',diagnostics:[],auth:{method:'none'},limits:{maxOutputTokens:8},usage:{inputTokens:'reported'}}));
 fixture.routes['/providers'].body.runtime={connections,authorizations:[{id:'fixture-grant',scope:snapshot.value.scope,mode:'mock-http',executor:[{profileId:'executor'}],verifier:[{profileId:'reviewer'}],maxOutputTokensPerCall:8}]};
 const host=await startFixtureHost(fixture),browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',process.cwd()+'/.runtime/q14/selection-browser.json','--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const r=JSON.parse(stdout);assert.ok(r.success,r.error);return r.data;},evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=process.cwd()+'/.runtime/q14/selection-clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of host.fixture.steps){await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  const selector='#work-selection-summary-'+work.id;await browser('wait',selector);
  const placement=await evaluate(`(()=>{const summary=document.querySelector(${JSON.stringify(selector)}),area=summary.parentElement,card=area.parentElement;return {inRoom:card.classList.contains('work-room'),collapsed:!area.open,afterSteps:!!(card.querySelector('.room-procedure').compareDocumentPosition(area)&Node.DOCUMENT_POSITION_FOLLOWING),beforeCheck:!!(area.compareDocumentPosition(card.querySelector('.room-inspection'))&Node.DOCUMENT_POSITION_FOLLOWING),legacy:!!card.querySelector('[id^="work-evidence-summary-"]')}})()`);
  assert.deepEqual(placement,{inRoom:true,collapsed:true,afterSteps:true,beforeCheck:true,legacy:false});await browser('screenshot',out+'/B7-selection-'+theme+'.png');
  await browser('click',selector);await browser('select','#executor-profile-'+work.id,'executor');await browser('select','#verifier-profile-'+work.id,'reviewer');await browser('select','#authorization-'+work.id,'fixture-grant');await browser('fill','#output-cap-'+work.id,'4');
  for(const width of [1440,390]){await browser('set','viewport',String(width),'900');const state=await evaluate(`(()=>{const form=document.querySelector('.work-room .execution-form');return {visible:form.checkVisibility({checkVisibilityCSS:true}),executor:form.querySelector('select').value,cap:form.querySelector('input').value,overflow:document.documentElement.scrollWidth>innerWidth}})()`);assert.deepEqual(state,{visible:true,executor:'executor',cap:'4',overflow:false});await browser('screenshot',out+'/B7-selection-'+theme+'-'+width+'.png');}
  rows.push({theme,...placement,selectionRetained:true,mobileOverflow:false});console.log(theme+': queued room selection placement and interaction passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/selection-interactions.json',JSON.stringify(rows,null,2)+'\n');
