import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startFixtureHost} from './fixture-host.ts';
import {readTelemetryReviewFixture} from './read-telemetry-review-fixture.ts';
import {workbenchReady} from './report.ts';

const run=promisify(execFile),out=process.cwd()+'/.runtime/read-telemetry-lead-review',rows=[];
await mkdir(out,{recursive:true});const config=out+'/browser-config.json';await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
const base=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-rn-review'])).stdout.trim();
for(const theme of ['dark','light'])for(const kind of ['pending','acknowledged','created','skipped']){
 const {fixture,workId}=await readTelemetryReviewFixture(kind),host=await startFixtureHost(fixture),session=base+'-'+theme+'-'+kind+'-'+randomUUID().slice(0,6);
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
 const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 const settle=()=>evaluate('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))');
 const capture=async name=>{await settle();await browser('screenshot',out+'/'+theme+'-'+name+'.png');await writeFile(out+'/'+theme+'-'+name+'.snapshot.txt',(await browser('snapshot')).snapshot+'\n');};
 const scrollTo=async expression=>{await evaluate(`(${expression}).scrollIntoView({block:'center'})`);await settle();};
 const bounds=expression=>evaluate(`(()=>{const el=${expression},r=el.getBoundingClientRect(),pane=document.getElementById('pane-body').getBoundingClientRect(),bar=document.querySelector('.work-room:not([hidden])>.room-inspection>summary').getBoundingClientRect();return {visible:el.checkVisibility({checkVisibilityCSS:true}),top:r.top,bottom:r.bottom,paneTop:pane.top,barTop:bar.top,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
 const inside=value=>{assert.equal(value.visible,true);assert.equal(value.overflow,false);assert.ok(value.top>=value.paneTop-1,JSON.stringify(value));assert.ok(value.bottom<=value.barTop+1,JSON.stringify(value));};
 const card=`document.querySelector('.work-room:not([hidden]) .room-grid').children[3]`;
 try{
  const clock=out+'/'+theme+'-'+kind+'-clock.js';await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  for(const step of fixture.steps){await browser('wait','--fn',workbenchReady);await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  if(kind==='pending'||kind==='acknowledged'){
   const note=await evaluate(`(()=>{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(workId)}),name=document.getElementById('work-room-member-'+w.id).textContent,note=document.querySelector('.work-room:not([hidden]) .room-step-note');return {text:note.textContent,member:name,acknowledged:w.tasks.some(t=>t.procedureEdit),conversation:document.querySelector('#chat-log .chat-step-notes').textContent}})()`);
   assert.equal(note.acknowledged,kind==='acknowledged');const status=kind==='pending'?'확인 대기':note.member+' 확인';assert.ok(note.text.includes(status));assert.ok(note.conversation.includes(status));
   await capture('step-'+kind);
   if(kind==='acknowledged'){
    await browser('click','#pane-widen');await browser('set','viewport','390','844');
    const effects=`document.querySelector('.work-room:not([hidden]) .room-grid').children[2]`;await scrollTo(effects);
    const files=await evaluate(`Array.from(document.querySelectorAll('.work-room:not([hidden]) .room-effect-file')).map(row=>{const path=row.querySelector('dt');return {path:path.textContent,title:path.title,state:row.querySelector('dd').textContent,overflow:getComputedStyle(path).textOverflow,nowrap:getComputedStyle(path).whiteSpace,truncated:path.scrollWidth>path.clientWidth,width:path.clientWidth,rowWidth:row.clientWidth}})`);
    assert.equal(files.length,5);assert.equal(new Set(files.map(f=>f.path)).size,5);assert.ok(files.every(f=>f.title===f.path&&f.overflow==='ellipsis'&&f.nowrap==='nowrap'));assert.ok(files.some(f=>f.truncated));assert.ok(files.every(f=>f.width>=f.rowWidth*0.7),JSON.stringify(files));
    const recordBounds=await bounds(card);inside(recordBounds);await capture('effects-mobile');rows.push({theme,kind,note,files,recordBounds});
   }else rows.push({theme,kind,note});
  }else{
   const expected=kind==='created'?'기록 생성':'기록 · 건너뜀',event=`Array.from(document.querySelectorAll('.work-room:not([hidden]) .room-flow>li')).find(row=>row.children[2].textContent===${JSON.stringify(expected)})`;
   const fact=await evaluate(`(()=>{const w=snapshot.value.works.find(w=>w.id===${JSON.stringify(workId)}),event=${event};return {text:event?.children[2].textContent,time:event?.querySelector('time').textContent,expectedTime:chatTime(w.record?.createdAt??w.verdict.checkedAt),record:!!w.record,acceptance:w.acceptance}})()`);
   assert.equal(fact.text,expected);assert.equal(fact.time,fact.expectedTime);assert.equal(fact.record,kind==='created');
   await scrollTo(event);const desktop=await bounds(event);inside(desktop);await capture('record-'+kind+'-desktop');
   await browser('set','viewport','390','844');await scrollTo(card);const mobileCard=await bounds(card);inside(mobileCard);await capture('record-'+kind+'-mobile-card');
   await scrollTo(event);const mobileFlow=await bounds(event);inside(mobileFlow);await capture('record-'+kind+'-mobile');rows.push({theme,kind,fact,desktop,mobileCard,mobileFlow});
  }
  console.log(theme+' '+kind+': observed state and viewport bounds passed');
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/report.json',JSON.stringify(rows,null,2)+'\n');
