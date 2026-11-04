import test from 'node:test';
import assert from 'node:assert/strict';
import {ConnectionCatalog} from '../src/provider-profiles.ts';
import type {ModelConnectionProfile} from '../src/provider-profiles.ts';
import {chatProfileFactory} from '../src/chat-profile-factory.ts';
const profile:ModelConnectionProfile={id:'remote-a',label:'Example A',backend:'model-provider',providerKind:'compatible-example',protocol:'openai-chat-completions/v1',model:'exact-v1',endpoint:'https://example.invalid/v1/chat/completions',revision:'1',enabled:true,auth:{method:'bearer',secretRef:'credential:a'},capabilities:['text-output'],usage:{inputTokens:'reported',outputTokens:'reported',cost:'unknown'},limits:{maxInputBytes:4096,maxOutputTokens:64,maxResponseBytes:4096,timeoutMs:100}};
const response=(model='exact-v1')=>new Response(JSON.stringify({id:'test',object:'chat.completion',created:1,model,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'Test only'}}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}}),{headers:{'content-type':'application/json'}});
const request=()=>({invocationId:'invocation',workId:'work',instruction:'Test only',inputReferences:[],signal:new AbortController().signal,maxOutputTokens:32});
test('bearer resolver is lazy, destination-bound, omitted from descriptors and used once per invocation',async()=>{
 let resolutions=0,sends=0;const factory=chatProfileFactory({mode:'https',resolveCredential:async r=>{resolutions++;assert.equal(r.endpoint,profile.endpoint);assert.equal(r.secretRef,'credential:a');assert.equal(r.profileId,profile.id);return 'synthetic-test-only';},transport:async(url,init)=>{sends++;assert.equal(url,profile.endpoint);assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-test-only');assert.equal(init.redirect,'error');return response();}});
 const catalog=new ConnectionCatalog([profile],[factory]);catalog.list();const selected=catalog.resolve(profile.id,['text-output']);assert.equal(resolutions,0);assert.equal(selected.status,'selected');if(selected.status!=='selected')return;
 assert.equal((await selected.adapter.invoke(request())).status,'completed');assert.equal(resolutions,1);assert.equal(sends,1);assert.ok(!JSON.stringify(selected.adapter.descriptor).includes('synthetic-test-only'));
});
test('resolver failure and model mismatch do not retry or select a fallback',async()=>{
 for(const failure of ['resolver','model']){let sends=0;const factory=chatProfileFactory({mode:'https',resolveCredential:async()=>{if(failure==='resolver')throw Error('synthetic-secret-error');return 'test-only';},transport:async()=>{sends++;return response('different-model');}});const selected=new ConnectionCatalog([profile],[factory]).resolve(profile.id,['text-output']);assert.equal(selected.status,'selected');if(selected.status!=='selected')continue;const outcome=await selected.adapter.invoke(request());assert.equal(outcome.status,'unknown');assert.equal(outcome.usage.outputTokens,null);assert.ok(!outcome.reason.includes('synthetic-secret'));assert.equal(sends,failure==='resolver'?0:1);}
});
test('mock mode cannot use bearer credentials and HTTPS mode cannot claim missing resolver ready',()=>{
 for(const factory of [chatProfileFactory({mode:'local-http-mock',transport:async()=>response()}),chatProfileFactory({mode:'https',transport:async()=>response()})])assert.equal(new ConnectionCatalog([profile],[factory]).resolve(profile.id,['text-output']).status,'unavailable');
});
test('cancelled call never resolves credentials or sends a request',async()=>{
 let calls=0;const factory=chatProfileFactory({mode:'https',resolveCredential:async()=>{calls++;return 'test';},transport:async()=>{calls++;return response();}});const selected=new ConnectionCatalog([profile],[factory]).resolve(profile.id,['text-output']);assert.equal(selected.status,'selected');if(selected.status!=='selected')return;const r=request();r.signal=AbortSignal.abort();assert.equal((await selected.adapter.invoke(r)).status,'cancelled');assert.equal(calls,0);
});

import {registerProviderConformance} from './support/provider-conformance.ts';
registerProviderConformance('Chat Completions profile adapter',behavior=>{
 let sends=0;const catalog=new ConnectionCatalog([profile],[chatProfileFactory({mode:'https',resolveCredential:async()=> 'synthetic-test-only',transport:async()=>{sends++;if(behavior==='unknown')throw Error('Synthetic transport loss');return response(behavior==='model-mismatch'?'wrong-model':'exact-v1');}})]);
 const selected=catalog.resolve(profile.id,['text-output']);assert.equal(selected.status,'selected');if(selected.status!=='selected')throw Error('Fixture misconfigured');return {adapter:selected.adapter,sends:()=>sends};
});
