import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {browserAddress} from './browser-runtime.ts';
import type {BrowserAdapter,RawBrowserPage} from './browser-runtime.ts';
const exec=promisify(execFile);
// Disable page scripts; return observed text only and sanitize before persistence.
const readPage=`(()=>({address:location.href,title:document.title,blocks:Array.from(document.querySelectorAll('h1,h2,h3,p,dt,dd,td,th,li')).filter(e=>e.checkVisibility()).slice(0,64).map(e=>e.textContent.trim().slice(0,4000)),fields:Array.from(document.querySelectorAll('input,select,textarea')).slice(0,64).map(e=>({label:(e.labels?.[0]?.textContent||e.getAttribute('aria-label')||e.name||'').trim().slice(0,4000),type:e.type,value:String(e.value).slice(0,4000),autocomplete:e.autocomplete||''}))}))()`;
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
  const run=async(args:string[],cancel:AbortSignal|undefined=signal)=>{const {stdout}=await exec('agent-browser',['--config',config,'--session',session,'--headed','false','--allowed-domains',new URL(address).hostname,'--args','--blink-settings=scriptEnabled=false','--json',...args],{cwd:dir,env:childEnv,timeout:30000,maxBuffer:262144,signal:cancel});const result=JSON.parse(stdout);if(!result.success)throw Error('Browser read failed');return result.data;};
  try{await run(['open',address]);return (await run(['eval','-b',Buffer.from(readPage).toString('base64')])).result as RawBrowserPage;}
  catch{throw Error('Local browser read failed');}
  finally{try{await run(['close'],AbortSignal.timeout(5000));}catch{}await rm(dir,{recursive:true,force:true});}
 }};
}
