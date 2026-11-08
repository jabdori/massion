#!/usr/bin/env node
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startFixtureHost,loadFixture} from './fixture-host.ts';
import {parseCheck,checkVisual,exitCode,reportMarkdown,isInteractionGap} from './report.ts';

const exec=promisify(execFile),root=fileURLToPath(new URL('../../',import.meta.url));
const specs=join(root,'docs/product/screens'),out=resolve(root,process.env.UI_CONTRACTS_OUTPUT||'.runtime/ui-contracts');
const blocking=process.env.UI_CONTRACTS_BLOCKING==='1';
const requested=process.argv.slice(2),screens=(await readdir(join(specs,'contracts'))).filter(name=>name.endsWith('.json')).map(name=>name.slice(0,-5)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
if(requested.some(screen=>!screens.includes(screen)))throw Error('Unknown screen: '+requested.filter(screen=>!screens.includes(screen)).join(', '));
for(const dir of ['snapshots','screenshots','checks','pairs','visual'])await mkdir(join(out,dir),{recursive:true});
const json=async path=>JSON.parse(await readFile(path,'utf8'));
const visual=await json(join(specs,'visual.json')),artboards=await json(join(specs,'artboards.json'));
// An explicit config and a clean agent-browser environment prevent inheriting a signed-in browser.
const config=join(out,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000',AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
const run=async(command,args,options={})=>exec(command,args,{cwd:root,env,timeout:45000,maxBuffer:8*1024*1024,...options});
const rows=[],runId=randomUUID().slice(0,8);
for(const screen of (requested.length?requested:screens)){
 const contract=await json(join(specs,'contracts',screen+'.json'));
 const row={screen,passed:0,failed:0,warnings:0,required:contract.regions.reduce((sum,r)=>sum+r.elements.filter(e=>e.required).length,0),visualFailures:[],gaps:[],errors:[],pair:null};
 rows.push(row);let host;
 const session=`massion-contract-${runId}-${screen.toLowerCase()}`;
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--allowed-domains','127.0.0.1','--json',...args]);const result=JSON.parse(stdout);if(!result.success)throw Error(result.error||stdout);return result.data;};
 try{
  const fixture=await loadFixture(screen);row.gaps.push(...fixture.gaps);
  host=await startFixtureHost(screen);
  const clock=join(out,'browser-clock.js');
  await writeFile(clock,`{const OriginalDate=Date;globalThis.Date=class extends OriginalDate{constructor(...args){super(...(args.length?args:[${fixture.now}]))}static now(){return ${fixture.now}}}}`);
  await browser('open','--init-script',clock);
  await browser('set','viewport',String(contract.viewport.width),String(contract.viewport.height));
  await browser('open',host.url);
  await browser('wait','--fn',"typeof chatView !== 'undefined' && chatView !== null");
  await browser('wait',fixture.readySelector);
  for(const step of fixture.steps){
   try{
    if(step.action==='fill')await browser('fill',step.selector,step.value);
    else await browser('click',step.selector);
    if(step.readySelector)await browser('wait',step.readySelector);
   }catch(error){if(!isInteractionGap(error))throw error;row.gaps.push(`Interaction ${step.action} ${step.selector}: ${error.message}`);break;}
  }
  await browser('eval','-b',Buffer.from('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))))').toString('base64'));
  const snapshot=await browser('snapshot');
  if(typeof snapshot.snapshot!=='string'||!snapshot.snapshot.trim())throw Error('Empty browser snapshot');
  const snapPath=join(out,'snapshots',screen+'.txt');await writeFile(snapPath,snapshot.snapshot);
  await browser('screenshot',join(out,'screenshots',screen+'.png'));
  let output;
  try{output=(await run(process.execPath,[join(root,'scripts/ui-contracts/contract-check.mjs'),snapPath,join(specs,'contracts',screen+'.json')])).stdout;}
  catch(error){if(error.code!==1)throw error;output=error.stdout;}
  await writeFile(join(out,'checks',screen+'.txt'),output);Object.assign(row,parseCheck(output));
  const expression=`(()=>{const selectors={rail:'.rail',sidebar:'#sidebar',main:'.page-body:not([hidden])',pane:'#work-pane',composer:'.chat-form',header:'.band'};return {tokens:Object.fromEntries(${JSON.stringify(Object.keys(visual.tokens))}.map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue(key).trim()])),regions:Object.fromEntries(Object.entries(selectors).map(([key,selector])=>{const el=document.querySelector(selector),r=el?.getBoundingClientRect();return [key,r&&r.width&&r.height?[r.x,r.y,r.width,r.height]:null]}))}})()`;
  const measured=(await browser('eval','-b',Buffer.from(expression).toString('base64'))).result;
  // Resolve CSS colour syntax through the browser before comparison (hex and rgb are equivalent).
  const normalized=(await browser('eval','-b',Buffer.from(`(()=>{const el=document.createElement('span');document.body.append(el);const tokens=Object.fromEntries(Object.entries(${JSON.stringify(measured.tokens)}).map(([key,value])=>{el.style.color='';el.style.color=value;return [key,value?getComputedStyle(el).color:'']}));el.remove();return tokens})()`).toString('base64'))).result;
  measured.tokens=normalized;
  row.visualFailures=checkVisual(contract,visual,measured);
  await writeFile(join(out,'visual',screen+'.json'),JSON.stringify({measured,failures:row.visualFailures},null,2)+'\n');
  const artboard=artboards[screen];
  if(artboard?.file){
   const pair=join(out,'pairs',screen+'.png');const args=[join(specs,artboard.file),join(out,'screenshots',screen+'.png'),'-thumbnail',`${contract.viewport.width}x${contract.viewport.height}`,'-tile','2x1','-geometry','+8+8','-background','#15171a',pair];
   try{await run('magick',['montage',...args]);}catch(error){if(error.code!=='ENOENT')throw error;await run('montage',args);}
   row.pair=`pairs/${screen}.png`;
  }else row.gaps.push(artboard?.reason||'Prototype artboard is not mapped.');
 }catch(error){row.errors.push(error.message+(error.stdout?"\n"+error.stdout:""));}
 finally{
  try{await browser('close');}catch(error){row.errors.push('Browser cleanup: '+error.message);}
  if(host)try{await host.close();}catch(error){row.errors.push('Fixture cleanup: '+error.message);}
 }
 console.log(`${screen}: ${row.passed}/${row.required} required, ${row.failed} failures, ${row.visualFailures.length} visual, ${row.gaps.length} gaps, ${row.errors.length} errors`);
 await writeFile(join(out,'report.json'),JSON.stringify({blocking,rows},null,2)+'\n');
 await writeFile(join(out,'report.md'),reportMarkdown(rows,blocking));
}
console.log(`Report: ${join(out,'report.md')}`);
process.exitCode=exitCode(rows,blocking);
