import {AppDocuments,appDocumentHeaders} from '../src/app-documents.ts';
import {app,BrowserWindow,ipcMain,nativeTheme,Notification,protocol,session,Menu} from 'electron';
import {readFile,mkdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createProtocolClient} from '../src/client-protocol.ts';
import {appOrigin,channels,windowOptions,isAppURL,allowWorkbenchRequest,validSender,contentPolicy,isAppDocumentURL} from './security.ts';
import {daemonOrigin,daemonTransport,proxyProtocol} from './transport.ts';
import {prepareControl,launchDaemon,drainDaemon,daemonFiles,daemonCredential} from './daemon.ts';
import {DesktopLifecycle} from './lifecycle.ts';
import {ExceptionTracker} from './notifications.ts';
import type {OwnerException} from './notifications.ts';

protocol.registerSchemesAsPrivileged([{scheme:'massion',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}},{scheme:'massion-app',privileges:{standard:true,secure:true}}]);

export async function startDesktop(){
 const headless=app.commandLine.hasSwitch('massion-headless');
 if(!app.requestSingleInstanceLock()){app.quit();return;}
 const origin=daemonOrigin(process.env.MASSION_DAEMON_ORIGIN??'http://127.0.0.1:8765');
 const directory=app.getPath('userData'),socket=join(directory,'daemon.sock');
 const credential=()=>daemonCredential(socket,origin);
 const client=createProtocolClient(daemonTransport(origin,credential)),tracker=new ExceptionTracker();
 let window:BrowserWindow|null=null,ready=false,pending:OwnerException|undefined,quitting=false,reading=false,daemonDrained=false;
 let timer:ReturnType<typeof setTimeout>|undefined,connecting:Promise<void>|undefined;
 const documents=new AppDocuments();
 const readDocument=(url:string)=>isAppDocumentURL(url)?documents.read(new URL(url).pathname):undefined;
 const notifications=new Map<string,Notification>();
 function deliver(){if(ready&&pending&&window&&!window.isDestroyed()){if(tracker.current(pending))window.webContents.send(channels.focus,pending);pending=undefined;}}
 async function openWindow(){
  if(window&&!window.isDestroyed()){if(!headless){if(window.isMinimized())window.restore();window.show();window.focus();}deliver();return window;}
  ready=false;
  const current=new BrowserWindow(windowOptions(join(import.meta.dirname,'preload.cjs')));window=current;
  current.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  current.webContents.on('will-navigate',(event,url)=>{if(!isAppURL(url))event.preventDefault();});
  current.webContents.on('will-frame-navigate',event=>{if(event.isMainFrame?!isAppURL(event.url):!(event.frame?.parent===current.webContents.mainFrame&&readDocument(event.url)!==undefined))event.preventDefault();});
  current.webContents.on('will-redirect',(event,url)=>{if(!isAppURL(url))event.preventDefault();});
  current.webContents.on('will-attach-webview',event=>event.preventDefault());
  current.on('closed',()=>{if(window===current){window=null;ready=false;}});
  if(!headless)current.once('ready-to-show',()=>current.show());
  await current.loadURL(appOrigin+'/');return current;
 }
 ipcMain.on(channels.ready,event=>{
  if(!window||!validSender(event,window.webContents)){console.warn('Refused desktop sender');return;}
  ready=true;deliver();
 });
 app.on('second-instance',()=>{void openWindow();});
 app.on('activate',()=>{void openWindow();});
 app.on('window-all-closed',()=>{});
 app.on('before-quit',event=>{
  if(quitting)return;event.preventDefault();quitting=true;clearTimeout(timer);documents.clear();
  for(const notice of notifications.values())notice.close();
  void (daemonDrained?Promise.resolve({status:'drained'}):drainDaemon(socket,origin)).then(result=>{if(result.status==='unsettled')console.error('Daemon drain unsettled; inspect original state');},error=>{if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))console.error('Daemon drain could not be confirmed');}).finally(()=>app.quit());
 });
 await app.whenReady();nativeTheme.themeSource='system';
 Menu.setApplicationMenu(Menu.buildFromTemplate([{label:'Massion',submenu:[{role:'about'},{type:'separator'},{role:'quit'}]},{role:'editMenu'},{role:'windowMenu'}]));
 await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const version=app.isPackaged?app.getVersion():JSON.parse(await readFile(join(import.meta.dirname,'../../package.json'),'utf8')).version;
 const lifecycle=await DesktopLifecycle.open(join(directory,'notifications.json'),version,async()=>{
  await connecting?.catch(()=>{});
  try{await credential();const result=await drainDaemon(socket,origin);if(result.status==='drained')daemonDrained=true;return result;}
  catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ECONNREFUSED')await prepareControl(socket);else if(code!=='ENOENT')throw error;daemonDrained=true;return {status:'drained'};}
 },()=>{setImmediate(()=>{app.relaunch();app.quit();});});
 for(const [channel,handle] of [[channels.settings,()=>lifecycle.read()],[channels.notifications,(value:boolean)=>lifecycle.saveNotifications(value)],[channels.restart,()=>lifecycle.restart()]] as const){
  ipcMain.handle(channel,(event,...args)=>{if(!window||!validSender(event,window.webContents))throw Error('Refused desktop sender');return handle(args[0]);});
 }

 const ses=session.defaultSession;
 ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
 ses.setPermissionCheckHandler(()=>false);ses.setDevicePermissionHandler(()=>false);
 ses.on('will-download',event=>event.preventDefault());
 ses.webRequest.onBeforeRequest((details,callback)=>{
  const document=details.resourceType==='subFrame'&&window&&!window.isDestroyed()&&details.webContentsId===window.webContents.id&&details.frame?.parent===window.webContents.mainFrame&&readDocument(details.url)!==undefined;
  const contents=window&&!window.isDestroyed()?window.webContents:undefined;
  callback({cancel:!allowWorkbenchRequest(details,contents)&&!document});
 });
 await ses.protocol.handle('massion-app',request=>{
  const html=request.method==='GET'?readDocument(request.url):undefined;
  return new Response(html??null,{status:html===undefined?404:200,headers:appDocumentHeaders});
 });
 const html=await readFile(join(import.meta.dirname,'index.html'),'utf8'),csp=contentPolicy(html);
 await ses.protocol.handle('massion',request=>{
  if(isAppURL(request.url)&&request.method==='GET')return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':csp,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  return proxyProtocol(request,origin,credential,html=>'massion-app://document'+documents.publish(html)).catch(()=>new Response(null,{status:503}));
 });
 async function connectDaemon(){
  try{await credential();return;}catch(error){if(!['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  if(!process.env.MASSION_SURREAL_RPC)throw new Error('Set MASSION_SURREAL_RPC before starting the desktop daemon');
  await prepareControl(socket);
  const node=process.env.MASSION_NODE_BINARY??'node';
  const {stdout}=await promisify(execFile)(node,['--version'],{timeout:3000});
  if(!/^v24\.(?:19|[2-9][0-9])\./.test(stdout.trim()))throw new Error('The daemon requires Node 24.19 or later in the Node 24 line');
  process.env.MASSION_PORT=new URL(origin).port;
  const {runner,entry}=daemonFiles(app.isPackaged,process.resourcesPath,import.meta.dirname);
  await launchDaemon({node,runner,entry,directory,socket,origin});
 }
 async function observe(){
  if(reading||quitting)return;reading=true;
  try{
   const info=await client.connection();if(info.state!=='ready'){client.reconnect();return;}
   const works=await client.query('/assistant/works',{scope:'notifications-works'}),view=await client.query('/assistant/conversation',{scope:'notifications-decisions'});
   if(!works.response.ok||!view.response.ok||!Array.isArray(works.body.works)||!Array.isArray(view.body.decisions))return;
   if(works.body.feedId!==view.body.feedId){tracker.clear();return;}
   const decisions=[...view.body.decisions];
   for(const member of view.body.members??[]){
    if(typeof member.id!=='string'||!/^[a-zA-Z0-9:_-]{1,128}$/.test(member.id))continue;
    const read=await client.query('/assistant/conversation?member='+encodeURIComponent(member.id),{scope:'notifications-member'});
    if(!read.response.ok||read.body.feedId!==view.body.feedId){tracker.clear();return;}
    for(const decision of read.body.decisions??[])decisions.push({...decision,memberId:member.id});
   }
   const fresh=tracker.update(view.body.feedId,works.body.works,decisions);
   for(const [key,notice] of notifications)if(!tracker.current({key} as OwnerException)){notice.close();notifications.delete(key);}
   if(headless||!lifecycle.notifications||!Notification.isSupported()||quitting)return;
   for(const item of fresh){
    const notice=new Notification({title:'Massion',body:item.title,silent:false});notifications.set(item.key,notice);
    notice.on('click',()=>{if(!tracker.current(item))return;pending=item;void openWindow();});
    notice.on('close',()=>notifications.delete(item.key));notice.show();
   }
  }catch{client.reconnect();}finally{reading=false;if(!quitting)timer=setTimeout(()=>void observe(),10000);}
 }
 connecting=connectDaemon().catch(()=>console.error('Desktop daemon unavailable; check local Node and daemon configuration'));
 await openWindow();
 void connecting.finally(()=>{client.reconnect();void observe();});
 return {get window(){return window;},openWindow};
}
