import {isAbsolute,normalize} from 'node:path';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner} from './cli-agent-providers.ts';
import {callTool} from './tool-call.ts';

export interface SecretSlot {owner:string;slot:string}
export interface SecretSlots {read(slot:SecretSlot,signal?:AbortSignal):Promise<string|undefined>;set(slot:SecretSlot,value:string):Promise<void>;delete(slot:SecretSlot):Promise<void>}
const unavailable=()=>new Error('Secret slot unavailable');
export function checkSlot(ref:SecretSlot):void {
 if(!ref||Object.keys(ref).length!==2||typeof ref.owner!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(ref.owner)||typeof ref.slot!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(ref.slot))throw new Error('Invalid secret slot');
}
function checkValue(value:string):void {if(typeof value!=='string'||!value||!value.isWellFormed()||/[\u0000-\u001f\u007f]/.test(value)||Buffer.byteLength(value)>1024)throw new Error('Secret value is invalid or too large');}

/** Test adapter only; values are private and never serialize. */
export class InMemorySecretSlots implements SecretSlots {
 #values=new Map<string,string>();
 async read(slot:SecretSlot,signal?:AbortSignal){checkSlot(slot);if(signal?.aborted)throw unavailable();return this.#values.get(JSON.stringify([slot.owner,slot.slot]));}
 async set(slot:SecretSlot,value:string){checkSlot(slot);checkValue(value);this.#values.set(JSON.stringify([slot.owner,slot.slot]),value);}
 async delete(slot:SecretSlot){checkSlot(slot);this.#values.delete(JSON.stringify([slot.owner,slot.slot]));}
}

/** The security interpreter reads one command from a pipe, never a shell or tty. */
export class KeychainSecretSlots implements SecretSlots {
 readonly #runner:CliRunner;readonly #platform:string;readonly #trustedHost:string;
 constructor(runner:CliRunner=spawnCliRunner,platform:string=process.platform,trustedHost=''){
  if(typeof trustedHost!=='string'||trustedHost.length>1024||!trustedHost.isWellFormed()||/[\u0000-\u001f\u007f]/.test(trustedHost)||trustedHost&&(!isAbsolute(trustedHost)||normalize(trustedHost)!==trustedHost||trustedHost==='/usr/bin/security'||trustedHost===process.execPath))throw unavailable();
  this.#runner=runner;this.#platform=platform;this.#trustedHost=trustedHost;
 }
 async #run(slot:SecretSlot,operation:'read'|'set'|'delete',value?:string,signal?:AbortSignal):Promise<string|undefined>{
  checkSlot(slot);if(this.#platform!=='darwin')throw unavailable();
  const identity=['-s','massion:'+slot.owner,'-a',slot.slot];
  const args=operation==='set'?['-i']:[operation==='read'?'find-generic-password':'delete-generic-password',...identity,...(operation==='read'?['-w']:[])];
  const stdin=operation==='set'?['add-generic-password','-U',...identity,'-T',JSON.stringify(this.#trustedHost),'-X',Buffer.from(value!).toString('hex')].join(' ')+'\n':'';
  if(Buffer.byteLength(stdin)>=4096)throw unavailable();
  try{
   const result=await callTool(s=>this.#runner({command:'/usr/bin/security',args,stdin,cwd:'/',env:{},signal:s,timeoutMs:5000,maxOutputBytes:4096}),{readOnly:operation==='read',signal,timeoutMs:5000});
   if(!result.spawned||result.aborted||result.timedOut||result.overflow)throw unavailable();
   if(result.exitCode===44&&operation!=='set')return undefined;
   if(result.exitCode!==0)throw unavailable();
   if(operation==='read'){const secret=result.stdout.replace(/\r?\n$/,'');checkValue(secret);return secret;}
  }catch{throw unavailable();}
 }
 async read(slot:SecretSlot,signal?:AbortSignal){return this.#run(slot,'read',undefined,signal);}
 async set(slot:SecretSlot,value:string){checkValue(value);await this.#run(slot,'set',value);}
 async delete(slot:SecretSlot){await this.#run(slot,'delete');}
}
