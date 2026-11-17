import {createHash} from 'node:crypto';
import {lstatSync,mkdirSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export function socketPath(dataDirectory:string,home:string){
 const name=createHash('sha256').update(dataDirectory.replace(/\/+$/,'')||'/','utf8').digest('hex').slice(0,12);
 const path=join(home,'.massion','run',name+'.sock');
 const bytes=Buffer.byteLength(path,'utf8');
 // Leave one byte in sun_path for the terminating NUL.
 const limit=process.platform==='darwin'?104:108;
 if(bytes>=limit)return {kind:'refused',reason:'socket-path-too-long',bytes} as const;
 return {kind:'socket',path} as const;
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
 | 'legacy-supervisor-running'|'legacy-socket-check-failed'|'socket-bind-failed';

export class SocketStartError extends Error{
 constructor(reason:SocketStartReason,bytes?:number){
  super(bytes===undefined?reason:reason+' ('+bytes+' bytes)');
 }
}
