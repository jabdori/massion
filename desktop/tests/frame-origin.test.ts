import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {daemonGuard} from '../../src/daemon-auth.ts';
import {AppDocuments} from '../../src/app-documents.ts';
import {proxyProtocol} from '../transport.ts';
import {contentPolicy,allowRequest,isAppDocumentURL} from '../security.ts';

test('desktop permits only controlled document paths without weakening workbench script and style policy',()=>{
 const url='massion-app://document/'+'a'.repeat(64);
 assert.equal(isAppDocumentURL(url),true);
 for(const bad of [url+'?x',url+'#x',url+'/',url.replace('document','user@document'),url.replace('document','document:80'),url.replace('massion-app:','https:')])assert.equal(isAppDocumentURL(bad),false,bad);
 assert.equal(allowRequest(url),false,'document admission is separate and requires a live lookup and subframe');
 const csp=contentPolicy('<script>safe()</script><style>body{color:red}</style>');
 assert.match(csp,/frame-src massion-app:\/\/document/);
 assert.doesNotMatch(csp,/script-src[^;]*unsafe-inline|style-src [^;]*unsafe-inline|unsafe-eval/);
});

test('authenticated app view is published by main; URLs and failed or unrelated replies cannot publish',async t=>{
 const secret=randomBytes(32).toString('hex'),guard=daemonGuard(secret),docs=new AppDocuments();
 let result:any={status:200,payload:{title:'Probe',groups:[],frame:{html:'<script>window.ran=true</script>'}}},published=0;
 const server=createServer((req,res)=>{if(!guard(req,res))return;req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(result));});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const publish=(html:string)=>{published++;return 'massion-app://document'+docs.publish(html);};
 const read=(path='/assistant/apps/view')=>proxyProtocol(new Request('massion://app/protocol/request',{method:'POST',body:JSON.stringify({path,kind:'command',payload:{app:'probe',handler:'page'}})}),base,async()=>secret,publish);
 const response=await (await read()).json() as any;
 assert.equal(response.payload.frame.html,undefined);assert.match(response.payload.frame.url,/^massion-app:\/\/document\/[a-f0-9]{64}$/);
 assert.match(docs.read(new URL(response.payload.frame.url).pathname)!,/window.ran=true/);assert.equal(published,1);
 await read('/health');assert.equal(published,1);
 result={status:400,payload:{frame:{html:'bad'}}};await read();assert.equal(published,1);
 result={status:200,payload:{frame:{url:'https://evil.test/'}}};assert.equal((await read()).status,502);assert.equal(published,1);
});

test('a malformed request retains the authenticated host rejection without local JSON parsing',async t=>{
 const secret=randomBytes(32).toString('hex'),guard=daemonGuard(secret);let published=0;
 const server=createServer((req,res)=>{if(!guard(req,res))return;req.resume();req.on('end',()=>{res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Invalid JSON'}));});});
 server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 const response=await proxyProtocol(new Request('massion://app/protocol/request',{method:'POST',body:'{'}),base,async()=>secret,()=>{published++;return 'unused';});
 assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'Invalid JSON'});assert.equal(published,0);
});

test('workbench requests require the owned main frame and committed app URL',async()=>{
 const {allowWorkbenchRequest}=await import('../security.ts');
 const mainFrame={url:'massion://app/'},contents={id:7,mainFrame},child={url:'massion-app://document/'+'a'.repeat(64),parent:mainFrame};
 for(const url of ['massion://app/','massion://app/protocol/connect','massion://app/protocol/request','massion://app/protocol/events?version=1']){
  const request={url,resourceType:'xhr',webContentsId:7,frame:mainFrame};
  assert.equal(allowWorkbenchRequest(request,contents),true,url);
  for(const changed of [{frame:child},{frame:null},{frame:undefined},{webContentsId:8},{webContentsId:undefined}])assert.equal(allowWorkbenchRequest({...request,...changed},contents),false);
  assert.equal(allowWorkbenchRequest(request,undefined),false);
 }
 const request={url:'massion://app/protocol/connect',resourceType:'xhr',webContentsId:7,frame:mainFrame};
 mainFrame.url='about:blank';assert.equal(allowWorkbenchRequest(request,contents),false,'bootstrap cannot admit API traffic');
 assert.equal(allowWorkbenchRequest({...request,url:'massion://app/',resourceType:'mainFrame'},contents),true,'owned initial navigation');
 assert.equal(allowWorkbenchRequest({...request,url:'massion://app/',resourceType:'subFrame',frame:child},contents),false);
 mainFrame.url='https://evil.example/';assert.equal(allowWorkbenchRequest(request,contents),false);
});
