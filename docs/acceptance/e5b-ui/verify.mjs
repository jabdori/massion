import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {startFixtureHost} from '../../../scripts/ui-contracts/fixture-host.ts';
import {workbenchReady} from '../../../scripts/ui-contracts/report.ts';

// This loopback-only overlay supplies fixture command results; the shared contract host stays read-only.
async function commandHost(screen){
 const upstream=await startFixtureHost(screen),initial=upstream.fixture.routes['/assistant/conversation'].body;
 let view=structuredClone(initial),commands=0;
 const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');
  try{
   if(req.url.startsWith('/protocol/events')){
    const query=new URL(req.url,'http://fixture').searchParams;
    res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({version:1,requestId:query.get('requestId'),generation:Number(query.get('generation')),kind:'feed',reason:'connected',feedId:view.feedId,cursor:view.cursor})+'\n\n');return;
   }
   let raw='';for await(const chunk of req)raw+=chunk;
   const message=raw?JSON.parse(raw):null,path=req.url==='/protocol/request'?message.path:req.url;
   if(path==='/assistant/apps/connect'||path==='/assistant/decisions'){
    const body=message?.payload??message;assert.equal(req.method,'POST');
    assert.equal(message?.feedId??req.headers['x-massion-feed'],view.feedId);
    const d=view.decisions.find(d=>d.id===body.decisionId);assert.ok(d);commands++;
    if(path==='/assistant/apps/connect'){
     assert.deepEqual(Object.keys(body).sort(),['commandId','decisionId','token']);assert.equal(body.token,'fixture-only');
     const done=await startFixtureHost('B24-connect-connected');try{view=structuredClone(done.fixture.routes['/assistant/conversation'].body);}finally{await done.close();}
    }else d.state=body.answer==='later'?'later':'open';
    const payload={status:'committed'};
    res.end(JSON.stringify(message?.kind?{...message,kind:'reply',status:200,payload}:payload));return;
   }
   const response=await fetch(new URL(req.url==='/__frame-probe'?'/':req.url,upstream.url),{method:req.method,headers:raw?{'Content-Type':'application/json'}:{},...(raw?{body:raw}:{})});
   res.statusCode=response.status;
   for(const name of ['content-type','content-security-policy'])if(response.headers.has(name))res.setHeader(name,response.headers.get(name));
   // The read-only fixture CSP bans frames altogether; this probe uses the production workbench CSP.
   if(req.url==='/__frame-probe')res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
   if(req.url==='/protocol/request'&&path.startsWith('/assistant/conversation')){
    const body=await response.json();body.payload=structuredClone(view);res.end(JSON.stringify(body));
   }else res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.statusCode=500;res.end(JSON.stringify({error:'Fixture assertion failed'}));}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 return {url:'http://127.0.0.1:'+server.address().port,commands:()=>commands,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await upstream.close();}};
}

const root=fileURLToPath(new URL('../../../',import.meta.url)),out=join(root,'.runtime/e5b-ui/actions'),run=promisify(execFile),rows=[];
await mkdir(out,{recursive:true});const config=join(out,'browser-config.json');await writeFile(config,'{}\n');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENT_BROWSER_')));
Object.assign(env,{AGENT_BROWSER_DEFAULT_TIMEOUT:'5000',AGENT_BROWSER_NO_WEBMCP:'1',AGENT_BROWSER_PLUGINS:'[]',TZ:'Asia/Seoul'});
for(const theme of ['dark','light']){
 const session='massion-e5b-'+theme+'-'+randomUUID().slice(0,8),host=await commandHost('B24-connect');
 const browser=async(...args)=>{const {stdout}=await run('agent-browser',['--config',config,'--session',session,'--color-scheme',theme,'--allowed-domains','127.0.0.1','--json',...args],{env,timeout:45000,maxBuffer:8*1024*1024});const reply=JSON.parse(stdout);assert.ok(reply.success,reply.error);return reply.data;};
 const evaluate=async source=>(await browser('eval','-b',Buffer.from(source).toString('base64'))).result;
 const capture=async screen=>{
  await browser('wait','--fn',workbenchReady);await evaluate('document.fonts.ready.then(()=>true)');
  const png=join(out,theme+'-'+screen+'.png');await browser('screenshot',png);const snapshot=await browser('snapshot');await writeFile(join(out,theme+'-'+screen+'.txt'),snapshot.snapshot+'\n');
  const pair=join(out,theme+'-'+screen+'-pair.png'),args=[join(root,'docs/product/screens/artboards',theme,screen+'.png'),png,'-tile','2x1','-geometry','+8+8',pair];
  try{await run('magick',['montage',...args]);}catch(error){if(error.code!=='ENOENT')throw error;await run('montage',args);}
  rows.push({theme,screen,png,pair,commands:host.commands()});
 };
 try{
  const clock=join(out,'clock.js');await writeFile(clock,'{const D=Date;globalThis.Date=class extends D{constructor(...a){super(...(a.length?a:[1793855520000]))}static now(){return 1793855520000}}}\n');
  await browser('open','--init-script',clock);await browser('set','viewport','1440','900');await browser('open',host.url);await browser('wait','--fn',workbenchReady);await browser('wait','#chat-decision-install');
  await capture('B24-connect');
  await browser('click','#chat-decision-install .chat-actions button:last-child');await browser('wait','#chat-system-install');assert.equal(host.commands(),1);await capture('B24-connect-later');
  await browser('click','#chat-system-install button');await browser('wait','#chat-decision-install');assert.equal(host.commands(),2);
  await browser('click','#chat-decision-install .chat-actions button:first-child');await browser('wait','#app-connect-token');
  assert.equal(await evaluate("document.getElementById('app-connect-token').type"),'password');assert.equal(await evaluate("document.getElementById('work-pane').hidden"),true);await capture('B24-connect-token');
  await browser('fill','#app-connect-token','fixture-only');await browser('click','#app-connect-submit');await browser('wait','#chat-system-install');
  assert.equal(await evaluate("document.getElementById('app-connect-token').value"),'');assert.equal(await evaluate("document.getElementById('app-connect-panel').hidden"),true);assert.equal(host.commands(),3);await capture('B24-connect-connected');
  assert.equal(await evaluate("[...Object.values(localStorage)].some(v=>v.includes('fixture-only'))"),false);
  await browser('open',host.url+'/__frame-probe');await browser('wait','--fn',workbenchReady);
  const frameProbe=await evaluate(`new Promise(resolve=>{
   const html='<script>addEventListener("message",async()=>{let parentAccess="allowed",network="allowed";try{parent.document.body}catch(e){parentAccess=e.name}try{await fetch("/health")}catch(e){network=e.name}parent.postMessage({type:"probe",parentAccess,network},"*");parent.postMessage({type:"resize",height:240},"*")})<'+ '/script>';
   const nodes=appsViewNodes({title:'Example',groups:[],frame:{html}}),frame=nodes[1];
   window.addEventListener('message',function probe(event){if(event.source!==frame.contentWindow||event.data?.type!=='probe')return;window.removeEventListener('message',probe);resolve({...event.data,sandbox:frame.getAttribute('sandbox'),referrer:frame.getAttribute('referrerpolicy')});});
   frame.id='e5b-frame-probe';frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'probe'},'*'));document.body.append(...nodes);
  })`);
  assert.deepEqual(frameProbe,{type:'probe',parentAccess:'SecurityError',network:'TypeError',sandbox:'allow-scripts',referrer:'no-referrer'});
  await browser('wait','--fn',"document.getElementById('e5b-frame-probe').style.height==='240px'");
  assert.equal(await evaluate(`(()=>{const frame=document.getElementById('e5b-frame-probe');for(const data of [{type:'resize',height:1},{type:'resize',height:1201},{type:'resize',height:250,extra:true},{type:'effect',command:'send'},{type:'ready'}])appFrameMessage({origin:'null',source:frame.contentWindow,data});return frame.style.height})()`),'240px');
  rows.push({theme,frameProbe,bridge:'Only ready and bounded resize; unknown effects and invalid resize ignored.'});
 }finally{await browser('close');await host.close();}
}
await writeFile(join(out,'report.json'),JSON.stringify({evidence:'Fixture commands only; no real credential, keychain or provider access.',rows},null,2)+'\n');
console.log('Verified Later, Ask again, masked token entry, single submission and connected read in both themes. '+join(out,'report.json'));
