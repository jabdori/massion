import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from 'node:http';
import {createBrowserNetwork} from './browser-network.mjs';

test('denying proxy survives browsers resetting refused CONNECT sockets',async()=>{
 const network=await createBrowserNetwork();
 try{
  for(let i=0;i<3;i++)await new Promise((resolve,reject)=>{
   const req=request(network.config.proxy,{method:'CONNECT',path:'localhost:443'});req.once('error',reject);
   req.once('connect',(res,socket)=>{try{assert.equal(res.statusCode,403);socket.resetAndDestroy();setImmediate(resolve);}catch(error){reject(error);}});req.end();
  });
 }finally{await network.close();}
});
