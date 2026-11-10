import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {startFixtureHost} from './fixture-host.ts';
import {workbenchReady} from './report.ts';
import {evidenceBrowser} from '../browser-evidence.mjs';
const run=promisify(execFile),out=resolve('.runtime/browser-interactions');await mkdir(out,{recursive:true});
const session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-browser-rb'])).stdout.trim(),config=out+'/browser.json';await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000',TZ:'Asia/Seoul'});
const rows=[];
for(const screen of ['B4','B15','B7'])for(const theme of ['dark','light']){
 const host=await startFixtureHost(screen),browser=evidenceBrowser(async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:2e6});const r=JSON.parse(stdout);assert.ok(r.success,r.error);return r.data;}),evaluate=async code=>(await browser('eval','-b',Buffer.from(code).toString('base64'))).result;
 try{
  const clock=out+'/clock.js';await writeFile(clock,`{const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[${host.fixture.now}]))}static now(){return ${host.fixture.now}}}}`);
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);
  await evaluate(`globalThis.browserCommands=0;const original=fetch;globalThis.fetch=(p,o)=>{if(p==='/protocol/request'&&JSON.parse(o.body).kind==='command')browserCommands++;return original(p,o)}`);
  for(const step of host.fixture.steps){await browser(step.action,step.selector,...(step.action==='fill'?[step.value]:[]));if(step.readySelector)await browser('wait',step.readySelector);}
  if(screen==='B7'){
   const evidence=await evaluate(`Array.from(document.querySelectorAll('.work-room:not([hidden]) .browser-read-steps li')).map(row=>row.innerText)`);assert.equal(evidence.length,2);assert.match(evidence[0],/지난 주문[\s\S]*shop.example.com/);assert.match(evidence[1],/상품 정보[\s\S]*shop.example.com/);
   for(const width of [1440,390]){await browser('set','viewport',String(width),'900');const layout=await evaluate(`(()=>{const row=document.querySelector('.work-room:not([hidden]) .room-browser'),[time,count,button]=[...row.children].map(e=>e.getBoundingClientRect());return {separated:time.right+4<=count.left&&count.right+4<=button.left,chat:document.getElementById('chat-log').innerText,overflow:document.documentElement.scrollWidth>innerWidth}})()`);assert.equal(layout.separated,true);assert.equal(layout.overflow,false);assert.match(layout.chat,/작업 중 · 페이지 2개 읽음/);rows.push({screen,theme,width,separated:true});await browser('screenshot',out+'/'+screen+'-'+theme+'-'+width+'.png');}
   continue;
  }
  if(screen==='B4'){
   await browser('wait','.browser-structure');const state=await evaluate(`({image:!!document.getElementById('browser-screenshot'),domain:document.getElementById('browser-address').textContent,text:document.querySelector('.browser-structure').innerText,commands:browserCommands})`);assert.equal(state.image,false);assert.equal(state.domain,'shop.example.com');assert.match(state.text,/레이저 토너 검정/);assert.match(state.text,/이미지는 작업 후 보관하지 않아요/);assert.match(state.text,/결제 수단[\s\S]*••••[\s\S]*가림/);assert.equal(state.commands,0);for(const width of [1440,390]){await browser('set','viewport',String(width),'900');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);rows.push({screen,theme,width,image:false,structural:true});await browser('screenshot',out+'/'+screen+'-'+theme+'-'+width+'.png');}continue;
  }
  await browser('wait','#browser-screenshot');await browser('wait','--fn','document.getElementById("browser-screenshot").complete && document.getElementById("browser-screenshot").naturalWidth>0');
  const count=await evaluate(`document.querySelectorAll('#pane-tabs [role=tab]').length`);assert.equal(count,screen==='B15'?3:1);
  for(let index=0;index<count;index++){
   await browser('click','#browser-page-tab-'+index);await browser('wait','--fn','document.getElementById("browser-screenshot").complete && document.getElementById("browser-screenshot").naturalWidth>0');
   const page=await evaluate(`(()=>{const p=document.getElementById('pane-effect'),img=document.getElementById('browser-screenshot'),r=img.getBoundingClientRect(),address=document.getElementById('browser-address');return {domain:address.textContent,image:img.src.startsWith('data:image/png;base64,'),pixels:[img.naturalWidth,img.naturalHeight],rect:[r.x,r.y,r.width,r.height],imageOnly:!p.querySelector('input,textarea,select,iframe,form,script'),hiddenAlternative:getComputedStyle(document.getElementById('browser-page-alternative')).position==='absolute',commands:browserCommands}})()`);assert.equal(page.image,true);assert.deepEqual(page.pixels,[584,764]);assert.equal(page.rect[0],848);assert.equal(page.rect[2],584);assert.ok(page.rect[1]>128);assert.equal(page.imageOnly,true);assert.equal(page.hiddenAlternative,true);assert.equal(page.commands,0);assert.equal(page.domain,screen==='B15'?'library.example.com':'shop.example.com');rows.push({screen,theme,index,...page});await browser('screenshot',out+'/'+screen+'-'+theme+'-'+index+'.png');
  }
  if(screen==='B15'){await browser('press','ArrowLeft');assert.equal(await evaluate(`document.getElementById('browser-page-tab-1').getAttribute('aria-selected')`),'true');}
  assert.equal(await evaluate(`JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)]).includes(document.getElementById('browser-screenshot').src.slice('data:image/png;base64,'.length))`),false);
  const active=await evaluate('paneActive'),work=screen==='B15'?'library':'toner';await browser('click','[id="side-line-intake/'+work+'"]');await browser('wait','--fn',workbenchReady);await evaluate('snapshot.revision++;renderShell()');await browser('click','[id="pane-tab-'+active+'"]');await browser('wait','#browser-screenshot');
  await browser('set','viewport','390','844');assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await browser('screenshot',out+'/'+screen+'-'+theme+'-mobile.png');await browser('click','#pane-close');assert.equal(await evaluate(`document.getElementById('work-pane').hidden`),true);assert.equal(await evaluate('browserCommands'),0);
 }finally{await browser('close');await host.close();}
}
await writeFile(out+'/report.json',JSON.stringify(rows,null,2)+'\n');console.log('Screenshot images, domain pills, tabs, B7 telemetry spacing, mobile and close verified:',rows.length,'states');
