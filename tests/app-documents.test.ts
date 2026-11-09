import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'node:http';
import {AppDocuments,createAppDocumentHost,appDocumentPolicy} from '../src/app-documents.ts';

test('documents are bounded, expire, and only exact unguessable paths resolve',()=>{
 let now=0;const docs=new AppDocuments(()=>now);
 const first=docs.publish('<style>body{color:red}</style><script>parent.postMessage({type:"ready"},"*")</script>');
 assert.match(first,/^\/[a-f0-9]{64}$/);assert.match(docs.read(first)!,/parent.postMessage/);
 for(const path of [first+'?x',first+'#x','/../'+first,first+'/','/','https://evil.test'+first])assert.equal(docs.read(path),undefined);
 assert.throws(()=>docs.publish('x'.repeat(65537)),/bound/);
 assert.throws(()=>docs.publish('한'.repeat(30000)),/bound/);
 for(let i=0;i<32;i++)docs.publish('document '+i);
 assert.equal(docs.read(first),undefined,'oldest is evicted at 32 documents');
 const last=docs.publish('last');now=300001;assert.equal(docs.read(last),undefined,'expires after five minutes');
 const fresh=docs.publish('fresh');docs.clear();assert.equal(docs.read(fresh),undefined);
 assert.match(appDocumentPolicy,/sandbox allow-scripts/);assert.match(appDocumentPolicy,/connect-src 'none'/);
});

test('browser documents have a separate loopback origin, own CSP, no credentials or publish endpoint',async t=>{
 const host=createAppDocumentHost();t.after(()=>host.close());
 const url=await host.publish('<style>body{color:red}</style><script>window.ran=true</script>');
 assert.match(url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{64}$/);
 const response=await fetch(url);assert.equal(response.status,200);
 assert.equal(response.headers.get('content-security-policy'),appDocumentPolicy);
 assert.equal(response.headers.get('cache-control'),'no-store');
 assert.equal(response.headers.get('access-control-allow-origin'),null);
 assert.match(await response.text(),/window.ran=true/);
 const denied:RequestInit[]=[{method:'POST',body:'html'},{headers:{Origin:'https://evil.test'}},{headers:{Cookie:'secret=x'}},{headers:{Authorization:'Bearer secret'}}];
 for(const init of denied)assert.equal((await fetch(url,init)).status,403);
 assert.equal((await fetch(url+'?extra=1')).status,404);
 assert.equal(await new Promise<number|undefined>((resolve,reject)=>{get(url,{headers:{Host:'localhost'}},response=>{response.resume();resolve(response.statusCode);}).on('error',reject);}),403);
 assert.equal((await fetch(new URL('/missing',url))).status,404);
 await host.close();await assert.rejects(host.publish('late'),/closed/);
});
