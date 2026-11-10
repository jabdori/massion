import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {captureBrowserPage,disableBrowserScripts} from '../../src/headless-browser.ts';
import {sanitizePage} from '../../src/browser-runtime.ts';

export async function captureReferencePages(verify=false){
 const root=fileURLToPath(new URL('./browser-pages/',import.meta.url)),exec=promisify(execFile),output=resolve('.runtime/browser-pages');await mkdir(output,{recursive:true});
 const session='massion-page-capture-'+randomUUID(),config=join(output,'config.json');await writeFile(config,'{}\n');
 const names={'library-guide':'https://library.example.com/guide','library-availability':'https://library.example.com/availability','library-form':'https://library.example.com/apply',checkout:'https://shop.example.com/checkout'},files=['page.css','shadow.html',...Object.keys(names).map(n=>n+'.html')];
 const probes={
  'private.html':'<title>PAGE-TITLE-CANARY</title><p>ARBITRARY-ENCODED-REFLECTION</p><label for="secret">Security code</label><input id="secret" name="csc" type="number" value="456">',
  'frame.html':'<title>FRAME-PARENT-CANARY</title><p>FRAME-REFLECTION-CANARY</p><iframe src="/private.html"></iframe>',
  'empty.html':'<title>Public empty form</title><label for="empty">Password</label><input id="empty" type="password" value="">',
  'invalid-number.html':'<title>INVALID-NUMBER-CANARY</title><input type="number" name="csc" value="PRIVATE-DEFAULT-CANARY">',
  'many.html':'<title>TRUNCATED-FIELD-CANARY</title>'+Array.from({length:65},(_,i)=>'<label for="name-'+i+'">이름</label><input id="name-'+i+'" value="Demo">').join('')+'<input type="password" value="LATE-PRIVATE-CANARY">'
 };
 const server=createServer(async(req,res)=>{const name=(req.url||'/').slice(1);res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',name.endsWith('.css')?'text/css':'text/html; charset=utf-8');if(Object.hasOwn(probes,name)){res.end('<!doctype html><html><body>'+probes[name]+'</body></html>');return;}if(!files.includes(name)){res.writeHead(404);res.end();return;}res.end(await readFile(join(root,name)));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));Object.assign(env,{AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_NO_VERSION_CHECK:'1',AGENT_BROWSER_PLUGINS:'[]',AGENT_BROWSER_IDLE_TIMEOUT_MS:'60000'});
 const run=async args=>{const {stdout}=await exec('agent-browser',['--config',config,'--session',session,'--headed','false','--hide-scrollbars','false','--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:512*1024});const r=JSON.parse(stdout);assert.ok(r.success,r.error);return r.data;},manifest={},pages={};let control;
 const read=async name=>{await run(['open','http://127.0.0.1:'+server.address().port+'/'+name]);return captureBrowserPage(run,control);};
 try{
  await run(['close']);await run(['open']);control=await disableBrowserScripts(run);
  for(const [name,address] of Object.entries(names)){
   const page=await read(name+'.html');pages[name]={...page,address};const {screenshot,...structure}=page;
   manifest[name]={...sanitizePage({...structure,address}),sourceAddress:address,sourceSha256:createHash('sha256').update(await readFile(join(root,name+'.html'))).update(await readFile(join(root,'page.css'))).digest('hex')};
  }
  if(verify){const rows=[];for(const name of Object.keys(probes)){
   const raw=await read(name),{screenshot,...structure}=raw,page=sanitizePage(structure);assert.ok(screenshot);assert.equal(page.tainted===true,name!=='empty.html');
   if(page.tainted){assert.equal('title' in page,false);assert.equal('blocks' in page,false);assert.equal('fields' in page,false);assert.equal('imageHash' in page,false);assert.ok(!JSON.stringify(page).includes('CANARY'));}
   if(name==='frame.html')assert.equal(page.summary.frames,1);
   if(name==='many.html'){assert.equal(page.summary.privateFields,1);assert.equal(page.summary.fields.length,64);assert.ok(page.summary.fields.every(f=>!f.private));}
   if(name==='invalid-number.html')assert.equal(page.summary.fields[0].length,'PRIVATE-DEFAULT-CANARY'.length);
   if(name==='private.html')assert.equal((await run(['eval','document.getElementById("secret").value'])).result,'••••');
   rows.push({name,tainted:page.tainted===true,liveImage:true});
  }
  await read('shadow.html').then(()=>assert.fail('Author shadow DOM must be refused'),error=>assert.match(error.message,/Author shadow DOM/));
  await writeFile(join(output,'redaction-report.json'),JSON.stringify({taintRule:true,privateFieldsBeforeTruncation:true,embeddedFramesConservative:true,emptyPrivateFieldsUntainted:true,invalidNumberDefaultsCounted:true,closedShadowRefused:true,standalonePageImagesWritten:0,rows},null,2)+'\n');
  await writeFile(join(output,'ephemeral-report.json'),JSON.stringify({liveImagesInMemory:true,persistedTaintedText:false,standalonePageImagesWritten:0},null,2)+'\n');
  }
  return {pages,manifest};
 }finally{await run(['close']).catch(()=>{});await control?.close();await new Promise(r=>server.close(r));}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const {manifest}=await captureReferencePages(true);await writeFile(new URL('./browser-pages/captured.json',import.meta.url),JSON.stringify(manifest,null,2)+'\n');console.log('Verified private taint and in-memory captures; persisted host metadata only for tainted pages.');}
