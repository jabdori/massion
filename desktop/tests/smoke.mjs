import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {startFixtureHost} from '../../scripts/ui-contracts/fixture-host.ts';

if(process.platform!=='linux'||!process.env.DISPLAY)throw new Error('Run this smoke only under Linux Xvfb. Native visible launches are forbidden.');
const root=await mkdtemp(join(tmpdir(),'massion-electron-'));
const server=await startFixtureHost('B7-unknown');
let child;
try{
 const require=createRequire(import.meta.url),electron=require('electron');
 const work=server.fixture.routes['/assistant/works'].body.works.find(work=>work.unknown);
 const target={feedId:server.fixture.routes['/read-state'].body.feedId,...work};
 child=spawn(electron,[join(import.meta.dirname,'smoke-launcher.cjs')],{stdio:'inherit',env:{...process.env,MASSION_DAEMON_ORIGIN:server.url,MASSION_SMOKE_DATA:join(root,'user'),MASSION_SMOKE_TARGET:JSON.stringify(target)}});
 const timer=setTimeout(()=>child.kill('SIGKILL'),60000);
 const [code]=await once(child,'exit');clearTimeout(timer);assert.equal(code,0,'Electron smoke exit');
 assert.equal((await fetch(new URL('/health',server.url))).status,200,'Externally owned daemon remains alive after app quit');
}finally{child?.kill();await server.close();await rm(root,{recursive:true,force:true});}
