import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCommand} from './browser-command.mjs';

const contextError='Failed to install browser network controls: CDP error (Runtime.evaluate): Cannot find default execution context';
const failure=error=>Object.assign(new Error('command failed'),{stdout:JSON.stringify({success:false,error})});

test('retries the context error once and returns the next result',async()=>{
 let calls=0;const result=await browserCommand(async()=>{if(++calls===1)throw failure(contextError);return {stdout:JSON.stringify({success:true,data:{ok:true}})};});
 assert.equal(calls,2);assert.deepEqual(result,{ok:true});
});

test('other errors and a repeated context error fail',async()=>{
 for(const message of ['other infrastructure error',contextError]){
  let calls=0;await assert.rejects(browserCommand(async()=>{calls++;throw failure(message);}));
  assert.equal(calls,message===contextError?2:1);
 }
});

test('browser egress proxy refuses HTTP, tunnels and upgraded connections without forwarding',async t=>{
 const {browserEgressProxy}=await import('./browser-command.mjs'),{request}=await import('node:http'),{connect}=await import('node:net');const proxy=await browserEgressProxy();t.after(()=>proxy.close());
 const status=await new Promise((resolve,reject)=>{const req=request(proxy.url,{path:'http://192.0.2.1/private',headers:{host:'192.0.2.1'}},r=>{r.resume();resolve(r.statusCode);});req.on('error',reject);req.end();});assert.equal(status,403);
 for(const message of ['CONNECT 192.0.2.1:443 HTTP/1.1\r\nHost: 192.0.2.1:443\r\n\r\n','GET ws://192.0.2.1/socket HTTP/1.1\r\nHost: 192.0.2.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n']){
  const reply=await new Promise((resolve,reject)=>{const socket=connect(Number(new URL(proxy.url).port),'127.0.0.1');let text='';socket.setTimeout(2000,()=>socket.destroy(Error('Proxy did not close')));socket.on('connect',()=>socket.write(message));socket.on('data',data=>text+=data);socket.on('end',()=>resolve(text));socket.on('error',reject);});assert.match(reply,/^HTTP\/1.1 403 Forbidden/);
 }
});
