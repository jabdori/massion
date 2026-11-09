import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,stat,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {control,prepareControl,launchDaemon,drainDaemon,daemonCredential} from '../daemon.ts';

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
