import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {windowOptions} from '../security.ts';

for(const headless of [true,false])test('desktop window and notification visibility: headless='+headless,async()=>{
 let shown=0,focused=0,notified=0;
 class Window extends EventEmitter{
  webContents=Object.assign(new EventEmitter(),{setWindowOpenHandler(){},send(){}});
  options:unknown;constructor(options:unknown){super();this.options=options;}
  isDestroyed(){return false;}isMinimized(){return false;}
  show(){shown++;}focus(){focused++;}async loadURL(){}
 }
 const app=Object.assign(new EventEmitter(),{requestSingleInstanceLock:()=>true,getPath:()=>'/private/tmp/e9c-fixture',whenReady:async()=>{},quit(){},commandLine:{hasSwitch:()=>headless}});
 const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},on(){},webRequest:{onBeforeRequest(){}},protocol:{handle:async()=>{}}};
 const source=stripTypeScriptTypes(await readFile(new URL('../main.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export async function','async function').replaceAll('import.meta.dirname',JSON.stringify('/private/tmp/e9c-fixture'));
 const context={appOrigin:"massion://app",app,BrowserWindow:Window,windowOptions,ipcMain:new EventEmitter(),nativeTheme:{},Menu:{setApplicationMenu(){},buildFromTemplate(){}},session:{defaultSession:session},protocol:{registerSchemesAsPrivileged(){}},
  AppDocuments:class{clear(){}},ExceptionTracker:class{update(){return [{key:'fixture',title:'Fixture'}];}current(){return true;}clear(){}},
  Notification:class extends EventEmitter{static isSupported(){return true;}show(){notified++;}},
  daemonOrigin:()=> 'http://127.0.0.1:8765',daemonCredential:async()=> 'fixture',daemonTransport:()=>{},
  createProtocolClient:()=>({connection:async()=>({state:'ready'}),query:async()=>({response:{ok:true},body:{works:[],decisions:[],members:[],feedId:'fixture'}}),reconnect(){}}),
  readFile:async()=>'<html></html>',mkdir:async()=>{},chmod:async()=>{},join:(...parts:string[])=>parts.join('/'),channels:{ready:'ready'},contentPolicy:()=>'',
  process:{env:{}},setTimeout:()=>0,clearTimeout(){},console};
 const desktop=await runInNewContext(source+'\nstartDesktop()',context);
 desktop.window.emit('ready-to-show');await desktop.openWindow();
 app.emit('activate');app.emit('second-instance');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(shown===0,headless);assert.equal(focused===0,headless);assert.equal(notified===0,headless);
 assert.equal(desktop.window.options.show,false);
 assert.equal(desktop.window.options.webPreferences.sandbox,true);
});
