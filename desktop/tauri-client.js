/* The Tauri client bootstrap, inlined into the app document by desktop/build.mjs.
 * Inert under Electron and the development host: everything is guarded on the
 * global Tauri API (app.withGlobalTauri). Inside Tauri it exposes the same
 * window.massionDesktop object as desktop/preload.cjs and the channel-fed
 * event source createSseTransport expects (see src/client-protocol.ts).
 * Tauri mechanisms: https://v2.tauri.app/develop/calling-rust/#channels */
(function(){
 'use strict';
 if(!window.__TAURI__||!window.__TAURI__.core)return;
 var api=window.__TAURI__;
 var sources=new Map(),lastEventId=null,focusCallbacks=[],focusListener=null,subscriptionSerial=0;
 var channel=new api.core.Channel();
 channel.onmessage=function(line){
  if(!line||typeof line!=='object')return;
  if(line.event==='message'){
   var source=sources.get(line.subscription);
   if(!source)return;
   if(line.lastEventId)lastEventId=line.lastEventId;
   if(typeof source.onmessage==='function')source.onmessage({lastEventId:line.lastEventId||'',data:line.data});
   return;
  }
  if(line.event==='error'){
   var failed=sources.get(line.subscription);
   if(failed&&typeof failed.onerror==='function')failed.onerror();
  }
 };
 function startFocusListener(){
  if(focusListener)return focusListener;
  focusListener=api.event.listen('desktop:focus',function(event){
   for(var index=0;index<focusCallbacks.length;index++)focusCallbacks[index](event.payload);
  });
  return focusListener;
 }
 Object.defineProperty(window,'massionDesktop',{value:Object.freeze({
  getSettings:function(){return api.core.invoke('desktop_settings').then(JSON.parse);},
  saveNotifications:function(value){return api.core.invoke('desktop_save_notifications',{value:value===true}).then(JSON.parse);},
  restart:function(){return api.core.invoke('desktop_restart').then(JSON.parse);},
  onFocus:function(callback){
   if(typeof callback!=='function')throw new TypeError('Focus callback required');
   focusCallbacks.push(callback);startFocusListener();
   api.core.invoke('desktop_ready');
   return function(){
    var position=focusCallbacks.indexOf(callback);
    if(position>=0)focusCallbacks.splice(position,1);
   };
  }
 }),writable:false,configurable:false});
 Object.defineProperty(window,'__massionSseSource',{value:function(url){
  var source={onopen:null,onmessage:null,onerror:null,closed:false,subscription:null};
  var resume=lastEventId,id='sub-'+(++subscriptionSerial);
  // Register before invoking: an event arriving before the subscribe response
  // must already find its source (events cannot precede registration).
  source.subscription=id;sources.set(id,source);
  api.core.invoke('desktop_events_subscribe',{subscription:id,path:url,lastEventId:resume,channel:channel}).then(function(){
   if(source.closed){sources.delete(id);api.core.invoke('desktop_events_close',{subscription:id});return;}
   if(typeof source.onopen==='function')source.onopen();
  },function(){if(typeof source.onerror==='function')source.onerror();});
  source.close=function(){
   if(source.closed)return;source.closed=true;
   if(source.subscription===null)return;
   sources.delete(source.subscription);
   api.core.invoke('desktop_events_close',{subscription:source.subscription});
   source.subscription=null;
  };
  return source;
 },writable:false,configurable:false});
})();
