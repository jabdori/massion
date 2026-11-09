import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {createWorkbench} from '../../src/server.ts';
import {InMemoryStore} from '../../src/storage.ts';
import {createProtocolClient} from '../../src/client-protocol.ts';
import {appOrigin,isAppURL,windowOptions,contentPolicy,allowRequest,validSender} from '../security.ts';
import {daemonTransport,proxyProtocol} from '../transport.ts';
import {ExceptionTracker} from '../notifications.ts';

test('untrusted URLs, subframes and renderer capabilities stay outside the host boundary',()=>{
 const options=windowOptions('/trusted/preload.cjs');
 assert.deepEqual(options.webPreferences,{preload:'/trusted/preload.cjs',sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false});
 assert.equal(isAppURL('massion://app/#mission=one'),true);
 for(const url of ['massion://app.evil/','massion://user@app/','file:///etc/passwd','https://example.org/','massion://app/other','massion://app:80/'])assert.equal(isAppURL(url),false,url);
 assert.equal(allowRequest('massion://app/protocol/connect'),true);
 for(const url of ['https://example.org/','file:///tmp/a','http://127.0.0.1:8765/','massion://app/secret'])assert.equal(allowRequest(url),false,url);
 const frame={url:appOrigin+'/'};const sender={mainFrame:frame};
 assert.equal(validSender({sender,senderFrame:frame},sender),true);
 assert.equal(validSender({sender,senderFrame:{url:frame.url}},sender),false);
 assert.equal(validSender({sender,senderFrame:frame},{mainFrame:frame}),false);
 frame.url='https://example.org/';assert.equal(validSender({sender,senderFrame:frame},sender),false);
 const csp=contentPolicy('<script>safe()</script><style>body{color:red}</style>');
 assert.match(csp,/script-src 'sha256-[^']+'/);assert.doesNotMatch(csp,/unsafe-eval|script-src[^;]*unsafe-inline/);
 assert.match(csp,/connect-src 'self'/);assert.match(csp,/frame-src 'none'/);
});

for(const state of ['ready','update-needed','restart-needed'] as const)test('desktop uses existing version negotiation: '+state,async t=>{
 const root=await mkdtemp(join(tmpdir(),'desktop-protocol-'));
 const store=new InMemoryStore<any>(),server=createWorkbench(store,root,{scheduleIntervalMs:0,protocol:state==='ready'?{}:{supported:{min:2,max:2},...(state==='restart-needed'?{supported:{min:1,max:1},installed:{min:2,max:2}}:{})}});
 server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as {port:number}).port;
 t.after(async()=>{await server.drain();await rm(root,{recursive:true,force:true});});
 const client=createProtocolClient(daemonTransport('http://127.0.0.1:'+port),state==='restart-needed'?{min:2,max:2}:{min:1,max:1});
 assert.equal((await client.connection()).state,state);
 if(state==='ready')assert.equal((await client.query('/health',{scope:'health'})).body.status,'ready');
 else await assert.rejects(client.dispatch('/fixture-run',{body:'{}'}),/update or restart/);
 assert.equal((await store.readEvents(0)).cursor,0);
});

test('proxy forwards one command, refuses redirects and never exposes non-protocol routes',async t=>{
 let requests=0;const server=createServer((req,res)=>{requests++;if(req.url==='/protocol/connect'){res.writeHead(302,{Location:'http://example.org/'});res.end();return;}req.resume();req.on('end',()=>res.destroy());});
 server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
 t.after(()=>server.close());
 await assert.rejects(proxyProtocol(new Request(appOrigin+'/protocol/connect',{method:'POST',body:'{}'}),base));
 await assert.rejects(proxyProtocol(new Request(appOrigin+'/protocol/request',{method:'POST',body:'{}'}),base));
 assert.equal(requests,2);
 assert.equal((await proxyProtocol(new Request(appOrigin+'/health'),base)).status,403);
 assert.equal((await proxyProtocol(new Request(appOrigin+'/protocol/request',{method:'PUT'}),base)).status,403);
 assert.equal(requests,2);
 assert.throws(()=>daemonTransport('https://example.org'),/loopback/i);
});

test('only owner exceptions notify; progress, duplicate revisions and stale feeds stay quiet',()=>{
 const tracker=new ExceptionTracker(),work={missionId:'mission',workId:'work',turnId:'turn',title:'Task',unknown:false,acceptance:'pending',execution:'active'};
 assert.deepEqual(tracker.update('feed',[work],[]),[]);
 const failure=tracker.update('feed',[{...work,acceptance:'failed'}],[]);assert.equal(failure.length,1);assert.equal(failure[0]!.kind,'failure');
 assert.deepEqual(tracker.update('feed',[{...work,acceptance:'failed',missionRevision:99}],[]),[]);
 assert.equal(tracker.update('feed',[{...work,unknown:true}],[])[0]!.kind,'unknown');
 const decision={id:'decision',title:'Allow',state:'open',at:1};
 assert.equal(tracker.update('feed',[work],[decision])[0]!.kind,'decision');
 assert.equal(tracker.current(failure[0]!),false);
 const latest=tracker.update('new-feed',[{...work,acceptance:'failed'}],[])[0]!;
 assert.equal(tracker.current(latest),true);assert.equal(tracker.current(failure[0]!),false);
 assert.deepEqual(tracker.update('new-feed',[{...work,acceptance:'accepted'}],[]),[]);
 assert.equal(tracker.current(latest),false);
 assert.deepEqual(tracker.update('new-feed',[{...work,workId:'../bad',unknown:true}],[{...decision,state:'done'}]),[]);
});
