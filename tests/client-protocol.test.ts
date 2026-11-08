import test from 'node:test';
import assert from 'node:assert/strict';
import {createProtocolClient} from '../src/client-protocol.ts';
import {protocolConnection} from '../src/protocol.ts';
import type {ProtocolTransport,ProtocolRequest,ProtocolReply,FeedHint} from '../src/protocol.ts';
function fixture(){
 const sent:ProtocolRequest[]=[],pending=new Map<string,{resolve:(r:ProtocolReply)=>void;reject:(e:Error)=>void}>();let connects=0;
 let event!:(e:FeedHint)=>void,disconnected!:()=>void;
 const transport:ProtocolTransport={connect:async m=>{connects++;return {...m,kind:'reply',status:200,payload:protocolConnection(m.supported)};},request:m=>{sent.push(m);return new Promise((resolve,reject)=>pending.set(m.requestId,{resolve,reject}));},subscribe:(_m,onEvent,onDisconnect)=>{event=onEvent;disconnected=onDisconnect;return()=>{};}};
 const client=createProtocolClient(transport);
 return {client,sent,pending,connects:()=>connects,event:(e:FeedHint)=>event(e),disconnect:()=>disconnected(),resolve:(n:number,payload:unknown)=>{const m=sent[n]!;pending.get(m.requestId)!.resolve({...m,kind:'reply',status:200,payload});}};
}
async function flush(){for(let n=0;n<10;n++)await Promise.resolve();}
for(const fail of [false,true])test(`central query generation drops late ${fail?'errors':'replies'} and correlates requests`,async()=>{
 const f=fixture(),old=f.client.request('/assistant/conversation?member=old');const rejected=assert.rejects(old,{name:'StaleProtocolReplyError'});await flush();
 const current=f.client.request('/assistant/conversation?member=new');await flush();assert.notEqual(f.sent[0]!.requestId,f.sent[1]!.requestId);assert.ok(f.sent[1]!.generation>f.sent[0]!.generation);
 f.resolve(1,{text:'new'});assert.equal((await current).body.text,'new');
 if(fail)f.pending.get(f.sent[0]!.requestId)!.reject(Error('late outage'));else f.resolve(0,{text:'old'});await rejected;assert.equal(f.connects(),1);
});
test('commands share one dispatch and never resend an unknown outcome',async()=>{
 const f=fixture(),payload={commandId:'original',expectedRevision:4,text:'retain draft'};
 const command=f.client.request('/assistant/messages',{method:'POST',headers:{'X-Massion-Feed':'original-feed'},body:JSON.stringify(payload)});const rejected=assert.rejects(command,/lost reply/);await flush();
 assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0]!.payload,payload);assert.equal(f.sent[0]!.feedId,'original-feed');
 f.pending.get(f.sent[0]!.requestId)!.reject(Error('lost reply'));await rejected;assert.equal(f.sent.length,1);
});
for(const field of ['requestId','version','generation'])test('rejects mismatched reply '+field,async()=>{
 const f=fixture(),read=f.client.request('/read-state');const rejected=assert.rejects(read,/protocol|correlation/i);await flush();const m=f.sent[0]!;
 f.pending.get(m.requestId)!.resolve({...m,kind:'reply',status:200,payload:{},[field]:field==='requestId'?'wrong':99});await rejected;
});
test('compatibility reports restart only for a known installed supporting core',()=>{
 assert.equal(protocolConnection({min:2,max:2}).state,'update-needed');assert.equal(protocolConnection({min:2,max:2},{min:1,max:1},{min:1,max:2}).state,'restart-needed');
 assert.equal(protocolConnection({min:1,max:1},{min:2,max:2},{min:2,max:3}).state,'update-needed');
});

test('unsupported reply keeps subsequent commands closed until a new connection negotiation',async()=>{
 const f=fixture(),read=f.client.request('/read-state');const rejected=assert.rejects(read,/protocol reply version/i);await flush();const m=f.sent[0]!;
 f.pending.get(m.requestId)!.resolve({...m,version:99,kind:'reply',status:200,payload:{}});await rejected;
 assert.equal((await f.client.connection()).state,'update-needed');
 const closed=f.client.request('/assistant/messages',{method:'POST',body:'{"commandId":"not-sent"}'});
 await assert.rejects(closed,/update or restart/);assert.equal(f.sent.length,1);
});

test('an aborted request cannot apply a reply from a transport that ignores cancellation',async()=>{
 const f=fixture(),controller=new AbortController(),read=f.client.request('/read-state',{signal:controller.signal});const rejected=assert.rejects(read,{name:'AbortError'});await flush();controller.abort();f.resolve(0,{stale:true});await rejected;
});

test('feature gates are negotiated once and refuse commands without a fallback path',async()=>{
 let connects=0,sends=0;
 const transport:ProtocolTransport={connect:async m=>{connects++;return {...m,kind:'reply',status:200,payload:{...protocolConnection(m.supported),features:{commands:false,queries:true,feedPush:false}}};},request:async m=>{sends++;return {...m,kind:'reply',status:200,payload:{read:true}};},subscribe(){assert.fail('No unavailable push fallback');}};
 const client=createProtocolClient(transport);assert.equal((await client.query('/read-state')).body.read,true);
 await assert.rejects(client.dispatch('/missions',{body:'{}'}),/update or restart/);await assert.rejects(client.subscribe({after:0},()=>{},()=>{}),/update or restart/);
 assert.equal(connects,1);assert.equal(sends,1);
});
