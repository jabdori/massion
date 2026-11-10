import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEnvironment,validateBrowserEnvironment} from '../src/browser-environment.ts';
import type {BrowserEnvironmentConfig,BrowserControl} from '../src/browser-environment.ts';
import {EnvironmentActions} from '../src/environment-actions.ts';
import {InMemoryStore} from '../src/storage.ts';

const config:BrowserEnvironmentConfig={environment:'browser-fixture',origin:'https://fixture.example',elements:[
 {id:'field',selector:'#field',role:'textbox',label:'Private input',operations:['type'],gates:[]},
 {id:'continue',selector:'#continue',role:'button',label:'Continue',operations:['click','submit'],gates:[]},
 {id:'human',selector:'#human',role:'checkbox',label:'Human check',operations:['click'],gates:[],ownerOnly:true},
],facts:[{id:'confirmed',selector:'#confirmed',state:'checked'}]};
function fixture(){
 let revision=1,document='document-one',privatePage=false;const calls:string[]=[];
 const page={address:config.origin+'/private-path?token=hidden',title:'Public title',blocks:['Public paragraph'],fields:[]};
 const control:BrowserControl={async evaluate(expression){calls.push(expression);if(expression.includes('"operation":"act"'))return {delivered:true};return {document,revision,available:['field','continue','human'],facts:{confirmed:false},page:{...page,...(privatePage?{privateFields:1}:{} )}};},async close(){}};
 const adapter=new BrowserEnvironment(control,config),store=new InMemoryStore<any>();let bytes:Uint8Array|undefined;
 const service=new EnvironmentActions(store,store,adapter,{owner:'local-owner',environment:config.environment,resolveSecret:async()=>bytes=new TextEncoder().encode('synthetic-private-value')});
 return {adapter,store,service,calls,page,bytes:()=>bytes,change:()=>{revision++;},navigate:()=>{document='document-two';},private:()=>{privatePage=true;}};
}

test('browser declarations reject HTTP origins, duplicate elements and page-text confirmation predicates',()=>{
 for(const patch of [{origin:'http://fixture.example'},{elements:[config.elements[0],config.elements[0]]},{facts:[{id:'confirmed',selector:'#confirmed',state:'text',value:'success'}]}])assert.throws(()=>validateBrowserEnvironment({...config,...patch} as BrowserEnvironmentConfig));
});

test('unknown browser clicks require approval and human-check controls have no executable target',async()=>{
 const s=fixture(),entry=await s.service.propose('click','continue',{kind:'click'});assert.equal(entry.status,'waiting');assert.deepEqual(entry.request.type==='action'?entry.request.action.gates:[],[{kind:'irreversible-submit'}]);
 await assert.rejects(s.service.execute('click',entry.hash),/approval/i);await s.service.answer('approve','click',entry.hash,'approve');assert.equal((await s.service.execute('click',entry.hash)).status,'delivered');
 await assert.rejects(s.service.propose('human','human',{kind:'click'}),/unavailable/i);
});

test('secret resolution is single-use at delivery, erased, and taints page reads as well as environment observations',async()=>{
 const s=fixture(),entry=await s.service.propose('fill','field',{kind:'type',secret:{owner:'local-owner',slot:'private'}});assert.equal((await s.service.execute('fill',entry.hash)).status,'delivered');assert.ok(s.bytes()?.every(b=>b===0));
 assert.ok(!JSON.stringify(s.store.inspect()).includes('synthetic-private-value'));assert.deepEqual((await s.service.observe()).structure,[]);
 const page=await s.adapter.read({address:config.origin+'/',sessionId:'unused',signal:new AbortController().signal});assert.equal(page.title,'');assert.deepEqual(page.blocks,[]);assert.equal(page.privateSession,true);
});

test('document or revision changes after approval invalidate delivery',async()=>{
 for(const kind of ['change','navigate'] as const){const s=fixture(),entry=await s.service.propose('click','continue',{kind:'click'});await s.service.answer('approve','click',entry.hash,'approve');s[kind]();assert.equal((await s.service.execute('click',entry.hash)).status,'invalidated');assert.equal(s.calls.filter(c=>c.includes('"operation":"act"')).length,0);}
});

test('private page values and adapter exceptions never escape public reads',async()=>{
 const s=fixture();s.page.title='synthetic-private-title';s.private();const page=await s.adapter.read({address:config.origin+'/',sessionId:'unused',signal:new AbortController().signal});assert.equal(page.title,'');assert.deepEqual(page.blocks,[]);
 const adapter=new BrowserEnvironment({async evaluate(){throw Error('synthetic-secret-error');},async close(){}},config);await assert.rejects(adapter.observe(new AbortController().signal),e=>e instanceof Error&&!String(e.stack).includes('synthetic-secret-error')&&!e.cause);
});

test('a secret resolved after navigation is erased without delivering to the new document',async()=>{
 const s=fixture(),o=await s.adapter.observe(new AbortController().signal),bytes=new TextEncoder().encode('private');const action={binding:o.binding,element:'field',input:{kind:'type' as const,secret:{owner:'local-owner',slot:'private'}},gates:[]};
 await assert.rejects(s.adapter.act(action,{signal:new AbortController().signal,secret:async()=>{s.navigate();return bytes;}}));assert.ok(bytes.every(b=>b===0));assert.equal(s.calls.filter(c=>c.includes('"operation":"act"')).length,0);
});

test('current-page reads cannot pretend to navigate and expired secret delivery clears its bytes',async()=>{
 const s=fixture();await assert.rejects(s.adapter.read({address:config.origin+'/another-page',sessionId:'unused',signal:new AbortController().signal}),/address/i);
 const controller=new AbortController(),o=await s.adapter.observe(controller.signal),bytes=new TextEncoder().encode('private');
 await assert.rejects(s.adapter.act({binding:o.binding,element:'field',input:{kind:'type',secret:{owner:'local-owner',slot:'private'}},gates:[]},{signal:controller.signal,secret:async()=>{controller.abort();return bytes;}}));assert.ok(bytes.every(b=>b===0));assert.equal(s.calls.filter(c=>c.includes('"operation":"act"')).length,0);
});
