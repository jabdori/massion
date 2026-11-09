import test from 'node:test';
import assert from 'node:assert/strict';
import {localBrowserAdapter,disableBrowserScripts} from '../src/headless-browser.ts';
test('real browser is disabled by default and requires explicit HTTPS origins',()=>{
 assert.equal(localBrowserAdapter({}),undefined);
 assert.throws(()=>localBrowserAdapter({MASSION_BROWSER_READS:'yes'}),/setting/);
 assert.throws(()=>localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:'http://127.0.0.1'}),/HTTPS/);
 assert.throws(()=>localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:'https://example.com/path'}),/origin/);
});
test('adapter rejects out-of-scope addresses before any browser process starts',async()=>{
 const adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:'https://shop.example.com'})!;
 await assert.rejects(adapter.read({address:'https://other.example.com/',sessionId:'session',signal:new AbortController().signal}),/origin/);
 await assert.rejects(adapter.read({address:'https://shop.example.com/?token=secret',sessionId:'session',signal:new AbortController().signal}),/address/);
});
test('headless adapter uses an isolated configuration and closes its session after a bounded read',async t=>{
 const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const methods:string[]=[];
 class Socket extends EventTarget{static OPEN=1;readyState=1;constructor(_url:URL){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}send(raw:string){const m=JSON.parse(raw);methods.push(m.method);const result=m.method==='Target.getTargets'?{targetInfos:[{type:'page',url:'about:blank',targetId:'page'}]}:m.method==='Target.attachToTarget'?{sessionId:'control'}:m.method==='DOM.getDocument'?{root:{backendNodeId:1,documentURL:'https://shop.example.com/',children:[]}}:{};queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({id:m.id,result})})));}close(){this.readyState=3;this.dispatchEvent(new Event('close'));}}
 const originalSocket=globalThis.WebSocket;globalThis.WebSocket=Socket as unknown as typeof WebSocket;t.after(()=>{globalThis.WebSocket=originalSocket;});
 const dir=await mkdtemp(join(tmpdir(),'browser-cli-fixture-')),log=join(dir,'calls.jsonl'),original=process.env.PATH;
 t.after(async()=>{process.env.PATH=original;await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'agent-browser'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,config:fs.readFileSync(a[a.indexOf('--config')+1],'utf8'),env:Object.keys(process.env)})+'\\n');if(a.includes('screenshot'))fs.writeFileSync(a[a.indexOf('screenshot')+1],Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=','base64'));const opened=fs.readFileSync(${JSON.stringify(log)},'utf8').trim().split('\\n').map(JSON.parse).map(c=>c.args).filter(args=>args.includes('open')).at(-1);const url=opened?.[opened.indexOf('open')+1]||'about:blank';console.log(JSON.stringify({success:true,data:a.includes('cdp-url')?{cdpUrl:'ws://127.0.0.1:9999/devtools/browser/fixture'}:a.includes('get')?{url}:a.includes('eval')?{result:{address:'https://shop.example.com/',title:'Fixture',blocks:[],fields:[]}}:{}}));`,{mode:0o700});
 process.env.PATH=dir+':'+original;const adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:'https://shop.example.com'})!;
 const page=await adapter.read({address:'https://shop.example.com/',sessionId:'work-session',signal:new AbortController().signal});assert.equal(page.title,'Fixture');
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.filter(c=>c.args.includes('screenshot')).length,1);assert.ok(calls.at(-1).args.includes('close'));assert.ok(methods.includes('Emulation.setScriptExecutionDisabled'));assert.equal(new Set(calls.map(c=>c.args[c.args.indexOf('--session')+1])).size,1);
 for(const call of calls){assert.equal(call.config,'{}\n');assert.ok(!call.args.includes('--blink-settings=scriptEnabled=false'));assert.equal(call.args[call.args.indexOf('--headed')+1],'false');assert.equal(call.args[call.args.indexOf('--allowed-domains')+1],'shop.example.com');assert.ok(!call.args.includes('--profile'));assert.ok(!call.env.includes('MASSION_SURREAL_RPC'));}
});

test('browser script control rejects nonlocal debugger endpoints',async()=>{for(const cdpUrl of ['ws://example.com/devtools/browser/id','ws://user:password@127.0.0.1/devtools/browser/id','ws://127.0.0.1/not-a-browser','http://127.0.0.1/devtools/browser/id'])await assert.rejects(disableBrowserScripts(async args=>args.includes('cdp-url')?{cdpUrl}:{url:'about:blank'}),/Local browser script control/);});
