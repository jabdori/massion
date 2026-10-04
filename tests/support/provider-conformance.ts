/** Reusable semantic suite: implement a protocol fixture, not a live account, for each extension. */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {ProviderAdapter,ProviderRequest} from '../../src/providers.ts';
export interface ProviderConformanceHarness {adapter:ProviderAdapter;sends:()=>number;cleanup?:()=>void|Promise<void>}
export type ProviderConformanceFixture=(behavior:'completed'|'unknown'|'model-mismatch')=>ProviderConformanceHarness;
export function registerProviderConformance(name:string,fixture:ProviderConformanceFixture){
 const request=():ProviderRequest=>({invocationId:'conformance',workId:'conformance-work',instruction:'Synthetic fixture only',inputReferences:[],signal:new AbortController().signal,maxOutputTokens:8});
 for(const behavior of ['completed','unknown','model-mismatch'] as const)test(`${name}: conformance ${behavior}, bounded single-send with no fallback`,async t=>{
  const h=fixture(behavior);t.after(()=>h.cleanup?.());const expected=structuredClone(h.adapter.descriptor);const outcome=await h.adapter.invoke(request());
  assert.equal(h.sends(),1);assert.deepEqual(h.adapter.descriptor,expected);
  if(behavior==='completed'){assert.equal(outcome.status,'completed');assert.equal(typeof outcome.output,'string');assert.ok(outcome.usage.outputTokens!==null&&outcome.usage.outputTokens<=8);}
  else{assert.equal(outcome.status,'unknown');assert.equal(outcome.output,null);assert.equal(outcome.usage.outputTokens,null);}
 });
 test(`${name}: conformance pre-dispatch cancellation sends nothing`,async t=>{const h=fixture('completed');t.after(()=>h.cleanup?.());const r=request();r.signal=AbortSignal.abort();assert.equal((await h.adapter.invoke(r)).status,'cancelled');assert.equal(h.sends(),0);});
}
