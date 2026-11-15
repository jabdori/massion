import {createDiffieHellman,createHash,createHmac,createPrivateKey,createPublicKey,generateKeyPairSync,getDiffieHellman,hkdfSync,randomBytes,randomInt,sign,timingSafeEqual,X509Certificate} from 'node:crypto';
import type {DiffieHellman,KeyObject} from 'node:crypto';
import {connect,createServer} from 'node:tls';
import type {Socket} from 'node:net';
import type {TLSSocket,Server as TlsServer} from 'node:tls';
import {hostname,networkInterfaces} from 'node:os';
import {DomainError,hash} from './domain.ts';
import type {Actor} from './domain.ts';
import {HostDrainError} from './runtime-lifetime.ts';
import type {SecretSlots} from './secret-slots.ts';
import {protocolConnection,protocolSupport,validRange} from './protocol.ts';
import type {ProtocolRange} from './protocol.ts';
import {CommitOutcomeUnknownError,FeedAdmissionError,withAdmissionFeed} from './storage.ts';
import type {CommitResult,Operation,Snapshot,Store} from './storage.ts';

export const DEVICE_LINK_ID='assistant-conversation:device-link';
const IDENTITY_SLOT={owner:'device-link',slot:'device-identity'};
const ADDRESS=/^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9._-]+):[0-9]{1,5}$/;
export interface DeviceGrants {view:boolean;instruct:boolean;answerApprovals:boolean}
export const DEFAULT_DEVICE_GRANTS:DeviceGrants={view:true,instruct:true,answerApprovals:true};
export type LinkCause='refused'|'not-found'|'timed-out'|'pin'|'protocol';
export type LinkStatus='connected'|'offline'|'failed'|'update-needed';
export interface PairedPeer {deviceId:string;publicKey:string;name:string;agentName:string;grants:DeviceGrants;addresses:string[];pairedAt:number;lastConnectedAt?:number;lastStatus?:LinkStatus;lastCause?:LinkCause;lastAddress?:string}
export interface StoredOffer {id:string;codeHash:string;grants:DeviceGrants;addresses:string[];name:string;created:number;expiresAt:number;used:boolean;wrongCodes?:number}
export interface DeviceLinkState {kind:'device-link';id:string;peers:PairedPeer[];offers:StoredOffer[];listen?:{port:number}}
type PeerPublic={deviceId:string;publicKey:string;name:string;agentName:string;addresses:string[]};
type LinkOwnerCommand={type:'link-owner';action:'create-offer';offerId:string;codeHash:string;grants:DeviceGrants;addresses:string[];name:string;created:number;expiresAt:number}|{type:'link-owner';action:'unpair';commandId:string;deviceId:string}|{type:'link-owner';action:'widen';commandId:string;deviceId:string;grants:DeviceGrants};
type LinkObserveCommand={type:'link-observe';action:'peer-added';peer:PairedPeer}|{type:'link-observe';action:'pairing-completed';peer:PairedPeer;offerId:string}|{type:'link-observe';action:'listener-bound';port:number}|{type:'link-observe';action:'code-rejected';offerId:string;attempt:number}|{type:'link-observe';action:'connection-observed';deviceId:string;status:LinkStatus;cause?:LinkCause;address?:string;at:number};
type DeviceLinkCommand=LinkOwnerCommand|LinkObserveCommand;
export interface DeviceLinkOptions {clock?:()=>number;port?:number;bind?:string;pairingTtlMs?:number;connectTimeoutMs?:number;preAuthTimeoutMs?:number;idleTimeoutMs?:number;maxUnauthenticated?:number;maxUnauthenticatedPerAddress?:number;inboundCoalesceMs?:number}
export type PairingOutcome={status:'paired';peer:{deviceId:string;name:string;agentName:string;grants:DeviceGrants}}|{status:'wrong-code';attemptsLeft:number}|{status:'code-ended'}|{status:'could-not-connect'};
// Initial defaults for unauthenticated sockets, to be measured: 10 s to authenticate, 10 min idle (above the 5 min pairing confirmation), 32 concurrent total, 8 per remote address.
const PREAUTH_TIMEOUT_MS=1e4,IDLE_TIMEOUT_MS=6e5,MAX_UNAUTHENTICATED=32,MAX_UNAUTHENTICATED_PER_ADDRESS=8,INBOUND_COALESCE_MS=3e4;
// Initial defaults, to be measured: a pairing window lives 5 minutes and ends on restart, and a code survives 5 wrong confirmations before the window closes.
const PAIRING_TTL_MS=3e5,MAX_WRONG_CODES=5;
// Initial default: hosts listen on one fixed port so a bare host name or IP is a full address; override with the existing port option.
const DEFAULT_LINK_PORT=47831;
type DeviceIdentity={deviceId:string;fingerprint:string;publicKey:string;keyPem:string;certPem:string};
type PairingWindow={salt:Buffer;exponent:bigint;verifier:bigint;expiresAt:number;wrong:number;consumed:boolean;closed:boolean;guard:Promise<void>};
// A window accepts a new pairing while it is open on every axis; a session claims it by setting consumed.
const windowOpen=(window:PairingWindow,now:number)=>!window.closed&&!window.consumed&&window.wrong<MAX_WRONG_CODES&&window.expiresAt>now;

const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9:_-]{1,128}$/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function ensure(v:unknown,message:string,code:'invalid'|'denied'|'conflict'='invalid'):asserts v {if(!v)throw new DomainError(message,code);}
const GRANT_KEYS=['view','instruct','answerApprovals'] as const;
const grants=(v:unknown):v is DeviceGrants=>!!v&&exact(v,['view','instruct','answerApprovals'])&&GRANT_KEYS.every(k=>typeof v[k]==='boolean');
const addresses=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=8&&v.every(a=>typeof a==='string'&&ADDRESS.test(a)&&a.length<=200);
const label=(v:unknown):v is string=>typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=2000&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const peerPublic=(v:unknown):v is PeerPublic=>!!v&&exact(v,['deviceId','publicKey','name','agentName','addresses'])&&id(v.deviceId)&&typeof v.publicKey==='string'&&/^[A-Za-z0-9+/=]{64,256}$/.test(v.publicKey)&&label(v.name)&&label(v.agentName)&&addresses(v.addresses);
const peerFull=(v:unknown):v is PairedPeer=>!!v&&typeof v==='object'&&!Array.isArray(v)&&exact(v,['deviceId','publicKey','name','agentName','addresses','grants','pairedAt',...('lastConnectedAt' in v?['lastConnectedAt']:[]),...('lastStatus' in v?['lastStatus']:[]),...('lastCause' in v?['lastCause']:[]),...('lastAddress' in v?['lastAddress']:[])])&&id(v.deviceId)&&typeof v.publicKey==='string'&&/^[A-Za-z0-9+/=]{64,256}$/.test(v.publicKey)&&label(v.name)&&label(v.agentName)&&addresses(v.addresses)&&grants(v.grants)&&Number.isSafeInteger(v.pairedAt)&&v.pairedAt>0&&(!('lastConnectedAt' in v)||Number.isSafeInteger(v.lastConnectedAt)&&v.lastConnectedAt>0)&&(!('lastStatus' in v)||['connected','offline','failed','update-needed'].includes(v.lastStatus))&&(!('lastCause' in v)||['refused','not-found','timed-out','pin','protocol'].includes(v.lastCause))&&(!('lastAddress' in v)||ADDRESS.test(v.lastAddress));
export const deviceIdFor=(publicKey:string)=>'device-'+createHash('sha256').update(Buffer.from(publicKey,'base64')).digest('hex').slice(0,32);
export interface SrpGroup {prime:Buffer;generator:Buffer;hash:string}
// RFC 5054 appendix A 3072-bit group: the prime is Node's modp15 and RFC 5054 pairs it with generator 5 (getDiffieHellman defaults this prime to generator 2).
export const SRP_GROUP:SrpGroup={prime:getDiffieHellman('modp15').getPrime(),generator:Buffer.from([5]),hash:'sha256'};
const bufferToBig=(value:Buffer)=>BigInt('0x'+(value.toString('hex')||'0'));
const bigToBuffer=(value:bigint,length=0)=>{let hex=value.toString(16);if(hex.length%2)hex='0'+hex;const raw=Buffer.from(hex,'hex');return length?Buffer.concat([Buffer.alloc(Math.max(0,length-raw.length)),raw]):raw;};
const srpHash=(group:SrpGroup,...parts:Buffer[])=>createHash(group.hash).update(Buffer.concat(parts)).digest();
const srpPad=(group:SrpGroup,value:Buffer)=>{const length=group.prime.length;return value.length>=length?value:Buffer.concat([Buffer.alloc(length-value.length),value]);};
// Building a DH object runs OpenSSL's primality check (~1.4 s for the 3072-bit group), so the group generator shares one exchange object per group; an arbitrary base builds one per use.
const generatorExchanges=new WeakMap<SrpGroup,DiffieHellman>();
const exchangeFor=(group:SrpGroup,base:bigint)=>createDiffieHellman(group.prime,bigToBuffer(base));
const generatorExchange=(group:SrpGroup)=>{let exchange=generatorExchanges.get(group);if(!exchange){exchange=exchangeFor(group,bufferToBig(group.generator));generatorExchanges.set(group,exchange);}return exchange;};
// generateKeys keeps a set private key (OpenSSL only fills in the missing public half), so this computes base^exponent through OpenSSL.
const powerWith=(exchange:DiffieHellman,exponent:bigint)=>{exchange.setPrivateKey(bigToBuffer(exponent));return bufferToBig(exchange.generateKeys());};
const srpModPow=(group:SrpGroup,base:bigint,exponent:bigint)=>{
 const prime=bufferToBig(group.prime);
 ensure(base>0n&&base<prime&&exponent>0n&&exponent<prime,'SRP value out of range');
 return powerWith(exchangeFor(group,base),exponent);
};
const srpGeneratorPow=(group:SrpGroup,exponent:bigint)=>{ensure(exponent>0n&&exponent<bufferToBig(group.prime),'SRP value out of range');return powerWith(generatorExchange(group),exponent);};
export const srpK=(group:SrpGroup)=>bufferToBig(srpHash(group,group.prime,srpPad(group,group.generator)));
export const srpX=(group:SrpGroup,salt:Buffer,secret:string)=>bufferToBig(srpHash(group,salt,srpHash(group,Buffer.from(secret,'utf8'))));
export const srpU=(group:SrpGroup,a:bigint,b:bigint)=>bufferToBig(srpHash(group,srpPad(group,bigToBuffer(a)),srpPad(group,bigToBuffer(b))));
export const srpVerifier=(group:SrpGroup,salt:Buffer,secret:string)=>srpGeneratorPow(group,srpX(group,salt,secret));
export const srpClientPublic=(group:SrpGroup,a:bigint)=>srpGeneratorPow(group,a);
export const srpServerPublic=(group:SrpGroup,verifier:bigint,b:bigint)=>(srpK(group)*verifier+srpGeneratorPow(group,b))%bufferToBig(group.prime);
// v^u = g^(x*u), so the shared generator exchange covers it; each side needs only one per-attempt base through OpenSSL.
export const srpServerSecret=(group:SrpGroup,a:bigint,x:bigint,u:bigint,b:bigint)=>{const prime=bufferToBig(group.prime);return srpModPow(group,(a*srpGeneratorPow(group,x*u))%prime,b);};
export const srpClientSecret=(group:SrpGroup,b:bigint,x:bigint,a:bigint,u:bigint)=>{const prime=bufferToBig(group.prime),base=(b-(srpK(group)*srpGeneratorPow(group,x))%prime+prime)%prime;return srpModPow(group,base,a+u*x);};
const srpExponent=()=>{for(;;){const value=bufferToBig(randomBytes(32));if(value>0n)return value;}};
const PAIRING_LABEL='massion-pair v1',PAIRING_CODE_PREFIX='massion-pair:';
type PeerClaim={deviceId:string;publicKey:string;name:string;agentName:string};
const peerClaim=(v:unknown):v is PeerClaim=>!!v&&exact(v,['deviceId','publicKey','name','agentName'])&&id(v.deviceId)&&typeof v.publicKey==='string'&&/^[A-Za-z0-9+/=]{64,256}$/.test(v.publicKey)&&label(v.name)&&label(v.agentName);
// The confirmation key binds the SRP secret to exactly what each side saw on this socket: both public keys, both identities and both declared protocol ranges.
const pairingTranscript=(client:PeerClaim,host:PeerClaim,clientSupported:ProtocolRange,hostSupported:ProtocolRange)=>JSON.stringify([PAIRING_LABEL,client.publicKey,host.publicKey,client.deviceId,client.name,client.agentName,host.deviceId,host.name,host.agentName,clientSupported.min,clientSupported.max,hostSupported.min,hostSupported.max]);
const confirmationKey=(premaster:Buffer,transcript:string)=>Buffer.from(hkdfSync('sha256',premaster,Buffer.from(PAIRING_LABEL),Buffer.from(transcript),32));
const confirmOf=(key:Buffer,role:'client'|'host')=>createHmac('sha256',key).update(role).digest();
/** Test-facing: a raw SRP client derives the same confirmation pair the service computes from its premaster secret and transcript. */
export const pairingConfirmations=(premaster:bigint,client:PeerClaim,host:PeerClaim,clientSupported:ProtocolRange,hostSupported:ProtocolRange)=>{const key=confirmationKey(bigToBuffer(premaster,SRP_GROUP.prime.length),pairingTranscript(client,host,clientSupported,hostSupported));return {client:confirmOf(key,'client').toString('base64'),host:confirmOf(key,'host').toString('base64')};};
const observeId=(command:LinkObserveCommand)=>'assistant-link:'+hash(command).slice(0,32);
const sendFrame=(socket:TLSSocket,message:unknown)=>{if(!socket.destroyed)socket.write(JSON.stringify(message)+'\n');};
const peerSpki=(socket:TLSSocket)=>{const cert=socket.getPeerCertificate();if(!cert||!cert.raw)throw new Error('Missing peer certificate');return new X509Certificate(cert.raw).publicKey.export({type:'spki',format:'der'}) as Buffer;};
const normalizeAddress=(host:string,port:number)=>host.includes(':')&&!host.startsWith('[')?`[${host}]:${port}`:`${host}:${port}`;
const HOST=/^(\[[0-9A-Fa-f:.%]+\]|[A-Za-z0-9._-]+)$/;
const splitAddress=(address:string):{host:string;port:number}=>{
 if(ADDRESS.test(address)){const ipv6=/^\[/.test(address),host=ipv6?address.slice(1,address.indexOf(']')):address.slice(0,address.lastIndexOf(':'));return {host,port:Number(address.slice(address.lastIndexOf(':')+1))};}
 const host=address.startsWith('[')?address.slice(1,-1):address;return {host,port:DEFAULT_LINK_PORT};
};
const fullAddress=(address:string)=>{const {host,port}=splitAddress(address);return normalizeAddress(host,port);};
const publicClaim=(identity:DeviceIdentity):PeerClaim=>({deviceId:identity.deviceId,publicKey:identity.publicKey,name:hostname(),agentName:hostname()});
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
   state.offers.push({id:command.offerId,codeHash:command.codeHash,grants:structuredClone(command.grants),addresses:[...command.addresses],name:command.name,created:command.created,expiresAt:command.expiresAt,used:false,wrongCodes:0});
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
  if(command.action==='peer-added'||command.action==='pairing-completed'||command.action==='listener-bound'||command.action==='code-rejected'){
   if(command.action==='code-rejected'){
    ensure(exact(command,['type','action','offerId','attempt'])&&id(command.offerId)&&Number.isSafeInteger(command.attempt)&&command.attempt>0,'Exact code rejection required');
    const offer=state.offers.find(o=>o.id===command.offerId);ensure(offer&&!offer.used,'Live pairing offer required','conflict');
    // Sequential attempts keep each rejection a distinct command identity while replaying deterministically.
    ensure(command.attempt===(offer.wrongCodes??0)+1,'Exact code rejection sequence','conflict');
    offer.wrongCodes=(offer.wrongCodes??0)+1;if(offer.wrongCodes>=MAX_WRONG_CODES)offer.used=true;
   }else if(command.action==='listener-bound'){
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

/** Pairing and the pinned mutual-TLS link. The private key never leaves the secret adapter; the pairing code and its SRP verifier live only in memory. */
export class DeviceLinkService {
 readonly #store:Store<any>;readonly #owner:Store<any>;readonly #secrets:SecretSlots;readonly #clock:()=>number;readonly #port:number|undefined;readonly #bind:string;readonly #pairingTtl:number;readonly #connectTimeout:number;
 #identityPromise?:Promise<DeviceIdentity>;
 #server?:TlsServer;#syncing?:Promise<void>;#drained=false;#expiryTimer?:NodeJS.Timeout;#links=new Map<string,TLSSocket>();#versions=new Map<string,number>();#accepted=new Set<TLSSocket>();
 #preauth=new Map<Socket,{host:string;timer:NodeJS.Timeout}>();#unauth=new Map<TLSSocket,{host:string;timer:NodeJS.Timeout;introSeen?:boolean}>();#idle=new Map<TLSSocket,NodeJS.Timeout>();#authedDevice=new Map<TLSSocket,string>();#unauthPerHost=new Map<string,number>();
 #pins=new Map<string,string>();#guard=new Map<string,{status:LinkStatus;host:string;at:number}>();#queues=new Map<TLSSocket,Promise<unknown>>();
 readonly #preAuthTimeoutMs:number;readonly #idleTimeoutMs:number;readonly #maxUnauth:number;readonly #maxUnauthPerAddress:number;readonly #inboundCoalesceMs:number;
 #window?:PairingWindow;
 #unknownCommit?:CommitOutcomeUnknownError;
 #pairings=new Map<TLSSocket,{window:PairingWindow;peer:PeerClaim;expected:Buffer;key:Buffer;done:boolean}>();
 #attempts=new Map<string,{address:string;code:string;name:string;agentName:string;outcome:Promise<PairingOutcome>}>();
 #outboundSockets=new Set<TLSSocket>();
 #active=new Set<Promise<unknown>>();#stop=new AbortController();
 constructor(store:Store<any>,owner:Store<any>,secrets:SecretSlots,options:DeviceLinkOptions={}){this.#store=store;this.#owner=owner;this.#secrets=secrets;this.#clock=options.clock??Date.now;this.#port=options.port;this.#bind=options.bind??'0.0.0.0';this.#pairingTtl=options.pairingTtlMs??PAIRING_TTL_MS;this.#connectTimeout=options.connectTimeoutMs??5000;this.#preAuthTimeoutMs=options.preAuthTimeoutMs??PREAUTH_TIMEOUT_MS;this.#idleTimeoutMs=options.idleTimeoutMs??IDLE_TIMEOUT_MS;this.#maxUnauth=options.maxUnauthenticated??MAX_UNAUTHENTICATED;this.#maxUnauthPerAddress=options.maxUnauthenticatedPerAddress??MAX_UNAUTHENTICATED_PER_ADDRESS;this.#inboundCoalesceMs=options.inboundCoalesceMs??INBOUND_COALESCE_MS;
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

 /** The listener binds while a pairing window is live or a paired peer exists (ADR 0006 decision 5). */
 async #syncListener(){
  if(this.#drained)return;if(this.#syncing)return this.#syncing;
  this.#syncing=(async()=>{
   const identity=await this.#identityLoad();
   // Expiry cleanup waits for any accepted commit; durable state is read only after it, so a peer that landed during the wait keeps the listener.
   const expiryNow=this.#clock();
   if(this.#window&&this.#window.expiresAt<=expiryNow){const window=this.#window;await this.#critical(window,async()=>{if(this.#window===window){this.#window=undefined;this.#endWindowSessions(window);}});}
   const state=await this.#state(),now=this.#clock();
   const want=!!this.#window||(state?.value.peers??[]).length>0;
   this.#refreshPins(state?.value);
   // Drain may have started while this synchronization was in flight.
   if(this.#drained)return;
   if(!want){if(this.#expiryTimer){clearTimeout(this.#expiryTimer);this.#expiryTimer=undefined;}if(this.#server){this.#server.close();this.#server=undefined;}return;}
   // The listener must close when the pairing window expires on a host with no paired devices.
   if(this.#expiryTimer)clearTimeout(this.#expiryTimer);
   const expiry=this.#window?.expiresAt;
   if(expiry!==undefined){const delay=Math.max(0,expiry-now+1);this.#expiryTimer=setTimeout(()=>{this.#expiryTimer=undefined;void this.#syncListener().catch(()=>{});},delay);this.#expiryTimer.unref?.();}
   if(this.#server)return;
   const server=createServer({key:identity.keyPem,cert:identity.certPem,minVersion:'TLSv1.3',handshakeTimeout:this.#preAuthTimeoutMs,requestCert:true,rejectUnauthorized:false},socket=>this.#accept(socket));
   // Pre-handshake sockets are tracked from the raw TCP connection so drain can close them.
   
   server.on('error',()=>{if(this.#server===server)this.#server=undefined;});
   // The unauthenticated accounting starts at the raw TCP connection, so staying before the handshake cannot exceed the caps.
   server.on('connection',raw=>{
    const host=hostKey(remoteHost(raw));
    if(this.#preauth.size+this.#unauth.size>=this.#maxUnauth||(this.#unauthPerHost.get(host)??0)>=this.#maxUnauthPerAddress){raw.destroy();return;}
    const timer=setTimeout(()=>raw.destroy(),this.#preAuthTimeoutMs);timer.unref?.();
    this.#preauth.set(raw,{host,timer});
    this.#unauthPerHost.set(host,(this.#unauthPerHost.get(host)??0)+1);
    raw.on('close',()=>{const entry=this.#preauth.get(raw);if(entry){clearTimeout(entry.timer);this.#preauth.delete(raw);const count=(this.#unauthPerHost.get(entry.host)??1)-1;if(count>0)this.#unauthPerHost.set(entry.host,count);else this.#unauthPerHost.delete(entry.host);}});
   });
   // An explicit nonzero port wins; a persisted listener port keeps an existing installation reachable; zero stays ephemeral and only a fresh install takes the fixed default.
   const explicit=this.#port!==undefined&&this.#port>0,desired=explicit?this.#port!:(state?.value.listen?.port??this.#port??DEFAULT_LINK_PORT);
   this.#server=server;await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(desired,this.#bind,()=>{server.off('error',reject);resolve();});});
   if(this.#drained){server.close();this.#server=undefined;return;}
   // A restart rebinds the persisted port so stored addresses stay reachable.
   const port=(server.address() as {port:number}).port;
   if(port!==(state?.value.listen?.port??0)){const recorded:LinkObserveCommand={type:'link-observe',action:'listener-bound',port};await this.#dispatch((await this.#store.readState()).feedId,observeId(recorded),recorded,false);}
  })().catch(error=>{this.#server=undefined;throw error;}).finally(()=>{this.#syncing=undefined;});
  return this.#syncing;
 }
 #accept(socket:TLSSocket){
  const host=hostKey(remoteHost(socket));
  // The handshake adopts the accounting that started at the raw TCP connection; a foreign socket still counts.
  const raw=(socket as {_parent?:Socket})._parent,pending=raw?this.#preauth.get(raw):undefined;
  if(pending&&raw){clearTimeout(pending.timer);this.#preauth.delete(raw);}
  else this.#unauthPerHost.set(host,(this.#unauthPerHost.get(host)??0)+1);
  this.#accepted.add(socket);
  const preauth=setTimeout(()=>socket.destroy(),this.#preAuthTimeoutMs);preauth.unref?.();
  this.#unauth.set(socket,{host,timer:preauth});
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
 this.#pairings.delete(socket);
  // An authenticated inbound link that closed leaves the device offline on this host.
  if(!idle)return;
  if(authedDevice)void this.#recordInbound(authedDevice,'offline',hostKey(remoteHost(socket))).catch(()=>{});
 }
 #refreshPins(value:DeviceLinkState|undefined){this.#pins.clear();for(const peer of value?.peers??[])this.#pins.set(peer.publicKey,peer.deviceId);}
 // A live window can still accept a new pairing; an ended (consumed, closed or exhausted) window stays bound until expiry so a dialing device meets a silent port instead of a refused one.
 #liveWindow(now=this.#clock()){const window=this.#window;return window&&windowOpen(window,now)?window:undefined;}
 // Ending a window ends every in-flight session of it, so a confirmation already computed against it cannot complete.
 #endWindowSessions(window:PairingWindow,except?:TLSSocket){for(const [socket,session] of this.#pairings)if(session.window===window&&socket!==except){this.#pairings.delete(socket);socket.destroy();}}
 // One critical section per window: accepting a confirmation (its liveness check through its commit and reply) and ending the window (close, expiry, exhaustion) never interleave. A commit that began before a close finishes and counts as paired before the close returns; nothing begins after it.
 #critical<T>(window:PairingWindow,action:()=>Promise<T>):Promise<T>{
  const previous=window.guard;
  let release:()=>void=()=>{};
  window.guard=new Promise<void>(resolve=>{release=resolve;});
  return (async()=>{await previous;try{return await action();}finally{release();}})();
 }
 // One address to show while a window is open: the bound interface, or the first LAN address when binding all interfaces.
 #shownAddress(){const port=this.#server?(this.#server.address() as {port:number}).port:(this.#port??DEFAULT_LINK_PORT),lan=[...Object.values(networkInterfaces())].flat().filter(i=>i?.family==='IPv4'&&!i.internal).map(i=>i!.address)[0];return normalizeAddress(this.#bind!=='0.0.0.0'?this.#bind:(lan??'127.0.0.1'),port);}
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
  if(message.kind==='pair-client'){
   const window=this.#liveWindow();
   // A pairing request is answered only while a live window exists; otherwise the socket is closed with no answer. One guess per socket.
   if(this.#pairings.has(socket)||!window){socket.destroy();return;}
   const claim=message.peer,aBuf=typeof message.A==='string'?Buffer.from(message.A,'base64'):undefined,prime=bufferToBig(SRP_GROUP.prime);
   if(!peerClaim(claim)||claim.publicKey!==peerSpki(socket).toString('base64')||claim.deviceId!==deviceIdFor(claim.publicKey)||!validRange(message.supported)||!aBuf||aBuf.length<1||aBuf.length>SRP_GROUP.prime.length||bufferToBig(aBuf)%prime===0n){socket.destroy();return;}
   const a=bufferToBig(aBuf),b=srpExponent(),bPub=srpServerPublic(SRP_GROUP,window.verifier,b),u=srpU(SRP_GROUP,a,bPub);
   if(u===0n){socket.destroy();return;}
   const premaster=srpServerSecret(SRP_GROUP,a,window.exponent,u,b),key=confirmationKey(bigToBuffer(premaster,SRP_GROUP.prime.length),pairingTranscript(claim,publicClaim(identity),message.supported,protocolSupport));
   this.#pairings.set(socket,{window,peer:structuredClone(claim),expected:confirmOf(key,'client'),key,done:false});
   sendFrame(socket,{kind:'pair-server',salt:window.salt.toString('base64'),B:bigToBuffer(bPub,SRP_GROUP.prime.length).toString('base64'),peer:publicClaim(identity),supported:protocolSupport});
   return;}
  if(message.kind==='pair-confirm'){
   const session=this.#pairings.get(socket);
   if(!session||session.done){socket.destroy();return;}
   // A confirmation is processed only while the session's window is still the live one: not closed, expired, exhausted or replaced.
   if(this.#liveWindow()!==session.window){socket.destroy();return;}
   session.done=true;
   const confirm=typeof message.confirm==='string'?Buffer.from(message.confirm,'base64'):undefined;
   // A wrong confirmation spends one attempt inside the window's critical section; the fifth ends the window with no answer, exactly like an ended code.
   if(!confirm||confirm.length!==session.expected.length||!timingSafeEqual(confirm,session.expected)){
   const window=session.window;this.#pairings.delete(socket);
   await this.#critical(window,async()=>{window.wrong++;if(window.wrong>=MAX_WRONG_CODES)this.#endWindowSessions(window);});
   if(window.wrong>=MAX_WRONG_CODES){socket.destroy();return;}
   socket.end(JSON.stringify({kind:'pair-failed',reason:'code',attemptsLeft:MAX_WRONG_CODES-window.wrong})+'\n');
    return;}
   // Acceptance and its commit run inside the window's critical section: once accepted, close, expiry and exhaustion wait for the write, and nothing is accepted after them.
   const accepted=await this.#critical(session.window,async()=>{
    // Everything the commit needs is prepared first; the store read is the last await before acceptance.
    const peer:PairedPeer={deviceId:session.peer.deviceId,publicKey:session.peer.publicKey,name:session.peer.name,agentName:session.peer.agentName,grants:{...DEFAULT_DEVICE_GRANTS},addresses:[],pairedAt:this.#clock()};
    const observe:LinkObserveCommand={type:'link-observe',action:'peer-added',peer};
    const feedId=(await this.#store.readState()).feedId;
    // The final liveness check — not closed, not replaced, not exhausted, and the clock still before the expiry — runs immediately before the dispatch starts, with no await in between.
    if(this.#window!==session.window||!windowOpen(session.window,this.#clock()))return false;
    session.window.consumed=true;
    const committed=await this.#awaitDrain(this.#dispatch(feedId,observeId(observe),observe,false));
    if(committed.status!=='committed'&&committed.status!=='replayed')return false;
    this.#pairings.delete(socket);
    sendFrame(socket,{kind:'pair-complete',confirm:confirmOf(session.key,'host').toString('base64'),peer:publicClaim(identity)});
    socket.end();
    return true;});
   if(!accepted){socket.destroy();return;}
   await this.#syncListener();
   return;}
  if(message.kind==='ping'){
   // Only a pinned paired key may ping, and the pin is checked before any durable state is loaded.
   const deviceId=this.#pins.get(peerSpki(socket).toString('base64'));
   if(!deviceId){socket.destroy();return;}
   if(!validRange(message.supported)){socket.destroy();return;}
   // The inbound side runs the same protocol negotiation as the outbound side; an incompatible range is update-needed, not connected.
   const link=protocolConnection(message.supported,protocolSupport);
   this.#markAuthenticated(socket,deviceId);
   sendFrame(socket,{kind:'pong',supported:protocolSupport});
   await this.#recordInbound(deviceId,link.state==='ready'?'connected':'update-needed',hostKey(remoteHost(socket)),normalizeAddress(remoteHost(socket),socket.remotePort??0));
   return;
  }
 }
 async #observe(deviceId:string,status:LinkStatus,cause?:LinkCause,address?:string){
  const command:LinkObserveCommand={type:'link-observe',action:'connection-observed',deviceId,status,at:this.#clock(),...(cause?{cause}:{}),...(address?{address}:{})};
  await this.#dispatch((await this.#store.readState()).feedId,observeId(command),command,false);
 }

 /** Opens the one live pairing window; a previous window is replaced. The code and its SRP verifier live only in memory, so a restart ends the window. */
 async openPairing(input:unknown,_feed?:string){return this.#run(async()=>{
  const value=windowCommand(input);
  if(this.#drained)throw new HostDrainError();
  const previous=this.#window;
  // Replacing a live window waits for its critical section exactly like closing it: a commit that already began finishes first, and nothing of the old window can begin afterwards.
  if(previous)await this.#critical(previous,()=>Promise.resolve());
  const code=String(randomInt(100000,1000000)),salt=randomBytes(16),exponent=srpX(SRP_GROUP,salt,PAIRING_CODE_PREFIX+code);
  this.#window={salt,exponent,verifier:srpGeneratorPow(SRP_GROUP,exponent),expiresAt:this.#clock()+this.#pairingTtl,wrong:0,consumed:false,closed:false,guard:Promise.resolve()};
  await this.#syncListener();
  return {code,expiresAt:this.#window.expiresAt,address:this.#shownAddress()};
 });}
 /** Ends the live pairing window; pairing requests then get no answer. */
 async closePairing(input:unknown,_feed?:string){return this.#run(async()=>{
  windowCommand(input);const window=this.#window;
  if(window)await this.#critical(window,async()=>{window.closed=true;this.#endWindowSessions(window);});
  await this.#syncListener();return {status:'closed' as const};
 });}
 /** Pairs with a host-shown code over SRP-6a; the code is never sent and no fingerprint is compared. A retried command identity replays its original outcome. */
 async pair(input:unknown,expectedFeed?:string):Promise<PairingOutcome>{
  const value=pairCommand(input),existing=this.#attempts.get(value.commandId);
  if(existing){
   // A retried command identity must carry the same payload; any change is a conflict, never a silent reuse.
   ensure(existing.address===value.address&&existing.code===value.code&&existing.name===value.name&&existing.agentName===value.agentName,'Pairing attempt identity conflict','conflict');
   return existing.outcome;
  }
  const attempt={address:value.address,code:value.code,name:value.name,agentName:value.agentName,outcome:this.#pairAttempt(value,expectedFeed)};
  this.#attempts.set(value.commandId,attempt);
  return attempt.outcome;
 }
 async #pairAttempt(value:{commandId:string;address:string;code:string;name:string;agentName:string},expectedFeed?:string):Promise<PairingOutcome>{return this.#run(async identity=>{
  const feedId=expectedFeed??(await this.#store.readState()).feedId;
  const address=fullAddress(value.address);
  let socket:TLSSocket;
  try{socket=await this.#dial(identity,address);}catch{return {status:'could-not-connect' as const};}
  try{
   const seen=peerSpki(socket).toString('base64'),claim:PeerClaim={deviceId:identity.deviceId,publicKey:identity.publicKey,name:value.name,agentName:value.agentName};
   let host:PeerClaim;
   try{
    const a=srpExponent(),aPub=srpClientPublic(SRP_GROUP,a);
    const reply=await this.#exchange(socket,{kind:'pair-client',peer:claim,supported:protocolSupport,A:bigToBuffer(aPub,SRP_GROUP.prime.length).toString('base64')},this.#pairingTtl,message=>message?.kind==='pair-server');
    if(reply?.kind!=='pair-server'||!peerClaim(reply.peer)||reply.peer.publicKey!==seen||reply.peer.deviceId!==deviceIdFor(seen)||!validRange(reply.supported))return {status:'code-ended' as const};
    const salt=Buffer.from(String(reply.salt),'base64'),bBuf=Buffer.from(String(reply.B),'base64'),prime=bufferToBig(SRP_GROUP.prime);
    if(salt.length<8||salt.length>64||bBuf.length<1||bBuf.length>SRP_GROUP.prime.length)return {status:'code-ended' as const};
    const b=bufferToBig(bBuf),u=srpU(SRP_GROUP,aPub,b),x=srpX(SRP_GROUP,salt,PAIRING_CODE_PREFIX+value.code);
    if(b%prime===0n||u===0n)return {status:'code-ended' as const};
    const premaster=srpClientSecret(SRP_GROUP,b,x,a,u),key=confirmationKey(bigToBuffer(premaster,SRP_GROUP.prime.length),pairingTranscript(claim,reply.peer,protocolSupport,reply.supported));
    const final=await this.#exchange(socket,{kind:'pair-confirm',confirm:confirmOf(key,'client').toString('base64')},this.#pairingTtl,message=>message?.kind==='pair-complete'||message?.kind==='pair-failed');
    // Only a reply with attempts left says wrong code; an exhausted window answers nothing and reads as an ended code.
    if(final?.kind==='pair-failed'&&Number.isSafeInteger(final.attemptsLeft)&&final.attemptsLeft>0)return {status:'wrong-code' as const,attemptsLeft:final.attemptsLeft};
    if(final?.kind!=='pair-complete'||!peerClaim(final.peer)||final.peer.publicKey!==seen||final.peer.deviceId!==deviceIdFor(seen))return {status:'code-ended' as const};
    const hostConfirm=Buffer.from(String(final.confirm),'base64'),expected=confirmOf(key,'host');
    if(hostConfirm.length!==expected.length||!timingSafeEqual(hostConfirm,expected))return {status:'code-ended' as const};
    host=reply.peer;
   }catch{
    // Only an aborted SRP exchange (invalid server values, a closed socket or a timeout) looks like an ended code; persistence errors stay themselves.
    return {status:'code-ended' as const};
   }
   await this.#feed(feedId);
   const peer:PairedPeer={deviceId:host.deviceId,publicKey:seen,name:host.name,agentName:host.agentName,grants:{...DEFAULT_DEVICE_GRANTS},addresses:[address],pairedAt:this.#clock()};
   const observe:LinkObserveCommand={type:'link-observe',action:'peer-added',peer};
   const committed=await this.#dispatch(feedId,observeId(observe),observe,false);
   ensure(committed.status==='committed'||committed.status==='replayed','Pairing did not complete','conflict');
   socket.end();await this.#syncListener();
   return {status:'paired' as const,peer:{deviceId:peer.deviceId,name:peer.name,agentName:peer.agentName,grants:peer.grants}};
  }finally{if(!socket.destroyed)socket.end();}
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
 // Inbound pairing commits run inside frame queues drain does not own; registering the write keeps shutdown from outrunning it. An unknown commit outcome is kept for drain to surface instead of silently ending the code.
 #awaitDrain<T>(task:Promise<T>){const tracked=task.catch(error=>{if(error instanceof CommitOutcomeUnknownError)this.#unknownCommit??=error;}).finally(()=>this.#active.delete(tracked));this.#active.add(tracked);return task;}
 #dial(identity:{deviceId:string;fingerprint:string;publicKey:string;keyPem:string;certPem:string},address:string,expected?:{fingerprint?:string;publicKey?:string}):Promise<TLSSocket>{
  return new Promise((resolve,reject)=>{
   const ipv6=/^\[/.test(address),host=ipv6?address.slice(1,address.indexOf(']')):address.slice(0,address.lastIndexOf(':')),port=Number(address.slice(address.lastIndexOf(':')+1));
   let settled=false;const succeed=(socket:TLSSocket)=>{if(settled)return;settled=true;resolve(socket);},fail=(error:unknown)=>{if(settled)return;settled=true;reject(error);};
   // Mutual TLS: this side always presents its device certificate; the peer key is pinned separately.
   const socket=connect({host,port,key:identity.keyPem,cert:identity.certPem,minVersion:'TLSv1.3',rejectUnauthorized:false,timeout:this.#connectTimeout},()=>{
    try{
     const spki=peerSpki(socket),hex=createHash('sha256').update(spki).digest('hex');
     if(expected?.fingerprint&&expected.fingerprint!==hex||expected?.publicKey&&expected.publicKey!==spki.toString('base64'))throw Object.assign(new Error('Pinned key mismatch'),{cause:'pin'});
     socket.setTimeout(0);
     succeed(socket);
    }catch(error){socket.destroy();fail(error);}});
   // Outbound sockets are tracked from the moment dial creates them, so drain cancels even a pending connection.
   this.#outboundSockets.add(socket);
   // A socket that closes before the handshake completes must reject its dial, or drain waits on it forever (issue #171 item 2).
   socket.on('close',()=>{this.#outboundSockets.delete(socket);fail(Object.assign(new Error('Dial socket closed'),{name:'AbortError'}));});
   if(this.#drained){socket.destroy();fail(new HostDrainError());}
   socket.on('error',error=>{socket.destroy();fail(error);});
   socket.on('timeout',()=>{socket.destroy();fail(Object.assign(new Error('Connection timed out'),{name:'AbortError'}));});
  });
 }
#exchange(socket:TLSSocket,message:Record<string,unknown>,timeout=this.#pairingTtl,accept?:(message:any)=>boolean):Promise<any>{
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
   const state=await this.#state(),window=this.#liveWindow();
   return {identity:{deviceId:identity.deviceId,fingerprint:identity.fingerprint,name:hostname()},
    // The peers list is the list of devices that can control this host.
    peers:(state?.value.peers??[]).map(p=>({deviceId:p.deviceId,name:p.name,agentName:p.agentName,grants:p.grants,addresses:p.addresses,pairedAt:p.pairedAt,lastConnectedAt:p.lastConnectedAt,lastStatus:p.lastStatus,lastCause:p.lastCause,lastAddress:p.lastAddress})),
    pairing:window?{expiresAt:window.expiresAt,attemptsLeft:MAX_WRONG_CODES-window.wrong}:null,
    // An unknown outcome of an inbound pairing commit is visible to the owner at once, not only at shutdown.
    unknownPairingCommit:this.#unknownCommit?.message??null,
    // While a connecting device is attached and before success, the host can report its name.
    incoming:[...this.#pairings.values()].map(session=>({peer:{deviceId:session.peer.deviceId,name:session.peer.name,agentName:session.peer.agentName}}))};
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
    if(this.#drained){live.destroy();throw new HostDrainError();}
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
 async drain(){this.#drained=true;if(this.#expiryTimer){clearTimeout(this.#expiryTimer);this.#expiryTimer=undefined;}this.beginDrain();for(const socket of this.#links.values())socket.destroy();this.#links.clear();for(const socket of this.#pairings.keys())socket.destroy();this.#pairings.clear();this.#window=undefined;this.#attempts.clear();for(const socket of this.#outboundSockets)socket.destroy();this.#outboundSockets.clear();for(const socket of this.#accepted)socket.destroy();this.#accepted.clear();for(const raw of this.#preauth.keys())raw.destroy();for(const entry of this.#preauth.values())clearTimeout(entry.timer);this.#preauth.clear();for(const entry of this.#unauth.values())clearTimeout(entry.timer);this.#unauth.clear();this.#unauthPerHost.clear();for(const timer of this.#idle.values())clearTimeout(timer);this.#idle.clear();this.#queues.clear();const listener=this.#server;this.#server=undefined;await new Promise<void>(resolve=>listener?listener.close(()=>resolve()):resolve());const results=await Promise.allSettled([...this.#active]);for(const result of results)if(result.status==='rejected')throw result.reason;if(this.#unknownCommit!==undefined)throw this.#unknownCommit;}
}

function commandIdOf(v:Record<string,unknown>):string|undefined {return typeof v.commandId==='string'&&id(v.commandId)&&!v.commandId.startsWith('assistant-')?v.commandId:undefined;}
function grantsOf(v:Record<string,unknown>):DeviceGrants {if(v.grants===undefined)return {...DEFAULT_DEVICE_GRANTS};ensure(grants(v.grants),'Exact grants required: view, instruct, answerApprovals');return structuredClone(v.grants);}
function windowCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&exact(v,['commandId'])&&commandId,'Exact pairing window command required');return {commandId};}
function pairCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);
 ensure(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['commandId','address','code','name','agentName'].includes(k))&&commandId&&typeof v.address==='string'&&v.address.length<=200&&(ADDRESS.test(v.address)||HOST.test(v.address))&&typeof v.code==='string'&&/^[0-9]{6}$/.test(v.code)&&(v.name===undefined||label(v.name))&&(v.agentName===undefined||label(v.agentName)),'Exact pairing command with an address and a six-digit code required');
 return {commandId,address:v.address as string,code:v.code as string,name:label(v.name)?v.name as string:hostname(),agentName:label(v.agentName)?v.agentName as string:hostname()};}
function unpairCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&exact(v,['commandId','deviceId'])&&commandId&&id(v.deviceId),'Exact unpair required');return v as {commandId:string;deviceId:string};}
function widenCommand(input:unknown){const v=input as Record<string,unknown>,commandId=commandIdOf(v);ensure(v&&exact(v,['commandId','deviceId','grants'])&&commandId&&id(v.deviceId)&&grants(v.grants),'Exact grant widening required');return v as {commandId:string;deviceId:string;grants:DeviceGrants};}
