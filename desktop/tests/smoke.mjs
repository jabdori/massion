import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {loadFixture} from '../../scripts/ui-contracts/fixture-host.ts';
import {launchDaemon,daemonCredential,drainDaemon,control} from '../daemon.ts';
import {daemonTransport} from '../transport.ts';
import {createProtocolClient} from '../../src/client-protocol.ts';

if(process.platform!=='linux'||!process.env.DISPLAY)throw new Error('Run this smoke only under Linux Xvfb. Native visible launches are forbidden.');
const root=await mkdtemp(join(tmpdir(),'massion-electron-'));
const directory=join(root,'user'),socket=join(directory,'daemon.sock');await mkdir(directory,{mode:0o700});
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
const origin='http://127.0.0.1:'+reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
let child;
try{
 const require=createRequire(import.meta.url),electron=require('electron');
 await launchDaemon({node:process.execPath,runner:join(import.meta.dirname,'../daemon-runner.mjs'),entry:join(import.meta.dirname,'fixture-daemon.mjs'),directory,socket,origin});
 const client=createProtocolClient(daemonTransport(origin,()=>daemonCredential(socket,origin)));
 for(let n=0;;n++){try{assert.equal((await client.connection()).state,'ready');break;}catch(error){if(n===49)throw error;await delay(100);}}
 assert.equal((await fetch(origin+'/health')).status,401,'Fixture uses the production authentication guard');
 const fixture=await loadFixture('B7-unknown'),work=fixture.routes['/assistant/works'].body.works.find(work=>work.unknown);
 const target={feedId:fixture.routes['/read-state'].body.feedId,...work};
 child=spawn(electron,[join(import.meta.dirname,'smoke-launcher.cjs')],{stdio:'inherit',env:{...process.env,MASSION_DAEMON_ORIGIN:origin,MASSION_SMOKE_DATA:directory,MASSION_SMOKE_TARGET:JSON.stringify(target)}});
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 const [code]=await once(child,'exit');clearTimeout(timer);assert.equal(code,0,'Electron smoke exit');
 await assert.rejects(control(socket,'status'),'Explicit app quit drains its authenticated supervisor');
}finally{child?.kill();await drainDaemon(socket,origin).catch(()=>{});await rm(root,{recursive:true,force:true});}
