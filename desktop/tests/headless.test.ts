import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,lstat,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {join} from 'node:path';
import {DesktopLifecycle} from '../lifecycle.ts';
import {daemonCredential,prepareControl,drainDaemon} from '../daemon.ts';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {windowOptions,validSender,channels} from '../security.ts';

for(const [daemonAvailable,headless] of [[true,true],[true,false],[false,true],[false,false],['stale',true]] as const)test(daemonAvailable==='stale'?'restart removes an owned stale daemon socket before relaunch':'desktop window and notification visibility: headless='+headless+', daemonAvailable='+daemonAvailable,async t=>{
 const directory=daemonAvailable==='stale'?await mkdtemp(join(await realpath('/tmp'),'massion-stale-')):'/private/tmp/e9c-fixture',socket=join(directory,'daemon.sock');let relaunched=0,quit=0;
 if(daemonAvailable==='stale'){
  const child=spawn(process.execPath,['--input-type=module','-e',`import {createServer} from 'node:net';import {chmod} from 'node:fs/promises';createServer().listen(${JSON.stringify(socket)},async()=>{await chmod(${JSON.stringify(socket)},0o600);process.stdout.write('ready');});`],{stdio:['ignore','pipe','inherit']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(directory,{recursive:true,force:true});});
  await once(child.stdout!,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;assert.equal((await lstat(socket)).isSocket(),true);
 }
 let shown=0,focused=0,notified=0,settingsCalls=0;const handlers=new Map<string,(event:any,...args:any[])=>any>();
 class Window extends EventEmitter{
  webContents=Object.assign(new EventEmitter(),{mainFrame:{url:'massion://app/'},setWindowOpenHandler(){},send(){}});
  options:unknown;constructor(options:unknown){super();this.options=options;}
  isDestroyed(){return false;}isMinimized(){return false;}
  show(){shown++;}focus(){focused++;}async loadURL(){}
 }
 const app=Object.assign(new EventEmitter(),{requestSingleInstanceLock:()=>true,getPath:()=>directory,whenReady:async()=>{},relaunch(){relaunched++;},quit(){quit++;},commandLine:{hasSwitch:()=>headless}});
 const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},on(){},webRequest:{onBeforeRequest(){}},protocol:{handle:async()=>{}}};
 const source=stripTypeScriptTypes(await readFile(new URL('../main.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export async function','async function').replaceAll('import.meta.dirname',JSON.stringify('/private/tmp/e9c-fixture'));
 const context={appOrigin:"massion://app",app,BrowserWindow:Window,windowOptions,DesktopLifecycle:daemonAvailable==='stale'?DesktopLifecycle:{open:async()=>({notifications:true,read(){settingsCalls++;return {installedVersion:'1.0.0'};},saveNotifications(value:boolean){settingsCalls++;if(typeof value!=='boolean')throw Error('Invalid notification setting');},restart(){settingsCalls++;}})},ipcMain:Object.assign(new EventEmitter(),{handle(channel:string,handle:(event:any,...args:any[])=>any){handlers.set(channel,handle);}}),nativeTheme:{},Menu:{setApplicationMenu(){},buildFromTemplate(){}},session:{defaultSession:session},protocol:{registerSchemesAsPrivileged(){}},
  AppDocuments:class{clear(){}},ExceptionTracker:class{update(){return [{key:'fixture',title:'Fixture'}];}current(){return true;}clear(){}},
  Notification:class extends EventEmitter{static isSupported(){return true;}show(){notified++;}},
  daemonOrigin:()=> 'http://127.0.0.1:8765',prepareControl,drainDaemon,daemonCredential:async()=>{if(daemonAvailable==='stale')return daemonCredential(socket,'http://127.0.0.1:8765');if(!daemonAvailable)throw Object.assign(Error('Absent fixture daemon'),{code:'ENOENT'});return 'fixture';},daemonTransport:()=>{},
  createProtocolClient:()=>({connection:async()=>({state:'ready'}),query:async()=>({response:{ok:true},body:{works:[],decisions:[],members:[],feedId:'fixture'}}),reconnect(){}}),
  readFile:async(path:string)=>path.endsWith('package.json')?'{"version":"1.0.0"}':'<html></html>',mkdir:async()=>{},chmod:async()=>{},join:(...parts:string[])=>parts.join('/'),channels,validSender,contentPolicy:()=>'',
  process:{env:{}},setImmediate,setTimeout:()=>0,clearTimeout(){},console:{...console,error(){}}};
 const desktop=await runInNewContext(source+'\nstartDesktop()',context);
 desktop.window.emit('ready-to-show');await desktop.openWindow();
 app.emit('activate');app.emit('second-instance');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shown===0,headless);assert.equal(focused===0,headless);assert.equal(notified===0,headless);
 for(const handle of handlers.values()){assert.throws(()=>handle({sender:desktop.window.webContents,senderFrame:{url:'massion://app/'}}),/Refused/);assert.throws(()=>handle({sender:{},senderFrame:desktop.window.webContents.mainFrame}),/Refused/);}
 assert.equal(settingsCalls,0);const sender={sender:desktop.window.webContents,senderFrame:desktop.window.webContents.mainFrame};assert.equal(handlers.get(channels.settings)!(sender).installedVersion,'1.0.0');if(daemonAvailable==='stale'){
  await assert.rejects(handlers.get(channels.notifications)!(sender,'false'),/Invalid/);
  const result=await handlers.get(channels.restart)!(sender);assert.equal(result.restartStatus,'restarting');await assert.rejects(lstat(socket),{code:'ENOENT'});await new Promise(resolve=>setImmediate(resolve));assert.equal(relaunched,1);assert.equal(quit,1);
 }else assert.throws(()=>handlers.get(channels.notifications)!(sender,'false'),/Invalid/);
 assert.equal(desktop.window.options.show,false);
 assert.equal(desktop.window.options.webPreferences.sandbox,true);
});
