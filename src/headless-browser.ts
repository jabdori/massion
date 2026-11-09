import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,stat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {browserAddress,sensitiveBrowserField,maskBrowserField,browserText,validateBrowserScreenshot} from './browser-runtime.ts';
import type {BrowserAdapter,RawBrowserPage} from './browser-runtime.ts';
const exec=promisify(execFile);
/** Runs in a fresh script-disabled browser before any screenshot is taken. */
function preparePage(){
 window.stop();const nodes=[...document.querySelectorAll('*')];if(nodes.length>20000)throw Error('Browser DOM bound exceeded');
 const controls=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')];if(controls.length>256)throw Error('Browser form bound exceeded');
 const original=controls.map(e=>({label:(e.labels?.[0]?.textContent||e.getAttribute('aria-label')||e.name||'').trim(),type:e.type,name:e.name,value:String(e.value),autocomplete:e.getAttribute('autocomplete')||''}));
 if(original.some(f=>[f.label,f.name,f.type,f.value,f.autocomplete].some(v=>v.length>4000)))throw Error('Browser field bound exceeded');
 const url=new URL(location.href),secrets=[url.username,url.password,url.hash.slice(1),...url.searchParams.values(),...original.filter(maskBrowserField).map(f=>f.value)].filter(Boolean).sort((a,b)=>b.length-a.length),clean=(value:string)=>browserText(value,secrets);
 for(const e of nodes){
  if(['SCRIPT','IFRAME','FRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO'].includes(e.tagName)||e.tagName.includes('-')||e.hasAttribute('contenteditable')){e.remove();continue;}
  for(const attr of [...e.attributes])if(['value','placeholder','title','alt','aria-label','style'].includes(attr.name)||attr.name.startsWith('data-')){const value=clean(attr.value);if(value!==attr.value)e.setAttribute(attr.name,value);}
 }
 const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())node.textContent=clean(node.textContent||'');
 controls.forEach((e,index)=>{const f=original[index]!;if(!e.isConnected)return;if(maskBrowserField(f)){if(e instanceof HTMLInputElement&&e.type!=='hidden')e.type='text';if(e instanceof HTMLSelectElement){e.replaceChildren(new Option('••••','••••'));}e.value='••••';e.setAttribute('value','••••');}else{e.value=clean(f.value);e.setAttribute('value',clean(f.value));}});
 const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";document.head.prepend(policy);
 const style=document.createElement('style');style.textContent='*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';document.head.append(style);
 return {address:location.href,title:clean(document.title),blocks:[...document.querySelectorAll('h1,h2,h3,p,dt,dd,td,th,li')].filter(e=>e.checkVisibility()).slice(0,64).map(e=>(e.textContent||'').trim().slice(0,4000)),fields:original.slice(0,64).map(f=>({...f,label:clean(f.label),value:maskBrowserField(f)?'••••':clean(f.value)}))};
}
export async function captureBrowserPage(run:(args:string[])=>Promise<any>,path:string):Promise<RawBrowserPage>{
 await run(['set','viewport','584','764']);
 const script=`const sensitiveBrowserField=${sensitiveBrowserField.toString()};const maskBrowserField=${maskBrowserField.toString()};const browserText=${browserText.toString()};(${preparePage.toString()})()`;
 const page=(await run(['eval','-b',Buffer.from(script).toString('base64')])).result as RawBrowserPage;
 await run(['screenshot',path]);if((await stat(path)).size>196608)throw Error('Browser screenshot byte bound exceeded');const bytes=await readFile(path);if(bytes.length<24)throw Error('Invalid browser screenshot');
 const screenshot={mimeType:'image/png' as const,data:bytes.toString('base64'),width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};validateBrowserScreenshot(screenshot);return {...page,screenshot};
}
/** Hold a CDP session so disabling page scripts survives navigation until browser cleanup. */
export async function disableBrowserScripts(run:(args:string[])=>Promise<any>,signal?:AbortSignal):Promise<()=>Promise<void>>{
 signal?.throwIfAborted();const {cdpUrl}=await run(['get','cdp-url']);let url:URL;try{url=new URL(cdpUrl);}catch{throw Error('Browser script control unavailable');}
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/devtools/browser/'))throw Error('Local browser script control required');
 const socket=new WebSocket(url),deadline=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
 try{await new Promise<void>((resolve,reject)=>{const stop=()=>reject(Error('Browser script control unavailable')),timer=setTimeout(stop,5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);stop();},{once:true});});deadline.throwIfAborted();}catch(error){socket.close();throw error;}
 let sequence=0;
 const call=(method:string,params:object,sessionId?:string)=>new Promise<any>((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>finish(Error('Browser script control timed out')),5000),receive=(event:MessageEvent)=>{let message;try{message=JSON.parse(String(event.data));}catch{return;}if(message.id===id)finish(message.error?Error('Browser script control failed'):null,message.result);},closed=()=>finish(Error('Browser script control closed'));
  const finish=(error:Error|null,result?:unknown)=>{clearTimeout(timer);socket.removeEventListener('message',receive);socket.removeEventListener('close',closed);error?reject(error):resolve(result);};socket.addEventListener('message',receive);socket.addEventListener('close',closed);try{socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{closed();}
 });
 try{const {targetInfos}=await call('Target.getTargets',{}),pages=targetInfos.filter((t:any)=>t.type==='page'),blank=pages.filter((t:any)=>t.url==='about:blank');if(blank.length!==1||pages.some((t:any)=>!['about:blank','chrome://newtab/'].includes(t.url)))throw Error('Fresh browser page required');for(const p of pages)if(p.url==='chrome://newtab/')await call('Target.closeTarget',{targetId:p.targetId});const {sessionId}=await call('Target.attachToTarget',{targetId:blank[0].targetId,flatten:true});await call('Emulation.setScriptExecutionDisabled',{value:true},sessionId);signal?.throwIfAborted();}
 catch(error){try{await call('Browser.close',{});}catch{}socket.close();throw error;}
 return async()=>{if(socket.readyState===WebSocket.OPEN)try{await call('Browser.close',{});}catch{}socket.close();};
}
export function localBrowserAdapter(env:Record<string,string|undefined>):BrowserAdapter|undefined{
 if(env.MASSION_BROWSER_READS===undefined||env.MASSION_BROWSER_READS==='0')return undefined;
 if(env.MASSION_BROWSER_READS!=='1')throw Error('Invalid local browser setting');
 const origins=(env.MASSION_BROWSER_ORIGINS??'').split(',');
 for(const origin of origins){let url:URL;try{url=new URL(origin);}catch{throw Error('Explicit HTTPS browser origins required');}if(url.protocol!=='https:'||url.origin!==origin||url.username||url.password)throw Error('Exact HTTPS browser origin required');}
 return {async read({address,signal}):Promise<RawBrowserPage>{
  if(address!==browserAddress(address)||!origins.includes(new URL(address).origin))throw Error('Browser address is outside the local origin setting');signal.throwIfAborted();
  const dir=await mkdtemp(join(tmpdir(),'massion-browser-')),config=join(dir,'config.json'),session='massion-read-'+randomUUID();
  await writeFile(config,'{}\n',{mode:0o600});
  const childEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_NO_VERSION_CHECK:'1',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'};
  const run=async(args:string[],cancel:AbortSignal|undefined=signal)=>{const {stdout}=await exec('agent-browser',['--config',config,'--session',session,'--headed','false','--hide-scrollbars','false','--allowed-domains',new URL(address).hostname,'--json',...args],{cwd:dir,env:childEnv,timeout:30000,maxBuffer:262144,signal:cancel});const result=JSON.parse(stdout);if(!result.success)throw Error('Browser read failed');return result.data;};
  let closeControl:undefined|(()=>Promise<void>);
  try{await run(['open']);closeControl=await disableBrowserScripts(run,signal);await run(['open',address]);return await captureBrowserPage(run,join(dir,'page.png'));}
  catch{throw Error('Local browser read failed');}
  finally{try{await run(['close'],AbortSignal.timeout(5000));}catch{}await closeControl?.();await rm(dir,{recursive:true,force:true});}
 }};
}
