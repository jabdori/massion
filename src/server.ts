/** Loopback-only development workbench. No production authentication or service deployment. */
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import type {Store} from './storage.ts';
import {SurrealStore,createHttpRpcTransport,initializeSurrealSchema} from './storage.ts';
import type {Mission} from './domain.ts';
import {runGrowthScenario} from './scenario.ts';
const page=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Massion · Workbench</title><style>body{font:16px system-ui;background:#10151e;color:#e6ecf4;max-width:960px;margin:48px auto;padding:0 24px}h1{font-size:40px}p{color:#bcc8d8;line-height:1.6}button,input{font:inherit;padding:12px;border-radius:8px;border:1px solid #60738b}button{background:#a8e1c4;color:#11231b;cursor:pointer}button:disabled{opacity:.5}input{background:#172334;color:white;min-width:280px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#172334;padding:20px;border-radius:12px}small{color:#bcc8d8}.row{display:flex;flex-wrap:wrap;gap:12px;margin:24px 0}</style><h1>Massion</h1><p>Mission → organized Work → independent Assurance → Records → Growth</p><p>This development workbench runs a controlled local fixture against SurrealDB. It performs real file and process effects. It does not run a real model or prove production readiness.</p><div class="row"><button id="run">Run verified-work fixture</button><button id="refresh">Refresh Mission</button></div><label>Mission ID <input id="mission" placeholder="mission identifier"></label><p id="status" role="status" aria-live="polite">Ready. No work started.</p><pre id="result">Accepted Records and pinned evidence will appear here.</pre><small>Refresh uses the same authoritative database. Event catch-up, recovery controls and production authentication remain open.</small><script>const $=id=>document.getElementById(id);async function load(){if(!$('mission').value)return;$('status').textContent='Reading authoritative state…';try{const r=await fetch('/missions/'+encodeURIComponent($('mission').value));const v=await r.json();if(!r.ok)throw Error(v.error);$('result').textContent=JSON.stringify(v,null,2);$('status').textContent='Loaded revision '+v.revision;}catch(e){$('status').textContent=e.message;}}$('refresh').onclick=load;$('run').onclick=async()=>{$('run').disabled=true;$('status').textContent='Running controlled wrong/fix/verify/Growth workflow…';try{const r=await fetch('/fixture-run',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const v=await r.json();if(!r.ok)throw Error(v.error);$('mission').value=v.missionId;localStorage.setItem('massion.fixture.mission',v.missionId);await load();}catch(e){$('status').textContent=e.message;}finally{$('run').disabled=false;}};$('mission').value=localStorage.getItem('massion.fixture.mission')||'';if($('mission').value)load();</script></html>`;
export function createWorkbench(store:Store<Mission>,workspaceRoot:string) {
 let running=false;
 const server=createServer(async(req,res)=>{
  const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  const address=server.address();const port=typeof address==='object'&&address?address.port:0;
  const expected=`127.0.0.1:${port}`;
  if(req.headers.host!==expected){send(403,{error:'Loopback host required'});return;}
  if(req.headers.origin&&req.headers.origin!==`http://${expected}`){send(403,{error:'Cross-origin request denied'});return;}
  try{
   const url=new URL(req.url??'/',`http://${expected}`);
   if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"});res.end(page);return;}
   if(req.method==='GET'&&url.pathname==='/health'){send(200,{status:'ready',mode:'local-development',provider:'controlled-fixture'});return;}
   if(req.method==='GET'&&url.pathname.startsWith('/missions/')){const id=decodeURIComponent(url.pathname.slice(10));if(!/^[a-zA-Z0-9:_-]{1,128}$/.test(id)){send(400,{error:'Invalid Mission identifier'});return;}const state=await store.load(id);send(state?200:404,state??{error:'Unknown Mission'});return;}
   if(req.method==='POST'&&url.pathname==='/fixture-run'){
    if(req.headers['content-type']!=='application/json'){send(415,{error:'JSON required'});return;}
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024){send(413,{error:'Request too large'});return;}}
    if(body.trim()!=='{}'){send(400,{error:'This route accepts only the built-in fixture command'});return;}
    if(running){send(409,{error:'A fixture is already running; observe its state before starting another'});return;}
    running=true;try{const result=await runGrowthScenario(store,workspaceRoot);send(201,{missionId:result.missionId,revision:result.snapshot?.revision,evidenceClass:'fixture'});}finally{running=false;}return;
   }
   send(404,{error:'Unknown route'});
  }catch(error){console.error(error instanceof Error?error.message:'Workbench failure');send(500,{error:'Operation failed; inspect local host logs. Unresolved effects are not replayed automatically.'});}
 });
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const endpoint=process.env.MASSION_SURREAL_RPC??process.env.MASSION_TEST_SURREAL_RPC;
 if(!endpoint)throw new Error('Set MASSION_SURREAL_RPC to an authorized local /rpc endpoint');
 const transport=createHttpRpcTransport({endpoint,namespace:process.env.MASSION_SURREAL_NAMESPACE??process.env.MASSION_TEST_SURREAL_NAMESPACE??'massion',database:process.env.MASSION_SURREAL_DATABASE??process.env.MASSION_TEST_SURREAL_DATABASE??'massion'});
 await initializeSurrealSchema(transport);
 const port=Number(process.env.MASSION_PORT??8765);if(!Number.isSafeInteger(port)||port<1024||port>65535)throw new Error('Invalid development port');
 const server=createWorkbench(new SurrealStore<Mission>(transport),resolve('.runtime/workspaces'));
 server.listen(port,'127.0.0.1',()=>console.log(`Massion development workbench: http://127.0.0.1:${port}`));
 for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>server.close(()=>process.exit(0)));
}
