import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopLifecycle} from '../lifecycle.ts';

async function fixture(t:any,drain:()=>Promise<{status:string}>=async()=>({status:'drained'})){
 const root=await mkdtemp(join(tmpdir(),'massion-lifecycle-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const file=join(root,'notifications.json'),calls:string[]=[];
 const host=await DesktopLifecycle.open(file,'1.0.0-rc.1',async()=>{calls.push('drain');return drain();},()=>{calls.push('relaunch');});
 return {host,file,calls};
}
test('saved notifications produce restart-required and survive a new process only after a private atomic save',async t=>{
 const {host,file}=await fixture(t);assert.equal(host.read().restartRequired,false);assert.equal(host.notifications,true);
 await host.saveNotifications(false);assert.equal(host.read().notifications,false);assert.equal(host.notifications,true);assert.equal(host.read().restartRequired,true);
 assert.equal((await stat(file)).mode&0o077,0);assert.deepEqual(JSON.parse(await readFile(file,'utf8')),{notifications:false});
 const reopened=await DesktopLifecycle.open(file,'1.0.0-rc.1',async()=>({status:'drained'}),()=>{});
 assert.equal(reopened.notifications,false);assert.equal(reopened.read().restartRequired,false);assert.equal(reopened.read().installedVersion,'1.0.0-rc.1');assert.equal(reopened.read().update,'unknown');
 await host.saveNotifications(true);assert.equal(host.read().restartRequired,false);
 await assert.rejects(host.saveNotifications('false' as any),/Invalid/);
 await writeFile(file,'{broken');await assert.rejects(DesktopLifecycle.open(file,'1',async()=>({status:'drained'}),()=>{}));
});
test('overlapping restart requests drain and relaunch once, in that order',async t=>{
 let release!:(value:{status:string})=>void;const held=new Promise<{status:string}>(resolve=>release=resolve);
 const {host,calls}=await fixture(t,()=>held);const a=host.restart(),b=host.restart();await Promise.resolve();assert.deepEqual(calls,['drain']);release({status:'drained'});await Promise.all([a,b]);assert.deepEqual(calls,['drain','relaunch']);await host.restart();assert.deepEqual(calls,['drain','relaunch']);
});
for(const status of ['unsettled','external'])test('unconfirmed drain blocks relaunch and cannot be retried: '+status,async t=>{
 const {host,calls}=await fixture(t,async()=>({status}));await host.restart();await host.restart();assert.equal(host.read().restartStatus,'unknown');assert.deepEqual(calls,['drain']);
});
test('a lost drain response never permits relaunch or a second attempt',async t=>{
 const {host,calls}=await fixture(t,async()=>{throw Error('lost reply');});await host.restart();await host.restart();assert.equal(host.read().restartStatus,'unknown');assert.deepEqual(calls,['drain']);
});

test('a failed preference write preserves the running and desired values',async t=>{
 const {host,file}=await fixture(t);const {mkdir}=await import('node:fs/promises');await mkdir(file+'.tmp');
 await assert.rejects(host.saveNotifications(false));assert.equal(host.read().notifications,true);assert.equal(host.read().restartRequired,false);
});
