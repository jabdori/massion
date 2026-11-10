import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,normalize} from 'node:path';
import {hash} from './domain.ts';
import {spawnCliRunner} from './cli-process.ts';
import {callTool,ToolCallError} from './tool-call.ts';

export type SecretSource={kind:'own'}|{kind:'external-ref'|'import';vendor:'onepassword';reference:string};
export type SecretSourceCode='needs-owner-unlock'|'cli-missing'|'reference-not-found'|'permission-denied'|'timeout'|'cancelled'|'grant-required'|'import-unavailable'|'unavailable';
export class SecretSourceError extends Error {
 readonly code:SecretSourceCode;
 constructor(code:SecretSourceCode){super('Secret source: '+code);this.name='SecretSourceError';this.code=code;}
}
export interface ExternalVault {read(reference:string,signal?:AbortSignal):Promise<string>}
export interface OnePasswordConfig {binary:string;account:string;configDirectory:string;sessionEnvironment:string}
const line=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=max&&v.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export function validateSecretValue(value:unknown):asserts value is string {if(!line(value,1024)||Buffer.byteLength(value)>1024)throw new SecretSourceError('unavailable');}
export function validateSecretSource(value:unknown):SecretSource {
 if(value===undefined)return {kind:'own'};
 if(exact(value,['kind'])&&value.kind==='own')return {kind:'own'};
 if(!exact(value,['kind','vendor','reference'])||!['external-ref','import'].includes(String(value.kind))||value.vendor!=='onepassword'||!line(value.reference,2048)||!/^op:\/\/[^/]+\/[^/]+\/.+/.test(value.reference))throw new SecretSourceError('unavailable');
 return structuredClone(value) as SecretSource;
}
export const sourceHash=(source:unknown)=>hash(validateSecretSource(source));
export function validateOnePasswordConfig(value:unknown):OnePasswordConfig {
 if(!exact(value,['binary','account','configDirectory','sessionEnvironment'])||![value.binary,value.configDirectory].every(v=>line(v,2048)&&isAbsolute(v)&&normalize(v)===v)||!line(value.account,256)||!line(value.sessionEnvironment,128)||! /^[A-Z_][A-Z0-9_]*$/.test(value.sessionEnvironment))throw new SecretSourceError('unavailable');
 return structuredClone(value) as unknown as OnePasswordConfig;
}
function classify(stderr:string):SecretSourceCode {
 if(/(?:vault is locked|session expired|not signed in|not currently signed in|sign in to your account|could not find a session)/i.test(stderr))return 'needs-owner-unlock';
 if(/(?:permission denied|access denied|not authorized|not allowed to access)/i.test(stderr))return 'permission-denied';
 if(/(?:(?:item|vault|field|reference) (?:was )?not found|could not find (?:item|vault|field))/i.test(stderr))return 'reference-not-found';
 return 'unavailable';
}
/** Host-owned configuration only; no inherited environment, shell, sign-in or desktop unlock. */
export class OnePasswordVault implements ExternalVault {
 readonly #config:OnePasswordConfig;readonly #session:(name:string)=>string|undefined;readonly #timeout:number;
 constructor(config:OnePasswordConfig,session:(name:string)=>string|undefined,options:{timeoutMs?:number}={}){
  this.#config=validateOnePasswordConfig(config);this.#session=session;this.#timeout=options.timeoutMs??5000;
  if(!Number.isSafeInteger(this.#timeout)||this.#timeout<1||this.#timeout>5000)throw new SecretSourceError('unavailable');
 }
 async read(reference:string,signal?:AbortSignal):Promise<string>{
  validateSecretSource({kind:'external-ref',vendor:'onepassword',reference});if(signal?.aborted)throw new SecretSourceError('cancelled');
  try{return await callTool(async bounded=>{
   let binary:string;
   try{binary=await realpath(this.#config.binary);const stat=await lstat(binary);if(!stat.isFile()||!(stat.mode&0o111))throw new Error();}catch{throw new SecretSourceError('cli-missing');}
   const session=this.#session(this.#config.sessionEnvironment);if(!line(session,8192))throw new SecretSourceError('needs-owner-unlock');
   bounded.throwIfAborted();const result=await spawnCliRunner({command:binary,args:['read','--no-newline','--cache=false','--no-color','--account',this.#config.account,'--config',this.#config.configDirectory,'--',reference],stdin:'',cwd:'/',env:{OP_SESSION:session,OP_BIOMETRIC_UNLOCK_ENABLED:'false'},signal:bounded,timeoutMs:this.#timeout,maxOutputBytes:1024});
   if(result.timedOut)throw new SecretSourceError('timeout');if(result.aborted)throw new SecretSourceError('cancelled');if(!result.spawned)throw new SecretSourceError('cli-missing');if(result.overflow)throw new SecretSourceError('unavailable');
   if(result.exitCode!==0)throw new SecretSourceError(classify(result.stderr));validateSecretValue(result.stdout);return result.stdout;
  },{readOnly:true,signal,timeoutMs:this.#timeout});}catch(error){if(error instanceof SecretSourceError)throw error;if(error instanceof ToolCallError)throw new SecretSourceError(error.timedOut?'timeout':'cancelled');throw new SecretSourceError('unavailable');}
 }
}
