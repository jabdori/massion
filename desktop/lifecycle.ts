import {readFile,writeFile,rename,rm} from 'node:fs/promises';

export interface DesktopSettings {installedVersion:string;notifications:boolean;restartRequired:boolean;restartStatus:'idle'|'restarting'|'unknown';update:'unknown'}
export class DesktopLifecycle {
 readonly notifications:boolean;
 #file:string;#version:string;#desired:boolean;#drain:()=>Promise<{status:string}>;#relaunch:()=>void;
 #saving=Promise.resolve();#restart:Promise<DesktopSettings>|undefined;#status:DesktopSettings['restartStatus']='idle';
 private constructor(file:string,version:string,notifications:boolean,drain:()=>Promise<{status:string}>,relaunch:()=>void){this.#file=file;this.#version=version;this.notifications=notifications;this.#desired=notifications;this.#drain=drain;this.#relaunch=relaunch;}
 static async open(file:string,version:string,drain:()=>Promise<{status:string}>,relaunch:()=>void){
  let notifications=true;
  try{const value=JSON.parse(await readFile(file,'utf8'));if(!value||Object.keys(value).length!==1||typeof value.notifications!=='boolean')throw Error('Invalid notification settings');notifications=value.notifications;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return new DesktopLifecycle(file,version,notifications,drain,relaunch);
 }
 read():DesktopSettings{return {installedVersion:this.#version,notifications:this.#desired,restartRequired:this.#desired!==this.notifications,restartStatus:this.#status,update:'unknown'};}
 async saveNotifications(value:boolean){
  if(typeof value!=='boolean')throw Error('Invalid notification setting');
  if(this.#restart)throw Error('Restart already requested');
  const save=this.#saving.then(async()=>{const temporary=this.#file+'.tmp';try{await writeFile(temporary,JSON.stringify({notifications:value})+'\n',{mode:0o600});await rename(temporary,this.#file);this.#desired=value;}finally{await rm(temporary,{force:true});}});
  this.#saving=save.catch(()=>{});await save;return this.read();
 }
 restart(){
  if(this.#restart)return this.#restart;
  this.#status='restarting';
  this.#restart=(async()=>{try{await this.#saving;const result=await this.#drain();if(result.status!=='drained')throw Error('Unconfirmed daemon drain');this.#relaunch();}catch{this.#status='unknown';}return this.read();})();
  return this.#restart;
 }
}
