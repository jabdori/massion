import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request} from 'node:http';
import {once} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appFrameClient} from '../../src/app-frame.ts';
import {createAppDocumentHost} from '../../src/app-documents.ts';
import {createBrowserNetwork} from './browser-network.mjs';
import {browserCommand} from './browser-command.mjs';

test('native loopback controls preserve isolated app execution and reject proxy traffic',{timeout:60000},async()=>{
 const run=promisify(execFile),root=await mkdtemp(join(tmpdir(),'massion-frame-network-')),host=createAppDocumentHost(),network=await createBrowserNetwork();
 const session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-frame-network'])).stdout.trim();
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]'});
 const config=join(root,'browser.json');await writeFile(config,JSON.stringify({...network.config,...(process.env.MASSION_E2E_BROWSER?{executablePath:process.env.MASSION_E2E_BROWSER}:{})}));
 const browser=(...args)=>browserCommand(()=>run('agent-browser',['--config',config,'--session',session,'--json',...args],{env,timeout:35000,maxBuffer:4e6}));
 const url=await host.publish(`<!doctype html><p id="probe">waiting</p><script>
try{parent.document.body.dataset.escaped='true';}catch{}
fetch('http://127.0.0.1:1/').then(()=>{},()=>{document.getElementById('probe').textContent='network blocked';parent.postMessage({type:'resize',height:617},'*');});
</script>`);
 const hosts=[],server=createServer((req,res)=>{hosts.push(req.headers.host);res.setHeader('Content-Type','text/html');res.end(`<button id="open">Open</button><div id="app-view"></div><script>const element=tag=>document.createElement(tag);${appFrameClient}document.getElementById('open').onclick=()=>document.getElementById('app-view').replaceChildren(appFrame('Probe',${JSON.stringify(url)}));</script>`);});
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  for(let i=0;i<3;i++){
   await browser('open',base);await browser('click','#open');await browser('wait','--fn',"document.querySelector('#app-view iframe')?.style.height==='617px'");
   const state=await browser('eval',"(()=>{const f=document.querySelector('iframe');let blocked=false;try{void f.contentWindow.document.body;}catch{blocked=true;}return {blocked,escaped:!!document.body.dataset.escaped,sandbox:f.getAttribute('sandbox')};})()");
   assert.deepEqual(state.result,{blocked:true,escaped:false,sandbox:'allow-scripts'});assert.match((await browser('snapshot')).snapshot,/network blocked/);
  }
  await browser('open','http://localhost:'+server.address().port);
  assert.equal((await browser('get','text','body')).text,'E2E loopback only');assert.ok(hosts.every(value=>value.startsWith('127.0.0.1:')));
  await new Promise((resolve,reject)=>{const req=request(network.config.proxy,{method:'CONNECT',path:'localhost:'+server.address().port});req.once('error',reject);req.once('connect',(res,socket)=>{socket.destroy();try{assert.equal(res.statusCode,403);resolve();}catch(error){reject(error);}});req.end();});
 }finally{await browser('close').catch(()=>{});server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await host.close();await network.close();await rm(root,{recursive:true,force:true});}
});
