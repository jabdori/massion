import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Script} from 'node:vm';
import {workbenchPage} from '../../src/workbench.ts';
import {harness,reply,settle,type TauriGlobal} from '../../tests/support/workbench-client.ts';

// Built once for both tests: the proof below must execute the page exactly as
// the build writes it, with its scripts in document order.
await promisify(execFile)(process.execPath,['build.mjs'],{cwd:new URL('..',import.meta.url)});
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]!);

test('desktop build preserves iframe client strings and defines the inert Tauri bootstrap before the workbench script',async()=>{
 assert.equal(scripts.length,3);
 for(const script of scripts)assert.doesNotThrow(()=>new Script(script),'Bundled renderer scripts must parse');
 const original=[...workbenchPage.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]!);
 assert.equal(scripts[0],'\n'+await readFile(new URL('../tauri-client.js',import.meta.url),'utf8')+'\n','The guarded Tauri bootstrap is defined before the workbench reads window.__massionSseSource');
 assert.equal(scripts[1],original[0],'Workbench script remains intact, including iframe HTML');
 assert.equal(scripts[2],'\n'+await readFile(new URL('../host-client.js',import.meta.url),'utf8')+'\n');
});

// Issue #295: classic scripts run in document order and the workbench reads
// window.__massionSseSource while its script evaluates, so a shim defined after
// the workbench leaves the feed on a native EventSource, which cannot stream
// from the massion:// origin.
test('the packaged page opens the event feed through the Tauri shim, not a native EventSource',async()=>{
 const invokes:{command:string;args:any}[]=[];
 class Channel{onmessage:((line:unknown)=>void)|null=null}
 const tauri:TauriGlobal={core:{invoke:(command:string,args:any)=>{invokes.push({command,args});return Promise.resolve('{}');},Channel},event:{listen:()=>Promise.resolve(()=>{})}};
 const app=harness(async path=>path.startsWith('/events')?reply({feedId:'feed:a',cursor:0,events:[]}):reply({}),{},undefined,{scripts,tauri});
 await settle();
 const subscriptions=invokes.filter(call=>call.command==='desktop_events_subscribe');
 assert.equal(subscriptions.length,1,'the workbench feed must subscribe through desktop_events_subscribe');
 assert.equal(app.streams.length,0,'a native EventSource was constructed for the feed');
});

test('desktop packaging uses the root candidate version',async()=>{
 const {createRequire}=await import('node:module'),require=createRequire(import.meta.url);
 const config=require('../electron-builder.cjs'),root=require('../../package.json'),desktop=require('../package.json');
 assert.equal(config.extraMetadata.version,root.version);
 assert.equal(desktop.version,undefined,'Desktop must not maintain a second version');
 assert.equal(config.mac.identity,null);assert.equal(config.mac.notarize,false);
});
