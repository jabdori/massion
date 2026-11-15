import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import https from 'node:https';
import {createServer,connect} from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import {createPrivateKey,X509Certificate} from 'node:crypto';
import {createPinnedDatabaseFetch,generateStartCertificate,isPinnedDatabaseEndpoint} from '../../src/database-tls.ts';
import {tempRoot} from '../../tests/support/temp-root.ts';

const desktop=join(import.meta.dirname,'..');
const authorization='Basic '+Buffer.from('root:'+'d'.repeat(64)).toString('base64');
const body=JSON.stringify({id:'db-tls-probe',method:'query',params:['RETURN 1',{}]});

test('each start certificate is a fresh EC P-256 pair for 127.0.0.1, valid for ten years',()=>{
 const first=generateStartCertificate(),second=generateStartCertificate();
 const parsed=new X509Certificate(first.certificate);
 assert.equal(parsed.subjectAltName,'IP Address:127.0.0.1');
 assert.equal(parsed.publicKey.asymmetricKeyType,'ec');
 assert.ok(['P-256','prime256v1'].includes(String(parsed.publicKey.asymmetricKeyDetails?.namedCurve)),'the curve is P-256');
 assert.equal(parsed.ca,false);
 assert.equal(parsed.checkPrivateKey(createPrivateKey(first.privateKey)),true,'the certificate matches its own private key');
 assert.ok(Date.parse(parsed.validTo)-Date.parse(parsed.validFrom)>=10*365*24*60*60*1000,'valid for at least ten years');
 assert.ok(Date.parse(parsed.validFrom)<Date.now(),'valid from before now');
 assert.notEqual(first.certificate,second.certificate,'a second start makes a new certificate');
 assert.notEqual(first.privateKey,second.privateKey);
});

test('a pinned request succeeds against a TLS server holding the pinned certificate',async t=>{
 const root=await mkdtemp(join(tempRoot(),'db-tls-right-'));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const start=generateStartCertificate();
 let seen='';
 const server=https.createServer({key:start.privateKey,cert:start.certificate},(request,response)=>{
  request.setEncoding('utf8');
  request.on('data',chunk=>{seen+=chunk;});
  request.on('end',()=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({echo:seen}));});
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(start.certificate);
 const response=await request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization,'content-type':'application/json'},body,signal:AbortSignal.timeout(3000)});
 assert.equal(response.status,200);assert.equal(response.ok,true);
 assert.equal(((await response.json()) as {echo:string}).echo,body,'the request body reached the server');
 assert.equal(seen,body);
});

test('a plain TCP decoy receives only a ClientHello, never the authorization or body',async t=>{
 const root=await mkdtemp(join(tempRoot(),'db-tls-plain-'));
 t.after(async()=>{await new Promise(resolve=>decoy.close(resolve));await rm(root,{recursive:true,force:true});});
 const start=generateStartCertificate();
 const received:Buffer[]=[];
 const decoy=createServer(socket=>{socket.on('data',chunk=>received.push(Buffer.from(chunk)));});
 decoy.listen(0,'127.0.0.1');await once(decoy,'listening');
 const port=(decoy.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(start.certificate);
 await assert.rejects(request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization},body,signal:AbortSignal.timeout(3000)}));
 await new Promise(resolve=>setTimeout(resolve,100));
 const raw=Buffer.concat(received);
 assert.ok(raw.length>0,'the decoy saw the connection attempt');
 assert.equal(raw.subarray(0,3).equals(Buffer.from([0x16,0x03,0x01])),true,'the first bytes on the wire are a TLS ClientHello');
 assert.equal(raw.includes(Buffer.from(authorization)),false,'no authorization value reached the decoy');
 assert.equal(raw.includes(Buffer.from(body)),false,'no request body reached the decoy');
});

test('a TLS decoy with a different key receives only the ClientHello and decrypts nothing',async t=>{
 const root=await mkdtemp(join(tempRoot(),'db-tls-decoy-'));
 t.after(async()=>{
  await new Promise(resolve=>proxy.close(resolve));
  await new Promise(resolve=>target.close(resolve));
  await rm(root,{recursive:true,force:true});
 });
 const pinned=generateStartCertificate(),other=generateStartCertificate();
 const decrypted:Buffer[]=[],wire:Buffer[]=[];
 const target=tls.createServer({key:other.privateKey,cert:other.certificate},socket=>{socket.on('data',chunk=>decrypted.push(Buffer.from(chunk)));});
 target.on('tlsClientError',()=>{});
 target.listen(0,'127.0.0.1');await once(target,'listening');
 const proxy=createServer(socket=>{
  const upstream=connect((target.address() as {port:number}).port,'127.0.0.1');
  socket.on('data',chunk=>wire.push(Buffer.from(chunk)));
  socket.pipe(upstream);upstream.pipe(socket);
  socket.on('error',()=>{});upstream.on('error',()=>{socket.destroy();});
 });
 proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
 const port=(proxy.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(pinned.certificate);
 await assert.rejects(request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization},body,signal:AbortSignal.timeout(3000)}));
 await new Promise(resolve=>setTimeout(resolve,200));
 const raw=Buffer.concat(wire);
 assert.ok(raw.length>0,'the proxy saw the connection attempt');
 assert.equal(raw.subarray(0,3).equals(Buffer.from([0x16,0x03,0x01])),true,'the first bytes on the wire are a TLS ClientHello');
 assert.equal(raw.includes(Buffer.from(authorization)),false,'no authorization value left the client');
 assert.equal(raw.includes(Buffer.from(body)),false,'no request body left the client');
 assert.equal(Buffer.concat(decrypted).length,0,'the decoy decrypted no application data');
 // Not tested: a TLS server presenting a DIFFERENT certificate for the SAME key.
});

test('the pinned request refuses URLs that are not https on 127.0.0.1 with an explicit port',async()=>{
 const start=generateStartCertificate(),request=createPinnedDatabaseFetch(start.certificate);
 for(const url of ['http://127.0.0.1:9/rpc','https://localhost:9/rpc','https://127.0.0.1/rpc','https://[::1]:9/rpc','https://other.test:9/rpc'])
  await assert.rejects(request(url,{signal:AbortSignal.timeout(250)}),/Pinned database requests/);
 assert.equal(isPinnedDatabaseEndpoint('https://127.0.0.1:9/rpc'),true);
 for(const endpoint of ['http://127.0.0.1:9/rpc','https://localhost:9/rpc','https://127.0.0.1/rpc','not a url'])
  assert.equal(isPinnedDatabaseEndpoint(endpoint),false);
});

test('no request to the managed database is made without the pinned function',()=>{
 const read=(relative:string)=>readFileSync(join(desktop,'..',relative),'utf8');
 const runner=read('desktop/daemon-runner.mjs'),keeper=read('desktop/daemon-keeper.mjs'),server=read('src/server.ts'),storage=read('src/storage.ts');
 assert.doesNotMatch(runner,/fetch\(\s*['"`]/,'the supervisor calls no fetch with a literal URL: its database requests go through the pinned function');
 assert.doesNotMatch(runner,/['"`]http:\/\/127\.0\.0\.1:['"`]\s*\+/,'no plain-http database URL is built');
 assert.equal(keeper.includes('fetch('),false,'the keeper never opens the database port');
 assert.match(server,/createPinnedDatabaseFetch/,'the core imports the pinned request factory');
 assert.match(server,/isPinnedDatabaseEndpoint/,'the core decides pinning from the endpoint shape');
 assert.doesNotMatch(server,/fetch\(\s*['"`]https?:\/\//,'the core calls no fetch with a literal URL');
 assert.match(storage,/options\.fetch \?\? globalThis\.fetch/,'the transport default remains the developer path only');
});

