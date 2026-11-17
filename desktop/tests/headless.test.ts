import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,lstat,mkdir,chmod,rmdir,symlink,writeFile} from 'node:fs/promises';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {dirname,join} from 'node:path';
import {DesktopLifecycle} from '../lifecycle.ts';
import {daemonCredential,prepareControl,drainDaemon,refuseLegacySupervisor,probeSocketBind} from '../daemon.ts';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:net';
import {socketPath,socketPathLength,ensureSocketDirectory,socketRefusal,SocketStartError} from '../socket-path.ts';
import {tempRoot} from '../../tests/support/temp-root.ts';
import {windowOptions,validSender,channels} from '../security.ts';

const source=stripTypeScriptTypes(await readFile(new URL('../main.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace('export async function','async function').replaceAll('import.meta.dirname',JSON.stringify('/private/tmp/e9c-fixture'));

async function startFixture(directory:string,home:string,headless:boolean,daemonAvailable:boolean|'stale',overrides:Record<string,unknown>={}){
 let relaunched=0,quit=0,lockRequests=0,exitCode:number|undefined;
 let shown=0,focused=0,notified=0,settingsCalls=0;const handlers=new Map<string,(event:any,...args:any[])=>any>();
 class Window extends EventEmitter{
  webContents=Object.assign(new EventEmitter(),{mainFrame:{url:'massion://app/'},setWindowOpenHandler(){},send(){}});
  options:unknown;constructor(options:unknown){super();this.options=options;}
  isDestroyed(){return false;}isMinimized(){return false;}
  show(){shown++;}focus(){focused++;}async loadURL(){}
 }
 const app=Object.assign(new EventEmitter(),{requestSingleInstanceLock(){lockRequests++;return true;},exit(code:number){exitCode=code;},getPath:()=>directory,whenReady:async()=>{},relaunch(){relaunched++;},quit(){quit++;},commandLine:{hasSwitch:()=>headless}});
 const session={setPermissionRequestHandler(){},setPermissionCheckHandler(){},setDevicePermissionHandler(){},on(){},webRequest:{onBeforeRequest(){}},protocol:{handle:async()=>{}}};
 const connection=Promise.withResolvers<void>();
 const context={appOrigin:"massion://app",app,BrowserWindow:Window,windowOptions,DesktopLifecycle:daemonAvailable==='stale'?DesktopLifecycle:{open:async()=>({notifications:true,read(){settingsCalls++;return {installedVersion:'1.0.0'};},saveNotifications(value:boolean){settingsCalls++;if(typeof value!=='boolean')throw Error('Invalid notification setting');},restart(){settingsCalls++;}})},ipcMain:Object.assign(new EventEmitter(),{handle(channel:string,handle:(event:any,...args:any[])=>any){handlers.set(channel,handle);}}),nativeTheme:{},Menu:{setApplicationMenu(){},buildFromTemplate(){}},session:{defaultSession:session},protocol:{registerSchemesAsPrivileged(){}},
  AppDocuments:class{clear(){}},ExceptionTracker:class{update(){return [{key:'fixture',title:'Fixture'}];}current(){return true;}clear(){}},
  Notification:class extends EventEmitter{static isSupported(){return true;}show(){notified++;}},
  daemonOrigin:()=> 'http://127.0.0.1:8765',prepareControl,drainDaemon,refuseLegacySupervisor,probeSocketBind,
  socketPath,socketPathLength,ensureSocketDirectory,socketRefusal,SocketStartError,userInfo:()=>({homedir:home}),daemonCredential:async(socket:string)=>{if(daemonAvailable==='stale')return daemonCredential(socket,'http://127.0.0.1:8765');if(!daemonAvailable)throw Object.assign(Error('Absent fixture daemon'),{code:'ENOENT'});return 'fixture';},daemonTransport:()=>{},
  createProtocolClient:()=>({connection:async()=>({state:'ready'}),query:async()=>({response:{ok:true},body:{works:[],decisions:[],members:[],feedId:'fixture'}}),reconnect(){connection.resolve();}}),
  readFile:async(path:string)=>path.endsWith('package.json')?'{"version":"1.0.0"}':'<html></html>',mkdir:async()=>{},chmod:async()=>{},join:(...parts:string[])=>parts.join('/'),channels,validSender,contentPolicy:()=>'',
  URL,execFile,promisify,process:{env:{}},setImmediate,setTimeout:()=>0,clearTimeout(){},console:{...console,error(){}}};
 const desktop=await runInNewContext(source+'\nstartDesktop()',Object.assign(context,overrides));
 return {app,desktop,handlers,connected:connection.promise,lockRequests,exitCode,get shown(){return shown;},get focused(){return focused;},get notified(){return notified;},get settingsCalls(){return settingsCalls;},get relaunched(){return relaunched;},get quit(){return quit;}};
}

for(const [daemonAvailable,headless] of [[true,true],[true,false],[false,true],[false,false],['stale',true]] as const)test(daemonAvailable==='stale'?'restart removes an owned stale daemon socket before relaunch':'desktop window and notification visibility: headless='+headless+', daemonAvailable='+daemonAvailable,async t=>{
 const home=await mkdtemp(join(tempRoot(),'s-')),directory=home;
 t.after(()=>rm(home,{recursive:true,force:true}));
 const location=socketPath(directory,home);assert.equal(location.kind,'socket');
 const socket=location.path;
 if(daemonAvailable==='stale'){
  assert.equal(ensureSocketDirectory(home).kind,'ready');
  const child=spawn(process.execPath,['--input-type=module','-e',`import {createServer} from 'node:net';import {chmod} from 'node:fs/promises';createServer().listen(${JSON.stringify(socket)},async()=>{await chmod(${JSON.stringify(socket)},0o600);process.stdout.write('ready');});`],{stdio:['ignore','pipe','inherit']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await once(child.stdout!,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;assert.equal((await lstat(socket)).isSocket(),true);
 }
 const fixture=await startFixture(directory,home,headless,daemonAvailable);
 const {app,desktop,handlers}=fixture;
 desktop.window.emit('ready-to-show');await desktop.openWindow();
 app.emit('activate');app.emit('second-instance');
 await fixture.connected;
 await new Promise(resolve=>setImmediate(resolve));
 const {shown,focused,notified,settingsCalls}=fixture;
 assert.equal(shown===0,headless);assert.equal(focused===0,headless);assert.equal(notified===0,headless);
 for(const handle of handlers.values()){assert.throws(()=>handle({sender:desktop.window.webContents,senderFrame:{url:'massion://app/'}}),/Refused/);assert.throws(()=>handle({sender:{},senderFrame:desktop.window.webContents.mainFrame}),/Refused/);}
 assert.equal(settingsCalls,0);const sender={sender:desktop.window.webContents,senderFrame:desktop.window.webContents.mainFrame};assert.equal(handlers.get(channels.settings)!(sender).installedVersion,'1.0.0');if(daemonAvailable==='stale'){
  await assert.rejects(handlers.get(channels.notifications)!(sender,'false'),/Invalid/);
  const result=await handlers.get(channels.restart)!(sender);assert.equal(result.restartStatus,'restarting');await assert.rejects(lstat(socket),{code:'ENOENT'});await new Promise(resolve=>setImmediate(resolve));const {relaunched,quit}=fixture;assert.equal(relaunched,1);assert.equal(quit,1);
 }else assert.throws(()=>handlers.get(channels.notifications)!(sender,'false'),/Invalid/);
 assert.equal(desktop.window.options.show,false);
 assert.equal(desktop.window.options.webPreferences.sandbox,true);
});

for(const [name,homeBytes,old,expected] of [
 ['60-byte account starts on the short socket',67,'missing',undefined],
 ['overlong home is refused before binding',200,'missing','socket-path-too-long (231 bytes)'],
 ['account lookup failure is reported before initialization',67,'home-error','socket-home-unavailable'],
 ['live old supervisor is refused before binding',67,'live','legacy-supervisor-running'],
 ['dead old socket does not prevent starting',67,'dead',undefined],
 ['a file at the new socket name is refused',67,'new-file','socket-entry-not-socket'],
 ['a link at the new socket name is refused',67,'new-link','socket-entry-symlink'],
 ['an exposed socket at the new name is refused',67,'new-mode','socket-entry-mode'],
 ['unsafe run directory is refused before binding',67,'unsafe','socket-directory-mode'],
 ['bind failure is refused before spawning the supervisor',67,'bind-error','socket-bind-failed'],
] as const)test('Electron socket start: '+name,{timeout:5000},async t=>{
 const root=await mkdtemp(join(tempRoot(),'s-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 let planted:{path:string;ino:number;mode:number}|undefined;
 const home=join(root,'a'.repeat(homeBytes-Buffer.byteLength(root)-1));
 const directory=old==='missing'?join(home,'Library','Application Support','massion-desktop'):join(root,'data');
 await mkdir(directory,{recursive:true,mode:0o700});await mkdir(home,{recursive:true,mode:0o700});
 const oldSocket=join(directory,'daemon.sock'),limit=process.platform==='darwin'?104:108;
 if(old==='missing'&&!expected)assert.ok(Buffer.byteLength(oldSocket)>=limit);
 const server=createServer(client=>client.on('data',()=>client.end('{"status":"running"}')));
 if(old==='live'){
  server.listen(oldSocket);await once(server,'listening');await chmod(oldSocket,0o600);
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 }else if(old==='unsafe'){
  const run=join(home,'.massion','run');await mkdir(run,{recursive:true});await chmod(run,0o755);
 }else if(old==='new-file'||old==='new-link'||old==='new-mode'){
  assert.equal(ensureSocketDirectory(home).kind,'ready');
  const location=socketPath(directory,home);assert.equal(location.kind,'socket');
  const path=location.path;
  if(old==='new-file')await writeFile(path,'keep');
  else if(old==='new-link')await symlink(directory,path);
  else{server.listen(path);await once(server,'listening');await chmod(path,0o660);}
  const before=await lstat(path);
  planted={path,ino:before.ino,mode:before.mode};
  if(old==='new-mode')t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 }else if(old==='dead'){
  const child=spawn(process.execPath,['--input-type=module','-e',`import {createServer} from 'node:net';import {chmodSync} from 'node:fs';createServer().listen(process.argv[1],()=>{chmodSync(process.argv[1],0o600);process.stdout.write('ready');});`,oldSocket],{stdio:['ignore','pipe','inherit']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  await once(child.stdout!,'data');const exited=once(child,'exit');child.kill('SIGKILL');await exited;
 }
 const done=Promise.withResolvers<void>(),startErrors:unknown[][]=[],attempts:string[]=[];
 let probes=0;
 const earlyFailure=homeBytes===200||old==='home-error';
 const fixture=await startFixture(directory,home,true,false,{
  userInfo:()=>{if(old==='home-error')throw Object.assign(new Error('account lookup'),{code:'ENOENT',errno:-2});return {homedir:home};},
  mkdir:async()=>{if(earlyFailure)throw new Error('data directory creation failed');},
  daemonCredential,prepareControl,
  probeSocketBind:async (socket:string)=>{
   probes++;
   if(old==='bind-error')await rmdir(dirname(socket));
   await probeSocketBind(socket);
  },
  bundledRuntimeDirectory:async()=>undefined,planRuntimeStart:()=>({node:process.execPath}),
  daemonFiles:()=>({runner:'fixture',entry:'fixture'}),
  launchDaemon:async ({socket}:{socket:string})=>{
   attempts.push(socket);
   const listener=createServer();
   listener.listen(socket);await once(listener,'listening');
   await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
   return {status:'running'};
  },
  createProtocolClient:()=>({connection:async()=>({state:'unavailable'}),reconnect(){done.resolve();}}),
  console:{...console,error(...args:unknown[]){startErrors.push(args);}},
 });
 if(fixture.desktop)await done.promise;
 if(expected){
  assert.deepEqual(startErrors,[['Desktop daemon unavailable:',expected]]);
  if(earlyFailure){assert.equal(fixture.lockRequests,0);assert.equal(fixture.exitCode,1);}
  assert.deepEqual(attempts,[]);
  assert.equal(probes,old==='bind-error'?1:0);
  if(old==='missing')await assert.rejects(lstat(join(home,'.massion')),{code:'ENOENT'});
 }else{
  assert.equal(attempts.length,1);
  assert.equal(attempts[0]?.startsWith(join(home,'.massion','run')+'/'),true,'Electron uses the new socket location');
  assert.deepEqual(startErrors,[]);
  assert.ok(Buffer.byteLength(attempts[0]!)<limit);
  assert.equal(probes,1);
 }
 if(old==='live'||old==='dead')assert.equal((await lstat(oldSocket)).isSocket(),true);
 if(planted){const after=await lstat(planted.path);assert.equal(after.ino,planted.ino);assert.equal(after.mode,planted.mode);}
});
