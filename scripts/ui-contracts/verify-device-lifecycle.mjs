import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {DesktopLifecycle} from '../../desktop/lifecycle.ts';
import {startFixtureHost} from './fixture-host.ts';

const exec=promisify(execFile),directory=await mkdtemp(join(tmpdir(),'massion-native-ui-')),out=resolve('.runtime/device-lifecycle-interactions');
const calls=[],native=await DesktopLifecycle.open(join(directory,'notifications.json'),'1.0.0-rc.1',async()=>{calls.push('drain');return {status:'drained'};},()=>calls.push('relaunch'));
const host=await startFixtureHost('B13-general'),session=(await exec('agent-browser',['session','id','--scope','worktree','--prefix','massion-device'])).stdout.trim();
const browser=async(...args)=>{const {stdout}=await exec('agent-browser',['--session',session,'--allowed-domains','127.0.0.1','--json',...args],{timeout:30000,maxBuffer:2*1024*1024});const reply=JSON.parse(stdout);assert.equal(reply.success,true,reply.error);return reply.data;};
const report=[],capture=async name=>{await writeFile(join(out,name+'.snapshot.json'),JSON.stringify(await browser('snapshot','-c')));await browser('screenshot',join(out,name+'.png'));report.push(name);};
const install=async state=>browser('eval',`window.massionDesktop={getSettings:async()=>(${JSON.stringify(state)}),saveNotifications:value=>{window.nativeSave=value;return new Promise(resolve=>window.finishNative=resolve);},restart:()=>{window.nativeRestart=true;return new Promise(resolve=>window.finishNative=resolve);}};true`);
try{
 await mkdir(out,{recursive:true});await browser('open',host.url);await browser('wait','#rail-me');await install(native.read());
 await browser('click','#rail-me');await browser('click','#me-settings');await browser('wait','#settings-notifications');
 assert.equal((await browser('eval',"document.querySelector('#settings-general-body').textContent.includes('1.0.0-rc.1')")).result,true);await capture('general');
 await browser('select','#settings-notifications','off');await browser('wait','--fn','window.nativeSave===false');await capture('saving');
 const saved=await native.saveNotifications(false);await browser('eval',`window.finishNative(${JSON.stringify(saved)});true`);await browser('wait','#settings-restart');await capture('restart-required');await install(saved);
 await browser('click','#settings-nav-devices');await browser('wait','#settings-device-restart');await capture('devices-pending');
 await browser('click','#settings-nav-general');await install(saved);await browser('eval',"void settingsLoad('general');true");await browser('wait','#settings-restart');
 for(const theme of ['dark','light']){await browser('set','media',theme);await capture('general-pending-'+theme);}
 await browser('click','#settings-restart');await browser('wait','--fn','window.nativeRestart===true');const restarted=await native.restart();await browser('eval',`window.finishNative(${JSON.stringify(restarted)});true`);await browser('wait','--fn',"document.querySelector('#settings-restart').disabled");assert.deepEqual(calls,['drain','relaunch']);await capture('restarting');
 const reopened=await DesktopLifecycle.open(join(directory,'notifications.json'),'1.0.0-rc.1',async()=>({status:'drained'}),()=>{});await install(reopened.read());await browser('eval',"void settingsLoad('general');true");await browser('wait','--fn',"!document.querySelector('#settings-restart') && document.querySelector('#settings-notifications').value==='off'");await capture('reopened');
 await writeFile(join(out,'report.json'),JSON.stringify({states:report,restartCalls:calls,notificationPersisted:!reopened.notifications,externalNetworkCalls:0,evidence:'Fixture IPC boundary with production native persistence and restart coordinator; relaunch is a recorded callback.'},null,2)+'\n');console.log(JSON.stringify({states:report,calls,out}));
}finally{await browser('close').catch(()=>{});await host.close();await rm(directory,{recursive:true,force:true});}
