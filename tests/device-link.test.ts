import test from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import {createServer} from 'node:tls';
import type {TLSSocket} from 'node:tls';
import {createHash,createPrivateKey,webcrypto} from 'node:crypto';
import {X509CertificateGenerator} from '@peculiar/x509';
import {InMemoryStore} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {DeviceLinkService} from '../src/device-link.ts';
import {hash} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const subtle=webcrypto.subtle,wait=async<T>(action:()=>Promise<T>|T,probe:(value:T)=>boolean,timeout=3000)=>{const end=Date.now()+timeout;for(;;){const value=await action();if(probe(value))return value;if(Date.now()>end)throw new Error('Condition not reached');await new Promise(resolve=>setTimeout(resolve,20));}};
// The service binds a kernel-assigned port; the offer response carries the real loopback address.
const liveAddress=(offer:{offer:{addresses:string[]}})=>offer.offer.addresses.filter(address=>address.startsWith('127.0.0.1:')).pop()!;
interface Core {store:ReturnType<typeof makeStore>;secrets:InMemorySecretSlots;service:DeviceLinkService}
const makeStore=()=>new InMemoryStore<any>();
async function core(clock:()=>number=Date.now,extra:Partial<{offerTtlMs:number}>={}){const store=makeStore(),secrets=new InMemorySecretSlots();const service=new DeviceLinkService(store,store,secrets,{clock,bind:'127.0.0.1',connectTimeoutMs:1000,...extra});return {store,secrets,service};}
async function pair(a:Core,b:Core,grants?:{view:boolean;instruct:boolean;answerApprovals:boolean}){
 const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop',...(grants?{grants}:{})});
 const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,name:'Laptop',agentName:'Claude Code'});
 const completing=b.service.confirm({commandId:'confirm-b',action:'confirm-outgoing',attemptId:attempt.attempt.id});
 const incoming=(await wait(()=>a.service.read(),value=>value.incoming.length===1)).incoming[0]!;
 await a.service.confirm({commandId:'confirm-a',action:'confirm-incoming',pendingId:incoming.id});
 assert.equal((await completing).status,'paired');
 return {offer,attempt,incoming};
}
const drain=async(...cores:Core[])=>{for(const core of cores)await core.service.drain();};

test('pairing holds one installation key in the secret adapter and both sides confirm before a device exists',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop'});
  assert.match(offer.code,/^[0-9]{6}$/);assert.ok(!JSON.stringify(offer.offer).includes(offer.code),'the pairing offer carries public information only');
  assert.equal((await b.service.read()).peers.length,0);
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,name:'Laptop',agentName:'Claude Code'});
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
  const wrong=await b.service.pair({commandId:'wrong',address:liveAddress(first),code:'000000',name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.confirm({commandId:'confirm-w',action:'confirm-outgoing',attemptId:wrong.attempt.id}),/complete|rejected|code/i);
  now+=500;
  const second=await a.service.createOffer({commandId:'offer-2',name:'Workshop'});
  now+=500;
  const attempt=await b.service.pair({commandId:'pair-2',address:liveAddress(second),code:second.code,name:'Laptop',agentName:'Claude Code'});
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
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,name:'Laptop',agentName:'Claude Code'});
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
  const revoked=(await b.service.read()).peers[0]!;
  await assert.rejects(b.service.connect({commandId:'reconnect',deviceId:revoked.deviceId}),/refused|timed out|pin/i);
  assert.equal((await b.service.read()).peers[0]!.lastStatus,'failed','a revoked device cannot reconnect');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('the link reports which candidate address connected and keeps the last connection',async()=>{
 const a=await core(),b=await core();
 try{
  const offer=await a.service.createOffer({commandId:'offer-1',name:'Workshop',addresses:['127.0.0.1:1']});
  const attempt=await b.service.pair({commandId:'pair-1',address:liveAddress(offer),code:offer.code,name:'Laptop',agentName:'Claude Code'});
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
 const store=makeStore(),secrets=new InMemorySecretSlots(),key=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const cert=await X509CertificateGenerator.createSelfSigned({serialNumber:'01',name:'CN=stub',notBefore:new Date(Date.now()-864e5),notAfter:new Date(Date.now()+3156e9),keys:{privateKey:key.privateKey as any,publicKey:key.publicKey as any},signingAlgorithm:{name:'ECDSA',hash:'SHA-256'}});
 const keyPem=createPrivateKey({key:Buffer.from(await subtle.exportKey('pkcs8',key.privateKey)),format:'der',type:'pkcs8'}).export({type:'pkcs8',format:'pem'}).toString(),certPem=cert.toString('pem');
 const stubSockets=new Set<TLSSocket>();
 const server=await new Promise<ReturnType<typeof createServer>>(resolve=>{const s=createServer({key:keyPem,cert:certPem,requestCert:false},socket=>{stubSockets.add(socket);socket.on('close',()=>stubSockets.delete(socket));socket.end(JSON.stringify({kind:'pong',supported:{min:99,max:99}})+'\n');});s.listen(0,'127.0.0.1',()=>resolve(s));});
 const port=(server.address() as {port:number}).port,service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
 const publicKey=Buffer.from(await subtle.exportKey('spki',key.publicKey)).toString('base64'),deviceId='device-'+createHash('sha256').update(Buffer.from(await subtle.exportKey('spki',key.publicKey))).digest('hex').slice(0,32);
 const command={type:'link-observe' as const,action:'peer-added' as const,peer:{deviceId,publicKey,name:'Future',agentName:'Future',grants:{view:true,instruct:true,answerApprovals:true},addresses:[`127.0.0.1:${port}`],pairedAt:Date.now()}};
 await store.commit({id:'assistant-conversation:device-link',commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:0,value:{kind:'device-link',id:'assistant-conversation:device-link',peers:[command.peer],offers:[]},events:[{type:command.type,actor:'device-link',command}],outbox:[]});
 try{
  await assert.rejects(service.connect({commandId:'future',deviceId}),/update/i);
  assert.equal((await service.read()).peers[0]!.lastStatus,'update-needed');
  validateMissionJournalLineage(store.inspect());
 }finally{await service.drain();for(const socket of stubSockets)socket.destroy();await new Promise(resolve=>server.close(()=>resolve(null)));}
});
