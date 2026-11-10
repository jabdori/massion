import {browserOriginRule,createBrowserDenyProxy} from './browser-network.ts';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {browserAddress,sensitiveBrowserField,maskBrowserField,browserText,browserPrivateRanges,validateBrowserScreenshot} from './browser-runtime.ts';
import type {BrowserAdapter,RawBrowserPage} from './browser-runtime.ts';
const exec=promisify(execFile);
/** Runs in a fresh script-disabled browser before any screenshot is taken. */
function preparePage(){
 window.stop();const nodes=[...document.querySelectorAll('*')];if(nodes.length>20000)throw Error('Browser DOM bound exceeded');
 const controls=[...document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,select,textarea')];if(controls.length>256)throw Error('Browser form bound exceeded');
 const original=controls.map(e=>({label:[...[...(e.labels??[])].map(label=>label.textContent),e.getAttribute('aria-label'),...(e.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent),e.getAttribute('title'),e.getAttribute('placeholder')].filter(Boolean).join(' ').trim()||e.name||'',type:e.type,name:e.name,value:String(e.value),autocomplete:e.getAttribute('autocomplete')||''}));
 if(original.some(f=>[f.label,f.name,f.type,f.value,f.autocomplete].some(v=>v.length>4000)))throw Error('Browser field bound exceeded');
 const url=new URL(location.href),secrets=[url.username,url.password,url.hash.slice(1),...url.searchParams.values(),...original.filter(maskBrowserField).map(f=>f.value)].filter(Boolean).sort((a,b)=>b.length-a.length),clean=(value:string)=>browserText(value,secrets);
 for(const e of nodes){
  if(['SCRIPT','IFRAME','FRAME','OBJECT','EMBED','CANVAS','VIDEO','AUDIO'].includes(e.tagName)||e.tagName==='META'&&e.getAttribute('http-equiv')?.toLowerCase()==='refresh'||e.tagName.includes('-')||e.hasAttribute('contenteditable')){e.remove();continue;}
  for(const attr of [...e.attributes]){if(attr.name.startsWith('on')){e.removeAttribute(attr.name);continue;}const value=clean(attr.value);if(value!==attr.value){if(['src','srcset','href','action','formaction'].includes(attr.name))e.removeAttribute(attr.name);else e.setAttribute(attr.name,value);}}
 }
 // Untrusted pixels cannot be matched to private strings. Preserve boxes, neutralize their paint.
 const imageProperties=['background-image','border-image-source','mask-image','-webkit-mask-image','list-style-image','clip-path','filter','backdrop-filter'];
 for(const e of nodes){if(!e.isConnected)continue;const style=(e as HTMLElement).style;if(!style)throw Error('Unsupported visual element');const family=/\bmonospace\b/.test(getComputedStyle(e).fontFamily)?'ui-monospace':'system-ui';style.setProperty('animation','none','important');style.setProperty('transition','none','important');for(const property of imageProperties)style.setProperty(property,'none','important');style.setProperty('content','normal','important');style.setProperty('font-family',family,'important');if(['IMG','PICTURE','SVG'].includes(e.tagName.toUpperCase())||e.tagName==='INPUT'&&e.getAttribute('type')==='image')style.setProperty('opacity','0','important');}
 const walker=document.createTreeWalker(document.documentElement,NodeFilter.SHOW_TEXT);let node;while(node=walker.nextNode())node.textContent=clean(node.textContent||'');
 // Match text across element boundaries before changing individual nodes; keep the page layout.
 for(const visibleOnly of [false,true]){
  const spans:{node:Node;start:number;end:number;text:string}[]=[];let flat='';const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
  while(node=walker.nextNode()){if(visibleOnly){let parent=node.parentElement;if(!parent||getComputedStyle(parent).visibility!=='visible')continue;while(parent&&getComputedStyle(parent).display==='contents')parent=parent.parentElement;if(!parent?.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))continue;}const text=node.textContent||'',start=flat.length;flat+=text;if(flat.length>262144)throw Error('Browser text bound exceeded');spans.push({node,start,end:flat.length,text});}
  const ranges=browserPrivateRanges(flat,secrets);let index=0;
  for(const span of spans){while(index<ranges.length&&ranges[index]![1]<=span.start)index++;let offset=span.start,result='';for(let i=index;i<ranges.length&&ranges[i]![0]<span.end;i++){const [start,end]=ranges[i]!;result+=span.text.slice(offset-span.start,Math.max(start,span.start)-span.start);if(start>=span.start)result+='••••';offset=Math.min(end,span.end);}result+=span.text.slice(offset-span.start);if(result!==span.text)span.node.textContent=result;}
 }
 controls.forEach((e,index)=>{const f=original[index]!;if(!e.isConnected)return;if(maskBrowserField(f)){if(e instanceof HTMLInputElement&&e.type!=='hidden')e.type='text';if(e instanceof HTMLSelectElement){e.replaceChildren(new Option('••••','••••'));}e.value='••••';e.setAttribute('value','••••');}else{e.value=clean(f.value);e.setAttribute('value',clean(f.value));}});
 const policy=document.createElement('meta');policy.httpEquiv='Content-Security-Policy';policy.content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'";document.head.prepend(policy);
 const paintPseudos=['::before','::after','::marker','::first-letter','::first-line','::placeholder','::selection','::backdrop'];
 const style=document.createElement('style');style.textContent='@layer massion-private-capture{'+['*',...paintPseudos.map(p=>'*'+p)].join(',')+'{animation:none!important;transition:none!important;caret-color:transparent!important;font-family:system-ui!important;'+imageProperties.map(p=>p+':none!important;').join('')+'}*::before,*::after,*::marker{content:none!important}}';document.head.prepend(style);
 for(const e of document.querySelectorAll('*'))for(const pseudo of ['::before','::after','::marker'])if(!['','none','normal'].includes(getComputedStyle(e,pseudo).content))throw Error('Browser generated content could not be suppressed');
 for(const e of nodes){if(!e.isConnected)continue;for(const pseudo of paintPseudos){const paint=getComputedStyle(e,pseudo);if(imageProperties.some(property=>!['','none'].includes(paint.getPropertyValue(property)))||paint.fontFamily&&!['system-ui','ui-monospace'].includes(paint.fontFamily))throw Error('Uninspectable browser pseudo-element pixels remain');}const style=getComputedStyle(e);if(imageProperties.some(property=>style.getPropertyValue(property)!=='none')||!['system-ui','ui-monospace'].includes(style.fontFamily)||['IMG','PICTURE','SVG'].includes(e.tagName.toUpperCase())&&style.opacity!=='0')throw Error('Uninspectable browser pixels remain');}
 if(clean(document.body.innerText)!==document.body.innerText)throw Error('Browser screenshot redaction incomplete');
 return {address:location.href,title:clean(document.title),blocks:[...document.querySelectorAll('h1,h2,h3,p,dt,dd,td,th,li')].filter(e=>e.checkVisibility({checkVisibilityCSS:true,checkOpacity:true})).slice(0,64).map(e=>((e as HTMLElement).innerText||'').trim().slice(0,4000)),fields:original.slice(0,64).map(f=>({...f,label:clean(f.label),value:maskBrowserField(f)?'••••':clean(f.value)}))};
}
export async function captureBrowserPage(run:(args:string[])=>Promise<any>,control:{assertDocument:(expected?:number)=>Promise<number>;screenshot:()=>Promise<string>}):Promise<RawBrowserPage>{
 const documentId=await control.assertDocument();await run(['set','viewport','584','764']);
 const script=`const browserPrivateRanges=${browserPrivateRanges.toString()};const sensitiveBrowserField=${sensitiveBrowserField.toString()};const maskBrowserField=${maskBrowserField.toString()};const browserText=${browserText.toString()};(${preparePage.toString()})()`;
 const page=(await run(['eval','-b',Buffer.from(script).toString('base64')])).result as RawBrowserPage;
 await control.assertDocument(documentId);const data=await control.screenshot();if(typeof data!=='string'||data.length>262144)throw Error('Browser screenshot byte bound exceeded');const bytes=Buffer.from(data,'base64');if(bytes.length<24)throw Error('Invalid browser screenshot');
 const screenshot={mimeType:'image/png' as const,data,width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};validateBrowserScreenshot(screenshot);return {...page,screenshot};
}
/** Hold a CDP session so disabling page scripts survives navigation until browser cleanup. */
export async function disableBrowserScripts(run:(args:string[])=>Promise<any>,signal?:AbortSignal):Promise<{assertDocument:(expected?:number)=>Promise<number>;screenshot:()=>Promise<string>;close:()=>Promise<void>}>{
 signal?.throwIfAborted();await run(['--no-pin-tab','get','url']);const bound=await run(['--pin-tab','get','url']);if(bound.url!=='about:blank')throw Error('Fresh browser page required');const {cdpUrl}=await run(['get','cdp-url']);let url:URL;try{url=new URL(cdpUrl);}catch{throw Error('Browser script control unavailable');}
 if(url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||!url.pathname.startsWith('/devtools/browser/'))throw Error('Local browser script control required');
 const socket=new WebSocket(url),deadline=AbortSignal.any([AbortSignal.timeout(5000),...(signal?[signal]:[])]);
 try{await new Promise<void>((resolve,reject)=>{const stop=()=>reject(Error('Browser script control unavailable')),timer=setTimeout(stop,5000);socket.addEventListener('open',()=>{clearTimeout(timer);resolve();},{once:true});socket.addEventListener('error',()=>{clearTimeout(timer);stop();},{once:true});});deadline.throwIfAborted();}catch(error){socket.close();throw error;}
 let sequence=0,pageSessionId='';
 const call=(method:string,params:object,sessionId?:string)=>new Promise<any>((resolve,reject)=>{
  const id=++sequence,timer=setTimeout(()=>finish(Error('Browser script control timed out')),5000),receive=(event:MessageEvent)=>{let message;try{message=JSON.parse(String(event.data));}catch{return;}if(message.id===id)finish(message.error?Error('Browser script control failed'):null,message.result);},closed=()=>finish(Error('Browser script control closed'));
  const finish=(error:Error|null,result?:unknown)=>{clearTimeout(timer);socket.removeEventListener('message',receive);socket.removeEventListener('close',closed);error?reject(error):resolve(result);};socket.addEventListener('message',receive);socket.addEventListener('close',closed);try{socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));}catch{closed();}
 });
 try{const {targetInfos}=await call('Target.getTargets',{}),pages=targetInfos.filter((t:any)=>t.type==='page'),blank=pages.filter((t:any)=>t.url==='about:blank');if(blank.length!==1||pages.some((t:any)=>!['about:blank','chrome://newtab/'].includes(t.url)))throw Error('Fresh browser page required');for(const p of pages)if(p.url==='chrome://newtab/')await call('Target.closeTarget',{targetId:p.targetId});const {sessionId}=await call('Target.attachToTarget',{targetId:blank[0].targetId,flatten:true});pageSessionId=sessionId;await call('Browser.setDownloadBehavior',{behavior:'deny',...(blank[0].browserContextId?{browserContextId:blank[0].browserContextId}:{})});await call('Emulation.setScriptExecutionDisabled',{value:true},sessionId);signal?.throwIfAborted();}
 catch(error){try{await call('Browser.close',{});}catch{}socket.close();throw error;}
 return {async assertDocument(expected){const current=await run(['get','url']),{root}=await call('DOM.getDocument',{depth:-1,pierce:true},pageSessionId);if(root.documentURL!==current.url||!Number.isSafeInteger(root.backendNodeId)||expected!==undefined&&root.backendNodeId!==expected)throw Error('Browser document changed during capture');const pending=[root];let count=0;while(pending.length){const node=pending.pop();if(++count>50000)throw Error('Browser document bound exceeded');if(node.shadowRoots?.some((r:any)=>r.shadowRootType==='open'||r.shadowRootType==='closed'))throw Error('Author shadow DOM cannot be safely captured');pending.push(...(node.children??[]));}return root.backendNodeId;},async screenshot(){const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false},pageSessionId);return data;},async close(){if(socket.readyState===WebSocket.OPEN)try{await call('Browser.close',{});}catch{}socket.close();}};
}
export function localBrowserAdapter(env:Record<string,string|undefined>):BrowserAdapter|undefined{
 if(env.MASSION_BROWSER_READS===undefined||env.MASSION_BROWSER_READS==='0')return undefined;
 if(env.MASSION_BROWSER_READS!=='1')throw Error('Invalid local browser setting');
 const origins=(env.MASSION_BROWSER_ORIGINS??'').split(',');
 for(const origin of origins)browserOriginRule(origin);
 return {async read({address,signal}):Promise<RawBrowserPage>{
  if(address!==browserAddress(address)||!origins.includes(new URL(address).origin))throw Error('Browser address is outside the local origin setting');signal.throwIfAborted();
  const dir=await mkdtemp(join(tmpdir(),'massion-browser-')),config=join(dir,'config.json'),session='massion-read-'+randomUUID();
  const childEnv={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_NO_VERSION_CHECK:'1',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'};
  const run=async(args:string[],cancel:AbortSignal|undefined=signal)=>{const {stdout}=await exec('agent-browser',['--config',config,'--session',session,'--headed','false','--hide-scrollbars','false','--allowed-domains',new URL(address).hostname,'--json',...args],{cwd:dir,env:childEnv,timeout:30000,maxBuffer:262144,signal:cancel});const result=JSON.parse(stdout);if(!result.success)throw Error('Browser read failed');return result.data;};
  let control:Awaited<ReturnType<typeof disableBrowserScripts>>|undefined,network:Awaited<ReturnType<typeof createBrowserDenyProxy>>|undefined;
  try{network=await createBrowserDenyProxy();await writeFile(config,JSON.stringify({proxy:network.url,proxyBypass:'<-loopback>;'+browserOriginRule(new URL(address).origin),args:'--force-webrtc-ip-handling-policy=disable_non_proxied_udp'}),{mode:0o600});await run(['open']);control=await disableBrowserScripts(run,signal);await run(['open',address]);return await captureBrowserPage(run,control);}
  catch{throw Error('Local browser read failed');}
  finally{try{try{if(network)await run(['close'],AbortSignal.timeout(5000));}catch{}await control?.close();await network?.close();}finally{await rm(dir,{recursive:true,force:true});}}
 }};
}
