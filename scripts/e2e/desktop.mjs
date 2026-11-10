import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {launchDaemon,daemonCredential,drainDaemon,control} from '../../desktop/daemon.ts';
import {authenticatedFetch} from '../../desktop/auth.ts';
import {workbenchReady} from '../ui-contracts/report.ts';
import {paymentJourney} from './decisions.mjs';
import {stopOwnedChild} from '../../tests/support/owned-process.ts';
import {browserCommand} from './browser-command.mjs';

export async function desktopJourney({out,database,store}){
 assert.ok(process.platform==='linux'&&process.env.DISPLAY,'Run E2E under Linux Xvfb; native visible launches are forbidden');
 const root=await mkdtemp(join(tmpdir(),'massion-owned-e9a2-desktop-')),socket=join(root,'daemon.sock'),config=join(root,'host.json'),run=promisify(execFile);
 const reserve=async()=>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));return port;};
 const origin='http://127.0.0.1:'+await reserve(),port=await reserve();let child,childArgv,logs='';const evidence=[];
 const session=(await run('agent-browser',['session','id','--scope','worktree','--prefix','massion-e9a2-desktop'])).stdout.trim();
 const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]'});
 const browser=async(...args)=>{const data=await browserCommand(()=>run('agent-browser',['--session',session,'--cdp',String(port),'--json',...args],{env,timeout:35000,maxBuffer:4e6}));if(args[0]==='reload')await browser('wait','--fn',workbenchReady);return data;};
 const wait=code=>browser('wait','--fn',code),until=async check=>{const end=Date.now()+20000;while(!await check()){assert.ok(Date.now()<end,'Desktop deadline: '+logs);await new Promise(r=>setTimeout(r,30));}};
 const calls=async()=>{try{return (await readFile(join(root,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const capture=async(name,patterns)=>{const {snapshot}=await browser('snapshot');await writeFile(join(out,name+'.snapshot.txt'),snapshot+'\n');await browser('screenshot',join(out,name+'.png'));for(const pattern of patterns)assert.match(snapshot,pattern);evidence.push(name);};
 try{
  await writeFile(config,JSON.stringify({mode:'configured',database,effectScenario:'desktop-payment'}));
  const previous=process.env.MASSION_E2E_CONFIG;process.env.MASSION_E2E_CONFIG=config;
  try{await launchDaemon({node:process.execPath,runner:resolve('desktop/daemon-runner.mjs'),entry:resolve('scripts/e2e/daemon.ts'),directory:root,socket,origin});}finally{if(previous===undefined)delete process.env.MASSION_E2E_CONFIG;else process.env.MASSION_E2E_CONFIG=previous;}
  await until(async()=>{try{const r=await authenticatedFetch(new URL('/health',origin),{},await daemonCredential(socket,origin));return r.status===200;}catch{return false;}});
  assert.equal((await fetch(origin+'/health')).status,401,'Daemon requires the production authentication handshake');
  const require=createRequire(new URL('../../desktop/package.json',import.meta.url));
  childArgv=[require('electron'),'--remote-debugging-port='+port,resolve('scripts/e2e/electron-launcher.cjs')];
  child=spawn(childArgv[0],childArgv.slice(1),{cwd:root,env:{...process.env,MASSION_DAEMON_ORIGIN:origin,MASSION_E2E_DESKTOP_DATA:root},stdio:['pipe','pipe','pipe']});
  child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);
  await until(async()=>{assert.equal(child.exitCode,null,'Electron exited: '+logs);assert.equal(child.signalCode,null,'Electron signalled: '+logs);try{return (await fetch('http://127.0.0.1:'+port+'/json/list')).ok;}catch{return false;}});
  await wait(workbenchReady);assert.equal((await browser('get','url')).url,'massion://app/');
  const sandbox=await browser('eval',"({node:typeof require,bridge:Object.keys(window.massionDesktop)})");assert.deepEqual(sandbox.result,{node:'undefined',bridge:['getSettings','saveNotifications','restart','onFocus']});
  await paymentJourney({browser,wait,capture,current:()=>store.load('intake'),calls,until},'desktop-payment',true);
  await writeFile(join(out,'desktop-calls.json'),JSON.stringify(await calls(),null,2)+'\n');
  const exited=once(child,'exit');child.stdin.end('quit\n');const timer=setTimeout(()=>child.kill('SIGKILL'),15000);let code;try{[code]=await exited;}finally{clearTimeout(timer);}assert.equal(code,0,'Electron drain: '+logs);
  await assert.rejects(control(socket,'status'),'Explicit quit drains the supervisor');
  return evidence;
 }catch(error){await capture('desktop-failure',[]).catch(()=>{});throw error;}
 finally{
  if(child)await stopOwnedChild(child,{cwd:root,argv:childArgv});
  await browser('close').catch(()=>{});await drainDaemon(socket,origin).catch(()=>{});
  await writeFile(join(out,'desktop.log'),logs);await writeFile(join(out,'desktop-daemon.log'),await readFile(join(root,'daemon.log'),'utf8').catch(()=>''));await rm(root,{recursive:true,force:true});
 }
}
