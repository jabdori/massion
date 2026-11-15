import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomUUID,sign,timingSafeEqual,X509Certificate} from 'node:crypto';
import type {KeyObject} from 'node:crypto';
import {connect,createServer} from 'node:tls';
import type {Socket} from 'node:net';
import type {TLSSocket,Server as TlsServer} from 'node:tls';
import {hostname,networkInterfaces} from 'node:os';
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import type {SecretSlots} from './secret-slots.ts';
import {protocolConnection,protocolSupport,validRange} from './protocol.ts';
import {FeedAdmissionError,withAdmissionFeed} from './storage.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const DEVICE_LINK_ID='assistant-conversation:device-link';
const IDENTITY_SLOT={owner:'device-link',slot:'device-identity'};
const ADDRESS=/^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9._-]+):[0-9]{1,5}$/;
export interface DeviceGrants {view:boolean;instruct:boolean;answerApprovals:boolean}
export const DEFAULT_DEVICE_GRANTS:DeviceGrants={view:true,instruct:true,answerApprovals:true};
export type LinkCause='refused'|'not-found'|'timed-out'|'pin'|'protocol';
export type LinkStatus='connected'|'offline'|'failed'|'update-needed';
export interface PairedPeer {deviceId:string;publicKey:string;name:string;agentName:string;grants:DeviceGrants;addresses:string[];pairedAt:number;lastConnectedAt?:number;lastStatus?:LinkStatus;lastCause?:LinkCause;lastAddress?:string}
export interface StoredOffer {id:string;codeHash:string;grants:DeviceGrants;addresses:string[];name:string;created:number;expiresAt:number;used:boolean}
export interface DeviceLinkState {kind:'device-link';id:string;peers:PairedPeer[];offers:StoredOffer[];listen?:{port:number}}
type PeerPublic={deviceId:string;publicKey:string;name:string;agentName:string;addresses:string[]};
type LinkOwnerCommand={type:'link-owner';action:'create-offer';offerId:string;codeHash:string;grants:DeviceGrants;addresses:string[];name:string;created:number;expiresAt:number}|{type:'link-owner';action:'unpair';commandId:string;deviceId:string}|{type:'link-owner';action:'widen';commandId:string;deviceId:string;grants:DeviceGrants};
type LinkObserveCommand={type:'link-observe';action:'peer-added';peer:PairedPeer}|{type:'link-observe';action:'pairing-completed';peer:PairedPeer;offerId:string}|{type:'link-observe';action:'listener-bound';port:number}|{type:'link-observe';action:'connection-observed';deviceId:string;status:LinkStatus;cause?:LinkCause;address?:string;at:number};
type DeviceLinkCommand=LinkOwnerCommand|LinkObserveCommand;
export interface DeviceLinkOptions {clock?:()=>number;port?:number;bind?:string;offerTtlMs?:number;connectTimeoutMs?:number;preAuthTimeoutMs?:number;idleTimeoutMs?:number;maxUnauthenticated?:number;maxUnauthenticatedPerAddress?:number;inboundCoalesceMs?:number}
// Initial defaults for unauthenticated sockets, to be measured: 10 s to authenticate, 10 min idle (above the 5 min pairing confirmation), 32 concurrent total, 8 per remote address.
const PREAUTH_TIMEOUT_MS=1e4,IDLE_TIMEOUT_MS=6e5,MAX_UNAUTHENTICATED=32,MAX_UNAUTHENTICATED_PER_ADDRESS=8,INBOUND_COALESCE_MS=3e4;
type DeviceIdentity={deviceId:string;fingerprint:string;publicKey:string;keyPem:string;certPem:string};

const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function ensure(v:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
const GRANT_KEYS=['view','instruct','answerApprovals'] as const;
const grants=(v:unknown):v is DeviceGrants=>!!v&&exact(v,['view','instruct','answerApprovals'])&&GRANT_KEYS.every(k=>typeof v[k]==='boolean');
const addresses=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=8&&v.every(a=>typeof a==='string'&&ADDRESS.test(a)&&a.length<=200);
const label=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=2000&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const peerPublic=(v:unknown):v is PeerPublic=>!!v&&exact(v,['deviceId','publicKey','name','agentName','addresses'])&&id(v.deviceId)&&typeof v.publicKey==='string'&&/^[A-Za-z0-9+/=]{64,256}$/.test(v.publicKey)&&label(v.name)&&label(v.agentName)&&addresses(v.addresses);
const peerFull=(v:unknown):v is PairedPeer=>!!v&&typeof v==='object'&&!Array.isArray(v)&&exact(v,['deviceId','publicKey','name','agentName','addresses','grants','pairedAt',...('lastConnectedAt' in v?['lastConnectedAt']:[]),...('lastStatus' in v?['lastStatus']:[]),...('lastCause' in v?['lastCause']:[]),...('lastAddress' in v?['lastAddress']:[])])&&id(v.deviceId)&&typeof v.publicKey==='string'&&/^[A-Za-z0-9+/=]{64,256}$/.test(v.publicKey)&&label(v.name)&&label(v.agentName)&&addresses(v.addresses)&&grants(v.grants)&&Number.isSafeInteger(v.pairedAt)&&v.pairedAt>0&&(!('lastConnectedAt' in v)||Number.isSafeInteger(v.lastConnectedAt)&&v.lastConnectedAt>0)&&(!('lastStatus' in v)||['connected','offline','failed','update-needed'].includes(v.lastStatus))&&(!('lastCause' in v)||['refused','not-found','timed-out','pin','protocol'].includes(v.lastCause))&&(!('lastAddress' in v)||ADDRESS.test(v.lastAddress));
const sha256=(value:string)=>createHash('sha256').update(value).digest();
export const deviceIdFor=(publicKey:string)=>'device-'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex').slice(0,32);
const observeId=(command:LinkObserveCommand)=>'assistant-link:'+hash(command).slice(0,32);
const sendFrame=(socket:TLSSocket,message:unknown)=>{if(!socket.destroyed)socket.write(JSON.stringify(message)+'\n');};
const peerSpki=(socket:TLSSocket)=>{const cert=socket.getPeerCertificate();if(!cert||!cert.raw)throw new Error('Missing peer certificate');return new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'}) as Buffer;};
const normalizeAddress=(host:string,port:number)=>host.includes(':')&&!host.startsWith('[')?`[${host}]:${port}`:`${host}:${port}`;
const remoteHost=(socket:{remoteAddress?:string|null})=>(socket.remoteAddress??'unknown').replace(/^::ffff:/,'');
const hostKey=(host:string)=>host.includes(':')&&!host.startsWith('[')?`[${host}]`:host;
const hostOf=(address:string|undefined)=>address?address.replace(/:[0-9]+$/,''):'';
const classify=(error:unknown):LinkCause=>{const code=(error as {code?:string})?.code??'';if(code==='ECONNREFUSED')return 'refused';if(code==='ENOTFOUND'||code==='EAI_AGAIN')return 'not-found';if(code==='ETIMEDOUT'||(error as Error)?.name==='AbortError'||code==='ECONNRESET')return 'timed-out';return 'pin';};

// Minimal DER assembly for one self-signed certificate; Node crypto owns all signing.
const derLength=(length:number)=>{if(length<128)return Buffer.from([length]);const bytes:number[]=[];let n=length;while(n>0){bytes.unshift(n&255);n>>=8;}return Buffer.from([0x80|bytes.length,...bytes]);};
const der=(tag:number,content:Buffer)=>Buffer.concat([Buffer.from([tag]),derLength(content.length),content]);
const derInt=(value:Buffer)=>{let v=value;while(v.length>1&&v[0]===0)v=v.subarray(1);if(!v.length)v=Buffer.from([0]);return der(0x02,v[0]!&0x80?Buffer.concat([Buffer.from([0]),v]):v);};
const derOid=(...parts:number[])=>{const body:number[]=[parts[0]!*40+parts[1]!];for(const part of parts.slice(2)){let n=part;const stack=[n&127];n>>=7;while(n>0){stack.unshift(128|(n&127));n>>=7;}body.push(...stack);}return der(0x06,Buffer.from(body));};
const derName=(commonName:string)=>der(0x30,der(0x31,der(0x30,Buffer.concat([derOid(2,5,4,3),der(0x0c,Buffer.from(commonName,'utf8'))]))));
const derTime=(at:number)=>{const d=new Date(at),p=(v:number)=>String(v).padStart(2,'0'),body=`${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;return d.getUTCFullYear()<2050?der(0x17,Buffer.from(`${p(d.getUTCFullYear()%100)}${body}`)):der(0x18,Buffer.from(`${d.getUTCFullYear()}${body}`));};
const ecdsaDer=(signature:Buffer)=>{if(signature[0]===0x30)return signature;const half=signature.length/2;return der(0x30,Buffer.concat([derInt(signature.subarray(0,half)),derInt(signature.subarray(half))]));};

/** One self-signed X.509 certificate binding the device key; used for TLS and parsed by Node itself in tests. */
export function selfSignedDeviceCertificate(key:KeyObject,deviceId:string,clock:()=>number=Date.now):string{
 const signatureAlgorithm=der(0x30,derOid(1,2,840,10045,4,3,2)),name=derName(deviceId),spki=createPublicKey(key).export({type:'spki',format:'der'}) as Buffer;
 const serial=derInt(createHash('sha256').update(deviceId).digest().subarray(0,16));
 const tbs=der(0x30,Buffer.concat([der(0xa0,der(0x02,Buffer.from([2]))),serial,signatureAlgorithm,name,der(0x30,Buffer.concat([derTime(clock()-864e5),derTime(clock()+3156e9)])),name,spki]));
 const signature=ecdsaDer(sign('sha256',tbs,key));
 const cert=der(0x30,Buffer.concat([tbs,signatureAlgorithm,der(0x03,Buffer.concat([Buffer.from([0]),signature]))]));
 return '-----BEGIN CERTIFICATE-----\n'+cert.toString('base64').replace(/(.{64})/g,'$1\n')+'\n-----END CERTIFICATE-----';
}

export const isDeviceLinkState=(v:unknown):v is DeviceLinkState=>!!v&&typeof v==='object'&&(v as {kind?:unknown}).kind==='device-link';
function applyDeviceLink(current:DeviceLinkState|null,command:DeviceLinkCommand,actor:Actor){
 ensure(command?.type==='link-owner'||command?.type==='link-observe','Unknown device link command');
 const state:DeviceLinkState=current?structuredClone(current):{kind:'device-link',id:DEVICE_LINK_ID,peers:[],offers:[]};
 if(command.type==='link-owner'){
  ensure(actor.id==='local-owner'&&actor.roles.includes('owner'),'Device link owner required','denied');
  if(command.action==='create-offer'){
   ensure(exact(command,['type','action','offerId','codeHash','grants','addresses','name','created','expiresAt'])&&id(command.offerId)&&!command.offerId.startsWith('assistant-')&&/^[a-f0-9]{64}$/.test(command.codeHash)&&grants(command.grants)&&addresses(command.addresses)&&label(command.name)&&Number.isSafeInteger(command.created)&&command.created>0&&Number.isSafeInteger(command.expiresAt)&&command.expiresAt>command.created&&command.expiresAt-command.created<=36e5,'Exact pairing offer required');
   state.offers=state.offers.filter(o=>!o.used&&o.expiresAt>command.created);ensure(!state.offers.some(o=>o.id===command.offerId),'Pairing offer identity already claimed','conflict');ensure(state.offers.length<8,'Pairing offer bound reached','conflict');
   state.offers.push({id:command.offerId,codeHash:command.codeHash,grants:structuredClone(command.grants),addresses:[...command.addresses],name:command.name,created:command.created,expiresAt:command.expiresAt,used:false});
  }else if(command.action==='unpair'){
   ensure(exact(command,['type','action','commandId','deviceId'])&&id(command.commandId)&&!command.commandId.startsWith('assistant-')&&id(command.deviceId),'Exact unpair required');
   ensure(state.peers.some(p=>p.deviceId===command.deviceId),'Paired peer required','conflict');state.peers=state.peers.filter(p=>p.deviceId!==command.deviceId);
  }else{
   ensure(exact(command,['type','action','commandId','deviceId','grants'])&&id(command.commandId)&&!command.commandId.startsWith('assistant-')&&id(command.deviceId)&&grants(command.grants),'Exact grant widening required');
   const peer=state.peers.find(p=>p.deviceId===command.deviceId);ensure(peer,'Paired peer required','conflict');
   ensure(GRANT_KEYS.every(k=>!peer.grants[k]||command.grants[k]),'Grants only widen additively','conflict');peer.grants=structuredClone(command.grants);
  }
 }else{
  ensure(actor.id==='device-link'&&actor.roles.includes('assistant'),'Device link service required','denied');
  if(command.action==='peer-added'||command.action==='pairing-completed'||command.action==='listener-bound'){
   if(command.action==='listener-bound'){
    ensure(exact(command,['type','action','port'])&&Number.isSafeInteger(command.port)&&command.port>0&&command.port<65536,'Exact listener observation required');
    state.listen={port:command.port};
   }else{
    ensure(exact(command,['type','action','peer',...(command.action==='pairing-completed'?['offerId']:[])])&&peerFull(command.peer),'Exact paired peer required');
    // Grants widen only through an owner command, so an existing peer must be unpaired before it can pair again.
    ensure(!state.peers.some(p=>p.deviceId===command.peer.deviceId),'Peer already paired; unpair first','conflict');ensure(state.peers.length<32,'Paired peer bound reached','conflict');
    // Pairing completion consumes its offer and adds the peer in one transition, so a code stays single-use under concurrent confirmations.
    const offer=command.action==='pairing-completed'?state.offers.find(o=>o.id===command.offerId):undefined;
    if(command.action==='pairing-completed')ensure(offer&&!offer.used,'Live pairing offer required','conflict');
    if(offer)offer.used=true;state.peers.push(structuredClone(command.peer));
   }
  }else{
   ensure(exact(command,['type','action','deviceId','status','at',...('cause' in command?['cause']:[]),...('address' in command?['address']:[])])&&id(command.deviceId)&&['connected','offline','failed','update-needed'].includes(command.status)&&(!('cause' in command)||command.cause===undefined||['refused','not-found','timed-out','pin','protocol'].includes(command.cause))&&(!('address' in command)||command.address===undefined||ADDRESS.test(command.address))&&Number.isSafeInteger(command.at)&&command.at>0,'Exact connection observation required');
   const peer=state.peers.find(p=>p.deviceId===command.deviceId);ensure(peer,'Paired peer required','conflict');
   peer.lastStatus=command.status;if('cause' in command&&command.cause!==undefined)peer.lastCause=command.cause;else delete peer.lastCause;if('address' in command&&command.address!==undefined)peer.lastAddress=command.address;else delete peer.lastAddress;if(command.status==='connected')peer.lastConnectedAt=command.at;
  }
 }
 return {value:state,events:[{type:command.type,actor:actor.id,command:structuredClone(command)}]};
}
export function replayDeviceLink(operation:Operation<DeviceLinkState>,prior:Operation<DeviceLinkState>|undefined){
 ensure(operation.aggregateId===DEVICE_LINK_ID&&operation.value.id===DEVICE_LINK_ID&&operation.expectedRevision===(prior?.revision??0)&&operation.revision===operation.expectedRevision+1,'Device link revision lineage mismatch');
 const e=operation.events[0] as {type:string;actor:string;command:DeviceLinkCommand};ensure(operation.events.length===1&&exact(e,['type','actor','command'])&&e.type===e.command?.type,'Exact device link event required');
 const owner=e.command.type==='link-owner';
 let expectedId:string;
 if(e.command.type==='link-owner')expectedId=e.command.action==='create-offer'?e.command.offerId:e.command.commandId;
 else expectedId=observeId(e.command);
 ensure(e.actor===(owner?'local-owner':'device-link')&&operation.commandId===expectedId,'Device link command identity mismatch');
 ensure(operation.fingerprint===hash({actorId:e.actor,command:e.command}),'Device link fingerprint mismatch');const derived=applyDeviceLink(prior?.value??null,e.command,{id:e.actor,roles:[owner?'owner':'assistant']});
 ensure(hash(derived.value)===hash(operation.value)&&hash(derived.events)===hash(operation.events)&&operation.outbox.length===0,'Device link transition mismatch');
}

/** Pairing and the pinned mutual-TLS link. The private key never leaves the secret adapter; offers carry public information only. */
export class DeviceLinkService {
 readonly #store:Store<any>;readonly #owner:Store<any>;readonly #secrets:SecretSlots;readonly #clock:()=>number;readonly #port:number;readonly #bind:string;readonly #offerTtl:number;readonly #connectTimeout:number;
 #identityPromise?:Promise<DeviceIdentity>;
 #server?:TlsServer;#syncing?:Promise<void>;#drained=false;#expiryTimer?:NodeJS.Timeout;#advertised:string[]=[];#links=new Map<string,TLSSocket>();#versions=new Map<string,number>();#accepted=new Set<TLSSocket>();
 #preauth=new Set<Socket>();#unauth=new Map<TLSSocket,{host:string;timer:NodeJS.Timeout;introSeen?:boolean}>();#idle=new Map<TLSSocket,NodeJS.Timeout>();#authedDevice=new Map<TLSSocket,string>();#unauthPerHost=new Map<string,number>();
 #pins=new Map<string,string>();#guard=new Map<string,{status:LinkStatus;host:string;at:number}>();#queues=new Map<TLSSocket,Promise<unknown>>();
 readonly #preAuthTimeoutMs:number;readonly #idleTimeoutMs:number;readonly #maxUnauth:number;readonly #maxUnauthPerAddress:number;readonly #inboundCoalesceMs:number;
 #incoming=new Map<string,{id:string;socket:TLSSocket;peer:PeerPublic;grants:DeviceGrants;offerId:string}>();
 #outgoing=new Map<string,{id:string;address:string;code:string;grants:DeviceGrants;publicInfo:PeerPublic;socket:TLSSocket;verifiedKey:string;peer:{deviceId:string;fingerprint:string;name:string}}>();
 #active=new Set<Promise<unknown>>();#stop=new AbortController();
 constructor(store:Store<any>,owner:Store<any>,secrets:SecretSlots,options:DeviceLinkOptions={}){this.#store=store;this.#owner=owner;this.#secrets=secrets;this.#clock=options.clock??Date.now;this.#port=options.port??0;this.#bind=options.bind??'0.0.0.0';this.#offerTtl=options.offerTtlMs??3e5;this.#connectTimeout=options.connectTimeoutMs??5000;this.#preAuthTimeoutMs=options.preAuthTimeoutMs??PREAUTH_TIMEOUT_MS;this.#idleTimeoutMs=options.idleTimeoutMs??IDLE_TIMEOUT_MS;this.#maxUnauth=options.maxUnauthenticated??MAX_UNAUTHENTICATED;this.#maxUnauthPerAddress=options.maxUnauthenticatedPerAddress??MAX_UNAUTHENTICATED_PER_ADDRESS;this.#inboundCoalesceMs=options.inboundCoalesceMs??INBOUND_COALESCE_MS;
  // A host with persisted pairings accepts its devices again from startup.
  void this.#identityLoad().then(()=>this.#syncListener()).catch(()=>{});
 }

 async #identityLoad(){return this.#identityPromise??=(async()=>{
  try{
  let stored=await this.#secrets.read(IDENTITY_SLOT);
  if(stored===undefined){const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});stored=privateKey.export({type:'pkcs8',format:'der'}).toString('base64');await this.#secrets.set(IDENTITY_SLOT,stored);}
  // Single-line base64 DER: the secret adapter rejects control characters, so no PEM wrapping.
  const key=createPrivateKey({key:Buffer.from(stored,'base64'),format:'der',type:'pkcs8'}),keyPem=key.export({type:'pkcs8',format:'pem'}).toString(),spki=createPublicKey(key).export({type:'spki',format:'der'}) as Buffer,publicKey=spki.toString('base64'),fingerprint=createHash('sha256').update(spki).digest('hex'),deviceId='device-'+fingerprint.slice(0,32);
  return {deviceId,fingerprint,publicKey,keyPem,certPem:selfSignedDeviceCertificate(key,deviceId,this.#clock)};
  }catch(error){this.#identityPromise=undefined;throw error;}
 })();}
 async #state(){return await this.#store.load(DEVICE_LINK_ID) as Snapshot<DeviceLinkState>|null;}
 async #feed(expected:string){if((await this.#store.readState()).feedId!==expected)throw new FeedAdmissionError();}
 async #dispatch(feedId:string,commandId:string,command:DeviceLinkCommand,owner:boolean):Promise<CommitResult<DeviceLinkState>>{
  return withAdmissionFeed(feedId,async()=>{
  const actor:Actor={id:owner?'local-owner':'device-link',roles:[owner?'owner':'assistant']},identity={id:DEVICE_LINK_ID,commandId,fingerprint:hash({actorId:actor.id,command})},store=owner?this.#owner:this.#store;
  for(let attempt=0;attempt<3;attempt++){
   const snapshot=await store.load(DEVICE_LINK_ID),prior=await store.lookupOperation(identity);await this.#feed(feedId);if(prior.status!=='unknown'){ensure(prior.status!=='conflict'||prior.reason!=='idempotency','Device link command identity conflict','conflict');return prior;}
   if(owner&&this.#stop.signal.aborted)throw new HostDrainError();const result=await store.commit({...identity,expectedRevision:snapshot?.revision??0,...applyDeviceLink(snapshot?.value??null,command,actor),outbox:[]});if(result.status!=='conflict'){this.#refreshPins(result.value);return result;}
  }return {status:'conflict',revision:(await this.#store.load(DEVICE_LINK_ID))?.revision??0,reason:'revision'};
  });
 }

 /** The listener binds only while pairing is enabled: a live offer or a paired peer exists. */
 async #syncListener(){
  if(this.#drained)return;if(this.#syncing)return this.#syncing;
  this.#syncing=(async()=>{
   const identity=await this.#identityLoad(),state=await this.#state(),now=this.#clock(),want=(state?.value.offers??[]).some(o=>!o.used&&o.expiresAt>now)||(state?.value.peers??[]).length>0;
   this.#refreshPins(state?.value);
   // Drain may have started while this synchronization was in flight.
   if(this.#drained)return;
   if(!want){if(this.#expiryTimer){clearTimeout(this.#expiryTimer);this.#expiryTimer=undefined;}if(this.#server){this.#server.close();this.#server=undefined;this.#advertised=[];}return;}
   // The listener must close when the last live offer expires on a host with no paired devices.
   if(this.#expiryTimer)clearTimeout(this.#expiryTimer);
   const expiry=Math.min(...(state?.value.offers??[]).filter(o=>!o.used&&o.expiresAt>now).map(o=>o.expiresAt));
   if(Number.isFinite(expiry)){const delay=Math.max(0,expiry-now+1);this.#expiryTimer=setTimeout(()=>{this.#expiryTimer=undefined;void this.#syncListener().catch(()=>{});},delay);this.#expiryTimer.unref?.();}
   if(this.#server){this.#advertised=this.#advertise(this.#server,state);return;}
   const server=createServer({key:identity.keyPem,cert:identity.certPem,minVersion:'TLSv1.3',requestCert:true,rejectUnauthorized:false},socket=>this.#accept(socket));
   // Pre-handshake sockets are tracked from the raw TCP connection so drain can close them.
   
   server.on('error',()=>{if(this.#server===server)this.#server=undefined;});
   server.on('connection',raw=>{this.#preauth.add(raw);raw.on('close',()=>this.#preauth.delete(raw));});
   this.#server=server;const desired=this.#port||state?.value.listen?.port||0;await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(desired,this.#bind,()=>{server.off('error',reject);resolve();});});
   if(this.#drained){server.close();this.#server=undefined;return;}
   this.#advertised=this.#advertise(server,state);
   // A restart rebinds the persisted port so stored addresses stay reachable.
   const port=(server.address() as {port:number}).port;
   if(port!==(state?.value.listen?.port??0)){const recorded:LinkObserveCommand={type:'link-observe',action:'listener-bound',port};await this.#dispatch((await this.#store.readState()).feedId,observeId(recorded),recorded,false);}
  })().catch(error=>{this.#server=undefined;throw error;}).finally(()=>{this.#syncing=undefined;});
  return this.#syncing;
 }
 #accept(socket:TLSSocket){
  const host=hostKey(remoteHost(socket));
  // Unauthenticated sockets are bounded in total and per remote address before any work is done for them.
  if(this.#unauth.size>=this.#maxUnauth||(this.#unauthPerHost.get(host)??0)>=this.#maxUnauthPerAddress){socket.destroy();return;}
  this.#accepted.add(socket);
  const preauth=setTimeout(()=>socket.destroy(),this.#preAuthTimeoutMs);preauth.unref?.();
  this.#unauth.set(socket,{host,timer:preauth});this.#unauthPerHost.set(host,(this.#unauthPerHost.get(host)??0)+1);
  socket.on('error',()=>socket.destroy());let buffer='';
  socket.on('data',(chunk:Buffer)=>{this.#touch(socket);buffer+=chunk;let index;
   if(buffer.length>16384){socket.destroy();return;}
   while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line)continue;
    let message;try{message=JSON.parse(line);}catch{socket.destroy();return;}
    // Frames are processed serially per socket so one write cannot pile concurrent state loads.
    const queue=this.#queues.get(socket)??Promise.resolve();
    this.#queues.set(socket,queue.then(()=>this.#frame(socket,message)).catch(()=>socket.destroy()));
   }});
  socket.on('close',()=>this.#close(socket));
 }
 #touch(socket:TLSSocket){const timer=this.#idle.get(socket);if(timer){clearTimeout(timer);const next=setTimeout(()=>socket.destroy(),this.#idleTimeoutMs);next.unref?.();this.#idle.set(socket,next);}}
 #markAuthenticated(socket:TLSSocket,deviceId?:string){
  const entry=this.#unauth.get(socket);if(!entry)return;
  clearTimeout(entry.timer);this.#unauth.delete(socket);
  const count=(this.#unauthPerHost.get(entry.host)??1)-1;if(count>0)this.#unauthPerHost.set(entry.host,count);else this.#unauthPerHost.delete(entry.host);
  const timer=setTimeout(()=>socket.destroy(),this.#idleTimeoutMs);timer.unref?.();this.#idle.set(socket,timer);
  if(deviceId)this.#authedDevice.set(socket,deviceId);
 }
 #close(socket:TLSSocket){
  this.#accepted.delete(socket);this.#queues.delete(socket);
  const idle=this.#idle.get(socket);if(idle){clearTimeout(idle);this.#idle.delete(socket);}
  const authedDevice=this.#authedDevice.get(socket);this.#authedDevice.delete(socket);
  const entry=this.#unauth.get(socket);
  if(entry){clearTimeout(entry.timer);this.#unauth.delete(socket);const count=(this.#unauthPerHost.get(entry.host)??1)-1;if(count>0)this.#unauthPerHost.set(entry.host,count);else this.#unauthPerHost.delete(entry.host);}
  for(const pending of this.#incoming.values())if(pending.socket===socket)this.#incoming.delete(pending.id);
  // An authenticated inbound link that closed leaves the device offline on this host.
  if(!idle)return;
  if(authedDevice)void this.#recordInbound(authedDevice,'offline',hostKey(remoteHost(socket))).catch(()=>{});
 }
 #refreshPins(value:DeviceLinkState|undefined){this.#pins.clear();for(const peer of value?.peers??[])this.#pins.set(peer.publicKey,peer.deviceId);}
 #advertise(server:TlsServer,state:Snapshot<DeviceLinkState>|null){const port=(server.address() as {port:number}).port,lan=[...Object.values(networkInterfaces())].flat().filter(i=>i?.family==='IPv4'&&!i.internal).map(i=>i!.address)[0]??this.#bind;return [...new Set([...(state?.value.offers??[]).flatMap(o=>o.addresses),...(lan!=='0.0.0.0'?[normalizeAddress(lan,port)]:[]),...(this.#bind!=='0.0.0.0'?[normalizeAddress(this.#bind,port)]:[])])].slice(0,8);}
 // Durable link state records transitions keyed on the remote host, never the ephemeral source port.
 async #recordInbound(deviceId:string,status:LinkStatus,host:string,address?:string){
  const guard=this.#guard.get(deviceId);
  if(guard&&guard.status===status&&guard.host===host)return;
  // Inbound transitions are coalesced per device so reconnect flapping cannot grow the journal; owner-initiated observations bypass this.
  if(guard&&this.#clock()-guard.at<this.#inboundCoalesceMs&&guard.host===host)return;
  const peer=((await this.#state())?.value.peers??[]).find(p=>p.deviceId===deviceId);
  if(!peer)return;
 if(status==='offline'){if(peer.lastStatus!=='connected'){this.#guard.set(deviceId,{status,host,at:this.#clock()});return;}}
 else if(peer.lastStatus===status&&hostOf(peer.lastAddress)===host){this.#guard.set(deviceId,{status,host,at:this.#clock()});return;}
  await this.#observe(deviceId,status,undefined,address);
 this.#guard.set(deviceId,{status,host,at:this.#clock()});
 }
 async #frame(socket:TLSSocket,message:Record<string,unknown>){
  const identity=await this.#identityLoad();
  if(message.kind==='pair-intro'){
   // An introduction while a live offer exists holds the socket until that offer expires; the socket still counts toward the unauthenticated caps.
   const entry=this.#unauth.get(socket);
   if(entry&&!entry.introSeen){entry.introSeen=true;const now=this.#clock(),expiry=Math.min(...((await this.#state())?.value.offers??[]).filter(o=>!o.used&&o.expiresAt>now).map(o=>o.expiresAt));
    if(Number.isFinite(expiry)){clearTimeout(entry.timer);const timer=setTimeout(()=>socket.destroy(),Math.max(0,expiry-now+1));timer.unref?.();entry.timer=timer;}}
   sendFrame(socket,{kind:'pair-hello',deviceId:identity.deviceId,fingerprint:identity.fingerprint,name:hostname()});return;}
  if(message.kind==='ping'){
   // Only a pinned paired key may ping, and the pin is checked before any durable state is loaded.
   const deviceId=this.#pins.get(peerSpki(socket).toString('base64'));
   if(!deviceId){socket.destroy();return;}
   this.#markAuthenticated(socket,deviceId);
   sendFrame(socket,{kind:'pong',supported:protocolSupport});
   await this.#recordInbound(deviceId,'connected',hostKey(remoteHost(socket)),normalizeAddress(remoteHost(socket),socket.remotePort??0));
   return;
  }
  if(message.kind!=='pair-request')return;
  const state=await this.#state();
  const code=typeof message.code==='string'&&/^[0-9]{6}$/.test(message.code)?message.code:null,now=this.#clock();
  const offer=(state?.value.offers??[]).find(o=>!o.used&&o.expiresAt>now&&timingSafeEqual(sha256(code??'------'),Buffer.from(o.codeHash,'hex')));
  // The claimed key must be the key that authenticated the TLS connection.
  if(!code||!offer||!peerPublic(message.peer)||!grants(message.grants)||message.peer.publicKey!==peerSpki(socket).toString('base64')||message.peer.deviceId!==deviceIdFor(message.peer.publicKey)){socket.end(JSON.stringify({kind:'pair-rejected',reason:'code'})+'\n');return;}
  this.#markAuthenticated(socket);
  const pendingId=randomUUID();this.#incoming.set(pendingId,{id:pendingId,socket,peer:structuredClone(message.peer),grants:structuredClone(offer.grants),offerId:offer.id});
  sendFrame(socket,{kind:'pair-pending',pendingId,grants:offer.grants});
 }
 async #observe(deviceId:string,status:LinkStatus,cause?:LinkCause,address?:string){
  const command:LinkObserveCommand={type:'link-observe',action:'connection-observed',deviceId,status,at:this.#clock(),...(cause?{cause}:{}),...(address?{address}:{})};
  await this.#dispatch((await this.#store.readState()).feedId,observeId(command),command,false);
 }

 async createOffer(input:unknown,expectedFeed?:string){return this.#run(async identity=>{
  const value=offerCommand(input),now=this.#clock(),code=String(1e5+Math.floor(Math.random()*9e5)),feedId=expectedFeed??(await this.#store.readState()).feedId;
  await this.#feed(feedId);
  let commit:CommitResult<DeviceLinkState>;
  try{commit=await this.#dispatch(feedId,value.commandId,{type:'link-owner',action:'create-offer',offerId:value.commandId,codeHash:sha256(code).toString('hex'),grants:value.grants,addresses:value.addresses,name:value.name,created:now,expiresAt:now+this.#offerTtl},true);}
  catch(error){
   // A retry with the caller's command identity returns the existing offer; the generated code and timestamps stay outside the request identity.
   if(error instanceof DomainError&&error.code==='conflict'&&error.message.includes('identity conflict')){
    const state=await this.#state(),existing=(state?.value.offers??[]).find(o=>o.id===value.commandId);
    if(existing)return {commit:{status:'replayed' as const,revision:state?.revision??0},offer:{version:1,deviceId:identity.deviceId,fingerprint:identity.fingerprint,name:existing.name,addresses:existing.addresses},expiresAt:existing.expiresAt};
   }
   throw error;
  }
  await this.#syncListener();
  return {commit,offer:{version:1,deviceId:identity.deviceId,fingerprint:identity.fingerprint,name:value.name,addresses:this.#advertised.length?this.#advertised:value.addresses},code,expiresAt:now+this.#offerTtl};
 });}
 async pair(input:unknown){return this.#run(async identity=>{
  const value=pairCommand(input),existing=this.#outgoing.get(value.commandId);if(existing)return {attempt:{id:existing.id,address:existing.address,peer:existing.peer}};
  const socket=await this.#dial(identity,value.address,value.fingerprint?{fingerprint:value.fingerprint}:undefined);
  try{
   const verifiedKey=peerSpki(socket).toString('base64');
   if(value.fingerprint&&value.fingerprint!==createHash('sha256').update(Buffer.from(verifiedKey,'base64')).digest('hex'))throw Object.assign(new Error('Pinned key mismatch'),{cause:'pin'});
   const hello=await this.#exchange(socket,{kind:'pair-intro'});
   ensure(hello?.kind==='pair-hello'&&id(hello.deviceId)&&/^[a-f0-9]{64}$/.test(hello.fingerprint)&&label(hello.name),'Pairing introduction required');
   if(hello.deviceId!==deviceIdFor(verifiedKey)||hello.fingerprint!==createHash('sha256').update(Buffer.from(verifiedKey,'base64')).digest('hex'))throw new DomainError('Pairing introduction key mismatch','conflict');
   this.#outgoing.set(value.commandId,{id:value.commandId,address:value.address,code:value.code,grants:value.grants,publicInfo:{deviceId:identity.deviceId,publicKey:identity.publicKey,name:value.name,agentName:value.agentName,addresses:value.addresses},socket,verifiedKey,peer:{deviceId:hello.deviceId,fingerprint:hello.fingerprint,name:hello.name}});
   return {attempt:{id:value.commandId,address:value.address,peer:{deviceId:hello.deviceId,fingerprint:hello.fingerprint,name:hello.name}}};
  }catch(error){socket.destroy();throw error;}
 });}
 async confirm(input:unknown,expectedFeed?:string){return this.#run(async identity=>{
  const value=confirmCommand(input),feedId=expectedFeed??(await this.#store.readState()).feedId;
  if(value.action==='confirm-incoming'||value.action==='reject-incoming'){
   const pending=this.#incoming.get(value.pendingId!);ensure(pending,'Pairing confirmation request required','conflict');await this.#feed(feedId);
   if(value.action==='reject-incoming'){this.#incoming.delete(value.pendingId!);sendFrame(pending.socket,{kind:'pair-rejected',reason:'denied'});pending.socket.destroy();return {status:'rejected' as const};}
   const state=await this.#state(),offer=(state?.value.offers??[]).find(o=>o.id===pending.offerId);
   ensure(offer&&!offer.used&&offer.expiresAt>this.#clock(),'Live pairing offer required','conflict');
   const peer:PairedPeer={...pending.peer,grants:pending.grants,pairedAt:this.#clock()};
   const observe:LinkObserveCommand={type:'link-observe',action:'pairing-completed',peer,offerId:pending.offerId};
   const committed=await this.#dispatch(feedId,observeId(observe),observe,false);
   if(committed.status!=='committed'&&committed.status!=='replayed'){this.#incoming.delete(value.pendingId!);pending.socket.destroy();throw new DomainError('Pairing did not complete','conflict');}
   this.#incoming.delete(value.pendingId!);
   sendFrame(pending.socket,{kind:'pair-complete',peer:{deviceId:identity.deviceId,publicKey:identity.publicKey,name:offer.name,agentName:offer.name,addresses:this.#advertised},grants:pending.grants});
   pending.socket.end();await this.#syncListener();return {status:'paired' as const,peer:{deviceId:peer.deviceId,name:peer.name,agentName:peer.agentName,grants:peer.grants}};
  }
  const attempt=this.#outgoing.get(value.attemptId!);ensure(attempt,'Outgoing pairing attempt required','conflict');
  if(value.action==='reject-outgoing'){this.#outgoing.delete(value.attemptId!);attempt.socket.destroy();return {status:'rejected' as const};}
  await this.#feed(feedId);
  const reply=await this.#exchange(attempt.socket,{kind:'pair-request',code:attempt.code,peer:attempt.publicInfo,grants:attempt.grants},this.#offerTtl,message=>message?.kind==='pair-complete'||message?.kind==='pair-rejected');
  // The completion must carry the same key that authenticated the pairing connection.
  if(reply?.kind!=='pair-complete'||!peerPublic(reply.peer)||!grants(reply.grants)||reply.peer.publicKey!==attempt.verifiedKey||reply.peer.deviceId!==deviceIdFor(attempt.verifiedKey)){this.#outgoing.delete(value.attemptId!);attempt.socket.destroy();throw new DomainError(reply?.reason==='denied'?'Pairing was rejected on the other device':'Pairing did not complete','denied');}
  // The locally approved grants govern this peer; the reply only proves the other side's key and identity.
  const observe:LinkObserveCommand={type:'link-observe',action:'peer-added',peer:{...reply.peer,grants:attempt.grants,pairedAt:this.#clock()}};
  const committed=await this.#dispatch(feedId,observeId(observe),observe,false);
  ensure(committed.status==='committed'||committed.status==='replayed','Pairing did not complete','conflict');
  this.#outgoing.delete(value.attemptId!);attempt.socket.end();await this.#syncListener();
  return {status:'paired' as const,peer:{deviceId:reply.peer.deviceId,name:reply.peer.name,agentName:reply.peer.agentName,grants:attempt.grants}};
 });}
 async unpair(input:unknown,expectedFeed?:string){return this.#run(async()=>{
  const value=unpairCommand(input),feedId=expectedFeed??(await this.#store.readState()).feedId;await this.#feed(feedId);
  const command:LinkOwnerCommand={type:'link-owner',action:'unpair',commandId:value.commandId,deviceId:value.deviceId};
  const result=await this.#dispatch(feedId,value.commandId,command,true);
  this.#links.get(value.deviceId)?.destroy();this.#links.delete(value.deviceId);await this.#syncListener();return result;
 });}
 async widen(input:unknown,expectedFeed?:string){return this.#run(async()=>{
  const value=widenCommand(input),feedId=expectedFeed??(await this.#store.readState()).feedId;await this.#feed(feedId);
  const command:LinkOwnerCommand={type:'link-owner',action:'widen',commandId:value.commandId,deviceId:value.deviceId,grants:value.grants};
  return await this.#dispatch(feedId,value.commandId,command,true);
 });}

 async #run<T>(action:(identity:DeviceIdentity)=>Promise<T>){const task=(async()=>action(await this.#identityLoad()))();this.#active.add(task);try{return await task;}finally{this.#active.delete(task);}}
 #dial(identity:{deviceId:string;fingerprint:string;publicKey:string;keyPem:string;certPem:string},address:string,expected?:{fingerprint?:string;publicKey?:string}):Promise<TLSSocket>{
  return new Promise((resolve,reject)=>{
   const ipv6=/^\[/.test(address),host=ipv6?address.slice(1,address.indexOf(']')):address.slice(0,address.lastIndexOf(':')),port=Number(address.slice(address.lastIndexOf(':')+1));
   // Mutual TLS: this side always presents its device certificate; the peer key is pinned separately.
   const socket=connect({host,port,key:identity.keyPem,cert:identity.certPem,minVersion:'TLSv1.3',rejectUnauthorized:false,timeout:this.#connectTimeout},()=>{
    try{
     const spki=peerSpki(socket),hex=createHash('sha256').update(spki).digest('hex');
     if(expected?.fingerprint&&expected.fingerprint!==hex||expected?.publicKey&&expected.publicKey!==spki.toString('base64'))throw Object.assign(new Error('Pinned key mismatch'),{cause:'pin'});
     socket.setTimeout(0);
     resolve(socket);
    }catch(error){socket.destroy();reject(error);}});
   socket.on('error',error=>{socket.destroy();reject(error);});
   socket.on('timeout',()=>{socket.destroy();reject(Object.assign(new Error('Connection timed out'),{name:'AbortError'}));});
  });
 }
 #exchange(socket:TLSSocket,message:Record<string,unknown>,timeout=this.#offerTtl,accept?:(message:any)=>boolean):Promise<any>{
  return new Promise((resolve,reject)=>{
   let buffer='';const timer=setTimeout(()=>{cleanup();socket.destroy();reject(Object.assign(new Error('Exchange timed out'),{name:'AbortError'}));},timeout);
   const onData=(chunk:Buffer)=>{buffer+=chunk;for(;;){const index=buffer.indexOf('\n');if(index<0)break;let reply;try{reply=JSON.parse(buffer.slice(0,index));}catch(error){cleanup();socket.destroy();reject(error);return;}buffer=buffer.slice(index+1);if(!accept||accept(reply)){cleanup();resolve(reply);return;}}
    if(buffer.length>16384){cleanup();socket.destroy();reject(new Error('Exchange overflow'));}};
   const onClosed=()=>{cleanup();reject(Object.assign(new Error('Exchange socket closed'),{name:'AbortError'}));};
   const cleanup=()=>{clearTimeout(timer);socket.off('data',onData);socket.off('close',onClosed);socket.off('end',onClosed);};
   socket.on('data',onData);socket.on('close',onClosed);socket.on('end',onClosed);socket.on('error',error=>{cleanup();reject(error);});sendFrame(socket,message);
  });
 }
 async read(){
  return this.#run(async identity=>{
   const state=await this.#state(),now=this.#clock();
   return {identity:{deviceId:identity.deviceId,fingerprint:identity.fingerprint,name:hostname()},
    // The peers list is the list of devices that can control this host.
    peers:(state?.value.peers??[]).map(p=>({deviceId:p.deviceId,name:p.name,agentName:p.agentName,grants:p.grants,addresses:p.addresses,pairedAt:p.pairedAt,lastConnectedAt:p.lastConnectedAt,lastStatus:p.lastStatus,lastCause:p.lastCause,lastAddress:p.lastAddress})),
    offers:(state?.value.offers??[]).filter(o=>!o.used&&o.expiresAt>now).map(o=>({id:o.id,name:o.name,grants:o.grants,addresses:o.addresses,expiresAt:o.expiresAt})),
    incoming:[...this.#incoming.values()].map(p=>({id:p.id,peer:p.peer,grants:p.grants})),
    outgoing:[...this.#outgoing.values()].map(a=>({id:a.id,address:a.address,peer:a.peer}))};
  });
 }
 /** The link exchanges only an authenticated ping and protocol-version negotiation. */
 async connect(input:unknown){return this.#run(async identity=>{
  const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(commandId&&id(v.deviceId)&&Object.keys(v).length===2,'Exact device link connect required');
  const connected=await this.#connectPeer(identity,v.deviceId);return {commandId,status:'connected' as const,address:connected.address,version:connected.version};
 });}
 async disconnect(input:unknown){return this.#run(async()=>{
  const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(commandId&&id(v.deviceId)&&Object.keys(v).length===2,'Exact device link disconnect required');
  const peer=((await this.#state())?.value.peers??[]).find(p=>p.deviceId===v.deviceId),host=hostOf(peer?.lastAddress);
  this.#links.get(v.deviceId)?.destroy();this.#links.delete(v.deviceId);this.#versions.delete(v.deviceId);await this.#observe(v.deviceId,'offline');
  if(host)this.#guard.set(v.deviceId,{status:'offline',host,at:this.#clock()});
  return {commandId,status:'offline' as const};
 });}
 async #connectPeer(identity:{deviceId:string;fingerprint:string;publicKey:string;keyPem:string;certPem:string},deviceId:string){
  const state=await this.#state(),peer=(state?.value.peers??[]).find(p=>p.deviceId===deviceId);ensure(peer,'Paired peer required','denied');
  const existing=this.#links.get(deviceId);
  if(existing&&!existing.destroyed)return {address:peer.lastAddress??peer.addresses[0]!,version:this.#versions.get(deviceId)??1};
  let lastCause:LinkCause|undefined;
  for(const address of peer.addresses){
   let socket:TLSSocket|undefined;
   try{
    const live:TLSSocket=socket=await this.#dial(identity,address,{publicKey:peer.publicKey});
    const pong=await this.#exchange(live,{kind:'ping',supported:protocolSupport},this.#connectTimeout);
    if(pong?.kind!=='pong'||!validRange(pong.supported))throw Object.assign(new Error('Protocol exchange invalid'),{cause:'protocol'});
    const link=protocolConnection(protocolSupport,pong.supported);
    if(link.state!=='ready')throw Object.assign(new Error('Protocol update needed'),{cause:'protocol'});
    this.#links.set(deviceId,live);this.#versions.set(deviceId,link.version!);live.on('close',()=>{if(this.#links.get(deviceId)===live){this.#links.delete(deviceId);this.#versions.delete(deviceId);void this.#recordInbound(deviceId,'offline',hostOf(address)).catch(()=>{});}});
    live.on('error',()=>live.destroy());
    await this.#observe(deviceId,'connected',undefined,address);return {address,version:link.version!};
   }catch(error){socket?.destroy();lastCause=(error as {cause?:LinkCause})?.cause??classify(error);}
  }
  const failed:LinkStatus=lastCause==='protocol'?'update-needed':'failed';
  await this.#observe(deviceId,failed,lastCause);
  throw new DomainError(lastCause==='refused'?'Connection refused at every address':lastCause==='not-found'?'No device found at any address':lastCause==='timed-out'?'Every address timed out':lastCause==='protocol'?'Protocol update needed':'Key pin mismatch','conflict');
 }
 beginDrain(){this.#stop.abort();}
 // Sockets close first so pending exchanges settle instead of holding drain open.
 async drain(){this.#drained=true;if(this.#expiryTimer){clearTimeout(this.#expiryTimer);this.#expiryTimer=undefined;}this.beginDrain();for(const socket of this.#links.values())socket.destroy();this.#links.clear();for(const pending of this.#incoming.values())pending.socket.destroy();this.#incoming.clear();for(const attempt of this.#outgoing.values())attempt.socket.destroy();this.#outgoing.clear();for(const socket of this.#accepted)socket.destroy();this.#accepted.clear();for(const raw of this.#preauth)raw.destroy();this.#preauth.clear();for(const entry of this.#unauth.values())clearTimeout(entry.timer);this.#unauth.clear();this.#unauthPerHost.clear();for(const timer of this.#idle.values())clearTimeout(timer);this.#idle.clear();this.#queues.clear();const listener=this.#server;this.#server=undefined;this.#advertised=[];await new Promise<void>(resolve=>listener?listener.close(()=>resolve()):resolve());const results=await Promise.allSettled([...this.#active]);for(const result of results)if(result.status==='rejected')throw result.reason;}
}

function commandIdOf(v:Record<string,unknown>):string|undefined {return typeof v.commandId==='string'&&id(v.commandId)&&!v.commandId.startsWith('assistant-')?v.commandId:undefined;}
function grantsOf(v:Record<string,unknown>):DeviceGrants {if(v.grants===undefined)return {...DEFAULT_DEVICE_GRANTS};ensure(grants(v.grants),'Exact grants required: view, instruct, answerApprovals');return structuredClone(v.grants);}
function offerCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['commandId','name','addresses','grants'].includes(k))&&commandId,'Exact pairing offer command required');return {commandId,name:label(v.name)?v.name:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[],grants:grantsOf(v)};}
function pairCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);
 // The advertised fingerprint is required: the code is only ever sent to a pinned key.
 ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['commandId','address','code','fingerprint','grants','name','agentName','addresses'].includes(k))&&commandId&&typeof v.address==='string'&&ADDRESS.test(v.address)&&typeof v.code==='string'&&/^[0-9]{6}$/.test(v.code)&&typeof v.fingerprint==='string'&&/^[a-f0-9]{64}$/.test(v.fingerprint)&&(v.name===undefined||label(v.name))&&(v.agentName===undefined||label(v.agentName)),'Exact pairing attempt with an advertised fingerprint required');
 return {commandId,address:v.address as string,code:v.code as string,fingerprint:v.fingerprint as string,grants:grantsOf(v),name:label(v.name)?v.name as string:hostname(),agentName:label(v.agentName)?v.agentName as string:hostname(),addresses:addresses(v.addresses)?[...v.addresses]:[]};}
function confirmCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&typeof v==='object'&&!Array.isArray(v)&&['commandId','action'].every(k=>Object.hasOwn(v,k))&&commandId&&['confirm-incoming','reject-incoming','confirm-outgoing','reject-outgoing'].includes(v.action as string)&&((v.action==='confirm-incoming'||v.action==='reject-incoming')?id(v.pendingId)&&Object.keys(v).length===3:(v.action==='confirm-outgoing'||v.action==='reject-outgoing')?id(v.attemptId)&&Object.keys(v).length===3:false),'Exact pairing confirmation required');return v as {commandId:string;action:'confirm-incoming'|'reject-incoming'|'confirm-outgoing'|'reject-outgoing';pendingId?:string;attemptId?:string};}
function unpairCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&exact(v,['commandId','deviceId'])&&commandId&&id(v.deviceId),'Exact unpair required');return v as {commandId:string;deviceId:string};}
function widenCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&exact(v,['commandId','deviceId','grants'])&&commandId&&id(v.deviceId)&&grants(v.grants),'Exact grant widening required');return v as {commandId:string;deviceId:string;grants:DeviceGrants};}
