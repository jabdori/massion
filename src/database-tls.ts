import {createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign,X509Certificate} from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import {der,derInt,derOid,derTime,sequence} from './der.ts';

/** One start's database certificate: PEM strings held in supervisor memory only. */
export interface StartCertificate{certificate:string;privateKey:string}

/** The call shape the database transport and the supervisor's own startup requests use. */
export interface DatabaseRequestInit{method?:string;headers?:HeadersInit;body?:string;redirect?:'error';signal?:AbortSignal}
export interface DatabaseResponse{ok:boolean;status:number;json():Promise<unknown>;text():Promise<string>}
export type DatabaseRequestFn=(url:string|URL,init?:DatabaseRequestInit)=>Promise<DatabaseResponse>;

const pem=(label:string,derBytes:Buffer)=>['-----BEGIN '+label+'-----',...derBytes.toString('base64').match(/.{1,64}/g)!,'-----END '+label+'-----',''].join('\n');

/** A fresh key pair and self-signed certificate for one database start: EC P-256, subject
 * alternative name IP 127.0.0.1, valid from one minute before now for ten years, because a
 * managed database may run for months. Nothing is kept between starts. */
export function generateStartCertificate(now:number=Date.now(),privateKeyPem?:string,assembly:{certificateDer?:(finished:Buffer)=>Buffer}={}):StartCertificate{
 const privateKey=privateKeyPem===undefined?generateKeyPairSync('ec',{namedCurve:'P-256'}).privateKey:createPrivateKey(privateKeyPem);
 const signatureAlgorithm=sequence(derOid(1,2,840,10045,4,3,2));
 const name=sequence(der(49,sequence(derOid(2,5,4,3),der(12,Buffer.from('massion-managed-database')))));
 const expires=new Date(now);expires.setUTCFullYear(expires.getUTCFullYear()+10);
 const subjectAlternativeName=der(0xa3,sequence(sequence(derOid(2,5,29,17),der(4,sequence(der(0x87,Buffer.from([127,0,0,1])))))));
 // RFC 5280 wants a positive serial; an all-zero draw (2^-128) is re-drawn so the serial stays random.
 let serial=randomBytes(16);
 while(serial.every(byte=>byte===0))serial=randomBytes(16);
 const spki=createPublicKey(privateKey).export({type:'spki',format:'der'}) as Buffer;
 const signed=sequence(
  der(0xa0,derInt(Buffer.from([2]))),
  derInt(serial),
  signatureAlgorithm,
  name,
  sequence(derTime(now-60_000),derTime(expires.getTime())),
  name,
  spki,
  subjectAlternativeName
 );
 const signature=sign('sha256',signed,privateKey);
 // Tests corrupt the finished DER through this seam to prove the self-check below stops the start.
 const finished=(assembly.certificateDer??((bytes:Buffer)=>bytes))(sequence(signed,signatureAlgorithm,der(3,Buffer.concat([Buffer.from([0]),signature]))));
 const certificate=pem('CERTIFICATE',finished);
 // Node itself parses the certificate before anything is written or handed to the database, so an
 // encoder bug stops this start with its real cause instead of surfacing later as a core refusal.
 try{
  const parsed=new X509Certificate(certificate);
  if(!(parsed.publicKey.export({type:'spki',format:'der'}) as Buffer).equals(spki))throw new Error('the public key does not match the generated key');
 }catch(error){throw new Error('the certificate just made is not valid: '+(error as Error).message,{cause:error});}
 return {
  certificate,
  privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString()
 };
}

/** True only for the managed endpoint shape: https on the loopback address with an explicit port. */
export function isPinnedDatabaseEndpoint(endpoint:string):boolean{
 let target:URL;
 try{target=new URL(endpoint);}catch{return false;}
 return target.protocol==='https:'&&target.hostname==='127.0.0.1'&&/^\d+$/.test(target.port);
}

/** One pinned request function per certificate: node:https with that certificate as the only
 * trust anchor and an exact DER comparison of the peer certificate, so any other listener fails
 * before a request header or body is written. Not a general fetch: only what callers use. */
export function createPinnedDatabaseFetch(certificatePem:string):DatabaseRequestFn{
 const pinnedDer=new X509Certificate(certificatePem).raw;
 return (url,init={})=>new Promise((resolve,reject)=>{
  let target:URL;
  try{target=url instanceof URL?url:new URL(String(url));}catch(error){reject(error);return;}
  if(target.protocol!=='https:'||target.hostname!=='127.0.0.1'||!/^\d+$/.test(target.port)||target.username||target.password){
   reject(new Error('Pinned database requests must use https://127.0.0.1:<port>/'));return;
  }
  const request=https.request(target,{
   method:init.method??'GET',
   headers:Object.fromEntries(new Headers(init.headers)),
   ca:certificatePem,
   agent:false,
   signal:init.signal,
   checkServerIdentity:(host,certificate)=>tls.checkServerIdentity(host,certificate)||(!certificate.raw.equals(pinnedDer)?new Error('Pinned database certificate mismatch'):undefined)
  },response=>{
   let body='';
   response.setEncoding('utf8');
   // A peer that drops the connection after the headers must reject like the default fetch does;
   // destroying the request also releases the half-open socket the unsettled response leaves.
   const cutOff=()=>{request.destroy();reject(new Error('The database response ended prematurely'));};
   response.on('data',chunk=>{body+=chunk;});
   response.on('error',error=>{request.destroy();reject(error);});
   response.on('aborted',cutOff);
   response.on('close',()=>{if(!response.complete)cutOff();});
   response.on('end',()=>{
    resolve({
     ok:response.statusCode!==undefined&&response.statusCode>=200&&response.statusCode<300,
     status:response.statusCode??0,
     json:async()=>JSON.parse(body),
     text:async()=>body
    });
   });
  });
  request.on('error',reject);
  request.end(init.body);
 });
}
