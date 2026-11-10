import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemorySecretSlots,KeychainSecretSlots} from '../src/secret-slots.ts';
import type {CliResult} from '../src/cli-agent-providers.ts';

const slot={owner:'metadata-fixture',slot:'api-key'};
const ok:CliResult={spawned:true,exitCode:0,stdout:'discarded-private-metadata',stderr:'discarded-private-metadata',timedOut:false,aborted:false,overflow:false};

test('in-memory presence checks isolate owners and never read stored secret bytes',async()=>{
 const secrets=new InMemorySecretSlots();assert.equal(typeof secrets.has,'function');secrets.read=async()=>assert.fail('Metadata must not read secret bytes');
 assert.equal(await secrets.has(slot),false);await secrets.set(slot,'fixture-secret');assert.equal(await secrets.has(slot),true);assert.equal(await secrets.has({...slot,owner:'other'}),false);await secrets.delete(slot);assert.equal(await secrets.has(slot),false);
 await assert.rejects(secrets.has({...slot,slot:'invalid\nslot'}));assert.doesNotMatch(JSON.stringify(secrets),/fixture-secret/);
});

test('keychain presence uses one fixed metadata command without password flags and discards output',async()=>{
 for(const [exitCode,present] of [[0,true],[44,false]] as const){
  let calls=0;const secrets=new KeychainSecretSlots(async call=>{calls++;assert.equal(call.command,'/usr/bin/security');assert.deepEqual(call.args,['find-generic-password','-s','massion:metadata-fixture','-a','api-key']);assert.equal(call.stdin,'');assert.deepEqual(call.env,{});return {...ok,exitCode};},'darwin');
  assert.equal(typeof secrets.has,'function');const result=await secrets.has(slot);assert.equal(result,present);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify([result,secrets]),/discarded-private/);
 }
});

test('metadata failures stay unavailable, never missing, and suppress raw tool errors',async()=>{
 for(const result of [{...ok,exitCode:1},{...ok,spawned:false},{...ok,timedOut:true},{...ok,aborted:true},{...ok,overflow:true}]){
  const secrets=new KeychainSecretSlots(async()=>result,'darwin');assert.equal(typeof secrets.has,'function');await assert.rejects(secrets.has(slot),e=>e instanceof Error&&e.message==='Secret slot unavailable'&&!e.cause);
 }
 const secrets=new KeychainSecretSlots(async()=>{throw Error('discarded-private-metadata');},'darwin');await assert.rejects(secrets.has(slot),e=>e instanceof Error&&!String(e.stack).includes('discarded-private')&&!e.cause);
 const otherPlatform=new KeychainSecretSlots(async()=>assert.fail('No fallback command'),'linux');await assert.rejects(otherPlatform.has(slot),/unavailable/);
});
