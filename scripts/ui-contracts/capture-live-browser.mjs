import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:https';
import {readFile,writeFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Application} from '../../src/application.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {BrowserSessions,browserSummary} from '../../src/browser-runtime.ts';
import {localBrowserAdapter} from '../../src/headless-browser.ts';
import {loadFixture,startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';

// 합성 로컬 페이지의 앱 화면만 저장합니다. 일반 증거 경로에는 이 예외를 적용하지 않습니다.
const exec=promisify(execFile),root=await mkdtemp(join(tmpdir(),'massion-live-evidence-')),out=resolve('.runtime/browser-live-fixture'),pagesRoot=new URL('./browser-pages/',import.meta.url),originalPath=process.env.PATH,realBrowser=(await exec('which',['agent-browser'])).stdout.trim();
const session='massion-live-evidence-'+randomUUID(),extra=process.env.MASSION_E2E_BROWSER?['--executable-path',process.env.MASSION_E2E_BROWSER]:[],config=join(root,'ui.json'),rows=[],requested=[];
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_NO_VERSION_CHECK:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000',TZ:'Asia/Seoul'});
let source,service;
const browser=async(...args)=>{try{const {stdout}=await exec(realBrowser,['--config',config,'--session',session,'--headed','false','--allowed-domains','127.0.0.1','--json',...extra,...args],{env,timeout:45000,maxBuffer:512*1024});const r=JSON.parse(stdout);if(!r.success)throw Error();return r.data;}catch{throw Error('Synthetic evidence browser command failed: '+args[0]);}};
const evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
try{
 await mkdir(out,{recursive:true});await writeFile(config,'{}\n');
 await exec('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1']);
 const files=new Map(await Promise.all(['library-guide.html','library-availability.html','library-form.html','page.css'].map(async name=>[name,await readFile(new URL(name,pagesRoot))])));
 source=createServer({key:await readFile(join(root,'key.pem')),cert:await readFile(join(root,'cert.pem'))},(req,res)=>{const name=req.url.slice(1),body=files.get(name);if(!body){res.writeHead(404);res.end();return;}requested.push(name);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(body);});await new Promise(r=>source.listen(0,'127.0.0.1',r));
 // 자체 서명 인증서 예외는 이 임시 테스트 실행 파일에만 존재합니다.
 await writeFile(join(root,'agent-browser'),'#!'+process.execPath+'\nconst {spawnSync}=require("node:child_process");const r=spawnSync('+JSON.stringify(realBrowser)+',[...process.argv.slice(2),"--ignore-https-errors",...'+JSON.stringify(extra)+'],{stdio:"inherit"});process.exit(r.status??1);\n',{mode:0o700});process.env.PATH=root+':'+originalPath;
 const origin='https://127.0.0.1:'+source.address().port,adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:origin}),template=await loadFixture('B15'),store=new InMemoryStore(),app=new Application(store,[{id:'local-owner',roles:['owner']},{id:'reader',roles:['executor']}],()=>clock);
 const mission=(template.routes['/read-state?mission=intake'].body).snapshot.value;let sequence=0,clock=template.now-180000;
 await app.create({id:'intake',purpose:mission.purpose,scope:mission.scope,constraints:mission.constraints,criteria:mission.criteria},'local-owner','create');
 const send=async(command,actorId='local-owner')=>{const result=await app.dispatch({missionId:'intake',expectedRevision:(await store.load('intake')).revision,commandId:'evidence-'+(++sequence),actorId,command});assert.equal(result.status,'committed');};
 await send({type:'admit-work',workId:'library',title:'스터디룸 신청',budget:1});await send({type:'assign',workId:'library',assignment:{id:'reader',actorId:'reader',role:'executor',taskId:'library:root',model:{provider:'fixture',model:'deterministic',configVersion:'v1',reason:'Synthetic local page observation',evidenceClass:'fixture'},extensionVersion:'v1'}});await send({type:'admit-effect',workId:'library',effect:{id:'read',taskId:'library:root',status:'pending',target:'Synthetic local HTTPS pages',authority:'Read only'},reserve:0},'reader');
 service=new BrowserSessions(store,store,{adapter,clock:()=>clock});for(const [index,name] of ['library-guide','library-availability','library-form'].entries()){clock+=60000;assert.equal((await service.capture({missionId:'intake',workId:'library',readId:'synthetic:'+index,address:origin+'/'+name+'.html'})).status,'committed');}
 assert.ok(['library-guide.html','library-availability.html','library-form.html','page.css'].every(name=>requested.includes(name)));
 for(const phase of ['live','ended']){
  if(phase==='ended'){await send({type:'receipt',workId:'library',effectId:'read',outcome:'succeeded',receipt:'Synthetic page reads completed',usage:0},'reader');await send({type:'settle-task',workId:'library',taskId:'library:root',result:'Read-only observation complete'},'reader');}
  const observed=await service.read('intake','library'),stored=await store.load('intake'),work=stored.value.works[0];assert.equal(Boolean(observed.session.page.screenshot),phase==='live');assert.ok(!JSON.stringify(store.inspect()).includes('iVBORw0KGgo'));
  const fixture=structuredClone(template);for(const [path,response] of Object.entries(fixture.routes))if(path.startsWith('/assistant/conversation')){response.body.decisions=[];for(const message of response.body.segment?.messages||[])if(message.id==='r:library')message.text='도서관 안내와 신청 페이지를 읽었어요.';}const snapshot=fixture.routes['/read-state?mission=intake'].body.snapshot;snapshot.revision=stored.revision;snapshot.value.works=snapshot.value.works.map(w=>w.id==='library'?work:w);fixture.routes['/missions/intake'].body=structuredClone(snapshot);
  for(const row of fixture.routes['/assistant/works'].body.works){row.missionRevision=stored.revision;if(row.workId==='library')Object.assign(row,{execution:work.execution,acceptance:work.acceptance,browser:browserSummary(work)});}
  fixture.routes['/missions/intake/works/library/browser']={status:200,body:{...observed,feedId:fixture.routes['/events'].body.feedId}};
  const clockFile=join(root,'clock.js');await writeFile(clockFile,`{const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${template.now}]))}static now(){return ${template.now}}}}`);const host=await startFixtureHost(fixture);try{for(const theme of ['dark','light']){
   await browser('close');await browser('--color-scheme',theme,'open','--init-script',clockFile);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
   for(const step of fixture.steps){await browser(step.action,step.selector);if(step.readySelector)await browser('wait',step.readySelector);}
   await browser('wait',phase==='live'?'#browser-screenshot':'.browser-structure');if(phase==='live')await browser('wait','--fn','document.getElementById("browser-screenshot").naturalWidth>0');
   for(const width of [1440,390]){await browser('set','viewport',String(width),'900');const state=await evaluate(`(()=>{const image=document.getElementById('browser-screenshot'),card=document.getElementById('browser-page');return {image:!!image&&image.complete&&image.naturalWidth===584,domain:document.getElementById('browser-address').textContent,steps:document.querySelectorAll('#pane-effect>.browser-read-steps li').length,notice:getComputedStyle(document.getElementById('browser-page-alternative')).position!=='absolute'&&card.innerText.includes('비공개 입력값이 있어 상세 내용은 보관하지 않아요.'),overflow:document.documentElement.scrollWidth>innerWidth,persisted:JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes('iVBORw0KGgo')}})()`);assert.equal(state.image,phase==='live');assert.equal(state.domain,'127.0.0.1');assert.equal(state.steps,3);assert.equal(state.overflow,false);assert.equal(state.persisted,false);assert.equal(state.notice,phase==='ended');
    // 유일한 이미지 포함 증거 경로: 위에서 만든 합성 페이지와 실제 어댑터 관찰만 사용합니다.
    const filename=phase+'-'+theme+'-'+width+'.png';await browser('screenshot',join(out,filename));rows.push({phase,theme,width,filename,...state});}
  }}finally{await browser('close');await host.close();}
 }
 const restarted=new BrowserSessions(store,store);assert.equal((await restarted.read('intake','library')).session.page.screenshot,undefined);await restarted.drain();await writeFile(join(out,'report.json'),JSON.stringify({adapter:'localBrowserAdapter',syntheticLocalOnly:true,readOnly:true,standalonePageImagesWritten:0,journalHasNoImage:true,restartHasNoImage:true,rows},null,2)+'\n');console.log('Synthetic real-adapter live and ended panes verified:',rows.length,'states');
}finally{process.env.PATH=originalPath;await browser('close').catch(()=>{});await service?.drain();if(source)await new Promise(r=>source.close(r));await rm(root,{recursive:true,force:true});}
