import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import https from 'node:https';
import {createServer,connect,type Socket} from 'node:net';
import tls from 'node:tls';
import {once} from 'node:events';
import type {Duplex} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign,X509Certificate,type KeyObject} from 'node:crypto';
import {createPinnedDatabaseFetch,generateStartCertificate,isPinnedDatabaseEndpoint} from '../../src/database-tls.ts';
import {der,derInt,derLength,derOid,derTime,sequence} from '../../src/der.ts';
import {tempRoot} from '../../tests/support/temp-root.ts';

const desktop=join(import.meta.dirname,'..');
const authorization='Basic '+Buffer.from('root:'+'d'.repeat(64)).toString('base64');
const body=JSON.stringify({id:'db-tls-probe',method:'query',params:['RETURN 1',{}]});

function httpsServerCleanup(server:https.Server){
 const sockets=new Set<Duplex>();
 // Track TCP sockets even if they never finish the TLS handshake.
 server.on('connection',socket=>{
  sockets.add(socket);
  socket.once('close',()=>sockets.delete(socket));
 });
 return async()=>{
  const closed=once(server,'close',{signal:AbortSignal.timeout(3000)});
  server.close();
  for(const socket of sockets)socket.destroy();
  await closed;
 };
}

/** The certificate shape generateStartCertificate writes, with the signing key, the key signed for,
 * the two names and the extensions as inputs; the generator fixes them all, and two tests below need
 * a pin that may issue certificates and a certificate without the loopback IP name. */
const x509Name=(commonName:string)=>sequence(der(49,sequence(derOid(2,5,4,3),der(12,Buffer.from(commonName)))));
const extension=(arcs:number[],value:Buffer)=>sequence(derOid(...arcs),der(4,value));
const ipAddress=extension([2,5,29,17],sequence(der(0x87,Buffer.from([127,0,0,1]))));
const otherHostName=extension([2,5,29,17],sequence(der(0x82,Buffer.from('localhost'))));
const mayIssue=extension([2,5,29,19],sequence(der(1,Buffer.from([0xff]))));
const pemOf=(key:KeyObject)=>key.export({type:'pkcs8',format:'pem'}).toString();
const certificate=(issuer:KeyObject,issued:KeyObject,issuerName:string,subjectName:string,...extensions:Buffer[])=>{
 const now=Date.now(),algorithm=sequence(derOid(1,2,840,10045,4,3,2)),expires=new Date(now);
 expires.setUTCFullYear(expires.getUTCFullYear()+10);
 const signed=sequence(der(0xa0,derInt(Buffer.from([2]))),derInt(randomBytes(16)),algorithm,x509Name(issuerName),sequence(derTime(now-60_000),derTime(expires.getTime())),x509Name(subjectName),createPublicKey(issued).export({type:'spki',format:'der'}) as Buffer,der(0xa3,sequence(...extensions)));
 const signature=sign('sha256',signed,issuer);
 return ['-----BEGIN CERTIFICATE-----',...(sequence(signed,algorithm,der(3,Buffer.concat([Buffer.from([0]),signature]))).toString('base64').match(/.{1,64}/g) as string[]),'-----END CERTIFICATE-----',''].join('\n');
};

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

test('pinned requests succeed against the pinned certificate and use a fresh connection each time',async t=>{
 const start=generateStartCertificate();
 let seen='';
 const requestSockets:Socket[]=[];
 const server=https.createServer({key:start.privateKey,cert:start.certificate},(request,response)=>{
  requestSockets.push(request.socket);
  seen='';
  request.setEncoding('utf8');
  request.on('data',chunk=>{seen+=chunk;});
  request.on('end',()=>{response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({echo:seen}));});
 });
 t.after(httpsServerCleanup(server));
 await once(server.listen(0,'127.0.0.1'),'listening',{signal:AbortSignal.timeout(3000)});
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(start.certificate);
 for(let attempt=0;attempt<2;attempt++){
  const response=await request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization,'content-type':'application/json'},body,signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);assert.equal(response.ok,true);
  assert.equal(((await response.json()) as {echo:string}).echo,body,'the request body reached the server');
  assert.equal(seen,body);
 }
 assert.equal(new Set(requestSockets).size,2,'the two requests used different TLS connections');
});

test('a pinned request rejects a response that is cut off before it completes',async t=>{
 const root=await mkdtemp(join(tempRoot(),'db-tls-cutoff-'));
 // A cut-off connection leaves the server side half-open, so cleanup destroys it explicitly.
 t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const start=generateStartCertificate();
 const sockets=new Set<import('node:net').Socket>();
 const server=tls.createServer({key:start.privateKey,cert:start.certificate},socket=>{
  sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
  socket.on('error',()=>{});
  // A graceful FIN after the partial body: no RST, so no request-level error — only the response
  // stream knows the answer never completed.
  socket.end('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 200\r\n\r\n{"partial":');
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(start.certificate);
 // No abort signal on the request itself: a regression must fail this bound, not pass it.
 const bounded=Promise.race([request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization},body}),delay(3000).then(()=>{throw new Error('the pinned request did not settle after a cut-off response');})]);
 await assert.rejects(bounded,(error:unknown)=>error instanceof Error&&!error.message.includes('did not settle'),'a cut-off response must reject, not hang');
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
});

test('a pinned request rejects a different certificate for the same key and sends no data',async t=>{
 const root=await mkdtemp(join(tempRoot(),'db-tls-samekey-'));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
 const pinnedStart=generateStartCertificate();
 const sameKey=generateStartCertificate(Date.now(),pinnedStart.privateKey);
 assert.notEqual(sameKey.certificate,pinnedStart.certificate,'the decoy certificate differs from the pinned one');
 const decrypted:Buffer[]=[];
 const server=tls.createServer({key:pinnedStart.privateKey,cert:sameKey.certificate},socket=>{socket.on('data',chunk=>decrypted.push(Buffer.from(chunk)));});
 server.on('tlsClientError',()=>{});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(pinnedStart.certificate);
 await assert.rejects(request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization},body,signal:AbortSignal.timeout(3000)}));
 const raw=Buffer.concat(decrypted);
 assert.equal(raw.includes(Buffer.from(authorization)),false,'no authorization value reached the same-key decoy');
 assert.equal(raw.includes(Buffer.from(body)),false,'no request body reached the same-key decoy');
});

test('a pinned request refuses a trusted, rightly named certificate other than the pinned bytes',async t=>{
 // The start certificate is never a CA, so OpenSSL refuses a certificate it issued (observed as
 // unsuitable certificate purpose): with a certificate the product makes, the trust check refuses
 // every other certificate before the byte comparison runs. A pin that may issue is the input where
 // the trust check and the IP name check both pass, so only the byte comparison can refuse.
 const {privateKey:pinKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const pin=certificate(pinKey,pinKey,'massion-managed-database','massion-managed-database',ipAddress,mayIssue);
 const issued=certificate(pinKey,pinKey,'massion-managed-database','massion-managed-database-issued',ipAddress);
 let handlerCalls=0;
 const server=https.createServer({key:pemOf(pinKey),cert:issued},(_request,response)=>{
  handlerCalls++;
  response.writeHead(200,{'content-type':'application/json'});response.end('{}');
 });
 const closeServer=httpsServerCleanup(server);
 t.after(async()=>{
  await closeServer();
  assert.equal(handlerCalls,0,'no request reached the server that presented the issued certificate');
 });
 await once(server.listen(0,'127.0.0.1'),'listening',{signal:AbortSignal.timeout(3000)});
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(pin);
 // The comparison's own message: the handshake and the IP name check passed before it.
 await assert.rejects(request('https://127.0.0.1:'+port+'/rpc',{method:'POST',headers:{authorization},body,signal:AbortSignal.timeout(3000)}),{message:'Pinned database certificate mismatch'});
});

test('a pinned request refuses a certificate without the loopback IP name, even when it is the pinned bytes',async t=>{
 // A start certificate always carries IP Address:127.0.0.1, so with the bytes the product pins only a
 // different certificate fails the IP name check, and the byte comparison refuses those as well. This
 // certificate has the pinned bytes, so the IP name check is the only line that can refuse it.
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const named=certificate(privateKey,privateKey,'massion-managed-database','massion-managed-database',otherHostName);
 const server=https.createServer({key:pemOf(privateKey),cert:named},(request,response)=>{response.writeHead(200);response.end('{}');});
 t.after(httpsServerCleanup(server));
 await once(server.listen(0,'127.0.0.1'),'listening',{signal:AbortSignal.timeout(3000)});
 const port=(server.address() as {port:number}).port;
 const request=createPinnedDatabaseFetch(named);
 await assert.rejects(request('https://127.0.0.1:'+port+'/rpc',{signal:AbortSignal.timeout(3000)}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
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
 // A tripwire, not a proof: greps the four files for plain-request shapes so an obvious regression
 // fails here. The proof is the real-database test where a plain http request to the port fails.
 const read=(relative:string)=>readFileSync(join(desktop,'..',relative),'utf8');
 const sources=[['desktop/daemon-runner.mjs',read('desktop/daemon-runner.mjs')],['desktop/daemon-keeper.mjs',read('desktop/daemon-keeper.mjs')],['src/server.ts',read('src/server.ts')],['src/storage.ts',read('src/storage.ts')]] as const;
 for(const [name,source] of sources){
  assert.doesNotMatch(source,/https?\.request\(/,name+' must not open the database port with node:http(s)');
  assert.doesNotMatch(source,/(?:fetch|request)\s*\(\s*['"`]http:\/\//,name+' must not call fetch or request with a literal plain URL');
  assert.doesNotMatch(source,/(?:fetch|request)\([^)]{0,120}http:\/\/127\.0\.0\.1:\$\{/,name+' must not build a template-literal plain database URL');
 }
 const runner=sources[0]![1],keeper=sources[1]![1],server=sources[2]![1],storage=sources[3]![1];
 assert.doesNotMatch(runner,/['"`]http:\/\/127\.0\.0\.1:['"`]\s*\+/,'no concatenated plain database URL in the runner');
 assert.equal(keeper.includes('fetch('),false,'the keeper never opens the database port');
 assert.match(server,/createPinnedDatabaseFetch/,'the core imports the pinned request factory');
 assert.match(server,/isPinnedDatabaseEndpoint/,'the core decides pinning from the endpoint shape');
 assert.equal(server.match(/createHttpRpcTransport\(/g)?.length,1,'the core builds exactly one database transport');
 assert.match(storage,/options\.fetch \?\? globalThis\.fetch/,'the transport default remains the developer path only');
});

test('the shared DER INTEGER encoder emits a minimal non-negative INTEGER for every input',()=>{
 const cases:readonly(readonly[string,string])[]=[
  ['0001','020101'],       // a leading zero byte before a small value is stripped
  ['0080','02020080'],     // a zero byte kept: the high bit of 80 needs the positive sign
  ['80','02020080'],
  ['7f','02017f'],
  ['00007f','02017f'],
  ['00'.repeat(16),'020100'], // sixteen zero bytes collapse to the single zero byte
  ['','020100']            // an empty input is the value zero
 ];
 for(const [input,expected] of cases)assert.equal(derInt(Buffer.from(input,'hex')).toString('hex'),expected,input||'empty');
});

test('derLength keeps its bytes below the bound and refuses lengths it cannot encode',()=>{
 const cases:readonly(readonly[number,string])[]=[
  [0,'00'],[127,'7f'],[128,'8180'],[255,'81ff'],[256,'820100'],[65535,'82ffff'],[65536,'83010000']
 ];
 for(const [length,expected] of cases)assert.equal(derLength(length).toString('hex'),expected,'derLength('+length+')');
 assert.equal(derLength(2**24-1).toString('hex'),'83ffffff','2^24-1 itself is the widest accepted length');
 for(const length of [-1,1.5,Number.NaN,2**24,2**31,2**32,2**53])
  assert.throws(()=>derLength(length),/DER length must be a non-negative safe integer/,'derLength('+length+') must be refused');
});

test('derOid keeps its bytes for the arcs the assemblers use and refuses malformed arcs',()=>{
 assert.equal(derOid(2,5,4,3).toString('hex'),'0603550403');
 assert.equal(derOid(2,5,29,17).toString('hex'),'0603551d11');
 assert.equal(derOid(1,2,840,10045,4,3,2).toString('hex'),'06082a8648ce3d040302');
 assert.equal(derOid(2,25,2**31-1).toString('hex'),'06066987ffffff7f','2^31-1 is the largest accepted sub-identifier');
 const refused:readonly(readonly[string,()=>Buffer])[]=[
  ['no arcs',()=>derOid()],['one arc',()=>derOid(2)],['first arc 3',()=>derOid(3,1)],
  ['second arc 40 under arc 1',()=>derOid(1,40)],['second arc 48 under arc 2',()=>derOid(2,48)],
  ['sub-identifier 2^31',()=>derOid(2,25,2**31)],['arc -1',()=>derOid(2,25,-1)],
  ['arc 1.5',()=>derOid(2,25,1.5)],['arc NaN',()=>derOid(2,25,Number.NaN)]
 ];
 for(const [name,call] of refused)assert.throws(call,/arc|OID/,name+' must be refused');
});

test('derTime writes UTCTime before 2050 and GeneralizedTime from 2050 on',()=>{
 assert.equal(derTime(Date.UTC(2049,11,31,23,59,59,999)).toString('hex'),'170d3439313233313233353935395a');
 assert.equal(derTime(Date.UTC(2050,0,1,0,0,0,0)).toString('hex'),'180f32303530303130313030303030305a');
});

test('5000 certificates from one key parse in Node and every serial is positive without a leading zero byte',()=>{
 const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
 for(let index=0;index<5000;index++){
  const parsed=new X509Certificate(generateStartCertificate(Date.now(),key).certificate);
  const serial=parsed.serialNumber;
  assert.match(serial,/^[0-9A-F]+$/);
  assert.notEqual(serial,'0','the serial is strictly positive');
  assert.ok(serial.length<=32,'the serial carries at most 16 bytes');
  const firstByte=parseInt(serial.length%2?serial.slice(0,1).padStart(2,'0'):serial.slice(0,2),16);
  assert.notEqual(firstByte,0,'the encoding has no leading zero byte');
 }
});

test('a certificate whose finished DER no longer parses fails the self-check instead of returning',()=>{
 const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
 // One flipped tag byte corrupts the finished DER. The runner writes database-tls.crt/.key only
 // after this call returns (desktop/daemon-runner.mjs); that ordering is not tested here.
 const corrupt={certificateDer:(finished:Buffer)=>{const broken=Buffer.from(finished);broken.set([broken[0]!^1],0);return broken;}};
 assert.throws(()=>generateStartCertificate(Date.now(),key,corrupt),/the certificate just made is not valid/);
});

test('the self-check throws for a certificate whose signature bytes were corrupted',()=>{
 const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
 // The last byte belongs to the ECDSA signature inside the BIT STRING: the DER still parses and
 // the serial still matches, so only the signature check below can catch this corruption.
 const corrupt={certificateDer:(finished:Buffer)=>{const broken=Buffer.from(finished);broken.set([broken[broken.length-1]!^1],broken.length-1);return broken;}};
 assert.throws(()=>generateStartCertificate(Date.now(),key,corrupt),/not correctly signed/);
});

test('the self-check throws for a certificate with the wrong serial',()=>{
 const key=generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
 const corrupt={certificateDer:(finished:Buffer)=>{
  const broken=Buffer.from(finished);
  const element=(at:number)=>{const first=broken[at+1]!;let length=first,size=0;if(first&0x80){size=first&0x7f;length=0;for(let index=0;index<size;index++)length=length*256+broken[at+2+index]!;}const content=at+2+size;return {content,end:content+length};};
  // Walk in past the certificate and tbsCertificate headers and the [0] version element; the
  // serial INTEGER follows, and flipping its last byte changes the value without breaking DER.
  const outer=element(0),tbs=element(outer.content),version=element(tbs.content),serial=element(version.end);
  broken.set([broken[serial.end-1]!^0xff],serial.end-1);
  return broken;
 }};
 assert.throws(()=>generateStartCertificate(Date.now(),key,corrupt),/serial does not match/);
});

