import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync,realpathSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

const digestLength=12;
const socketDirectory=(home:string)=>join(home,'.massion','run');

export function socketPathLength(home:string){
 const bytes=Buffer.byteLength(join(socketDirectory(home),'0'.repeat(digestLength)+'.sock'),'utf8');
 // Leave one byte in sun_path for the terminating NUL.
 const limit=process.platform==='darwin'?104:108;
 if(bytes>=limit)return {kind:'refused',reason:'socket-path-too-long',bytes} as const;
 return {kind:'ready'} as const;
}

export function socketPath(dataDirectory:string,home:string){
 const length=socketPathLength(home);
 if(length.kind==='refused')return length;
 try{
  // OS realpath resolves existing aliases, but does not guarantee unification of case or Unicode normalization.
  const canonical=realpathSync.native(dataDirectory);
  const name=createHash('sha256').update(canonical,'utf8').digest('hex').slice(0,digestLength);
  return {kind:'socket',path:join(socketDirectory(home),name+'.sock'),dataDirectory:canonical} as const;
 }catch(error){
  return socketRefusal('socket-data-directory-unavailable',error);
 }
}

export function checkSocketDirectory(stat:Pick<Stats,'isDirectory'|'uid'|'mode'>,uid:number){
 if(!stat.isDirectory())return {kind:'refused',reason:'socket-directory-not-directory'} as const;
 if(stat.uid!==uid)return {kind:'refused',reason:'socket-directory-owner'} as const;
 if((stat.mode&0o7777)!==0o700)return {kind:'refused',reason:'socket-directory-mode'} as const;
 return {kind:'ready'} as const;
}

function privateDirectory(path:string){
 const existing=lstatSync(path,{throwIfNoEntry:false});
 if(existing)return existing;
 try{mkdirSync(path,{mode:0o700});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 return lstatSync(path);
}

export function ensureSocketDirectory(home:string){
 const uid=process.getuid?.();
 if(uid===undefined)return {kind:'refused',reason:'socket-directory-unavailable'} as const;
 try{
  const ancestors=[resolve(home)];
  while(ancestors[0]!==dirname(ancestors[0]!))ancestors.unshift(dirname(ancestors[0]!));
  for(const path of ancestors){
   const parent=lstatSync(path);
   if(!parent.isDirectory()||(parent.uid!==uid&&parent.uid!==0)||((parent.mode&0o022)!==0&&(parent.mode&0o1000)===0)){
    return {kind:'refused',reason:'socket-directory-parent-unsafe'} as const;
   }
  }
  const path=join(home,'.massion'),parent=privateDirectory(path);
  if(!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o022)!==0){
   return {kind:'refused',reason:'socket-directory-parent-unsafe'} as const;
  }
  return checkSocketDirectory(privateDirectory(join(path,'run')),uid);
 }catch{
  return {kind:'refused',reason:'socket-directory-unavailable'} as const;
 }
}

type SocketStartReason=
 | Extract<ReturnType<typeof socketPath>|ReturnType<typeof ensureSocketDirectory>,{kind:'refused'}>['reason']
 | 'socket-home-unavailable'|'legacy-supervisor-running'|'legacy-socket-check-failed'|'socket-bind-failed';

export function socketRefusal<Reason extends string>(reason:Reason,error?:unknown){
 const systemError=error as NodeJS.ErrnoException|undefined;
 return {kind:'refused',reason,code:systemError?.code,errno:systemError?.errno} as const;
}

type SocketRefusal={kind:'refused';reason:SocketStartReason;bytes?:number;code?:string;errno?:number};

export class SocketStartError extends Error{
 readonly refusal:SocketRefusal;
 constructor(refusal:SocketRefusal,message?:string){
  super(message??(refusal.bytes===undefined?refusal.reason:refusal.reason+' ('+refusal.bytes+' bytes)'));
  this.refusal=refusal;
 }
}
