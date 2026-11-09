import test from 'node:test';
import assert from 'node:assert/strict';
import {CASES,evaluateCase,summarize} from '../scripts/eval-room-discriminator.ts';
import {fixtureDiscriminator} from '../src/discriminator-adapters.ts';
import type {ProviderAdapter} from '../src/providers.ts';

const pin={groupId:'evaluation',profileId:'moderator',configHash:'a'.repeat(64),provider:'codex-cli',model:'zai/glm-5.3'};
const member:ProviderAdapter={descriptor:{provider:'codex-cli',model:'gpt-6.1-terra',configVersion:'v1',enabled:true,capabilities:['text-output'],evidenceClass:'fixture'},async invoke(r){return {status:'completed',output:JSON.parse(r.instruction).literal,usage:{inputTokens:1,outputTokens:1},reason:'fixture'};}};

test('fixed cases cover both moments, three languages and both stricter labels without leaking labels',async()=>{
 assert.equal(CASES.length,20);assert.equal(new Set(CASES.map(c=>c.id)).size,20);
 assert.deepEqual(new Set(CASES.map(c=>c.language)),new Set(['en','ko','mixed']));
 assert.deepEqual(new Set(CASES.map(c=>c.expected)),new Set(['challenge','return-challenge',null]));
 for(const c of CASES){
  const adapter=fixtureDiscriminator(pin,q=>({kind:q.kind,options:q.options,distribution:c.expected==='return-challenge'||c.expected===null&&!c.challenge?[0,1]:[1,0],confidence:1}));
  const invoke=adapter.invoke;adapter.invoke=async(q,input,signal)=>{assert.equal(Object.hasOwn(input,'expected'),false);assert.equal(Object.hasOwn(input,'wrongClaim'),false);assert.equal(input.quotes[0]!.quoted,c.artifact);return invoke(q,input,signal);};
  const result=await evaluateCase(c,member,adapter,new AbortController().signal);
  assert.equal(result.status,'recorded');assert.equal(result.agrees,true,c.id);assert.equal(result.falseRelax,false);assert.equal(result.applied,false);
 }
});

test('the unchanged shadow timeout is a failed observation, retains restrictions, and never retries',async()=>{
 let calls=0;
 const adapter:ReturnType<typeof fixtureDiscriminator>={pin,async invoke(_q,_input,signal){calls++;await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(Error('fixture abort')),{once:true}));throw Error('unreachable');}};
 const result=await evaluateCase(CASES[11]!,member,adapter,new AbortController().signal);
 assert.equal(result.status,'timeout');assert.equal(result.agrees,false);assert.equal(result.applied,false);assert.equal(result.falseRelax,false);assert.equal(calls,1);
});

test('member output drift fails before moderation instead of scoring an invalid label',async()=>{
 const drift={...member,invoke:async()=>({status:'completed' as const,output:'different',usage:{inputTokens:1,outputTokens:1},reason:'fixture'})};
 await assert.rejects(evaluateCase(CASES[0]!,drift,fixtureDiscriminator(pin,()=>assert.fail('must not moderate drift')),new AbortController().signal),/reproduction/);
});

test('metrics retain missing coverage and distinguish missed strictness from false relaxation',()=>{
 const results=[{id:'one',status:'recorded',agrees:false,expected:'challenge',proposal:null,falseRelax:false,applied:false},{id:'two',status:'timeout',agrees:false,expected:null,proposal:null,falseRelax:false,applied:false}] as Parameters<typeof summarize>[0];
 const s=summarize(results,20);assert.equal(s.valid,1);assert.equal(s.agreed,0);assert.equal(s.missedStrictness,1);assert.equal(s.falseRelax,0);assert.equal(s.unrun,18);assert.equal(s.agreementAllCases,0);
 assert.equal(summarize([{...results[0]!,falseRelax:true}],20).falseRelax,1);
});
