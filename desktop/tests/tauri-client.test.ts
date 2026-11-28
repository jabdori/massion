import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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

test('the first contentful paint reports the round of its own document',async()=>{
 const rust=await readFile(new URL('../tauri/src/first_paint.rs',import.meta.url),'utf8');
 const script=rust.match(/const PAINT_SCRIPT: &str = r#"([\s\S]*?)"#;/)?.[1];
 assert.ok(script,'missing first paint script');
 const calls:unknown[][]=[];
 for(const round of ['17','18']){
  let onReady!:()=>void;
  let onPaint!:(list:{getEntriesByName:(name:string)=>unknown[]},observer:{disconnect:()=>void})=>void;
  let disconnected=false;
  const location={search:'?__massion_round='+round,hash:'#mission=one'};
  runInNewContext(script,{
   URLSearchParams,
   window:{location,__TAURI__:{core:{invoke:(...args:unknown[])=>{calls.push(args);return Promise.resolve();}}}},
   document:{readyState:'loading',querySelector:(selector:string)=>selector==='#health, .cannot-start #technical-details'?{}:null,addEventListener:(event:string,callback:()=>void)=>{
    assert.equal(event,'DOMContentLoaded');onReady=callback;
   }},
   PerformanceObserver:class{
    constructor(callback:typeof onPaint){onPaint=callback;}
    observe(options:{type:string;buffered:boolean}){assert.equal(options.type,'paint');assert.equal(options.buffered,true);}
   },
  });
  const before=calls.length;
  location.search='?__massion_round=99';
  onReady();
  assert.equal(typeof onPaint,'function','the observer must find the workbench or cannot-start marker');
  const observer={disconnect:()=>{disconnected=true;}};
  onPaint({getEntriesByName:()=>[]},observer);
  assert.equal(calls.length,before);
  onPaint({getEntriesByName:name=>name==='first-contentful-paint'?[{}]:[]},observer);
  assert.equal(disconnected,true);
  assert.equal(JSON.stringify(calls.at(-1)),JSON.stringify(['desktop_ready',{firstPaint:round}]));
 }
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

test('the host cannot-start document matches the copy table and pins exact CSP hashes',async()=>{
 const [rust,copyRaw]=await Promise.all([
  readFile(new URL('../tauri/src/cannot_start.rs',import.meta.url),'utf8'),
  readFile(new URL('../../docs/product/screens/copy.ko.json',import.meta.url),'utf8'),
 ]);
 const copyTable=JSON.parse(copyRaw) as Record<string,{ko:string}>;
 const rustConst=(name:string)=>{
  const match=rust.match(new RegExp(`pub\\(crate\\) const ${name}: &str = (?:"([^"]*)"|r#"([\\s\\S]*?)"#);`));
  assert.ok(match,`missing constant ${name}`);
  return match[1]??match[2]!;
 };
 assert.equal(rustConst('TITLE'),copyTable['ui.desktop.cannot-start.title']?.ko);
 assert.equal(rustConst('MESSAGE'),copyTable['ui.desktop.cannot-start.message']?.ko);
 assert.equal(rustConst('CLOSED_MESSAGE'),copyTable['ui.desktop.cannot-start.closed-message']?.ko);
 assert.equal(rustConst('RETRY_LABEL'),copyTable['conversation.button.07']?.ko);
 assert.equal(rustConst('DETAILS_LABEL'),copyTable['ui.desktop.cannot-start.details']?.ko);
 assert.equal(rustConst('COPY_LABEL'),copyTable['conversation.button.10']?.ko);

 const sha=(text:string)=>`'sha256-${createHash('sha256').update(text).digest('base64')}'`;
 const csp=rustConst('CONTENT_SECURITY_POLICY');
 assert.equal(
  csp,
  `default-src 'none'; script-src ${sha(rustConst('SCRIPT'))}; style-src ${sha(rustConst('STYLE'))}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  'CSP policy and hashes must match exactly',
 );
});

test('the cannot-start retry script invokes desktop_relaunch once and disables the button',async()=>{
 const rust=await readFile(new URL('../tauri/src/cannot_start.rs',import.meta.url),'utf8');
 const match=rust.match(/pub\(crate\) const SCRIPT: &str = r#"([\s\S]*?)"#;/);
 assert.ok(match,'missing SCRIPT');
 const script=match[1]!;

 const makeButton=()=>{
  let listener:(()=>Promise<void>|void)|undefined;
  return {
   disabled:false,
   addEventListener:(event:string,fn:()=>Promise<void>|void)=>{if(event==='click')listener=fn;},
   click:()=>listener?.(),
  };
 };

 // Normal press: invokes desktop_relaunch with no arguments, disables immediately, and ignores a second press.
 {
  const retry=makeButton(),copy=makeButton(),details={textContent:'start-connection-unavailable'};
  const calls:{command:string;args:unknown[]}[]=[];
  let release!:()=>void;
  const context:any={
   document:{getElementById:(id:string)=>id==='retry-launch'?retry:id==='copy-details'?copy:id==='technical-details'?details:null},
   window:{__TAURI__:{core:{invoke:(command:string,...rest:unknown[])=>{calls.push({command,args:rest});return new Promise<void>(resolve=>{release=resolve;});}}}},
  };
  runInNewContext(script,context);
  const first=retry.click();
  assert.equal(retry.disabled,true,'button must disable immediately on the first click');
  await retry.click();
  assert.equal(calls.length,1,'second click while pending must not invoke again');
  release();
  await first;
  assert.equal(retry.disabled,true,'button stays disabled after relaunch request');
  await retry.click();
  assert.deepEqual(calls,[{command:'desktop_relaunch',args:[]}]);
 }

 // Refused press (for example current_binary unavailable): re-enables the button so the user is not stranded.
 {
  const retry=makeButton(),copy=makeButton(),details={textContent:'start-connection-unavailable'};
  let attempts=0;
  const context:any={
   document:{getElementById:(id:string)=>id==='retry-launch'?retry:id==='copy-details'?copy:id==='technical-details'?details:null},
   window:{__TAURI__:{core:{invoke:()=>{attempts+=1;return Promise.reject(new Error('unavailable'));}}}},
  };
  runInNewContext(script,context);
  await retry.click();
  assert.equal(attempts,1);
  assert.equal(retry.disabled,false,'button must re-enable when desktop_relaunch rejects');
 }
});
