import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer} from 'node:tls';
import type {TLSSocket} from 'node:tls';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,X509Certificate} from 'node:crypto';
import {InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {DeviceLinkService,selfSignedDeviceCertificate,deviceIdFor} from '../src/device-link.ts';
import {hash} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const wait=async<T>(action:()=>Promise<T>|T,probe:(value:T)=>boolean,timeout=3000)=>{const end=Date.now()+timeout;for(;;){const value=await action();if(probe(value))return value;if(Date.now()>end)throw new Error('Condition not reached');await new Promise(resolve=>setTimeout(resolve,20));}};
// The service binds a kernel-assigned port; the offer response carries the real loopback address.
const liveAddress=(offer:{offer:{addresses:string[]}})=>offer.offer.addresses.filter(address=>address.startsWith('127.0.0.1:')).pop()!;
const probePort=async()=>new Promise<number>(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=(server.address() as {port:number}).port;server.close(()=>resolve(port));});});
interface Core {store:ReturnType<typeof makeStore>;secrets:InMemorySecretSlots;service:DeviceLinkService}
const makeStore=()=>new InMemoryStore<any>();
async function core(clock:()=>number=Date.now,extra:Partial<{offerTtlMs:number;port:number;bind:string;connectTimeoutMs:number}>={}){const store=makeStore(),secrets=new InMemorySecretSlots();const service=new DeviceLinkService(store,store,secrets,{clock,bind:'127.0.0.1',connectTimeoutMs:1000,...extra});return {store,secrets,service};}
async function pair(a:Core,b:Core,prefix='offer-1',initiatorAddresses?:string[]){
 const offer=await a.service.createOffer({commandId:prefix,name:'Workshop'});
 const attempt=await b.service.pair({commandId:'pair-'+prefix,address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code',...(initiatorAddresses?{addresses:initiatorAddresses}:{})});
 const completing=b.service.confirm({commandId:'confirm-b-'+prefix,action:'confirm-outgoing',attemptId:attempt.attempt.id});
 const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
 await a.service.confirm({commandId:'confirm-a-'+prefix,action:'confirm-incoming',pendingId:incoming.id});
 assert.equal((await completing).status,'paired');
 return {offer,attempt,incoming};
}
const drain=async(...cores:Core[])=>{for(const core of cores)await core.service.drain();};
const rawServer=async(options:{key:string;cert:string;requestCert:boolean},handler:(socket:TLSSocket)=>void)=>{const sockets=new Set<TLSSocket>();const server=await new Promise<ReturnType<typeof createServer>>(resolve=>{const s=createServer({...options},socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));handler(socket);});s.listen(0,'127.0.0.1',()=>resolve(s));});return {server,sockets,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(()=>resolve(null)));}};};
const rawIdentity=()=>{const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const spki=publicKey.export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(privateKey,deviceIdFor(publicKeyB64)),publicKeyB64,fingerprint:createHash('sha256').update(spki).digest('hex'),deviceId:deviceIdFor(publicKeyB64)};};

test('the self-signed certificate assembles DER that Node parses, verifies and handshakes',async()=>{
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'}),spki=publicKey.export({type:'spki',format:'der'}) as Buffer,deviceId=deviceIdFor(spki.toString('base64'));
 const cert=new X509Certificate(selfSignedDeviceCertificate(privateKey,deviceId));
 assert.equal(cert.subject,`CN=${deviceId}`);
 assert.deepEqual((cert.publicKey.export({type:'spki',format:'der'}) as Buffer).equals(spki),true);
 assert.equal(cert.verify(publicKey),true);
 assert.ok(cert.validToDate.getTime()>Date.now());
 const client=rawIdentity(),serverIdentity=rawIdentity();
 const stub=await rawServer({key:serverIdentity.privateKeyPem,cert:serverIdentity.certPem,requestCert:true},socket=>socket.end());
 try{
  const socket:TLSSocket=await new Promise((resolve,reject)=>{const c=connect({port:(stub.server.address() as {port:number}).port,host:'127.0.0.1',key:client.privateKeyPem,cert:client.certPem,rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
  const peerCert=new X509Certificate(socket.getPeerCertificate().raw);
  assert.equal(peerCert.subject,`CN=${serverIdentity.deviceId}`);
  assert.equal(peerCert.verify(createPublicKey({key:Buffer.from(serverIdentity.publicKeyB64,'base64'),format:'der',type:'spki'})),true);
  socket.destroy();
 }finally{await stub.close();}
});

test('pairing holds one installation key in the secret adapter and both sides confirm before a device exists',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  assert.match(offer.code,/^[0-9]{6}$/);assert.ok(!JSON.stringify(offer.offer).includes(offer.code),'the pairing offer carries public information only');
  assert.equal((await b.service.read()).peers.length,0);
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  assert.equal(attempt.attempt.peer.fingerprint,(await a.service.read()).identity.fingerprint);
  assert.equal((await a.service.read()).incoming.length,0,'no confirmation request before the code is presented');
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  assert.equal(incoming.peer.name,'Laptop');assert.equal(incoming.grants.instruct,true);
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});
  assert.equal((await completing).status,'paired');
  const aView=await a.service.read(),bView=await b.service.read();
  assert.equal(aView.peers.length,1);assert.equal(aView.peers[0]!.name,'Laptop');assert.equal(aView.offers.length,0,'a completed code is single-use');
  assert.equal(bView.peers.length,1);assert.equal(bView.peers[0]!.name,'Workshop');
  const restart=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1'});
  assert.equal((await restart.read()).identity.fingerprint,aView.identity.fingerprint,'the installation key survives restart');
  await restart.drain();
  const stored=await a.secrets.read({owner:'device-link',slot:'device-identity'});
  assert.match(stored!,/^[A-Za-z0-9+/=]+$/);assert.ok(Buffer.byteLength(stored!)<=1024);
  assert.ok(!JSON.stringify(a.store.inspect()).includes(stored!),'the private key never reaches the database');
  validateMissionJournalLineage(a.store.inspect());validateMissionJournalLineage(b.store.inspect());
 }finally{await drain(a,b);}
});

test('expired, reused and wrong pairing codes are refused',async()=>{
 let now=Date.now();const a=await core(()=>now,{offerTtlMs:200}),b=await core();
 try{
  const first=await a.service.createOffer({commandId:'offer-0',name:'Workshop'});
  const wrong=await b.service.pair({commandId:'wrong',address:liveAddress(first),code:'000000',fingerprint:first.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.confirm({commandId:'confirm-w',action:'confirm-outgoing',attemptId:wrong.attempt.id}),/complete|rejected|code/i);
  now+=500;
  const second=await a.service.createOffer({commandId:'offer-2',name:'Workshop'});
  now+=500;
  const attempt=await b.service.pair({commandId:'pair-2',address:liveAddress(second),code:second.code,fingerprint:second.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.confirm({commandId:'confirm-b2',action:'confirm-outgoing',attemptId:attempt.attempt.id}),/complete|rejected|code/i);
 }finally{await drain(a,b);}
});

test('a fingerprint mismatch refuses the pairing attempt before any code is sent',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  await assert.rejects(b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:'123456',fingerprint:'ab'.repeat(32),name:'Laptop',agentName:'Claude Code'}),/mismatch|pin/i);
 }finally{await drain(a,b);}
});

test('grants only widen additively and unpair removes the grant and stored key in one action',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop',grants:{view:true,instruct:false,answerApprovals:false}});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  assert.equal(incoming.grants.instruct,false,'the confirmation shows the narrowed grants');
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});await completing;
  const before=(await a.service.read()).peers[0]!;assert.equal(before.grants.instruct,false);
  await a.service.widen({commandId:'widen-1',deviceId:before.deviceId,grants:{view:true,instruct:true,answerApprovals:false}});
  assert.equal((await a.service.read()).peers[0]!.grants.instruct,true);
  await assert.rejects(a.service.widen({commandId:'widen-2',deviceId:before.deviceId,grants:{view:true,instruct:false,answerApprovals:false}}),/additively/i);
  await a.service.unpair({commandId:'unpair-1',deviceId:before.deviceId});
  assert.equal((await a.service.read()).peers.length,0,'unpair revokes the grant and deletes the stored device key');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('the link reports which candidate address connected and keeps the last connection',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop',addresses:['127.0.0.1:1']});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});await completing;
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const connected=await b.service.connect({commandId:'link-1',deviceId});
  assert.equal(connected.status,'connected');assert.equal(connected.address,liveAddress(offer),'the failed candidate is skipped and the live one reported');
  assert.equal((await b.service.read()).peers[0]!.lastStatus,'connected');
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastConnectedAt!==undefined);
  assert.equal((await a.service.read()).peers[0]!.lastStatus,'connected','the granting host observes the device');
  await b.service.disconnect({commandId:'link-2',deviceId});
  const after=await b.service.read();assert.equal(after.peers[0]!.lastStatus,'offline');assert.ok(after.peers[0]!.lastConnectedAt,'the last connection is kept');
 }finally{await drain(a,b);}
});

test('a protocol range mismatch reports update needed through the existing negotiation',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots(),identity=rawIdentity();
 const stub=await rawServer({key:identity.privateKeyPem,cert:identity.certPem,requestCert:false},socket=>{socket.end(JSON.stringify({kind:'pong',supported:{min:99,max:99}})+'\n');});
 const port=(stub.server.address() as {port:number}).port,service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
 const command={type:'link-observe' as const,action:'peer-added' as const,peer:{deviceId:identity.deviceId,publicKey:identity.publicKeyB64,name:'Future',agentName:'Future',grants:{view:true,instruct:true,answerApprovals:true},addresses:[`127.0.0.1:${port}`],pairedAt:Date.now()}};
 await store.commit({id:'assistant-conversation:device-link',commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:0,value:{kind:'device-link',id:'assistant-conversation:device-link',peers:[command.peer],offers:[]},events:[{type:command.type,actor:'device-link',command}],outbox:[]});
 try{
  await assert.rejects(service.connect({commandId:'future',deviceId:identity.deviceId}),/update/i);
  assert.equal((await service.read()).peers[0]!.lastStatus,'update-needed');
  validateMissionJournalLineage(store.inspect());
 }finally{await service.drain();await stub.close();}
});

test('a restarted host restores its listener on the persisted port',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined,b2:DeviceLinkService|undefined;
 try{
  await pair(a,b);
  await drain(a,b);
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
  b2=new DeviceLinkService(b.store,b.store,b.secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
  const deviceId=(await b2.read()).peers[0]!.deviceId;
  const connected=await wait(()=>b2!.connect({commandId:'restart-link',deviceId}).catch(()=>"retrying" as const),value=>value!=='retrying');
  assert.equal((connected as {status:string}).status,'connected','the persisted pairing reopens the same port without a new offer');
 }finally{if(a2)await a2.drain();if(b2)await b2.drain();}
});

test('each unpair keeps its own command identity across a re-pairing',async()=>{
 const a=await core(),b=await core();
 try{
  await pair(a,b,'round-1');
  const first=(await a.service.read()).peers[0]!,stale=(await b.service.read()).peers[0]!;
  await a.service.unpair({commandId:'unpair-1',deviceId:first.deviceId});
  assert.equal((await a.service.read()).peers.length,0);
  const offer=await a.service.createOffer({commandId:'offer-blocked',name:'Workshop',grants:{view:false,instruct:false,answerApprovals:false}});
  const blocked=await b.service.pair({commandId:'pair-blocked',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-blocked',action:'confirm-outgoing',attemptId:blocked.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await a.service.confirm({commandId:'confirm-a-blocked',action:'confirm-incoming',pendingId:incoming.id});
  await assert.rejects(completing,/already paired|complete/i,'a stale peer must be unpaired before re-pairing');
  assert.equal((await a.service.read()).peers.length,1,'the host-side confirmation stands; the initiator failed on its own stale peer');
  assert.equal((await a.service.read()).peers[0]!.grants.instruct,false,'the narrowed offer grants are stored, never widened silently');
  await a.service.unpair({commandId:'unpair-1b',deviceId:first.deviceId});
  await b.service.unpair({commandId:'unpair-b',deviceId:stale.deviceId});
  await pair(a,b,'round-2');
  const second=(await a.service.read()).peers[0]!;
  assert.equal(second.deviceId,first.deviceId);
  await a.service.unpair({commandId:'unpair-2',deviceId:second.deviceId});
  assert.equal((await a.service.read()).peers.length,0,'the second revocation removes the new grant instead of replaying the first');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('one pairing code confirms exactly once under concurrent requests',async()=>{
 const a=await core(),b=await core(undefined,{offerTtlMs:400}),c=await core(undefined,{offerTtlMs:400});
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempts=await Promise.all([b,c].map((core,index)=>core.service.pair({commandId:'pair-'+index,address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop '+index,agentName:'Claude Code'})));
  const confirmations=attempts.map((result,index)=>{const core=[b,c][index]!;return core.service.confirm({commandId:'confirm-'+index,action:'confirm-outgoing',attemptId:result.attempt.id}).then(()=>'paired',error=>String(error.message));});
  const pendings=(await wait(()=>a.service.read(),value=>value.incoming.length===2)).incoming;
  const results=[] as string[];
  for(const pending of pendings){try{await a.service.confirm({commandId:'confirm-a-'+pending.id,action:'confirm-incoming',pendingId:pending.id});results.push('paired');}catch(error){results.push((error as Error).message);}}
  assert.equal(results.filter(result=>result==='paired').length,1,'only one confirmation consumes the offer');
  assert.equal((await a.service.read()).peers.length,1);
  await Promise.all(confirmations);
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b,c);}
});

test('a completion naming a different key than the verified TLS peer is refused',async()=>{
 const b=await core(),rogue=rawIdentity(),other=rawIdentity();
 const stub=await rawServer({key:rogue.privateKeyPem,cert:rogue.certPem,requestCert:false},socket=>{socket.write(JSON.stringify({kind:'pair-hello',deviceId:rogue.deviceId,fingerprint:rogue.fingerprint,name:'Rogue'})+'\n');socket.write(JSON.stringify({kind:'pair-complete',peer:{deviceId:other.deviceId,publicKey:other.publicKeyB64,name:'Other',agentName:'Other',addresses:[]},grants:{view:true,instruct:true,answerApprovals:true}})+'\n');});
 try{
  const port=(stub.server.address() as {port:number}).port;
  const attempt=await b.service.pair({commandId:'pair-1',address:`127.0.0.1:${port}`,code:'123456',fingerprint:rogue.fingerprint,name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id}),/complete/i);
  assert.equal((await b.service.read()).peers.length,0,'a substituted key is never stored');
 }finally{await drain(b);await stub.close();}
});

test('a pairing request naming a different key than its TLS certificate is rejected',async()=>{
 const a=await core(),liar=rawIdentity(),other=rawIdentity();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const socket=await new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port:Number(liveAddress(offer).split(':')[1]),host:'127.0.0.1',key:liar.privateKeyPem,cert:liar.certPem,rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
  const replies:string[]=[];socket.on('data',(chunk:Buffer)=>replies.push(String(chunk)));
  socket.write(JSON.stringify({kind:'pair-intro'})+'\n');
  socket.write(JSON.stringify({kind:'pair-request',code:offer.code,peer:{deviceId:other.deviceId,publicKey:other.publicKeyB64,name:'Liar',agentName:'Liar',addresses:[]},grants:{view:true,instruct:true,answerApprovals:true}})+'\n');
  await new Promise(resolve=>socket.on('close',resolve));
  assert.ok(replies.join('').includes('"kind":"pair-rejected"'),'the substituted key claim is refused');
  assert.equal((await a.service.read()).incoming.length,0,'a key claim that does not match the certificate creates no confirmation');
 }finally{await drain(a);}
});

test('a pending exchange settles when drain closes its socket',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const pending=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  pending.catch(()=>{});
  const marker=Symbol('timeout');
  const settled=await Promise.race([b.service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),3000))]);
  assert.notEqual(settled,marker,'drain settles instead of waiting out the exchange timeout');
 }finally{await drain(a);}
});

test('concurrent first uses share one installation identity',async()=>{
 const a=await core();
 try{
  const views=await Promise.all([a.service.read(),a.service.read(),a.service.read()]);
  const identities=new Set(views.map(view=>view.identity.fingerprint));
  assert.equal(identities.size,1,'all callers observe one generated key');
 }finally{await drain(a);}
});

test('bracketed IPv6 loopback addresses pair and dial',async()=>{
 const a=await core(Date.now,{bind:'::1'}),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const address=offer.offer.addresses.find(candidate=>candidate.startsWith('[::1]:'))!;
  assert.ok(address,'the advertised address keeps the bracketed IPv6 form');
  const attempt=await b.service.pair({commandId:'pair-1',address,code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});await completing;
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  assert.equal((await b.service.connect({commandId:'link-1',deviceId})).status,'connected');
 }finally{await drain(a,b);}
});

const identityFromSecrets=async(secrets:InMemorySecretSlots)=>{const stored=await secrets.read({owner:'device-link',slot:'device-identity'});const key=createPrivateKey({key:Buffer.from(stored!,'base64'),format:'der',type:'pkcs8'});const spki=createPublicKey(key).export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {keyPem:key.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(key,deviceIdFor(publicKeyB64)),deviceId:deviceIdFor(publicKeyB64)};};
const observations=(core:Core,deviceId:string)=>core.store.inspect().filter(operation=>(operation.events[0] as {command:{action?:string;deviceId?:string}}).command?.action==='connection-observed'&&(operation.events[0] as {command:{deviceId?:string}}).command?.deviceId===deviceId).length;

test('a pairing confirmation slower than the connect timeout still completes',async()=>{
 const a=await core(Date.now,{connectTimeoutMs:300}),b=await core(Date.now,{connectTimeoutMs:300});
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  await new Promise(resolve=>setTimeout(resolve,700));
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await new Promise(resolve=>setTimeout(resolve,700));
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});
  assert.equal((await completing).status,'paired','the handshake timeout no longer governs confirmation');
 }finally{await drain(a,b);}
});

test('drain destroys accepted link sockets and awaits the listener',async()=>{
 const a=await core(),b=await core();
 try{
  const own=await b.service.createOffer({commandId:'b-offer',name:'Laptop'});
  await pair(a,b,'offer-1',[liveAddress(own)]);
  const identity=await identityFromSecrets(b.secrets);
  const port=Number(((await b.service.read()).peers[0]!.addresses.find(candidate=>candidate.startsWith('127.0.0.1:'))!).split(':')[1]);
  const dial=()=>new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',key:identity.keyPem,cert:identity.certPem,rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
  const exchange=async(socket:TLSSocket)=>{const replies:string[]=[];socket.on('data',(chunk:Buffer)=>replies.push(String(chunk)));for(let index=0;index<5;index++)socket.write(JSON.stringify({kind:'ping'})+'\n');await new Promise(resolve=>setTimeout(resolve,300));return replies.join('');};
  const socket=await dial();
  const first=await exchange(socket);assert.ok(first.includes('"kind":"pong"'));
  const peerId=(await a.service.read()).peers[0]!.deviceId,before=observations(a,peerId);
  const second=await exchange(socket);assert.equal(observations(a,peerId),before,'pings over one socket record one transition');
  assert.ok(second.includes('"kind":"pong"'));
  await a.service.drain();
  socket.write(JSON.stringify({kind:'ping'})+'\n');
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'drain destroys the accepted socket');
 }finally{await drain(a,b);}
});

test('coalesced exchange frames in one packet are all processed',async()=>{
 const b=await core(),stubIdentity=rawIdentity();
 const stub=await rawServer({key:stubIdentity.privateKeyPem,cert:stubIdentity.certPem,requestCert:false},socket=>{
  socket.on('data',()=>{socket.write(JSON.stringify({kind:'pair-hello',deviceId:stubIdentity.deviceId,fingerprint:stubIdentity.fingerprint,name:'Stub'})+'\n');socket.write(JSON.stringify({kind:'pair-pending',pendingId:'p1'})+'\n'+JSON.stringify({kind:'pair-complete',peer:{deviceId:stubIdentity.deviceId,publicKey:stubIdentity.publicKeyB64,name:'Stub',agentName:'Stub',addresses:[]},grants:{view:true,instruct:true,answerApprovals:true}})+'\n');});
 });
 try{
  const port=(stub.server.address() as {port:number}).port;
  const attempt=await b.service.pair({commandId:'pair-1',address:`127.0.0.1:${port}`,code:'123456',fingerprint:stubIdentity.fingerprint,name:'Laptop',agentName:'Claude Code'});
  assert.equal((await b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id})).status,'paired','both buffered frames are consumed');
  assert.equal((await b.service.read()).peers[0]!.deviceId,stubIdentity.deviceId);
 }finally{await drain(b);await stub.close();}
});

test('a pairing confirmation reports failure when its commit cannot land',async()=>{
 const base=makeStore();let pairingFailures=3;
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events?.[0]?.command?.action==='pairing-completed'&&pairingFailures>0){pairingFailures--;return {status:'conflict',revision:0,reason:'revision' as const};}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
 const secrets=new InMemorySecretSlots(),service=new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000}),b=await core();
 const a={store:guarded,secrets,service};
 try{
  const offer=await service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await assert.rejects(service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id}),/did not complete|conflict/i);
  assert.equal((await service.read()).incoming.length,0,'the failed request is withdrawn');
  assert.equal((await service.read()).offers.length,1,'the offer stays live');
  await assert.rejects(completing,/complete|rejected|closed/i);
 }finally{await service.drain();await drain(b);}
});

test('each side stores the grants its owner approved',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,grants:{view:true,instruct:false,answerApprovals:false},name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});await completing;
  assert.equal((await a.service.read()).peers[0]!.grants.instruct,true,'the granting host keeps its own offer grants');
  assert.equal((await b.service.read()).peers[0]!.grants.instruct,false,'the initiator keeps the grants it approved');
 }finally{await drain(a,b);}
});

test('pairing without the advertised fingerprint is refused',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  await assert.rejects(b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,name:'Laptop',agentName:'Claude Code'} as unknown as Record<string,unknown>),/fingerprint/i,'the code is never sent to an unpinned key');
 }finally{await drain(a,b);}
});

test('the initiating device keeps its advertised address candidates',async()=>{
 const a=await core(),b=await core();
 try{
  const own=await b.service.createOffer({commandId:'b-offer',name:'Laptop'}),bAddress=liveAddress(own);
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,addresses:[bAddress],name:'Laptop',agentName:'Claude Code'});
  const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
  const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
  await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});await completing;
  const stored=(await a.service.read()).peers[0]!;
  assert.ok(stored.addresses.includes(bAddress),'the initiator declared its own address');
  assert.ok(!stored.addresses.some(address=>address===liveAddress(offer)),'the host never stores its own address as the peer address');
  assert.equal((await a.service.connect({commandId:'dial-back',deviceId:stored.deviceId})).status,'connected','the host dials the peer, not itself');
 }finally{await drain(a,b);}
});

test('a supplied malformed grants object is rejected, never widened by fallback',async()=>{
 const a=await core(),b=await core();
 try{
  await assert.rejects(a.service.createOffer({commandId:'offer-bad',name:'Workshop',grants:{view:true,instruct:false} as unknown as never}),/grants/i);
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  await assert.rejects(b.service.pair({commandId:'pair-bad',address:liveAddress(offer),code:offer.code,fingerprint:offer.offer.fingerprint,grants:{view:true,instruct:false} as unknown as never,name:'Laptop',agentName:'Claude Code'}),/grants/i);
  assert.equal((await a.service.read()).offers.length,1,'no offer was created from a malformed grants object');
 }finally{await drain(a,b);}
});

test('connecting an already connected device reuses the live link',async()=>{
 const a=await core(),b=await core();
 try{
  await pair(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const first=await b.service.connect({commandId:'link-1',deviceId});
  const observed=observations(a,deviceId);
  const second=await b.service.connect({commandId:'link-2',deviceId});
  assert.equal(second.address,first.address,'the same connection is reused');
  assert.equal(observations(a,deviceId),observed,'no second accepted socket replaces the first');
  await b.service.disconnect({commandId:'link-3',deviceId});
 }finally{await drain(a,b);}
});

test('the listener closes when the last offer expires with no paired devices',async()=>{
 const a=await core(Date.now,{offerTtlMs:200}),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  const port=Number(liveAddress(offer).split(':')[1]);
  await new Promise(resolve=>setTimeout(resolve,600));
  await assert.rejects(new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);}),/refused|closed/i,'an expired offer leaves no listener');
 }finally{await drain(a,b);}
});

test('a failed first identity initialization is retried',async()=>{
 const secrets=new InMemorySecretSlots(),original=secrets.read.bind(secrets);let failed=false;
 const flaky=async(slot:Parameters<typeof original>[0],signal?:AbortSignal)=>{if(!failed&&slot.owner==='device-link'){failed=true;throw new Error('adapter unavailable');}return original(slot,signal);};
 secrets.read=flaky as unknown as typeof secrets.read;
 const store=makeStore(),service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
 try{
  await wait(()=>Promise.resolve(),()=>failed,1000);
  const view=await service.read();
  assert.match(view.identity.fingerprint,/^[a-f0-9]{64}$/,'initialization retries after the adapter recovers');
 }finally{await service.drain();}
});
