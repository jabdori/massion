import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {growthStore} from '../../tests/support/growth-fixture.ts';
import {stopOwnedChild} from '../../tests/support/owned-process.ts';
import {exportPortableBackup,restorePortableBackup} from '../../src/portable-backup.ts';
import {TextArtifactStore} from '../../src/text-artifacts.ts';
import {workbenchReady} from '../ui-contracts/report.ts';

const run=promisify(execFile),out=resolve('.runtime/e2e');
// No skip: a missing database/browser must fail the required CI job.
assert.ok(process.env.SURREAL_TEST_RUNTIME,'Run npm run e2e inside scripts/with-surreal.py');
await run('agent-browser',['--version']);

test('real daemon + workbench + durable owner journeys',{timeout:480000},async t=>{
 await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});
 const root=await mkdtemp(join(tmpdir(),'massion-owned-e9a-')),f=await growthStore(true);let database=(await f.transport.query('RETURN $session.db;',{}))[0];
 const session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-e9a'])).stdout.trim();
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_')));
 Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]'});
 const browserConfig=join(root,'browser.json');await writeFile(browserConfig,JSON.stringify(process.env.MASSION_E2E_BROWSER?{executablePath:process.env.MASSION_E2E_BROWSER}:{}));
 const browser=async(...args)=>{
  const result=JSON.parse((await run('agent-browser',['--config',browserConfig,'--session',session,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:35000,maxBuffer:4e6})).stdout);
  assert.ok(result.success,result.error);if(args[0]==='reload')await browser('wait','--fn',workbenchReady);return result.data;
 };
 const wait=async code=>browser('wait','--fn',code);
 const entry=fileURLToPath(new URL('./daemon.ts',import.meta.url)),configPath=join(root,'host.json'),argv=[process.execPath,entry,configPath];
 let child,url,logs='',currentStore=f.store;const evidence=[];
 const calls=async()=>{try{return (await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const current=async()=>currentStore.load('intake');
 async function journey(name,check){let failure;await t.test(name,async()=>{try{await check();}catch(error){failure=error;console.error(name,error);throw error;}});if(failure)throw failure;}
 const until=async check=>{const end=Date.now()+20000;while(!await check()){assert.ok(Date.now()<end,'Durable journey deadline; daemon: '+logs);await new Promise(r=>setTimeout(r,30));}};
 const get=async path=>{const response=await fetch(url+path);assert.equal(response.status,200,path);return response.json();};
 const post=async(path,body)=>{const response=await fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 async function start(mode='configured',extra={}){
  await writeFile(configPath,JSON.stringify({mode,database:{endpoint:process.env.MASSION_TEST_SURREAL_RPC,namespace:process.env.MASSION_TEST_SURREAL_NAMESPACE,database},...extra}));
  child=spawn(process.execPath,[entry,configPath],{cwd:root,env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe','ipc']});logs='';
  child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Daemon readiness timeout: '+logs)),20000);child.once('exit',code=>{clearTimeout(timer);reject(Error('Daemon exited '+code+': '+logs));});child.on('message',message=>{if(message.type==='ready'){clearTimeout(timer);resolve(message.url);}});});
 }
 async function stop(){if(!child)return;const owned=child;await stopOwnedChild(owned,{cwd:root,argv});child=undefined;assert.equal(owned.exitCode,0,'Daemon drain: '+logs);}
 async function open(fragment=''){await browser('open',url+'/'+fragment);await wait(workbenchReady);}
 async function capture(name,patterns){const {snapshot}=await browser('snapshot');await writeFile(join(out,name+'.snapshot.txt'),snapshot+'\n');await browser('screenshot',join(out,name+'.png'));for(const pattern of patterns)assert.match(snapshot,pattern,name);evidence.push(name);}
 async function say(text){await browser('fill','#chat-input',text);await browser('click','#chat-send');await wait("!document.getElementById('chat-input').disabled && !document.getElementById('chat-input').value");}
 async function finished(title,acceptance='accepted'){
  await until(async()=>{const work=(await current()).value.works.find(w=>w.title===title);return work?.acceptance===acceptance&&work.execution==='settled';});
  await wait(`document.getElementById('chat-log').textContent.includes(${JSON.stringify(title)})`);
  const work=(await current()).value.works.find(w=>w.title===title);
  await wait(`document.getElementById(${JSON.stringify('side-line-intake/'+work.id)})?.querySelector('.state')?.textContent.includes(${JSON.stringify(acceptance==='accepted'?'완료':'실패')})`);
  return work;
 }
 try{
  await browser('set','viewport','1280','900');assert.equal((await browser('eval','navigator.onLine')).result,true,'Browser must have a network interface; use an internal Docker network to block egress');
  await journey('first run without a connection and with detected subscription',async()=>{
   await start('none');await browser('open',url);await wait("!document.getElementById('first-signin').hidden");await capture('first-run-none',[/ChatGPT/]);assert.deepEqual(await calls(),[]);assert.equal((await f.store.exportJournal()).head,0);await stop();
   await start('found');await open();await wait("!!document.getElementById('first-calculation')");await capture('first-run-found',[/radio|계산|정리/]);assert.deepEqual(await calls(),[]);assert.equal((await f.store.exportJournal()).head,0);await stop();
  });
  await start();await open();
  await journey('conversation, handoff and independent accepted Record',async()=>{
   await say('direct');await wait("document.getElementById('chat-log').textContent.includes('Fixture conversation reply')");await capture('conversation',[/Fixture conversation reply/]);assert.equal((await current()).value.works.length,0);
   await say('pass');const work=await finished('pass');assert.equal(work.record.evidenceClass,'fixture');assert.notEqual(work.assignments.find(a=>a.role==='executor').actorId,work.assignments.find(a=>a.role==='verifier').actorId);assert.equal(work.verdict.status,'passed');assert.equal(await new TextArtifactStore(join(root,'artifacts')).read(work.record.artifact),'Accepted fixture output');await capture('accepted',[/pass/,/완료/]);
   await say('second');await finished('second');
  });
  await journey('member decision, team steps, challenge and independent check',async()=>{
   const proposed=new Promise((resolve,reject)=>{const listener=message=>{if(message.type==='proposed'||message.type==='error'){child.off('message',listener);message.type==='error'?reject(Error(message.error)):resolve();}};child.on('message',listener);});child.send({type:'propose-member'});await proposed;
   await browser('reload');await wait("!!document.querySelector('.chat-decision')");await capture('member-decision',[/Fixture analysis/]);
   const decision=(await get('/assistant/conversation')).decisions.find(d=>d.form==='member');assert.ok(decision);
   await browser('click','.chat-decision .chat-actions button:first-child');await browser('fill','#member-name','Quill');await browser('click','#member-shape-drop');await browser('click','#member-create');await wait("document.getElementById('member-dialog').hidden");assert.equal((await get('/assistant/conversation')).members[0].name,'Quill');
   await browser('reload');await wait("document.getElementById('sidebar').textContent.includes('Quill')");
   await say('team');const work=await finished('team');assert.ok(work.team);assert.ok(work.tasks.filter(task=>task.step).every(task=>task.status==='settled'));assert.deepEqual(work.room.messages.map(m=>m.kind),['proposal','challenge','concede']);assert.deepEqual(work.record.room,work.room);assert.equal(work.verdict.status,'passed');
   await browser('click',`[id="side-line-intake/${work.id}"]`);await wait("!!document.querySelector('.work-room:not([hidden])')");await capture('team-room',[/Quill/,/Research/,/Writing/,/Name the evidence/,/The fixture has no outside evidence/]);
   await browser('click','#pane-close');
  });
  await journey('known rejection becomes a separately checked correction',async()=>{
   await say('fail');const failed=await finished('fail','failed');assert.equal(failed.record,undefined);
   await browser('open',url+'/#mission=intake');await browser('reload');await wait("document.getElementById('loaded-id').textContent==='intake'");await browser('click','#pane-widen');
   await browser('click','#correction-summary');await browser('select','#correction-source',failed.id);
   for(const [id,value] of Object.entries({'correction-id':'fixed','correction-title':'Fixed fixture output','correction-reason':'Replace the known rejected result without overwriting it','correction-budget':'8'}))await browser('fill','#'+id,value);
   await browser('click','#correction-review');await wait("!document.getElementById('correction-save').disabled");await capture('correction-review',[/Fixed fixture output/]);await browser('click','#correction-save');await until(async()=>!!(await current()).value.works.find(w=>w.id==='fixed'));
   let snapshot=await current();assert.equal(snapshot.value.works.find(w=>w.id==='fixed').runtimeRun,undefined);
   assert.equal((await post('/missions/intake/run',{commandId:'e9a-correction-run',expectedRevision:snapshot.revision,workId:'fixed'})).status,200);
   snapshot=await current();const fixed=snapshot.value.works.find(w=>w.id==='fixed');assert.equal(fixed.acceptance,'accepted');assert.equal(fixed.record.correction.workId,failed.id);assert.deepEqual(snapshot.value.works.find(w=>w.id===failed.id),failed);await browser('reload');await wait("document.getElementById('loaded-id').textContent==='intake'");await capture('correction-accepted',[/fixed/]);await open();
  });
  await journey('app install decision persists; unsupported decisions fail closed',async()=>{
   await browser('click','#rail-me');await browser('click','#me-settings');await browser('click','#settings-nav-apps');await wait("!!document.querySelector('#settings-apps-body button')");await capture('apps-catalog',[/GitHub/]);
   await browser('find','role','button','click','--name','설치','--exact');await wait("!!document.querySelector('.chat-decision')");await capture('app-decision',[/GitHub/]);
   const decision=(await get('/assistant/conversation')).decisions.find(d=>d.id.startsWith('app-decision:'));assert.ok(decision);await browser('click','.chat-decision .chat-actions button:first-child');await until(async()=>(await get('/assistant/apps')).apps.length===1);await browser('reload');await wait("document.getElementById('app').textContent.includes('GitHub')");assert.equal((await get('/assistant/apps')).apps[0].enabled,true);await capture('app-installed',[/GitHub/]);
   const before=await f.store.exportJournal();for(const decisionId of ['payment','delegate','budget'])assert.equal((await post('/assistant/decisions',{commandId:'e9a-'+decisionId,decisionId,answer:'act'})).status,400);assert.deepEqual(await f.store.exportJournal(),before);
  });
  await journey('unknown outcome and drain mid-Work survive restart without resend',async()=>{
   await open();await say('unknown');await until(async()=>(await current()).value.works.find(w=>w.title==='unknown')?.effects.some(e=>e.status==='unknown'));
   await wait("[...document.querySelectorAll('.chat-exception')].some(node=>node.textContent.includes('unknown'))");await capture('unknown',[/unknown/]);const unknown=structuredClone((await current()).value.works.find(w=>w.title==='unknown'));assert.equal(unknown.record,undefined);
   await say('drain');await until(async()=>(await calls()).some(c=>c.title==='drain'&&c.kind==='produce'));await capture('before-drain',[/drain/]);await stop();
   const before=await f.store.exportJournal(),count=(await calls()).length,drained=(await current()).value.works.find(w=>w.title==='drain');assert.ok(drained.effects.some(e=>e.status==='unknown'));assert.equal(drained.record,undefined);
   await start();await open();await wait("!!document.querySelector('.chat-exception')");await capture('restarted',[/unknown/,/drain/]);assert.deepEqual(await f.store.exportJournal(),before);assert.deepEqual((await current()).value.works.find(w=>w.id===unknown.id),unknown);assert.equal((await calls()).length,count);await stop();
  });
  await journey('fresh database restore preserves Records, uncertainty and exact relocated text',async()=>{
   // A separate two-Work installation stays within the server's default RPC size limit.
   const source=await growthStore(true);currentStore=source.store;database=(await source.transport.query('RETURN $session.db;',{}))[0];
   await start();await open();await say('pass');const accepted=await finished('pass');await say('unknown');await until(async()=>(await current()).value.works.find(w=>w.title==='unknown')?.effects.some(e=>e.status==='unknown'));await stop();
   const journal=await source.store.exportJournal(),bundle=await exportPortableBackup(source.store,new TextArtifactStore(join(root,'artifacts'))),dest=await growthStore(true),restoredRoot=join(root,'restored'),bundlePath=join(root,'backup.json');await writeFile(bundlePath,bundle,{mode:0o600});await restorePortableBackup(bundle,dest.store,restoredRoot);assert.deepEqual(await dest.store.exportJournal(),journal);
   await rm(join(root,'artifacts'),{recursive:true,force:true});const count=(await calls()).length;
   database=(await dest.transport.query('RETURN $session.db;',{}))[0];currentStore=dest.store;
   await start('configured',{restoredBundle:bundlePath,restoredRoot});await open();await capture('restored',[/pass/,/unknown/]);
   assert.deepEqual((await current()).value.works.find(w=>w.id===accepted.id),accepted);assert.equal((await get('/missions/intake/record-artifact?'+new URLSearchParams({work:accepted.id,record:accepted.record.id,version:String(accepted.record.artifact.version),sha256:accepted.record.artifact.sha256}))).content,'Accepted fixture output');assert.equal((await calls()).length,count);assert.deepEqual(await dest.store.exportJournal(),journal);
  });
  await writeFile(join(out,'calls.json'),JSON.stringify(await calls(),null,2)+'\n');
  await writeFile(join(out,'report.json'),JSON.stringify({evidence,fixtureCalls:(await calls()).length,liveCalls:0,capabilityGaps:['payment','external member','monthly budget','MCP reconcile','Electron journeys']},null,2)+'\n');
 }catch(error){console.error('Journey failure',error);console.error('Browser errors',await browser('errors').catch(()=>null));console.error('Settings state',await browser('eval',"JSON.stringify({shown:typeof settingsShown==='undefined'?null:settingsShown,apps:typeof settingsApps==='undefined'?null:settingsApps})").catch(()=>null));await capture('failure',[]).catch(()=>{});await writeFile(join(out,'failure-state.json'),JSON.stringify({connections:url?await get('/connections').catch(()=>null):null,conversation:url?await get('/assistant/conversation').catch(()=>null):null,snapshot:await current(),calls:await calls()},null,2));throw error;}
 finally{await browser('close').catch(()=>{});await stop();await writeFile(join(out,'daemon.log'),logs);await rm(root,{recursive:true,force:true});}
});
