import {readFile,writeFile,rename,rm} from 'node:fs/promises';

export interface DesktopSettings {installedVersion:string;notifications:boolean;showMenuBarItem?:boolean;restartRequired:boolean;restartStatus:'idle'|'restarting'|'unknown';update:'unknown'}
export class DesktopLifecycle {
 readonly notifications:boolean;
 #file:string;#version:string;#desired:boolean;#menuBarItem:boolean|undefined;#drain:()=>Promise<{status:string}>;#relaunch:()=>void;
 #saving=Promise.resolve();#restart:Promise<DesktopSettings>|undefined;#status:DesktopSettings['restartStatus']='idle';
 private constructor(file:string,version:string,notifications:boolean,showMenuBarItem:boolean|undefined,drain:()=>Promise<{status:string}>,relaunch:()=>void){this.#file=file;this.#version=version;this.notifications=notifications;this.#desired=notifications;this.#menuBarItem=showMenuBarItem;this.#drain=drain;this.#relaunch=relaunch;}
 static async open(file:string,version:string,drain:()=>Promise<{status:string}>,relaunch:()=>void){
  let notifications=true,showMenuBarItem:boolean|undefined;
  try{
   const value=JSON.parse(await readFile(file,'utf8'));
   if(!value||typeof value.notifications!=='boolean'||Object.keys(value).some(key=>key!=='notifications'&&key!=='showMenuBarItem')||Object.hasOwn(value,'showMenuBarItem')&&typeof value.showMenuBarItem!=='boolean')throw Error('Invalid notification settings');
   ({notifications,showMenuBarItem}=value);
  }
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return new DesktopLifecycle(file,version,notifications,showMenuBarItem,drain,relaunch);
 }
 get showMenuBarItem():boolean{return this.#menuBarItem??true;}
 read():DesktopSettings{return {installedVersion:this.#version,notifications:this.#desired,restartRequired:this.#desired!==this.notifications,restartStatus:this.#status,update:'unknown'};}
 async saveNotifications(value:boolean){
  if(typeof value!=='boolean')throw Error('Invalid notification setting');
  await this.#save({notifications:value});return this.read();
 }
 async saveMenuBarItem(value:boolean){
  if(typeof value!=='boolean')throw Error('Invalid menu bar setting');
  await this.#save({showMenuBarItem:value});return {...this.read(),showMenuBarItem:this.showMenuBarItem};
 }
 async #save(change:{notifications?:boolean;showMenuBarItem?:boolean}){
  if(this.#restart)throw Error('Restart already requested');
  const save=this.#saving.then(async()=>{
   const temporary=this.#file+'.tmp';
   const settings={notifications:change.notifications??this.#desired,showMenuBarItem:change.showMenuBarItem??this.#menuBarItem};
   try{
    await writeFile(temporary,JSON.stringify(settings)+'\n',{mode:0o600});
    await rename(temporary,this.#file);
    this.#desired=settings.notifications;this.#menuBarItem=settings.showMenuBarItem;
   }finally{await rm(temporary,{force:true});}
  });
  this.#saving=save.catch(()=>{});await save;
 }
 restart(){
  if(this.#restart)return this.#restart;
  this.#status='restarting';
  const attempt=(async()=>{
   let refused=false;
   try{await this.#saving;const result=await this.#drain();if(result.status!=='drained')throw Error('Unconfirmed daemon drain');this.#relaunch();}
   catch(error){this.#status='unknown';refused=(error as NodeJS.ErrnoException|null|undefined)?.code==='restart-refused';}
   const settings=this.read();
   // A stop refused before any signal was sent (stopCoreForRestart in daemon-runner.mjs) left nothing
   // half-stopped: this request reports the refusal, later requests are not answered with it.
   if(refused){this.#restart=undefined;this.#status='idle';}
   return settings;
  })();
  this.#restart=attempt;
  return attempt;
 }
}
