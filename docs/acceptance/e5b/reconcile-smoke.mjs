import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AppsService,APPS_ID,appDecisionId} from '../../../src/apps.ts';
import {InMemoryStore} from '../../../src/storage.ts';
import {createWorkbench} from '../../../src/server.ts';

// Fixture transport only; owner clicks use the real host command, store and reducer.
const tools=[{name:'comment',description:'Comment',inputSchema:{type:'object'},readOnly:false}];
const pkg={manifest:{format:'massion.app.v1',id:'mcp-proof',name:'MCP',version:'1.0.0',description:'Fixture app',kind:'mcp',mcp:{transport:'http',url:'http://127.0.0.1:4318/mcp',tools},permissions:{read:[],write:['comment'],network:['127.0.0.1'],files:[],secrets:[],events:[]},contributes:{templates:[],skills:[],procedures:[],tools:['comment']},handlers:['run']},source:''};
const store=new InMemoryStore();let sent=0;
const mcp={list:async()=>tools,call:async()=>{sent++;return sent===1?new Promise(()=>{}):{content:[]};},close:async()=>{}};
const service=new AppsService(store,{mcp,toolTimeoutMs:10});
await service.offer({commandId:'assistant-app-proof',pkg,origin:'catalog'});
await service.decide({commandId:'owner-install',decisionId:appDecisionId('assistant-app-proof'),answer:'act'});
const input={commandId:'assistant-app-unknown',appId:'app-mcp-proof',name:'comment',arguments:{}};
assert.equal((await service.callTool(input)).status,'unknown');
const server=createWorkbench(store,process.cwd(),{scheduleIntervalMs:0,mcp});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const url='http://127.0.0.1:'+server.address().port,out=resolve('docs/acceptance/e5b/reconciliation'),config=resolve('.runtime/e5b-reconcile-browser.json');await mkdir(out,{recursive:true});await mkdir(resolve('.runtime'),{recursive:true});await writeFile(config,'{}\n');
const run=promisify(execFile),session='massion-reconcile-'+randomUUID().slice(0,8),env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'});
let theme='dark';const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:8*1024*1024});const result=JSON.parse(stdout);assert.ok(result.success,result.error);return result.data;};
const capture=async state=>{await browser('screenshot',join(out,theme+'-'+state+'.png'));const snapshot=await browser('snapshot');await writeFile(join(out,theme+'-'+state+'.txt'),snapshot.snapshot+'\n');};
try{
 await browser('open',url);await browser('set','viewport','1440','900');await browser('wait','#rail-app-app-mcp-proof');await browser('click','#rail-app-app-mcp-proof');await browser('wait','#app-reconcile-evidence-assistant-app-unknown');
 for(const value of ['dark','light']){theme=value;await browser('set','media',theme);assert.equal((await browser('eval','-b',Buffer.from("matchMedia('(prefers-color-scheme: "+theme+")').matches").toString('base64'))).result,true);await capture('unknown');}
 await browser('fill','#app-reconcile-evidence-assistant-app-unknown','Fixture receipt #42 confirms completion');
 await browser('click','#app-reconcile-done-assistant-app-unknown');await browser('wait','--fn',"document.getElementById('app-tool-outcomes').hidden");
 assert.equal(sent,1,'owner reconciliation never invokes the transport');
 const saved=(await store.load(APPS_ID)).value.toolCalls[0];assert.equal(saved.status,'succeeded');assert.equal(saved.reconciliation.actorId,'local-owner');assert.equal(saved.reconciliation.evidence,'Fixture receipt #42 confirms completion');
 assert.equal((await service.callTool(input)).status,'succeeded');assert.equal(sent,1,'same invocation remains read-only');
 for(const value of ['dark','light']){theme=value;await browser('set','media',theme);assert.equal((await browser('eval','-b',Buffer.from("matchMedia('(prefers-color-scheme: "+theme+")').matches").toString('base64'))).result,true);await capture('reconciled');}
 assert.equal((await service.callTool({...input,commandId:'assistant-app-next'})).status,'succeeded');assert.equal(sent,2,'only a distinct later write is admitted');
 await writeFile(join(out,'report.json'),JSON.stringify({fixtureOnly:true,themes:['dark','light'],reconciliation:saved.reconciliation,sendCountBefore:1,sendCountAfterReconcile:1,sendCountAfterNewWrite:2,checks:['Unknown-outcome wording','Owner evidence and exact call','No resend on reconciliation or replay','Distinct later write admitted']},null,2)+'\n');
}finally{await browser('close').catch(()=>{});server.closeAllConnections();await new Promise(r=>server.close(r));}
console.log('Owner reconciliation UI and single-send behavior passed in both themes.');
