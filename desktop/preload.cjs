const {contextBridge,ipcRenderer}=require('electron');
const channels=__DESKTOP_CHANNELS__;
contextBridge.exposeInMainWorld('massionDesktop',Object.freeze({
 onFocus(callback){
  if(typeof callback!=='function')throw new TypeError('Focus callback required');
  const listener=(_event,target)=>callback(target);
  ipcRenderer.on(channels.focus,listener);ipcRenderer.send(channels.ready);
  return()=>ipcRenderer.removeListener(channels.focus,listener);
 }
}));
