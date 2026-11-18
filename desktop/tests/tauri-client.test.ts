import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

async function boot(handlers:Record<string,(args:any)=>any>={}){
 const script=await readFile(new URL('../tauri-client.js',import.meta.url),'utf8');
 const calls:{command:string;args:any}[]=[];
 let channel:unknown;
 let listener:((event:{payload:unknown})=>void)|undefined;
 class Channel{onmessage:((line:unknown)=>void)|null=null}
 const context:any={window:{}};
 context.__TAURI__={
  core:{invoke:(command:string,args:any)=>{calls.push({command,args});return Promise.resolve(handlers[command]?handlers[command](args):'{}');},Channel},
  event:{listen:(_name:string,handle:(event:{payload:unknown})=>void)=>{listener=handle;return Promise.resolve(()=>{});}},
 };
 context.window.__TAURI__=context.__TAURI__;
 runInNewContext(script,context);
 context.channelObject=channel;
 const channelOf=()=>calls.find(call=>call.command==='desktop_events_subscribe')?.args.channel as {onmessage:((line:unknown)=>void)|null};
 return {calls,context,listener:()=>listener,channel:channelOf};
}

test('the bootstrap stays inert without the Tauri global API',async()=>{
 const context:any={window:{}};
 const script=await readFile(new URL('../tauri-client.js',import.meta.url),'utf8');
 runInNewContext(script,context);
 assert.equal(context.window.massionDesktop,undefined);
 assert.equal(context.window.__massionSseSource,undefined);
});

test('massionDesktop exposes the four methods through Tauri commands',async t=>{
 const {calls,context}=await boot({
  desktop_settings:()=>'{"notifications":true}',
  desktop_save_notifications:()=>'{"notifications":false}',
  desktop_restart:()=>'{"restartStatus":"idle"}',
 });
 assert.equal(JSON.stringify(await context.window.massionDesktop.getSettings()),'{"notifications":true}');
 assert.equal(JSON.stringify(await context.window.massionDesktop.saveNotifications(false)),'{"notifications":false}');
 assert.equal(JSON.stringify(await context.window.massionDesktop.restart()),'{"restartStatus":"idle"}');
 assert.equal(calls.filter(call=>call.command==='desktop_save_notifications')[0]!.args.value,false);
 assert.throws(()=>context.window.massionDesktop.onFocus('nope'),/Focus callback required/);
 assert.equal(Object.isFrozen(context.window.massionDesktop),true);
 void t;
});

test('onFocus registers the listener, reports readiness and unsubscribes',async()=>{
 const {calls,context,listener}=await boot();
 const seen:unknown[]=[];
 const stop=context.window.massionDesktop.onFocus((target:unknown)=>seen.push(target));
 assert.equal(calls.some(call=>call.command==='desktop_ready'),true);
 listener()!({payload:{feedId:'feed',decisionId:'d1'}});
 assert.equal(JSON.stringify(seen),'[{"feedId":"feed","decisionId":"d1"}]');
 stop();
 listener()!({payload:{feedId:'feed',decisionId:'d2'}});
 assert.equal(JSON.stringify(seen),'[{"feedId":"feed","decisionId":"d1"}]');
});

test('the channel-fed event source resumes from the last event id',async()=>{
 const {calls,context,channel}=await boot();
 const first=context.window.__massionSseSource('/protocol/events?after=0');
 const opened:boolean[]=[];
 first.onopen=()=>opened.push(true);
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(opened[0],true);
 const subscribe=calls.find(call=>call.command==='desktop_events_subscribe')!;
 assert.equal(subscribe.args.subscription,'sub-1');
 assert.equal(subscribe.args.path,'/protocol/events?after=0');
 assert.equal(subscribe.args.lastEventId,null);
 assert.ok(subscribe.args.channel);
 const messages:string[]=[];
 first.onmessage=(event:{lastEventId:string;data:string})=>messages.push(event.data);
 channel()!.onmessage!({event:'message',subscription:'sub-1',lastEventId:'["feed",5]',data:'{"cursor":5}'});
 assert.deepEqual(messages,['{"cursor":5}']);
 first.close();
 assert.equal(calls.at(-1)!.command,'desktop_events_close');
 assert.equal(calls.at(-1)!.args.subscription,'sub-1');
 const second=context.window.__massionSseSource('/protocol/events?after=0');
 await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(calls.at(-1)!.args.lastEventId,'["feed",5]');
 second.close();
 const failures:string[]=[];
 second.onerror=()=>failures.push('x');
 channel()!.onmessage!({event:'error',subscription:'sub-1'});
 assert.equal(failures.length,0,'a closed source no longer receives events');
});

test('an event delivered before the subscribe response resolves still reaches the source',async()=>{
 let release!:()=>void;
 const {context,channel}=await boot({desktop_events_subscribe:()=>new Promise(resolve=>{release=()=>resolve(undefined);})});
 const seen:string[]=[];
 const source=context.window.__massionSseSource('/protocol/events?after=0');
 source.onmessage=(event:{lastEventId:string;data:string})=>seen.push(event.data);
 channel()!.onmessage!({event:'message',subscription:'sub-1',lastEventId:'["feed",1]',data:'{"cursor":1}'});
 assert.deepEqual(seen,['{"cursor":1}'],'registration precedes any event delivery');
 release();
 await new Promise(resolve=>setTimeout(resolve,10));
 source.close();
});

test('a quit failure does not dispatch a focus target',async()=>{
 const {context,listener}=await boot();
 const seen:unknown[]=[];
 context.window.massionDesktop.onFocus((target:unknown)=>seen.push(target));
 listener()!({payload:{quitFailure:'quit-unsettled'}});
 assert.deepEqual(seen,[]);
});
