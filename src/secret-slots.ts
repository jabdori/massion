import {isAbsolute,normalize} from 'node:path';
import {spawnCliRunner} from './cli-process.ts';
import type {CliRunner} from './cli-agent-providers.ts';
import {callTool} from './tool-call.ts';

export interface SecretSlot {owner:string;slot:string}
export interface SecretSlots {has?(slot:SecretSlot,signal?:AbortSignal):Promise<boolean>;read(slot:SecretSlot,signal?:AbortSignal):Promise<string|undefined>;set(slot:SecretSlot,value:string):Promise<void>;delete(slot:SecretSlot):Promise<void>}
const unavailable=()=>new Error('Secret slot unavailable');
export function checkSlot(ref:SecretSlot):void {
 if(!ref||Object.keys(ref).length!==2||typeof ref.owner!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(ref.owner)||typeof ref.slot!=='string'||!/^[a-z0-9][a-z0-9-]{0,47}$/.test(ref.slot))throw new Error('Invalid secret slot');
}
function checkValue(value:string):void {if(typeof value!=='string'||!value||!value.isWellFormed()||/[\u0000-\u001f\u007f]/.test(value)||Buffer.byteLength(value)>1024)throw new Error('Secret value is invalid or too large');}

/** Test adapter only; values are private and never serialize. */
export class InMemorySecretSlots implements SecretSlots {
 #values=new Map<string,string>();
 async has(slot:SecretSlot,signal?:AbortSignal){checkSlot(slot);if(signal?.aborted)throw unavailable();return this.#values.has(JSON.stringify([slot.owner,slot.slot]));}
 async read(slot:SecretSlot,signal?:AbortSignal){checkSlot(slot);if(signal?.aborted)throw unavailable();return this.#values.get(JSON.stringify([slot.owner,slot.slot]));}
 async set(slot:SecretSlot,value:string){checkSlot(slot);checkValue(value);this.#values.set(JSON.stringify([slot.owner,slot.slot]),value);}
 async delete(slot:SecretSlot){checkSlot(slot);this.#values.delete(JSON.stringify([slot.owner,slot.slot]));}
}

/** One remembered outcome per slot; a value stays only in the host process that read it. */
type HeldSecret={state:'value';value:string}|{state:'present'}|{state:'absent'};

/** The security interpreter reads one command from a pipe, never a shell or tty. */
export class KeychainSecretSlots implements SecretSlots {
 readonly #runner:CliRunner;readonly #platform:string;readonly #trustedHost:string;
 readonly #held=new Map<string,HeldSecret>();readonly #reads=new Map<string,Promise<string|undefined>>();readonly #epochs=new Map<string,number>();#stopped=false;
 constructor(runner:CliRunner=spawnCliRunner,platform:string=process.platform,trustedHost=''){
  if(typeof trustedHost!=='string'||trustedHost.length>1024||!trustedHost.isWellFormed()||/[\u0000-\u001f\u007f]/.test(trustedHost)||trustedHost&&(!isAbsolute(trustedHost)||normalize(trustedHost)!==trustedHost||trustedHost==='/usr/bin/security'||trustedHost===process.execPath))throw unavailable();
  this.#runner=runner;this.#platform=platform;this.#trustedHost=trustedHost;
 }
 async #run(slot:SecretSlot,operation:'read'|'set'|'delete'|'has',value?:string,signal?:AbortSignal):Promise<string|undefined>{
  checkSlot(slot);if(this.#platform!=='darwin')throw unavailable();
  const identity=['-s','massion:'+slot.owner,'-a',slot.slot];
  const args=operation==='set'?['-i']:[operation==='read'||operation==='has'?'find-generic-password':'delete-generic-password',...identity,...(operation==='read'?['-w']:[])];
  const stdin=operation==='set'?['add-generic-password','-U',...identity,'-T',JSON.stringify(this.#trustedHost),'-X',Buffer.from(value!).toString('hex')].join(' ')+'\n':'';
  if(Buffer.byteLength(stdin)>=4096)throw unavailable();
  try{
   const result=await callTool(s=>this.#runner({command:'/usr/bin/security',args,stdin,cwd:'/',env:{},signal:s,timeoutMs:5000,maxOutputBytes:4096}),{readOnly:operation==='read'||operation==='has',signal,timeoutMs:5000});
   if(!result.spawned||result.aborted||result.timedOut||result.overflow)throw unavailable();
   if(result.exitCode===44&&operation!=='set')return undefined;
   if(result.exitCode!==0)throw unavailable();
   if(operation==='has')return 'present';
   if(operation==='read'){const secret=result.stdout.replace(/\r?\n$/,'');checkValue(secret);return secret;}
  }catch{throw unavailable();}
 }
 // Writes bump the slot epoch so a read overlapping a write cannot remember a superseded value.
 #epoch(key:string){return this.#epochs.get(key)??0;}
 #bump(key:string){this.#epochs.set(key,this.#epoch(key)+1);}
 async has(slot:SecretSlot,signal?:AbortSignal){
  checkSlot(slot);const key=JSON.stringify([slot.owner,slot.slot]),held=this.#held.get(key);
  if(held)return held.state!=='absent';
  const epoch=this.#epoch(key),present=await this.#run(slot,'has',undefined,signal)!==undefined;
  if(!this.#stopped&&this.#epoch(key)===epoch)this.#held.set(key,present?{state:'present'}:{state:'absent'});
  return present;
 }
 async read(slot:SecretSlot,signal?:AbortSignal):Promise<string|undefined>{
  checkSlot(slot);const key=JSON.stringify([slot.owner,slot.slot]),held=this.#held.get(key);
  if(held?.state==='value')return held.value;
  if(held?.state==='absent')return undefined;
  const running=this.#reads.get(key);if(running)return running;
  const epoch=this.#epoch(key),flight=(async()=>{try{const value=await this.#run(slot,'read',undefined,signal);if(!this.#stopped&&this.#epoch(key)===epoch)this.#held.set(key,value===undefined?{state:'absent'}:{state:'value',value});return value;}finally{this.#reads.delete(key);}})();
  this.#reads.set(key,flight);return flight;
 }
 async set(slot:SecretSlot,value:string){
  checkSlot(slot);checkValue(value);const key=JSON.stringify([slot.owner,slot.slot]);
  this.#bump(key);this.#held.delete(key);
  await this.#run(slot,'set',value);
  this.#bump(key);if(!this.#stopped)this.#held.set(key,{state:'value',value});
 }
 async delete(slot:SecretSlot){
  checkSlot(slot);const key=JSON.stringify([slot.owner,slot.slot]);
  this.#bump(key);this.#held.delete(key);
  await this.#run(slot,'delete');
  this.#bump(key);if(!this.#stopped)this.#held.set(key,{state:'absent'});
 }
 /** Host drain forgets every held outcome; values are never written anywhere else. */
 beginDrain(){this.#stopped=true;this.#held.clear();}
 /** Count-only seam for tests: how many slot outcomes are held, never the values. */
 heldCount():number{return this.#held.size;}
}
