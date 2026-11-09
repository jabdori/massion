import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {readFileSync,closeSync} from 'node:fs';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {Socket} from 'node:net';

export const validAuthValue=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function authProof(secret:string,role:'server'|'client',origin:string,challenge:string,nonce:string){
 return createHmac('sha256',Buffer.from(secret,'hex')).update(JSON.stringify(['massion-desktop-v1',role,origin,challenge,nonce])).digest('hex');
}
export function equalAuth(provided:unknown,expected:string){
 return validAuthValue(provided)&&timingSafeEqual(Buffer.from(provided,'hex'),Buffer.from(expected,'hex'));
}
export function inheritedDaemonSecret(){
 const fd=process.env.MASSION_DESKTOP_AUTH_FD;if(fd===undefined)return undefined;delete process.env.MASSION_DESKTOP_AUTH_FD;
 if(fd!=='3')throw new Error('Invalid daemon authentication descriptor');
 let secret:string;try{secret=readFileSync(3,'utf8');}finally{closeSync(3);}
 if(!validAuthValue(secret))throw new Error('Invalid daemon authentication key');return secret;
}
export function daemonGuard(secret:string){
 if(!validAuthValue(secret))throw new Error('Invalid daemon authentication key');
 const sessions=new WeakMap<Socket,string>();
 return (req:IncomingMessage,res:ServerResponse)=>{
  const origin='http://127.0.0.1:'+req.socket.localPort,challenge=req.headers['x-massion-challenge'];
  if(req.method==='GET'&&req.url==='/desktop-auth'&&validAuthValue(challenge)){
   const nonce=randomBytes(32).toString('hex');sessions.set(req.socket,authProof(secret,'client',origin,challenge,nonce));
   res.writeHead(204,{'X-Massion-Nonce':nonce,'X-Massion-Proof':authProof(secret,'server',origin,challenge,nonce),'Cache-Control':'no-store'});res.end();return false;
  }
  const expected=sessions.get(req.socket),authorization=req.headers.authorization;
  if(expected&&typeof authorization==='string'&&authorization.startsWith('Bearer ')&&equalAuth(authorization.slice(7),expected))return true;
  res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store','Connection':'close'});res.end('{"error":"Daemon authentication required"}');return false;
 };
}
