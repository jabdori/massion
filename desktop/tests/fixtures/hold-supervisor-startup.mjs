import fs from 'node:fs/promises';
import {once} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {Socket} from 'node:net';

const socket=process.argv[2],drainHold=process.env.MASSION_TEST_DRAIN_HOLD;
function hold(operation,target){
 const original=fs[operation];
 fs[operation]=async(file,...args)=>{
  if(file===target){
   fs[operation]=original;
   syncBuiltinESMExports();
   const release=once(process,'message');
   process.send(operation);
   await release;
  }
  return original(file,...args);
 };
}
if(!drainHold||drainHold==='chmod')hold('chmod',socket);
if(!drainHold||drainHold==='writeFile')hold('writeFile',socket+'.pid');
syncBuiltinESMExports();

if(drainHold){
 const setTimeout=Socket.prototype.setTimeout;
 Socket.prototype.setTimeout=function(ms,...args){
  // Only the drain command clears the accepted socket's timeout in these runs.
  if(ms===0&&this.server?.address()===socket)process.send('drain received');
  return setTimeout.call(this,ms,...args);
 };
}
