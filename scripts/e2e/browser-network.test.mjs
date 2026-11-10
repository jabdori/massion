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

test('browser egress proxy refuses HTTP, tunnels and upgraded connections without forwarding',async t=>{
 const {connect}=await import('node:net');const proxy=await createBrowserNetwork();t.after(()=>proxy.close());
 const status=await new Promise((resolve,reject)=>{const req=request(proxy.config.proxy,{path:'http://192.0.2.1/private',headers:{host:'192.0.2.1'}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);
 for(const message of ['CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1:443\r\n\r\n','GET ws://192.0.2.1/socket HTTP/1.1\r\nHost: 192.0.2.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n']){
  const reply=await new Promise((resolve,reject)=>{const socket=connect(Number(new URL(proxy.config.proxy).port),'127.0.0.1');let text='';socket.setTimeout(2000,()=>socket.destroy(Error('Proxy did not close')));socket.on('connect',()=>socket.write(message));socket.on('data',data=>text+=data);socket.on('end',()=>resolve(text));socket.on('error',reject);});assert.match(reply,/^HTTP\/1.1 403 Forbidden/);
 }
});
