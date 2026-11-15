import test from 'node:test';
import assert from 'node:assert/strict';
import {connect,createServer} from 'node:tls';
import type {TLSSocket} from 'node:tls';
import {connect as netConnect,createServer as netCreateServer} from 'node:net';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,X509Certificate} from 'node:crypto';
import {InMemoryStore,CommitOutcomeUnknownError} from '../src/storage.ts';
import {InMemorySecretSlots} from '../src/secret-slots.ts';
import {DeviceLinkService,DEVICE_LINK_ID,selfSignedDeviceCertificate,deviceIdFor,SRP_GROUP,srpK,srpX,srpVerifier,srpClientPublic,srpServerPublic,srpU,srpServerSecret,srpClientSecret,pairingConfirmations} from '../src/device-link.ts';
import {hash} from '../src/domain.ts';
import {validateMissionJournalLineage} from '../src/backup-lineage.ts';

const wait=async<T>(action:()=>Promise<T>|T,probe:(value:T)=>boolean,timeout=3000)=>{const end=Date.now()+timeout;for(;;){const value=await action();if(probe(value))return value;if(Date.now()>end)throw new Error('Condition not reached');await new Promise(resolve=>setTimeout(resolve,20));}};
interface Core {store:ReturnType<typeof makeStore>;secrets:InMemorySecretSlots;service:DeviceLinkService}
const makeStore=()=>new InMemoryStore<any>();
let sequence=0;
async function core(clock:()=>number=Date.now,extra:Partial<{pairingTtlMs:number;port:number;bind:string;connectTimeoutMs:number;preAuthTimeoutMs:number;idleTimeoutMs:number;maxUnauthenticated:number;maxUnauthenticatedPerAddress:number;inboundCoalesceMs:number}>={}){const store=makeStore(),secrets=new InMemorySecretSlots();const service=new DeviceLinkService(store,store,secrets,{clock,bind:'127.0.0.1',port:0,connectTimeoutMs:1000,...extra});return {store,secrets,service};}
const openWindow=(a:Core,commandId=`window-${++sequence}`)=>a.service.openPairing({commandId});
const pairFrom=(b:Core,address:string,code:string)=>b.service.pair({commandId:`pair-${++sequence}`,address,code,name:'Laptop',agentName:'Claude Code'});
const link=async(a:Core,b:Core)=>{const window=await openWindow(a);const outcome=await pairFrom(b,window.address,window.code!);assert.equal(outcome.status,'paired');return window;};
const drain=async(...cores:Core[])=>{for(const core of cores)await core.service.drain();};
const rawServer=async(options:{key:string;cert:string;requestCert:boolean},handler:(socket:TLSSocket)=>void)=>{const sockets=new Set<TLSSocket>();const server=await new Promise<ReturnType<typeof createServer>>(resolve=>{const s=createServer({...options},socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));handler(socket);});s.listen(0,'127.0.0.1',()=>resolve(s));});return {server,sockets,close:async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(()=>resolve(null)));}};};
const rawIdentity=()=>{const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});const spki=publicKey.export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(privateKey,deviceIdFor(publicKeyB64)),publicKeyB64,fingerprint:createHash('sha256').update(spki).digest('hex'),deviceId:deviceIdFor(publicKeyB64)};};
const dial=(port:number,identity?:{privateKeyPem?:string;keyPem?:string;certPem:string})=>new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',...(identity?{key:identity.privateKeyPem??identity.keyPem,cert:identity.certPem}:{}),minVersion:'TLSv1.3',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);});
const readFrames=(socket:TLSSocket)=>{const parts:string[]=[];socket.on('data',(chunk:Buffer)=>parts.push(String(chunk)));return {text:()=>parts.join(''),frames:()=>parts.join('').split('\n').filter(Boolean).map(line=>JSON.parse(line)as Record<string,any>)};};
const randomExponent=()=>BigInt('0x'+randomBytes(32).toString('hex'));
// A raw SRP client that can hold its confirmation: it starts a session and computes a valid confirmation for a given code on demand.
const rawSession=async(port:number,name:string)=>{
 const identity=rawIdentity(),socket=await dial(port,identity),frames=readFrames(socket);
 const claim={deviceId:identity.deviceId,publicKey:identity.publicKeyB64,name,agentName:name},exponent=randomExponent(),aPub=srpClientPublic(SRP_GROUP,exponent);
 socket.write(JSON.stringify({kind:'pair-client',peer:claim,supported:{min:1,max:1},A:bigB64(aPub)})+'\n');
 const reply=(await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'))).find(message=>message.kind==='pair-server')!;
 return {socket,frames,confirm:(code:string)=>{
  const salt=Buffer.from(reply.salt,'base64'),b=BigInt('0x'+Buffer.from(reply.B,'base64').toString('hex'));
  const x=srpX(SRP_GROUP,salt,`massion-pair:${code}`),u=srpU(SRP_GROUP,aPub,b);
  return pairingConfirmations(srpClientSecret(SRP_GROUP,b,x,exponent,u),claim,reply.peer,{min:1,max:1},reply.supported).client;
 }};
};
const bigHex=(value:bigint,length:number)=>value.toString(16).toUpperCase().padStart(length*2,'0');
const bigB64=(value:bigint)=>{let hex=value.toString(16);if(hex.length%2)hex='0'+hex;return Buffer.from(hex,'hex').toString('base64');};
const bigPaddedB64=(value:bigint)=>Buffer.from(value.toString(16).padStart(SRP_GROUP.prime.length*2,'0'),'hex').toString('base64');
const identityFromSecrets=async(secrets:InMemorySecretSlots)=>{const stored=await secrets.read({owner:'device-link',slot:'device-identity'});const key=createPrivateKey({key:Buffer.from(stored!,'base64'),format:'der',type:'pkcs8'});const spki=createPublicKey(key).export({type:'spki',format:'der'}) as Buffer,publicKeyB64=spki.toString('base64');return {keyPem:key.export({type:'pkcs8',format:'pem'}).toString(),certPem:selfSignedDeviceCertificate(key,deviceIdFor(publicKeyB64)),deviceId:deviceIdFor(publicKeyB64)};};
const observations=(core:Core,deviceId:string)=>core.store.inspect().filter(operation=>(operation.events[0] as {command:{action?:string;deviceId?:string}}).command?.action==='connection-observed'&&(operation.events[0] as {command:{deviceId?:string}}).command?.deviceId===deviceId).length;
const seedPeer=async(store:ReturnType<typeof makeStore>,deviceId:string,address:string,publicKey='A'.repeat(64))=>{const command={type:'link-observe' as const,action:'peer-added' as const,peer:{deviceId,publicKey,name:'Seeded',agentName:'Seeded',grants:{view:true,instruct:true,answerApprovals:true},addresses:[address],pairedAt:Date.now()}};await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(command).slice(0,32),fingerprint:hash({actorId:'device-link',command}),expectedRevision:0,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[command.peer],offers:[]},events:[{type:command.type,actor:'device-link',command}],outbox:[]});};

// RFC 5054 appendix B: 1024-bit group (generator 2), SHA-1, user "alice" with "password123".
const RFC_N='EEAF0AB9ADB38DD69C33F80AFA8FC5E86072618775FF3C0B9EA2314C9C256576D674DF7496EA81D3383B4813D692C6E0E0D5D8E250B98BE48E495C1D6089DAD15DC7D7B46154D6B6CE8EF4AD69B15D4982559B297BCF1885C529F566660E57EC68EDBC3C05726CC02FD4CBF4976EAA9AFD5138FE8376435B9FC61D2FC0EB06E3';
const RFC_V='7E273DE8696FFC4F4E337D05B4B375BEB0DDE1569E8FA00A9886D8129BADA1F1822223CA1A605B530E379BA4729FDC59F105B4787E5186F5C671085A1447B52A48CF1970B4FB6F8400BBF4CEBFBB168152E08AB5EA53D15C1AFF87B2B9DA6E04E058AD51CC72BFC9033B564E26480D78E955A5E29E7AB245DB2BE315E2099AFB';
const RFC_A='61D5E490F6F1B79547B0704C436F523DD0E560F0C64115BB72557EC44352E8903211C04692272D8B2D1A5358A2CF1B6E0BFCF99F921530EC8E39356179EAE45E42BA92AEACED825171E1E8B9AF6D9C03E1327F44BE087EF06530E69F66615261EEF54073CA11CF5858F0EDFDFE15EFEAB349EF5D76988A3672FAC47B0769447B';
const RFC_B='BD0C61512C692C0CB6D041FA01BB152D4916A1E77AF46AE105393011BAF38964DC46A0670DD125B95A981652236F99D9B681CBF87837EC996C6DA04453728610D0C6DDB58B318885D7D82C7F8DEB75CE7BD4FBAA37089E6F9C6059F388838E7A00030B331EB76840910440B1B27AAEAEEB4012B7D7665238A8E3FB004B117B58';
const RFC_S='B0DC82BABCF30674AE450C0287745E7990A3381F63B387AAF271A10D233861E359B48220F7C4693C9AE12B0A6F67809F0876E2D013800D6C41BB59B6D5979B5C00A172B4A2A5903A0BDCAF8A709585EB2AFAFA8F3499B200210DCC1F10EB33943CD67FC88A2F39A4BE5BEC4EC0A3212DC346D7E474B29EDE8A469FFECA686E5A';

test('the RFC 5054 appendix B vectors reproduce through the SRP code path',()=>{
 const group={prime:Buffer.from(RFC_N,'hex'),generator:Buffer.from([2]),hash:'sha1'},salt=Buffer.from('BEB25379D1A8581EB5A727673A2441EE','hex');
 const a=BigInt('0x60975527035CF2AD1989806F0407210BC81EDC04E2762A56AFD529DDDA2D4393'),b=BigInt('0xE487CB59D31AC550471E81F00F6928E01DDA08E974A004F49E61F5D105284D20');
 const k=srpK(group),x=srpX(group,salt,'alice:password123'),v=srpVerifier(group,salt,'alice:password123');
 const aPub=srpClientPublic(group,a),bPub=srpServerPublic(group,v,b),u=srpU(group,aPub,bPub);
 const client=srpClientSecret(group,bPub,x,a,u),server=srpServerSecret(group,aPub,x,u,b);
 assert.equal(bigHex(k,20),'7556AA045AEF2CDD07ABAF0F665C3E818913186F');
 assert.equal(bigHex(x,20),'94B7555AABE9127CC58CCF4993DB6CF84D16C124');
 assert.equal(bigHex(v,128),RFC_V);
 assert.equal(bigHex(aPub,128),RFC_A);
 assert.equal(bigHex(bPub,128),RFC_B);
 assert.equal(bigHex(u,20),'CE38B9593487DA98554ED47D70A7AE5F462EF019');
 assert.equal(bigHex(client,128),RFC_S);
 assert.equal(client===server,true,'both sides derive the same premaster secret');
});

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

test('two services pair with the right code and then link over pinned mutual TLS',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.match(window.code!,/^[0-9]{6}$/);
  assert.equal(window.expiresAt>Date.now(),true);
  assert.match(window.address,/127\.0\.0\.1:[0-9]+/);
  assert.equal((await a.service.read()).pairing!.attemptsLeft,5);
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'paired');
  assert.equal((await a.service.read()).pairing,null,'a successful pairing closes the window');
  const aView=await a.service.read(),bView=await b.service.read();
  assert.equal(aView.peers.length,1);assert.equal(aView.peers[0]!.name,'Laptop');assert.equal(aView.peers[0]!.grants.instruct,true,'the three grants are on by default');
  assert.equal(bView.peers.length,1);assert.equal(bView.peers[0]!.name,aView.identity.name);assert.equal(bView.peers[0]!.addresses[0],window.address);
  const deviceId=bView.peers[0]!.deviceId;
  const connected=await b.service.connect({commandId:`link-${++sequence}`,deviceId});
  assert.equal(connected.status,'connected');
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  validateMissionJournalLineage(a.store.inspect());validateMissionJournalLineage(b.store.inspect());
 }finally{await drain(a,b);}
});

test('a wrong code reports the remaining attempts and five wrong codes end the window',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  for(let index=4;index>=0;index--){
   const wrong=await pairFrom(b,window.address,'000000');
   assert.equal(wrong.status,'wrong-code');
   assert.equal(wrong.attemptsLeft,index);
  }
  assert.equal((await a.service.read()).pairing,null,'the exhausted window is closed');
  const ended=await pairFrom(b,window.address,window.code!);
  assert.equal(ended.status,'code-ended','the right code no longer answers after five wrong confirmations');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('an expired code is refused like an ended one',async()=>{
 let now=Date.now();const a=await core(()=>now),b=await core();
 try{
  const window=await openWindow(a);
  now+=3e5+1000;
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'code-ended');
 }finally{await drain(a,b);}
});

test('a pairing request with no open window gets no answer',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const stored=(await b.service.read()).peers[0]!.addresses[0]!;
  assert.equal((await pairFrom(b,stored,'123456')).status,'code-ended');
  const port=Number(stored.split(':')[1]);
  const stranger=rawIdentity(),socket=await dial(port,stranger),frames=readFrames(socket);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:stranger.deviceId,publicKey:stranger.publicKeyB64,name:'Stranger',agentName:'Stranger'},supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n');
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'the socket is closed');
  assert.ok(!frames.text().includes('pair-server'),'no pairing material is disclosed');
 }finally{await drain(a,b);}
});

test('a man in the middle that terminates TLS on both sides does not pair',async()=>{
 const a=await core(),b=await core(),relayIdentity=rawIdentity();
 try{
  const window=await openWindow(a),hostPort=Number(window.address.split(':')[1]);
  const relay=await rawServer({key:relayIdentity.privateKeyPem,cert:relayIdentity.certPem,requestCert:true},client=>{
   const upstream=connect({host:'127.0.0.1',port:hostPort,key:relayIdentity.privateKeyPem,cert:relayIdentity.certPem,minVersion:'TLSv1.3',rejectUnauthorized:false});
   client.on('data',data=>upstream.write(data));upstream.on('data',data=>client.write(data));
   client.on('close',()=>upstream.destroy());upstream.on('close',()=>client.destroy());client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  });
  try{
   const port=(relay.server.address() as {port:number}).port;
   const outcome=await pairFrom(b,`127.0.0.1:${port}`,window.code!);
   assert.notEqual(outcome.status,'paired','the relayed confirmations bind different socket keys and differ');
   assert.equal((await a.service.read()).peers.length,0);
   assert.equal((await b.service.read()).peers.length,0);
  }finally{await relay.close();}
 }finally{await drain(a,b);}
});

test('the code, the verifier and the premaster secret never reach the store or a thrown message',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,'000000')).status,'wrong-code');
  const conflictId='pair-conflict';
  await b.service.pair({commandId:conflictId,address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'});
  // A raw client with the right code derives the real session premaster but never confirms.
  const guesser=rawIdentity(),port=Number(window.address.split(':')[1]);
  const socket=await dial(port,guesser),frames=readFrames(socket);
  const exponent=randomExponent(),aPub=srpClientPublic(SRP_GROUP,exponent);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:guesser.deviceId,publicKey:guesser.publicKeyB64,name:'Guesser',agentName:'Guesser'},supported:{min:1,max:1},A:bigB64(aPub)})+'\n');
  const reply=(await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'))).find(message=>message.kind==='pair-server')!;
  const salt=Buffer.from(reply.salt,'base64'),bBig=BigInt('0x'+Buffer.from(reply.B,'base64').toString('hex'));
  const secret=`massion-pair:${window.code}`;
  const x=srpX(SRP_GROUP,salt,secret),u=srpU(SRP_GROUP,aPub,bBig);
  const premaster=srpClientSecret(SRP_GROUP,bBig,x,exponent,u),verifier=srpVerifier(SRP_GROUP,salt,secret);
  socket.destroy();
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const thrown=await b.service.pair({commandId:conflictId,address:window.address,code:'000000',name:'Renamed',agentName:'Claude Code'}).then(()=>null,error=>error as Error);
  assert.ok(thrown instanceof Error&&/conflict/i.test(thrown.message),'a changed payload under the same command identity is refused');
  assert.ok(!thrown!.message.includes(window.code!),'a thrown message never carries the code');
  for(const target of [a,b]){
   const operations=target.store.inspect();
   const serialized=JSON.stringify(operations),strings:string[]=[];
   const walk=(value:unknown)=>{if(typeof value==='string')strings.push(value);else if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')Object.values(value).forEach(walk);};
   walk(operations);
   assert.ok(strings.every(text=>!text.includes(window.code!)),'the pairing code never appears as a stored string');
   for(const value of [premaster,verifier])for(const form of [bigB64(value),bigPaddedB64(value)])assert.ok(!serialized.includes(form),'SRP secrets never reach the journal');
  }
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('A = 0, A = N and B = 0 are refused',async()=>{
 const a=await core(),b=await core(),stubIdentity=rawIdentity();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  for(const value of [0n,BigInt('0x'+SRP_GROUP.prime.toString('hex'))]){
   const attacker=rawIdentity(),socket=await dial(port,attacker),frames=readFrames(socket);
   socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:attacker.deviceId,publicKey:attacker.publicKeyB64,name:'Attacker',agentName:'Attacker'},supported:{min:1,max:1},A:bigB64(value)})+'\n');
   await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
   assert.ok(socket.destroyed);assert.ok(!frames.text().includes('pair-server'));
  }
  const stub=await rawServer({key:stubIdentity.privateKeyPem,cert:stubIdentity.certPem,requestCert:true},socket=>{socket.on('data',()=>socket.write(JSON.stringify({kind:'pair-server',salt:randomBytes(16).toString('base64'),B:bigB64(0n),peer:{deviceId:stubIdentity.deviceId,publicKey:stubIdentity.publicKeyB64,name:'Rogue',agentName:'Rogue'},supported:{min:1,max:1}})+'\n'));});
  try{
   const stubPort=(stub.server.address() as {port:number}).port;
   const outcome=await pairFrom(b,`127.0.0.1:${stubPort}`,'123456');
   assert.equal(outcome.status,'code-ended','a zero server value aborts the client exchange');
   assert.equal((await b.service.read()).peers.length,0);
  }finally{await stub.close();}
 }finally{await drain(a,b);}
});

test('a second pairing attempt on one socket is refused',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const attacker=rawIdentity(),socket=await dial(port,attacker),frames=readFrames(socket);
  const claim={deviceId:attacker.deviceId,publicKey:attacker.publicKeyB64,name:'Attacker',agentName:'Attacker'},frame=JSON.stringify({kind:'pair-client',peer:claim,supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n';
  socket.write(frame);
  await wait(frames.frames,list=>list.some(message=>message.kind==='pair-server'));
  socket.write(frame);
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'one guess per socket');
  assert.equal(frames.frames().filter(message=>message.kind==='pair-server').length,1,'the second attempt is never answered');
 }finally{await drain(a);}
});

test('opening a window replaces the previous one and closing ends it',async()=>{
 const a=await core(),b=await core();
 try{
  const first=await openWindow(a),second=await openWindow(a);
  assert.notEqual(first.code,second.code);
  assert.equal((await pairFrom(b,second.address,second.code!)).status,'paired');
  const third=await openWindow(a);
  await a.service.closePairing({commandId:`close-${++sequence}`});
  assert.equal((await pairFrom(b,third.address,third.code!)).status,'code-ended','a closed window no longer answers');
 }finally{await drain(a,b);}
});

test('a restart ends a live pairing window',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined;
 try{
  const window=await openWindow(a);
  await a.service.drain();
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'could-not-connect','the window, being memory only, cannot survive a restart');
  await a2.drain();
 }finally{await drain(b);}
});

test('journals from the offer era replay and no offer events are ever written',async()=>{
 const store=makeStore(),now=Date.parse('2026-11-15T00:00:00Z');
 const offerCommand={type:'link-owner' as const,action:'create-offer' as const,offerId:'legacy-1',codeHash:'ab'.repeat(32),grants:{view:true,instruct:true,answerApprovals:true},addresses:[],name:'Workshop',created:now,expiresAt:now+3e5};
 const legacyOffer={id:'legacy-1',codeHash:'ab'.repeat(32),grants:{view:true,instruct:true,answerApprovals:true},addresses:[],name:'Workshop',created:now,expiresAt:now+3e5,used:false,wrongCodes:0};
 await store.commit({id:DEVICE_LINK_ID,commandId:'legacy-1',fingerprint:hash({actorId:'local-owner',command:offerCommand}),expectedRevision:0,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[legacyOffer]},events:[{type:'link-owner',actor:'local-owner',command:offerCommand}],outbox:[]});
 const rejectCommand={type:'link-observe' as const,action:'code-rejected' as const,offerId:'legacy-1',attempt:1};
 await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(rejectCommand).slice(0,32),fingerprint:hash({actorId:'device-link',command:rejectCommand}),expectedRevision:1,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[{...legacyOffer,wrongCodes:1}]},events:[{type:'link-observe',actor:'device-link',command:rejectCommand}],outbox:[]});
 const legacyPeer={deviceId:'device-legacy',publicKey:'A'.repeat(64),name:'Laptop',agentName:'Laptop',addresses:[],grants:{view:true,instruct:true,answerApprovals:true},pairedAt:now};
 const completeCommand={type:'link-observe' as const,action:'pairing-completed' as const,peer:legacyPeer,offerId:'legacy-1'};
 await store.commit({id:DEVICE_LINK_ID,commandId:'assistant-link:'+hash(completeCommand).slice(0,32),fingerprint:hash({actorId:'device-link',command:completeCommand}),expectedRevision:2,value:{kind:'device-link',id:DEVICE_LINK_ID,peers:[legacyPeer],offers:[{...legacyOffer,used:true,wrongCodes:1}]},events:[{type:'link-observe',actor:'device-link',command:completeCommand}],outbox:[]});
 validateMissionJournalLineage(store.inspect());
 const secrets=new InMemorySecretSlots(),a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})},b=await core();
 try{
  assert.equal((await a.service.read()).peers.length,1,'the legacy journal loads');
  const window=await openWindow(a);
  assert.equal((await pairFrom(b,window.address,window.code!)).status,'paired');
  const legacyCount=store.inspect().filter(operation=>{const action=(operation.events[0] as {command:{action?:string}}).command?.action;return action==='create-offer'||action==='code-rejected'||action==='pairing-completed';}).length;
  assert.equal(legacyCount,3,'new operations never write offer events');
  validateMissionJournalLineage(store.inspect());
 }finally{await drain(a,b);}
});

test('a repeated pairing command with a changed payload is refused',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a),commandId=`pair-${++sequence}`;
  await b.service.pair({commandId,address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'});
  await assert.rejects(b.service.pair({commandId,address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}),/conflict/i,'a changed code under the same command identity is a conflict');
 }finally{await drain(a,b);}
});

test('a confirmation cannot complete after the window is closed or the budget is exhausted',async()=>{
 const a=await core(),b=await core();
 try{
  const closedWindow=await openWindow(a),held=await rawSession(Number(closedWindow.address.split(':')[1]),'Closer');
  await a.service.closePairing({commandId:'close-window'});
  held.socket.write(JSON.stringify({kind:'pair-confirm',confirm:held.confirm(closedWindow.code!)})+'\n');
  await wait(()=>Promise.resolve(held.socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(held.socket.destroyed,'closing the window ends every in-flight session of it');
  assert.ok(!held.frames.text().includes('pair-complete'),'a confirmation computed before the close never completes');
  assert.equal((await a.service.read()).peers.length,0);

  const exhaustedWindow=await openWindow(a),late=await rawSession(Number(exhaustedWindow.address.split(':')[1]),'Late');
  for(let index=0;index<5;index++)assert.equal((await pairFrom(b,exhaustedWindow.address,'000000')).status,'wrong-code');
  late.socket.write(JSON.stringify({kind:'pair-confirm',confirm:late.confirm(exhaustedWindow.code!)})+'\n');
  await wait(()=>Promise.resolve(late.socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(late.socket.destroyed,'an exhausted window ends every in-flight session of it');
  assert.ok(!late.frames.text().includes('pair-complete'),'a confirmation after five wrong attempts never completes');
  assert.equal((await a.service.read()).peers.length,0);
 }finally{await drain(a,b);}
});

test('a restart keeps the persisted listener port instead of the fixed default',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined;
 try{
  const window=await link(a,b);
  await a.service.drain();
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000});
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const connected=await b.service.connect({commandId:'keep-port',deviceId});
  assert.equal(connected.status,'connected','the persisted port is rebound, not replaced by the default');
  assert.equal(connected.address,window.address);
 }finally{if(a2)await a2.drain();await drain(b);}
});

test('an unknown commit outcome stays unknown instead of ending the code',async()=>{
 const a=await core(),base=makeStore();
 const failing=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{const result=await target.commit(input);if(input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID)throw new CommitOutcomeUnknownError(input);return result;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const b:Core={store:failing,secrets,service:new DeviceLinkService(failing,failing,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 try{
  const window=await openWindow(a);
  await assert.rejects(b.service.pair({commandId:'p-unknown',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'}),error=>error instanceof CommitOutcomeUnknownError,'only SRP and network failures become code-ended');
  assert.equal((await b.service.read()).peers.length,1,'the peer is durably recorded; only the acknowledgement was lost');
 }finally{await drain(a,b);}
});

test('drain awaits an in-flight inbound pairing commit',async()=>{
 const base=makeStore();let arrived=false,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(!arrived&&input.events?.[0]?.command?.action==='peer-added'&&input.id===DEVICE_LINK_ID){arrived=true;await gate;}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const pairing=b.service.pair({commandId:'p-drain',address:window.address,code:window.code,name:'Laptop',agentName:'Claude Code'});
  pairing.catch(()=>{});
  await wait(()=>Promise.resolve(arrived),value=>value,3000);
  const draining=a.service.drain();
  await new Promise(resolve=>setTimeout(resolve,400));
  const marker=Symbol('timeout');
  const early=await Promise.race([draining.then(()=>'settled',()=>'settled'),new Promise(resolve=>setTimeout(()=>resolve(marker),50))]);
  assert.equal(early,marker,'drain waits for the in-flight pairing commit instead of returning early');
  release();
  await draining.catch(()=>{});
  assert.equal((await a.service.read()).peers.length,1,'the commit settles before drain reports completion');
 }finally{release();await drain(a,b).catch(()=>{});}
});

test('a retried pairing command replays the original outcome without spending attempts',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a),wrong={commandId:'p-retry-wrong',address:window.address,code:'000000',name:'Laptop',agentName:'Claude Code'};
  const first=await b.service.pair(wrong);
  assert.equal(first.status,'wrong-code');
  const retry=await b.service.pair({...wrong});
  assert.equal(retry.status,'wrong-code');
  assert.equal(retry.attemptsLeft,first.attemptsLeft,'the retry replays the original outcome');
  assert.equal((await a.service.read()).pairing!.attemptsLeft,4,'a replayed wrong code spends one attempt, not two');
  const ok={commandId:'p-retry-ok',address:window.address,code:window.code!,name:'Laptop',agentName:'Claude Code'};
  assert.equal((await b.service.pair(ok)).status,'paired');
  assert.equal((await b.service.pair({...ok})).status,'paired','a completed exchange replays instead of dialing a consumed window');
  assert.equal((await b.service.read()).peers.length,1);
 }finally{await drain(a,b);}
});

test('an unfinished dial is rejected on socket close so drain settles',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots();
 const gate=await new Promise<ReturnType<typeof netCreateServer>>(resolve=>{const server=netCreateServer(socket=>{socket.on('data',()=>{});});server.listen(0,'127.0.0.1',()=>resolve(server));});
 const port=(gate.address() as {port:number}).port;
 await seedPeer(store,'device-held',`127.0.0.1:${port}`);
 const service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:5000});
 try{
  const connecting=service.connect({commandId:'held',deviceId:'device-held'});connecting.catch(()=>{});
  await new Promise(resolve=>setTimeout(resolve,300)); // TCP is up, the TLS handshake never completes
  const marker=Symbol('timeout');
  const settled=await Promise.race([service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),2500))]);
  assert.notEqual(settled,marker,'drain settles once the pending dial is rejected on close');
  const outcome=await connecting.then(()=>'resolved',error=>error as Error);
  assert.ok(outcome instanceof Error,'the dial rejects instead of hanging');
 }finally{await service.drain().catch(()=>{});gate.close();}
});

test('an incompatible inbound protocol range is recorded as update-needed',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets);
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const socket=await dial(port,identity),frames=readFrames(socket);
  socket.write(JSON.stringify({kind:'ping',supported:{min:99,max:99}})+'\n');
  await wait(frames.frames,list=>list.some(message=>message.kind==='pong'));
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='update-needed');
  socket.destroy();
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('a protocol range mismatch on an outbound link reports update needed',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots(),identity=rawIdentity();
 const stub=await rawServer({key:identity.privateKeyPem,cert:identity.certPem,requestCert:false},socket=>{socket.end(JSON.stringify({kind:'pong',supported:{min:99,max:99}})+'\n');});
 const port=(stub.server.address() as {port:number}).port,service=new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
 await seedPeer(store,identity.deviceId,`127.0.0.1:${port}`,identity.publicKeyB64);
 try{
  await assert.rejects(service.connect({commandId:'future',deviceId:identity.deviceId}),/update/i);
  assert.equal((await service.read()).peers[0]!.lastStatus,'update-needed');
  validateMissionJournalLineage(store.inspect());
 }finally{await service.drain();await stub.close();}
});

test('grants only widen additively and unpair removes the paired device',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const before=(await a.service.read()).peers[0]!;
  assert.equal(before.grants.view,true);assert.equal(before.grants.instruct,true);assert.equal(before.grants.answerApprovals,true,'pairing turns the three grants on');
  await a.service.widen({commandId:`widen-${++sequence}`,deviceId:before.deviceId,grants:{view:true,instruct:true,answerApprovals:true}});
  assert.equal((await a.service.read()).peers[0]!.grants.instruct,true);
  await assert.rejects(a.service.widen({commandId:`widen-${++sequence}`,deviceId:before.deviceId,grants:{view:true,instruct:false,answerApprovals:true}}),/additively/i,'narrowing is never allowed');
  await a.service.unpair({commandId:`unpair-${++sequence}`,deviceId:before.deviceId});
  assert.equal((await a.service.read()).peers.length,0,'unpair removes the grant and the stored device key');
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('a restarted host restores its listener on the persisted port and its identity',async()=>{
 const a=await core(),b=await core();
 let a2:DeviceLinkService|undefined,b2:DeviceLinkService|undefined;
 try{
  const window=await link(a,b);
  await drain(a,b);
  a2=new DeviceLinkService(a.store,a.store,a.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  b2=new DeviceLinkService(b.store,b.store,b.secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  assert.equal((await a2.read()).identity.fingerprint,(await a.service.read()).identity.fingerprint,'the installation key survives restart');
  const deviceId=(await b2.read()).peers[0]!.deviceId;
  const connected=await wait(()=>b2!.connect({commandId:'restart-link',deviceId}).catch(()=>'retrying' as const),value=>value!=='retrying');
  assert.equal((connected as {status:string}).status,'connected','the persisted pairing reopens the same port without a new window');
  assert.equal((await b2.read()).peers[0]!.addresses[0],window.address);
 }finally{if(a2)await a2.drain();if(b2)await b2.drain();}
});

test('a paired device can be unpaired and then paired again',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const first=(await a.service.read()).peers[0]!,stale=(await b.service.read()).peers[0]!;
  await a.service.unpair({commandId:'unpair-1',deviceId:first.deviceId});
  await b.service.unpair({commandId:'unpair-b',deviceId:stale.deviceId});
  await link(a,b);
  const second=(await a.service.read()).peers[0]!;
  assert.equal(second.deviceId,first.deviceId);
  await a.service.unpair({commandId:'unpair-2',deviceId:second.deviceId});
  assert.equal((await a.service.read()).peers.length,0);
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b);}
});

test('one pairing code pairs exactly once under concurrent requests',async()=>{
 const a=await core(),b=await core(),c=await core();
 try{
  const window=await openWindow(a);
  const outcomes=await Promise.all([b,c].map(peer=>pairFrom(peer,window.address,window.code!)));
  const paired=outcomes.filter(outcome=>(outcome as {status?:string}).status==='paired');
  assert.equal(paired.length,1,'only the first confirmation consumes the window');
  assert.equal((await a.service.read()).peers.length,1);
  validateMissionJournalLineage(a.store.inspect());
 }finally{await drain(a,b,c);}
});

test('a pending pairing exchange settles when drain closes its socket',async()=>{
 const b=await core(),stubIdentity=rawIdentity();
 const stub=await rawServer({key:stubIdentity.privateKeyPem,cert:stubIdentity.certPem,requestCert:true},socket=>{socket.on('data',()=>{});});
 try{
  const port=(stub.server.address() as {port:number}).port;
  const pending=b.service.pair({commandId:'pair-held',address:`127.0.0.1:${port}`,code:'123456',name:'Laptop',agentName:'Claude Code'});
  pending.catch(()=>{});
  const marker=Symbol('timeout');
  const settled=await Promise.race([b.service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),3000))]);
  assert.notEqual(settled,'drain settles instead of waiting out the exchange timeout');
 }finally{await b.service.drain().catch(()=>{});await stub.close();}
});

test('concurrent first uses share one installation identity',async()=>{
 const a=await core();
 try{
  const views=await Promise.all([a.service.read(),a.service.read(),a.service.read()]);
  assert.equal(new Set(views.map(view=>view.identity.fingerprint)).size,1,'all callers observe one generated key');
 }finally{await drain(a);}
});

test('bracketed IPv6 loopback addresses pair and dial',async()=>{
 const a=await core(Date.now,{bind:'::1'}),b=await core();
 try{
  const window=await openWindow(a);
  assert.match(window.address,/\[::1\]:[0-9]+/,'the address keeps the bracketed IPv6 form');
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'paired');
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  assert.equal((await b.service.connect({commandId:'link-v6',deviceId})).status,'connected');
 }finally{await drain(a,b);}
});

test('a fresh host listens on the fixed default port and a bare address pairs',async()=>{
 const store=makeStore(),secrets=new InMemorySecretSlots();
 const a:Core={store,secrets,service:new DeviceLinkService(store,store,secrets,{clock:Date.now,bind:'127.0.0.1',connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  assert.equal(window.address,'127.0.0.1:47831','the initial default port is fixed');
  const outcome=await b.service.pair({commandId:'pair-bare',address:'127.0.0.1',code:window.code,name:'Laptop',agentName:'Claude Code'});
  assert.equal(outcome.status,'paired','a bare host name dials the default port');
 }finally{await drain(a,b);}
});

test('the listener closes when the last window expires with no paired devices',async()=>{
 const a=await core(Date.now,{pairingTtlMs:200}),b=await core();
 try{
  const window=await openWindow(a);
  const port=Number(window.address.split(':')[1]);
  await new Promise(resolve=>setTimeout(resolve,600));
  await assert.rejects(new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);}),/refused|closed/i,'an expired window leaves no listener');
 }finally{await drain(a,b);}
});

test('an expired unused window beside a paired peer does not busy-loop the listener',async()=>{
 let now=Date.now();const a=await core(()=>now),b=await core();
 let restart:DeviceLinkService|undefined;
 try{
  await link(a,b);
  await openWindow(a);
  now+=3e5+1000;
  let loads=0;const base=a.store;
  const counted=new Proxy(base,{get(target,key){if(key==='load')return async(id:string)=>{const snapshot=await target.load(id) as {aggregateId?:string}|null;if(id===DEVICE_LINK_ID&&snapshot?.aggregateId===DEVICE_LINK_ID)loads++;return snapshot;};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
  restart=new DeviceLinkService(counted,counted,a.secrets,{clock:()=>now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000});
  await new Promise(resolve=>setTimeout(resolve,300));
  const settled=loads;await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(loads,settled,'the expired window schedules no zero-delay resynchronization');
  assert.ok((await restart.read()).peers.length===1,'the paired peer keeps the listener up');
 }finally{if(restart)await restart.drain();await drain(a,b);}
});

test('a pre-handshake connection does not hold drain open',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const raw=netConnect({port,host:'127.0.0.1'},()=>{});raw.on('error',()=>{});
  await new Promise(resolve=>setTimeout(resolve,150));
  const marker=Symbol('timeout');
  const settled=await Promise.race([a.service.drain().catch(error=>error),new Promise(resolve=>setTimeout(()=>resolve(marker),2500))]);
  assert.notEqual(settled,marker,'drain destroys sockets that never completed the handshake');
  raw.destroy();
 }finally{await a.service.drain().catch(()=>{});}
});

test('a closed inbound link records the device offline and keeps the last connection',async()=>{
 const a=await core(Date.now,{inboundCoalesceMs:0}),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  await b.service.connect({commandId:'link-1',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  await b.service.disconnect({commandId:'link-2',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='offline');
  assert.ok((await a.service.read()).peers[0]!.lastConnectedAt,'the last connection time survives the disconnect');
 }finally{await drain(a,b);}
});

test('a TLS 1.2-only client cannot reach the link',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  await assert.rejects(new Promise<TLSSocket>((resolve,reject)=>{const c=connect({port,host:'127.0.0.1',maxVersion:'TLSv1.2',rejectUnauthorized:false},()=>resolve(c));c.on('error',reject);}),/version|protocol|handshake/i,'the link enforces TLS 1.3');
 }finally{await drain(a);}
});

test('reconnects from new source ports add no durable history',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets),peerId=(await a.service.read()).peers[0]!.deviceId;
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const pingOnce=async()=>{const socket=await dial(port,identity);socket.on('data',()=>{});socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');await new Promise(resolve=>setTimeout(resolve,150));socket.destroy();};
  await pingOnce();
  const first=observations(a,peerId);
  for(let index=0;index<4;index++)await pingOnce();
  assert.equal(observations(a,peerId),first,'each reconnect from the same host records one transition');
 }finally{await drain(a,b);}
});

test('drain destroys accepted link sockets, awaits the listener and coalesced pings answer once each',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const identity=await identityFromSecrets(b.secrets),peerId=(await a.service.read()).peers[0]!.deviceId;
  const port=Number((await b.service.read()).peers[0]!.addresses[0]!.split(':')[1]);
  const socket=await dial(port,identity),frames=readFrames(socket);
  for(let index=0;index<5;index++)socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');
  await wait(frames.frames,list=>list.filter(message=>message.kind==='pong').length===5);
  const before=observations(a,peerId);
  await wait(()=>a.service.read(),view=>observations(a,view.peers[0]?.deviceId??'')>=before);
  await a.service.drain();
  socket.write(JSON.stringify({kind:'ping',supported:{min:1,max:1}})+'\n');
  await wait(()=>Promise.resolve(socket.destroyed),destroyed=>destroyed,2000);
  assert.ok(socket.destroyed,'drain destroys the accepted socket');
 }finally{await drain(a,b);}
});

test('unauthenticated sockets face a deadline and concurrency caps, plain TCP included',async()=>{
 const a=await core(Date.now,{preAuthTimeoutMs:200}),capped=await core(Date.now,{maxUnauthenticated:2,maxUnauthenticatedPerAddress:2,preAuthTimeoutMs:200});
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const idle=await dial(port);idle.on('data',()=>{});
  await wait(()=>Promise.resolve(idle.destroyed),destroyed=>destroyed,2000);
  assert.ok(idle.destroyed,'a socket that never authenticates is closed');
  const cappedWindow=await openWindow(capped),cappedPort=Number(cappedWindow.address.split(':')[1]);
  const raws=await Promise.all([0,1,2].map(()=>new Promise<ReturnType<typeof netConnect>>(resolve=>{const raw=netConnect({port:cappedPort,host:'127.0.0.1'},()=>resolve(raw));raw.on('error',()=>{});})));
  await wait(()=>Promise.resolve(raws.some(raw=>raw.destroyed)),destroyed=>destroyed,2000);
  assert.ok(raws.some(raw=>raw.destroyed),'a connection that never handshakes is refused by the caps or the deadline');
  for(const raw of raws)raw.destroy();
 }finally{await drain(a,capped);}
});

test('a closed outbound link records the device offline on the dialing side',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  await b.service.connect({commandId:'link-1',deviceId});
  await wait(()=>a.service.read(),view=>view.peers[0]?.lastStatus==='connected');
  await a.service.drain();
  await wait(()=>b.service.read(),view=>view.peers[0]?.lastStatus==='offline');
 }finally{await drain(b);}
});

test('connecting an already connected device reuses the live link',async()=>{
 const a=await core(),b=await core();
 try{
  await link(a,b);
  const deviceId=(await b.service.read()).peers[0]!.deviceId;
  const first=await b.service.connect({commandId:'link-1',deviceId});
  const observed=observations(a,deviceId);
  const second=await b.service.connect({commandId:'link-2',deviceId});
  assert.equal(second.address,first.address,'the same connection is reused');
  assert.equal(observations(a,deviceId),observed,'no second accepted socket replaces the first');
  await b.service.disconnect({commandId:'link-3',deviceId});
 }finally{await drain(a,b);}
});

test('a pairing confirmation whose commit cannot land fails closed',async()=>{
 const base=makeStore();let pairingFailures=5;
 const guarded=new Proxy(base,{get(target,key){if(key==='commit')return async(input:any)=>{if(input.events?.[0]?.command?.action==='peer-added'&&pairingFailures>0){pairingFailures--;return {status:'conflict',revision:0,reason:'revision' as const};}return target.commit(input);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}) as unknown as ReturnType<typeof makeStore>;
 const secrets=new InMemorySecretSlots();
 const a:Core={store:guarded,secrets,service:new DeviceLinkService(guarded,guarded,secrets,{clock:Date.now,bind:'127.0.0.1',port:0,connectTimeoutMs:1000})};
 const b=await core();
 try{
  const window=await openWindow(a);
  const outcome=await pairFrom(b,window.address,window.code!);
  assert.equal(outcome.status,'code-ended','a commit that cannot land completes nothing');
  assert.equal((await a.service.read()).peers.length,0);
  assert.equal((await b.service.read()).peers.length,0);
 }finally{await drain(a,b);}
});

test('an attaching device is visible by name before pairing completes',async()=>{
 const a=await core();
 try{
  const window=await openWindow(a),port=Number(window.address.split(':')[1]);
  const stranger=rawIdentity(),socket=await dial(port,stranger);
  socket.write(JSON.stringify({kind:'pair-client',peer:{deviceId:stranger.deviceId,publicKey:stranger.publicKeyB64,name:'Attaching',agentName:'Attaching'},supported:{min:1,max:1},A:bigB64(srpClientPublic(SRP_GROUP,randomExponent()))})+'\n');
  const view=await wait(()=>a.service.read(),current=>current.incoming.length===1);
  assert.equal(view.incoming[0]!.peer.name,'Attaching');
  socket.destroy();
 }finally{await drain(a);}
});

test('malformed pairing commands change nothing',async()=>{
 const a=await core(),b=await core();
 try{
  const window=await openWindow(a);
  await assert.rejects(b.service.pair({commandId:'bad-1',address:window.address,code:'12345',name:'Laptop',agentName:'Claude Code'}),/six-digit/i);
  await assert.rejects(b.service.pair({commandId:'bad-2',address:window.address,code:'123456',grants:{view:true,instruct:false} as unknown as never,name:'Laptop',agentName:'Claude Code'}),/exact pairing command/i);
  await assert.rejects(a.service.openPairing({commandId:'bad-3',name:'Extra'}),/window/i);
  assert.ok((await a.service.read()).pairing,'no window was lost');
 }finally{await drain(a,b);}
});
