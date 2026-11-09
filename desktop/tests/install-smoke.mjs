import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {createServer} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {launchDaemon,daemonCredential,drainDaemon} from '../daemon.ts';
import {daemonTransport} from '../transport.ts';
import {createProtocolClient} from '../../src/client-protocol.ts';
import {loadFixture} from '../../scripts/ui-contracts/fixture-host.ts';
import {browserCommand} from '../../scripts/e2e/browser-command.mjs';

assert.equal(process.platform,'darwin','This smoke tests the built macOS .app');
const executable=resolve(import.meta.dirname,'../release',process.arch==='x64'?'mac':'mac-'+process.arch,'Massion.app/Contents/MacOS/Massion');
await access(executable);
const root=await mkdtemp(join(await realpath(tmpdir()),'massion-install-')),directory=join(root,'user'),socket=join(directory,'daemon.sock');
const out=resolve(import.meta.dirname,'../smoke-artifacts/install');await rm(out,{recursive:true,force:true});await mkdir(out,{recursive:true});await mkdir(directory,{mode:0o700});
const run=promisify(execFile),session='massion-install-'+process.pid;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]'});
const config=join(root,'browser.json');await writeFile(config,'{}');
async function port(){const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value;}
const origin='http://127.0.0.1:'+await port(),debugPort=await port();let child,logs='';
const browser=(...args)=>browserCommand(()=>run('agent-browser',['--config',config,'--session',session,'--cdp',String(debugPort),'--json',...args],{env,timeout:30000,maxBuffer:4e6}));
try{
 await launchDaemon({node:process.execPath,runner:resolve(import.meta.dirname,'../daemon-runner.mjs'),entry:resolve(import.meta.dirname,'fixture-daemon.mjs'),directory,socket,origin});
 const client=createProtocolClient(daemonTransport(origin,()=>daemonCredential(socket,origin)));
 for(let n=0;;n++){try{assert.equal((await client.connection()).state,'ready');break;}catch(error){if(n===49)throw error;await delay(100);}}
 assert.equal((await fetch(origin+'/health')).status,401,'Fixture daemon refuses unauthenticated requests');
 child=spawn(executable,['--massion-headless','--user-data-dir='+directory,'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort],{cwd:root,env:{PATH:process.env.PATH,MASSION_DAEMON_ORIGIN:origin},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',chunk=>logs+=chunk);child.stderr.on('data',chunk=>logs+=chunk);child.on('error',error=>logs+=error.message);
 const deadline=Date.now()+30000;
 for(;;){
  assert.equal(child.exitCode,null,'Packaged app exited: '+logs);assert.equal(child.signalCode,null,'Packaged app signalled: '+logs);
  try{if((await fetch('http://127.0.0.1:'+debugPort+'/json/list')).ok)break;}catch{}
  assert.ok(Date.now()<deadline,'Packaged app startup timeout: '+logs);await delay(100);
 }
 await browser('wait','--fn','typeof chatView!=="undefined"&&!!chatView?.feedId&&!reconnectRequired');
 assert.equal((await browser('get','url')).url,'massion://app/');
 assert.deepEqual((await browser('eval',"({node:typeof require,bridge:Object.keys(window.massionDesktop)})")).result,{node:'undefined',bridge:['onFocus']});
 const fixture=await loadFixture('B7-unknown'),work=fixture.routes['/assistant/works'].body.works.find(work=>work.unknown);
 const initial=(await browser('eval',`protocol.query('/assistant/works',{scope:'install-before'}).then(r=>r.body.works.find(w=>w.workId===${JSON.stringify(work.workId)}))`)).result;
 assert.equal(initial.unknown,true);
 for(const step of fixture.steps){
  assert.equal(step.action,'click');await browser('click',step.selector);
  if(step.readySelector)await browser('wait',step.readySelector);
 }
 assert.equal((await browser('eval','paneActive')).result,work.missionId+'/'+work.workId);
 const snapshot=(await browser('snapshot')).snapshot;assert.ok(snapshot.includes(work.title));
 await writeFile(join(out,'work.snapshot.txt'),snapshot+'\n');await browser('screenshot',join(out,'work.png'));
 const after=(await browser('eval',`protocol.query('/assistant/works',{scope:'install-after'}).then(r=>r.body.works.find(w=>w.workId===${JSON.stringify(work.workId)}))`)).result;
 assert.deepEqual(after,initial,'Inspection preserves the unknown outcome');
 assert.equal((await drainDaemon(socket,origin)).status,'drained');
 await writeFile(join(out,'report.json'),JSON.stringify({status:'passed',version:JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version,architecture:process.arch,executable,headless:true,journey:'authenticated connection → unknown Work → activity → unchanged outcome',liveCalls:0,daemon:'drained'},null,2)+'\n');
 console.log('Packaged macOS install smoke passed: '+out);
}finally{
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{await exited;}finally{clearTimeout(timer);}}
 await browser('close').catch(()=>{});await drainDaemon(socket,origin).catch(()=>{});
 await writeFile(join(out,'app.log'),logs);await writeFile(join(out,'daemon.log'),await readFile(join(directory,'daemon.log'),'utf8').catch(()=>''));await rm(root,{recursive:true,force:true});
}
