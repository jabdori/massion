import {createPublicKey,generateKeyPairSync,randomBytes,sign,X509Certificate} from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';

/** One start's database certificate: PEM strings held in supervisor memory only. */
export interface StartCertificate{certificate:string;privateKey:string}

/** The call shape the database transport and the supervisor's own startup requests use. */
export interface DatabaseRequestInit{method?:string;headers?:HeadersInit;body?:string;redirect?:'error';signal?:AbortSignal}
export interface DatabaseResponse{ok:boolean;status:number;json():Promise<unknown>;text():Promise<string>}
export type DatabaseRequestFn=(url:string|URL,init?:DatabaseRequestInit)=>Promise<DatabaseResponse>;

const derLength=(length:number)=>length<128?Buffer.from([length]):length<256?Buffer.from([0x81,length]):Buffer.from([0x82,length>>8,length&255]);
const der=(tag:number,content:Buffer)=>Buffer.concat([Buffer.from([tag]),derLength(content.length),content]);
const sequence=(...parts:Buffer[])=>der(48,Buffer.concat(parts));
const objectIdentifier=(...path:number[])=>{
 const bytes=[path[0]!*40+path[1]!];
 for(const value of path.slice(2)){
  let encoded=[value&127],rest=value>>7;
  while(rest>0){encoded.unshift(128|(rest&127));rest>>=7;}
  bytes.push(...encoded);
 }
 return der(6,Buffer.from(bytes));
};
const integer=(value:Buffer)=>der(2,value[0]!&128?Buffer.concat([Buffer.from([0]),value]):value);
const utcTime=(value:number)=>der(23,Buffer.from(new Date(value).toISOString().replace(/[-:T]/g,'').slice(2,14)+'Z'));
const pem=(label:string,derBytes:Buffer)=>['-----BEGIN '+label+'-----',...derBytes.toString('base64').match(/.{1,64}/g)!,'-----END '+label+'-----',''].join('\n');

/** A fresh key pair and self-signed certificate for one database start: EC P-256, subject
 * alternative name IP 127.0.0.1, valid from one minute before now for ten years, because a
 * managed database may run for months. Nothing is kept between starts. */
export function generateStartCertificate(now:number=Date.now()):StartCertificate{
 const {privateKey}=generateKeyPairSync('ec',{namedCurve:'P-256'});
 const signatureAlgorithm=sequence(objectIdentifier(1,2,840,10045,4,3,2));
 const name=sequence(der(49,sequence(objectIdentifier(2,5,4,3),der(12,Buffer.from('massion-managed-database')))));
 const expires=new Date(now);expires.setUTCFullYear(expires.getUTCFullYear()+10);
 const subjectAlternativeName=der(0xa3,sequence(sequence(objectIdentifier(2,5,29,17),der(4,sequence(der(0x87,Buffer.from([127,0,0,1])))))));
 const signed=sequence(
  der(0xa0,integer(Buffer.from([2]))),
  integer(randomBytes(16)),
  signatureAlgorithm,
  name,
  sequence(utcTime(now-60_000),utcTime(expires.getTime())),
  name,
  createPublicKey(privateKey).export({type:'spki',format:'der'}) as Buffer,
  subjectAlternativeName
 );
 const signature=sign('sha256',signed,privateKey);
 return {
  certificate:pem('CERTIFICATE',sequence(signed,signatureAlgorithm,der(3,Buffer.concat([Buffer.from([0]),signature])))),
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
   response.on('data',chunk=>{body+=chunk;});
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
