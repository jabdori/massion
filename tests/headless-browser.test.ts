import test from 'node:test';
import assert from 'node:assert/strict';
import {localBrowserAdapter} from '../src/headless-browser.ts';
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
 const dir=await mkdtemp(join(tmpdir(),'browser-cli-fixture-')),log=join(dir,'calls.jsonl'),original=process.env.PATH;
 t.after(async()=>{process.env.PATH=original;await rm(dir,{recursive:true,force:true});});
 await writeFile(join(dir,'agent-browser'),`#!${process.execPath}\nconst fs=require('node:fs'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,config:fs.readFileSync(a[a.indexOf('--config')+1],'utf8'),env:Object.keys(process.env)})+'\\n');console.log(JSON.stringify({success:true,data:a.includes('eval')?{result:{address:'https://shop.example.com/',title:'Fixture',blocks:[],fields:[]}}:{}}));`,{mode:0o700});
 process.env.PATH=dir+':'+original;const adapter=localBrowserAdapter({MASSION_BROWSER_READS:'1',MASSION_BROWSER_ORIGINS:'https://shop.example.com'})!;
 const page=await adapter.read({address:'https://shop.example.com/',sessionId:'work-session',signal:new AbortController().signal});assert.equal(page.title,'Fixture');
 const calls=(await readFile(log,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.length,3);assert.ok(calls[2].args.includes('close'));assert.equal(new Set(calls.map(c=>c.args[c.args.indexOf('--session')+1])).size,1);
 for(const call of calls){assert.equal(call.config,'{}\n');assert.ok(call.args.includes('--blink-settings=scriptEnabled=false'));assert.equal(call.args[call.args.indexOf('--headed')+1],'false');assert.equal(call.args[call.args.indexOf('--allowed-domains')+1],'shop.example.com');assert.ok(!call.args.includes('--profile'));assert.ok(!call.env.includes('MASSION_SURREAL_RPC'));}
});
