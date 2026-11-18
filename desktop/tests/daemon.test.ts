import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,stat,chmod,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {control,prepareControl,launchDaemon,drainDaemon,daemonCredential} from '../daemon.ts';
import {tempRoot} from '../../tests/support/temp-root.ts';

test('detached daemon survives launcher exit, excludes a second owner and drains on explicit quit',async t=>{
 const root=await mkdtemp(join(tmpdir(),'e4-daemon-')),socket=join(root,'daemon.sock'),entry=join(root,'core.mjs');
 // Slow initialization must not let supervisor readiness stand in for child readiness.
 await writeFile(entry,`import {writeFileSync} from 'node:fs';import {setTimeout as delay} from 'node:timers/promises';await delay(250);setInterval(()=>{},1000);process.on('SIGTERM',()=>{writeFileSync(${JSON.stringify(join(root,'drained'))},'yes');process.exit(0);});writeFileSync(${JSON.stringify(join(root,'started'))},String(process.pid));`);
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 await prepareControl(socket);
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 // The launcher exits, as an Electron process would; only the detached supervisor remains.
 const launcher=spawn(process.execPath,['--input-type=module','-e',`import {launchDaemon} from ${JSON.stringify(new URL('../daemon.ts',import.meta.url).href)};await launchDaemon({node:process.execPath,runner:${JSON.stringify(runner)},entry:${JSON.stringify(entry)},directory:${JSON.stringify(root)},socket:${JSON.stringify(socket)},origin:'http://127.0.0.1:8765'});`],{stdio:'pipe'});
 let stderr='';launcher.stderr.on('data',data=>stderr+=data);assert.equal((await once(launcher,'exit'))[0],0,stderr);
 await t.waitFor(()=>readFile(join(root,'started'),'utf8'),{timeout:5000});
 const status=await control(socket,'status');assert.equal(status.status,'running');assert.ok(status.pid);
 assert.equal(typeof status.secret,'undefined');assert.equal((await stat(socket)).mode&0o777,0o600);
 const secret=await daemonCredential(socket,'http://127.0.0.1:8765');assert.equal(secret.length,64);
 await assert.rejects(daemonCredential(socket,'http://127.0.0.1:9000'),/authentication/);
 await chmod(socket,0o666);await assert.rejects(daemonCredential(socket,'http://127.0.0.1:8765'),/Private/);await chmod(socket,0o600);
 await assert.rejects(prepareControl(socket),/already running/);
 await launchDaemon({node:process.execPath,runner,entry,directory:root,socket,origin:'http://127.0.0.1:8765'});
 assert.equal((await control(socket,'status')).pid,status.pid);
 assert.equal((await drainDaemon(socket,'http://127.0.0.1:9000')).status,'external');
 assert.equal((await control(socket,'status')).pid,status.pid);
 assert.equal((await drainDaemon(socket,'http://127.0.0.1:8765')).status,'drained');
 assert.equal(await readFile(join(root,'drained'),'utf8'),'yes');
 await rm(join(root,'started'));
 await launchDaemon({node:process.execPath,runner,entry,directory:root,socket,origin:'http://127.0.0.1:8765'});
 await t.waitFor(()=>readFile(join(root,'started'),'utf8'),{timeout:5000});
 const nextSecret=await daemonCredential(socket,'http://127.0.0.1:8765');assert.equal(secret===nextSecret,false);
 assert.equal((await readFile(join(root,'daemon.log'),'utf8')).includes(secret),false);
 assert.equal((await readFile(socket+'.pid','utf8')).includes(nextSecret),false);
});

test('the second supervisor on a taken socket logs one line, exits 0 and leaves the first alone',async t=>{
 const root=await mkdtemp(join(tempRoot(),'address-conflict-')),socket=join(root,'daemon.sock'),entry=join(root,'core.mjs');
 await writeFile(entry,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const startSupervisor=()=>spawn(process.execPath,[runner,socket,entry,'http://127.0.0.1:8765'],{cwd:root,stdio:['ignore','ignore','pipe']});
 const first=startSupervisor();
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 // The order is observed, never timed: the second supervisor starts only after the first answers status.
 await t.waitFor(()=>control(socket,'status'),{timeout:10_000});
 const before=await control(socket,'status');
 const second=startSupervisor();
 let secondStderr='';second.stderr.on('data',chunk=>secondStderr+=chunk);
 await t.waitFor(()=>{
  if(second.exitCode===null&&second.signalCode===null)throw new Error('the second supervisor is still running');
  if(!secondStderr.includes('another supervisor already listens on this socket'))throw new Error('the exit line was not written');
 },{timeout:10_000});
 assert.equal(second.exitCode,0,secondStderr);
 assert.ok(secondStderr.includes(`supervisor ${second.pid} exits`),secondStderr);
 const after=await control(socket,'status');
 assert.equal(after.status,'running');assert.equal(after.pid,before.pid);
 assert.equal((await stat(socket)).isSocket(),true);
 assert.equal(JSON.parse(await readFile(socket+'.pid','utf8')).pid,first.pid);
});

test('the second supervisor still exits 0 when its standard error cannot be written',async t=>{
 const root=await mkdtemp(join(tempRoot(),'address-conflict-unwritable-')),socket=join(root,'daemon.sock'),entry=join(root,'core.mjs');
 await writeFile(entry,'setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));');
 const runner=new URL('../daemon-runner.mjs',import.meta.url).pathname;
 const command=[runner,socket,entry,'http://127.0.0.1:8765'];
 const first=spawn(process.execPath,command,{cwd:root,stdio:['ignore','ignore','pipe']});
 t.after(async()=>{await control(socket,'drain').catch(()=>{});await rm(root,{recursive:true,force:true});});
 // The order is observed, never timed: the second supervisor starts only after the first answers status.
 await t.waitFor(()=>control(socket,'status'),{timeout:10_000});
 const before=await control(socket,'status');
 // fd 2 of the child is a duplicate of a read-only descriptor, so every write to it fails with
 // EBADF (a descriptor that is open, but not open for writing): the log line cannot be written.
 await writeFile(join(root,'unwritable'),'');
 const unwritable=await open(join(root,'unwritable'),'r');
 t.after(()=>unwritable.close());
 const second=spawn(process.execPath,command,{cwd:root,stdio:['ignore','ignore',unwritable.fd]});
 await t.waitFor(()=>{
  if(second.exitCode===null&&second.signalCode===null)throw new Error('the second supervisor is still running');
 },{timeout:10_000});
 assert.equal(second.exitCode,0);
 const after=await control(socket,'status');
 assert.equal(after.status,'running');assert.equal(after.pid,before.pid);
 assert.equal((await stat(socket)).isSocket(),true);
 assert.equal(JSON.parse(await readFile(socket+'.pid','utf8')).pid,first.pid);
});
