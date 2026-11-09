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
 assert.deepEqual(await contents.executeJavaScript('Object.keys(window.massionDesktop)'),['onFocus']);
 for(let n=0;n<100;n++){if(await contents.executeJavaScript('typeof chatView!=="undefined"&&!!chatView?.feedId&&!reconnectRequired'))break;await delay(100);}
 assert.equal(await contents.executeJavaScript('protocol.connection().then(info=>info.state)'), 'ready');
 assert.equal(await contents.executeJavaScript('!!chatView?.feedId&&!reconnectRequired'),true,'Existing UI completed connection');
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
 const target=JSON.parse(process.env.MASSION_SMOKE_TARGET);
 contents.send('desktop:focus',target);
 for(let n=0;n<100;n++){if(await contents.executeJavaScript(`paneActive===${JSON.stringify(target.missionId+'/'+target.workId)}&&!document.getElementById('work-pane').hidden`))break;await delay(100);}
 assert.equal(await contents.executeJavaScript('paneActive'),target.missionId+'/'+target.workId,'Notification target opens its Work');
 assert.equal(await contents.executeJavaScript('document.activeElement.id'),'work-heading-'+target.workId,'Work receives keyboard focus');
 await writeFile(join(artifacts,'focused-work.png'),(await contents.capturePage()).toPNG());
 contents.debugger.detach();
 window.close();await delay(100);assert.equal(desktop.window,null);
 await desktop.openWindow();assert.equal(desktop.window.webContents.getURL(),'massion://app/');
 console.log(JSON.stringify({electronSmoke:'passed',title,accessibilityNodes:nodes.length,security:'sandbox, isolation, CSP, navigation, permissions',theme:'dark/light',windowLifecycle:'close and reopen',notification:'existing Work pane and keyboard focus',artifacts}));
 app.quit();
}catch(error){console.error(error);app.exit(1);}
