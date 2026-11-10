import assert from 'node:assert/strict';
import {app,nativeTheme,BrowserWindow} from 'electron';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

if(process.platform!=='linux'||!process.env.DISPLAY)throw new Error('Linux Xvfb required');
app.setPath('userData',process.env.MASSION_SMOKE_DATA);
const {startDesktop}=await import('../dist/main.js');
try{
 const desktop=await startDesktop(),window=desktop.window,contents=window.webContents;
 assert.equal(app.isHardwareAccelerationEnabled(),false,'Smoke renders without GPU acceleration');
 const prefs=contents.getLastWebPreferences();
 assert.equal(prefs.sandbox,true);assert.equal(prefs.contextIsolation,true);assert.equal(prefs.nodeIntegration,false);
 assert.equal(await contents.executeJavaScript('typeof require'), 'undefined');
 assert.deepEqual(await contents.executeJavaScript('Object.keys(window.massionDesktop)'),['getSettings','saveNotifications','restart','onFocus']);
 const native=await contents.executeJavaScript('window.massionDesktop.getSettings()');assert.match(native.installedVersion,/^1\./);assert.equal(native.restartRequired,false);assert.equal(native.update,'unknown');
 const saved=await contents.executeJavaScript('window.massionDesktop.saveNotifications(false)');assert.equal(saved.notifications,false);assert.equal(saved.restartRequired,true);
 assert.equal(await contents.executeJavaScript('window.massionDesktop.saveNotifications("false").then(()=>false,()=>true)'),true);
 assert.equal((await contents.executeJavaScript('window.massionDesktop.saveNotifications(true)')).restartRequired,false);
 for(let n=0;n<100;n++){if(await contents.executeJavaScript('typeof chatView!=="undefined"&&!!chatView?.feedId&&!reconnectRequired'))break;await delay(100);}
 assert.equal(await contents.executeJavaScript('protocol.connection().then(info=>info.state)'), 'ready');
 assert.equal(await contents.executeJavaScript('!!chatView?.feedId&&!reconnectRequired'),true,'Existing UI completed connection');
 const mainFetch=await contents.executeJavaScript(`protocol.query('/assistant/conversation',{scope:'smoke-main-frame-fetch'}).then(result=>result.response.ok&&!!result.body.feedId)`);
 assert.equal(mainFetch,true,'Owned main-frame API fetch succeeds');
 const mainSSE=await contents.executeJavaScript(`new Promise((resolve,reject)=>{
  const source=new EventSource('/protocol/events?version=1&requestId=smoke-main-frame-sse&generation=1&after=0');
  const timer=setTimeout(()=>{source.close();reject(new Error('Main-frame SSE timeout'));},5000);
  source.onmessage=event=>{clearTimeout(timer);source.close();resolve(JSON.parse(event.data).kind==='feed');};
  source.onerror=()=>{clearTimeout(timer);source.close();reject(new Error('Main-frame SSE refused'));};
 })`);
 assert.equal(mainSSE,true,'Owned main-frame SSE receives actual feed');
 const title=contents.getTitle();assert.ok(title.length>0);
 contents.debugger.attach('1.3');
 const {nodes}=await contents.debugger.sendCommand('Accessibility.getFullAXTree');
 assert.ok(nodes.some(node=>node.role?.value==='textbox'),'Composer in accessibility tree');
 const artifacts=join(import.meta.dirname,'../smoke-artifacts');await mkdir(artifacts,{recursive:true});
 await writeFile(join(artifacts,'accessibility.json'),JSON.stringify(nodes,null,2));
 await writeFile(join(artifacts,'window.png'),(await contents.capturePage()).toPNG());
 for(const theme of ['dark','light']){nativeTheme.themeSource=theme;await delay(100);assert.equal(await contents.executeJavaScript("matchMedia('(prefers-color-scheme: dark)').matches"),theme==='dark');}
 nativeTheme.themeSource='system';
 assert.equal(await contents.executeJavaScript("window.open('https://example.org')===null"),true);
 assert.equal(BrowserWindow.getAllWindows().length,1);
 assert.equal(await contents.executeJavaScript("fetch('http://127.0.0.1:1/').then(()=>false,()=>true)"),true);
 assert.equal(await contents.executeJavaScript("navigator.mediaDevices.getUserMedia({audio:true}).then(()=>false,()=>true)"),true);
 assert.equal(await contents.executeJavaScript("new Promise(resolve=>{const s=document.createElement('script');s.textContent='window.injected=true';document.head.append(s);setTimeout(()=>resolve(window.injected!==true),20);})"),true);
 await contents.executeJavaScript("location.href='https://example.org'");await delay(100);assert.equal(contents.getURL(),'massion://app/');
 const hosted=await contents.executeJavaScript(`protocol.dispatch('/assistant/apps/view',{body:JSON.stringify({app:'frame-probe',handler:'page'})}).then(result=>result.body)`);
 assert.equal(hosted.frame.html,undefined,'Renderer receives URL only');
 assert.match(hosted.frame.url,/^massion-app:\/\/document\/[a-f0-9]{64}$/);
 await contents.executeJavaScript("document.getElementById('rail-app-frame-probe').click()");
 for(let n=0;n<100;n++){if(await contents.executeJavaScript("!!document.querySelector('#app-view iframe')"))break;await delay(100);}
 hosted.frame.url=await contents.executeJavaScript("window.smokeFrame=document.querySelector('#app-view iframe');window.smokeFrame.src");
 for(let n=0;n<100;n++){if(await contents.executeJavaScript("window.smokeFrame.style.height==='617px'"))break;await delay(100);}
 assert.equal(await contents.executeJavaScript('window.smokeFrame.style.height'),'617px','App script posts resize through source-validated bridge');
 const appFrame=contents.mainFrame.frames.find(frame=>frame.url===hosted.frame.url);assert.ok(appFrame,'Document loaded on isolated app origin');
 const {allowWorkbenchRequest}=await import('../dist/security.js');
 const childRequests=[];
 for(const path of ['/','/protocol/connect','/protocol/request','/protocol/events']){
  const url='massion://app'+path;
  // Exercise the independent gate with real Electron frame identity; do not bypass document CSP.
  const admitted=allowWorkbenchRequest({url,resourceType:'xhr',webContentsId:contents.id,frame:appFrame},contents);
  assert.equal(admitted,false,'Request gate independently refuses the actual child frame '+path);
  const fetchDenied=await appFrame.executeJavaScript(`fetch(${JSON.stringify(url)}).then(()=>false,()=>true)`);
  assert.equal(fetchDenied,true,'Actual child fetch remains denied under its unchanged CSP '+path);
  childRequests.push({path,admitted,fetchDenied});
 }
 await writeFile(join(artifacts,'frame-boundary.json'),JSON.stringify({mainFetch,mainSSE,childRequests},null,2));
 assert.deepEqual(await appFrame.executeJavaScript('window.probe'),{ran:true,parentBlocked:true,networkBlocked:true});
 assert.equal(await appFrame.executeJavaScript('getComputedStyle(document.body).backgroundColor'),'rgb(12, 34, 56)','App own styles apply under separate CSP');
 assert.equal(await appFrame.executeJavaScript('typeof require'),'undefined');
 assert.equal(await appFrame.executeJavaScript('typeof window.massionDesktop'),'undefined');
 assert.equal(await contents.executeJavaScript('document.body.dataset.appEscaped'),undefined,'Parent DOM stays inaccessible');
 await contents.executeJavaScript("appFrameMessage({source:{},origin:'null',data:{type:'resize',height:900}})");
 assert.equal(await contents.executeJavaScript('window.smokeFrame.style.height'),'617px','Forged source cannot resize');
 await writeFile(join(artifacts,'app-frame.png'),(await contents.capturePage()).toPNG());
 await writeFile(join(artifacts,'app-frame.json'),JSON.stringify({url:hosted.frame.url,script:true,style:'rgb(12, 34, 56)',resize:617,parentBlocked:true,networkBlocked:true}));
 await contents.executeJavaScript('window.smokeFrame.remove()');
 const target=JSON.parse(process.env.MASSION_SMOKE_TARGET);
 contents.send('desktop:focus',target);
 for(let n=0;n<100;n++){if(await contents.executeJavaScript(`paneActive===${JSON.stringify(target.missionId+'/'+target.workId)}&&!document.getElementById('work-pane').hidden&&document.activeElement.id===${JSON.stringify('work-heading-'+target.workId)}`))break;await delay(100);}
 assert.equal(await contents.executeJavaScript('paneActive'),target.missionId+'/'+target.workId,'Notification target opens its Work');
 assert.equal(await contents.executeJavaScript('document.activeElement.id'),'work-heading-'+target.workId,'Work receives keyboard focus');
 await writeFile(join(artifacts,'focused-work.png'),(await contents.capturePage()).toPNG());
 contents.debugger.detach();
 window.close();await delay(100);assert.equal(desktop.window,null);
 await desktop.openWindow();assert.equal(desktop.window.webContents.getURL(),'massion://app/');
 console.log(JSON.stringify({electronSmoke:'passed',title,accessibilityNodes:nodes.length,security:'sandbox, isolation, CSP, navigation, permissions',theme:'dark/light',windowLifecycle:'close and reopen',notification:'existing Work pane and keyboard focus',artifacts}));
 app.quit();
}catch(error){console.error(error);app.exit(1);}
